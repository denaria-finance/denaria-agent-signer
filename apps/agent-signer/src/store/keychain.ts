import { z } from 'zod';
import { SignerError } from '../errors.js';
import { runTool, type ToolResult } from './run-tool.js';
import {
  assertPlainSlot,
  isSlotOf,
  type KeyItem,
  type KeyItemMeta,
  type KeyStore,
} from './types.js';

/**
 * The macOS Keychain through Apple's own `/usr/bin/security`, no native
 * module (agent-trading Stage 2 Q57). The tool runs in interactive mode
 * (`security -i`) and reads its command from stdin, so the secret is never in
 * a process argument another user could list. One generic password per slot:
 * service `denaria-agent-signer`, account = slot (the Env for the 0.1.0 key).
 *
 * Ticket 15 (ADR-0062 §18): each item carries its metadata in its comment
 * attribute (`dn1.<hex of JSON>`, plain characters for the interactive
 * parser). `security` cannot list the items of one service without dumping
 * the whole keychain, so every key made since also has a directory entry,
 * account `<env>.<n>` (n = 1, 2, …, a dot no slot has), with the same comment
 * and no secret: listing reads the 0.1.0 account, those entries and the
 * items they name one by one, attributes only (`find-generic-password` without `-w`), which never
 * prompts and never reads another item. An entry is claimed by an add without
 * `-U`, which fails when it exists: two Signers never take the same number.
 * The entry is made before the key: a key is never saved unlisted, and an
 * entry whose key was never saved lists nothing (a retry in the slot reuses it).
 */

export const KEYCHAIN_SERVICE = 'denaria-agent-signer';
const SECURITY_PATH = '/usr/bin/security';

/** `security` exit codes are the low byte of the OSStatus. */
const ITEM_NOT_FOUND = 44; // errSecItemNotFound, -25300
const DUPLICATE_ITEM = 45; // errSecDuplicateItem, -25299
const ACCESS_REFUSED = new Set([
  36, // errSecInteractionNotAllowed, -25308: locked keychain, no GUI session
  51, // errSecAuthFailed, -25293
  128, // errSecUserCanceled, -128
]);

/** `security -i` splits its command line on spaces and quotes. */
const PLAIN_TOKEN = /^[A-Za-z0-9._:-]+$/;
const KEYCHAIN_PATH = /^\/[A-Za-z0-9._/-]+$/;
const META_PREFIX = 'dn1.';
/** A bound on the directory: far more agents than one computer runs. */
const MAX_DIRECTORY_ENTRIES = 256;

export type SecurityRunner = (argv: readonly string[], stdin: string) => Promise<ToolResult>;

export const runSecurity: SecurityRunner = (argv, stdin) => runTool(SECURITY_PATH, argv, stdin);

function plain(token: string): string {
  if (!PLAIN_TOKEN.test(token)) throw new Error('Keychain command token is not plain');
  return token;
}

const metaSchema = z.object({
  env: z.string(),
  slot: z.string(),
  name: z.string().nullable(),
  identity: z.string(),
  createdAt: z.string(),
});

const encodeMeta = (slot: string, meta: KeyItemMeta): string =>
  `${META_PREFIX}${Buffer.from(JSON.stringify({ ...meta, slot }), 'utf8').toString('hex')}`;

function decodeMeta(comment: string | null): z.infer<typeof metaSchema> | null {
  if (comment === null || !comment.startsWith(META_PREFIX)) return null;
  const hex = comment.slice(META_PREFIX.length);
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  try {
    return metaSchema.parse(JSON.parse(Buffer.from(hex, 'hex').toString('utf8')));
  } catch {
    return null;
  }
}

/** An attribute of what `find-generic-password` (no `-w`) prints. */
function attributeOf(stdout: string, name: string): string | null {
  const match = new RegExp(`^\\s*"${name}"<blob>="(.*)"\\s*$`, 'm').exec(stdout);
  return match?.[1] ?? null;
}

export function keychainKeyStore(options: {
  run: SecurityRunner;
  service?: string;
  /** A keychain file instead of the default one (the live test's throwaway). */
  keychain?: string;
}): KeyStore {
  const service = plain(options.service ?? KEYCHAIN_SERVICE);
  if (options.keychain !== undefined && !KEYCHAIN_PATH.test(options.keychain)) {
    throw new Error('Keychain path is not plain');
  }
  const target = options.keychain === undefined ? '' : ` ${options.keychain}`;

  // Never echo security's output into an error: on a failed add it could
  // repeat the command line, secret included.
  const failure = (action: string, code: number | null): SignerError =>
    code !== null && ACCESS_REFUSED.has(code)
      ? new SignerError(
          `The macOS Keychain refused to ${action} (it may be locked, or this session cannot reach it). Unlock it and try again, or start the Denaria Agent Signer with --store file and DENARIA_SIGNER_PASSPHRASE set.`,
        )
      : new SignerError(
          `The macOS Keychain could not ${action} (security exited with ${code ?? 'a signal'}). Try again, or start the Denaria Agent Signer with --store file and DENARIA_SIGNER_PASSPHRASE set.`,
        );

  const run = async (command: string) => {
    try {
      return await options.run(['-i'], `${command}${target}\n`);
    } catch {
      throw new SignerError(
        `${SECURITY_PATH} could not be started. Start the Denaria Agent Signer with --store file and DENARIA_SIGNER_PASSPHRASE set.`,
      );
    }
  };

  const assertSavable = (slot: string, secret: string) => {
    assertPlainSlot(slot);
    if (!PLAIN_TOKEN.test(secret)) throw new Error('Keychain secret is not a plain token');
  };

  const add = async (slot: string, secret: string, meta: KeyItemMeta, update: boolean) => {
    assertSavable(slot, secret);
    const result = await run(
      `add-generic-password${update ? ' -U' : ''} -s ${service} -a ${slot} -j ${encodeMeta(slot, meta)} -w ${secret}`,
    );
    if (result.code === DUPLICATE_ITEM) {
      throw new SignerError(
        `The macOS Keychain already holds a key for ${slot} (service ${service}); it was not overwritten.`,
      );
    }
    if (result.code !== 0) throw failure('save the key', result.code);
  };

  /** The attributes of one item, or null when there is none. */
  const find = async (account: string): Promise<string | null> => {
    const result = await run(`find-generic-password -s ${service} -a ${plain(account)}`);
    if (result.code === ITEM_NOT_FOUND) return null;
    if (result.code !== 0) throw failure('list the keys', result.code);
    return result.stdout;
  };

  /** The directory entries of `env`, in order, up to the first gap. */
  const directory = async (env: string) => {
    const entries: Array<{ n: number; comment: string | null }> = [];
    for (let n = 1; n <= MAX_DIRECTORY_ENTRIES; n++) {
      const found = await find(`${env}.${n}`);
      if (found === null) break;
      entries.push({ n, comment: attributeOf(found, 'icmt') });
    }
    return entries;
  };

  const enter = async (slot: string, meta: KeyItemMeta) => {
    const entries = await directory(meta.env);
    if (entries.some((entry) => decodeMeta(entry.comment)?.slot === slot)) return;
    // From the first gap on: a number another Signer takes first fails the
    // add (no -U) and the next one is tried.
    let n = entries.length + 1;
    for (; n <= MAX_DIRECTORY_ENTRIES; n++) {
      const result = await run(
        `add-generic-password -s ${service} -a ${meta.env}.${n} -j ${encodeMeta(slot, meta)} -w none`,
      );
      if (result.code === 0) return;
      if (result.code !== DUPLICATE_ITEM) throw failure('list the new key', result.code);
    }
    throw new SignerError('The macOS Keychain holds too many Denaria Agent Signer keys.');
  };

  return {
    describe: (slot) => `the macOS Keychain (service ${service}, account ${slot})`,

    async load(slot) {
      assertPlainSlot(slot);
      const result = await run(`find-generic-password -s ${service} -a ${slot} -w`);
      if (result.code === ITEM_NOT_FOUND) return null;
      if (result.code !== 0) throw failure('read the key', result.code);
      return result.stdout.replace(/\r?\n$/, '');
    },

    async save(slot, secret, meta) {
      assertSavable(slot, secret);
      await enter(slot, meta);
      await add(slot, secret, meta, false);
    },
    // `-U` updates the item in place: the Keychain keeps no old version, and
    // the old key's Grant is revoked anyway when the Signer rotates. The slot
    // keeps its directory entry (the 0.1.0 one has none and needs none).
    replace: (slot, secret, meta) => add(slot, secret, meta, true),

    async list(env) {
      assertPlainSlot(env);
      // The metadata is read from each key item itself: a directory entry
      // whose key was deleted lists nothing.
      const items = new Map<string, KeyItem>();
      const slots = [env];
      for (const entry of await directory(env)) {
        const meta = decodeMeta(entry.comment);
        if (meta !== null && meta.env === env && isSlotOf(env, meta.slot)) slots.push(meta.slot);
      }
      for (const slot of slots) {
        if (items.has(slot)) continue;
        const found = await find(slot);
        if (found === null) continue;
        const meta = decodeMeta(attributeOf(found, 'icmt'));
        items.set(slot, {
          slot,
          name: meta?.name ?? null,
          identity: meta?.identity ?? null,
          createdAt: meta?.createdAt ?? null,
        });
      }
      return [...items.values()];
    },
  };
}
