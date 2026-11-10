import { SignerError } from '../errors.js';
import type { ToolRunner } from './run-tool.js';
import {
  assertPlainSlot,
  FILE_STORE_HINT,
  isSlotOf,
  type KeyItem,
  type KeyItemMeta,
  type KeyStore,
} from './types.js';

/**
 * The Linux keyring (GNOME Keyring, KWallet, KeePassXC: any Secret Service)
 * through libsecret's own `secret-tool`, no native module (agent-trading
 * Stage 2 Q57). `store` reads the secret from stdin, so it is never in a
 * process argument. One item per slot: attributes service
 * `denaria-agent-signer`, account = slot (the Env for the 0.1.0 key), the same
 * as the macOS Keychain. Ticket 15 (ADR-0062 §18): an item made since also
 * carries `env`, `agent-name` (when there is one), `agent-identity` and
 * `created-at`. Found through PATH: distributions install it in different
 * places.
 *
 * Listing: `search` prints each item's path, label, secret (the keyring
 * unlocked) and dates on stdout and its attributes on stderr, with nothing on
 * stderr between two items, so the attributes of one item cannot be told from
 * the next one's. `search --all` gives the accounts (one per item), then a
 * `search` of each account gives that item's attributes alone. No option
 * leaves the secret out (`SECRET_SEARCH_LOAD_SECRETS` is always set): stdout
 * is never read here, so the secrets reach this process's memory, never a
 * result, an error or the log.
 *
 * `save` never replaces a key (the KeyStore contract): `store` would, so it
 * first asks `search`, which lists an item without unlocking it. A lookup that
 * came back empty because the keyring was locked, or its unlock prompt was
 * dismissed, then fails instead of overwriting the key a Grant trusts.
 */

export const SECRET_SERVICE_NAME = 'denaria-agent-signer';
const SECRET_TOOL = 'secret-tool';

const FALLBACK = `or ${FILE_STORE_HINT}`;

export function secretServiceKeyStore(options: { run: ToolRunner; service?: string }): KeyStore {
  const service = options.service ?? SECRET_SERVICE_NAME;

  const run = async (argv: readonly string[], stdin: string) => {
    try {
      return await options.run(SECRET_TOOL, argv, stdin);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SignerError(
          `secret-tool is not installed, so the Linux keyring cannot keep the key. Install it (Debian and Ubuntu: apt install libsecret-tools; Fedora: dnf install libsecret) ${FALLBACK}.`,
        );
      }
      throw new SignerError(`secret-tool could not be started. Try again, ${FALLBACK}.`);
    }
  };

  // Never echo secret-tool's output into an error.
  const failure = (action: string) =>
    new SignerError(
      `The Linux keyring could not ${action}: no Secret Service answered, or it is locked (a desktop session usually provides one; a server or container usually has none). Unlock it and try again, ${FALLBACK}.`,
    );

  const store = async (slot: string, secret: string, meta: KeyItemMeta) => {
    assertPlainSlot(slot);
    const result = await run(
      [
        'store',
        `--label=Denaria Agent Signer (${slot})`,
        'service',
        service,
        'account',
        slot,
        'env',
        meta.env,
        ...(meta.name === null ? [] : ['agent-name', meta.name]),
        'agent-identity',
        meta.identity,
        'created-at',
        meta.createdAt,
      ],
      secret,
    );
    if (result.code !== 0) throw failure('save the key');
  };

  return {
    describe: (slot) => `the Secret Service keyring (service ${service}, account ${slot})`,

    async load(slot) {
      assertPlainSlot(slot);
      const result = await run(['lookup', 'service', service, 'account', slot], '');
      if (result.code === 0) return result.stdout.replace(/\r?\n$/, '');
      // secret-tool exits 1 for "no such item" without a word; anything it
      // says is a keyring it could not reach.
      if (result.code === 1 && result.stderr.trim() === '') return null;
      throw failure('read the key');
    },

    async save(slot, secret, meta) {
      assertPlainSlot(slot);
      const found = await run(['search', 'service', service, 'account', slot], '');
      if (found.code !== 0) throw failure('check for a key before saving one');
      if (found.stdout.trim() !== '') {
        throw new SignerError(
          `The Linux keyring already holds a key for ${slot} (service ${service}); it was not overwritten. If the keyring is locked, unlock it and try again.`,
        );
      }
      await store(slot, secret, meta);
    },

    // Rotation after a revoked Grant. `store` replaces only an item with the
    // very same attributes, and the new item's metadata differs from the old
    // one's: the old item is cleared first, so a lookup can never find the
    // revoked key beside the new one. A failure in between leaves no key,
    // and connect makes one; the old key's Grant is revoked anyway.
    async replace(slot, secret, meta) {
      assertPlainSlot(slot);
      const cleared = await run(['clear', 'service', service, 'account', slot], '');
      if (cleared.code !== 0 && !(cleared.code === 1 && cleared.stderr.trim() === '')) {
        throw failure('replace the key');
      }
      await store(slot, secret, meta);
    },

    async list(env) {
      assertPlainSlot(env);
      const search = async (argv: readonly string[]) => {
        const found = await run(['search', ...argv], '');
        if (found.code === 1 && found.stderr.trim() === '') return [];
        if (found.code !== 0) throw failure('list the keys');
        return attributeLines(found.stderr);
      };
      const slots = new Set(
        (await search(['--all', 'service', service]))
          .filter(([key, value]) => key === 'account' && isSlotOf(env, value))
          .map(([, value]) => value),
      );
      const items: KeyItem[] = [];
      for (const slot of slots) {
        const attributes = new Map(await search(['service', service, 'account', slot]));
        if (attributes.get('account') !== slot) continue;
        const itemEnv = attributes.get('env');
        // The 0.1.0 item has no env attribute: its account is the Env.
        if (itemEnv === undefined ? slot !== env : itemEnv !== env) continue;
        items.push({
          slot,
          name: attributes.get('agent-name') ?? null,
          identity: attributes.get('agent-identity') ?? null,
          createdAt: attributes.get('created-at') ?? null,
        });
      }
      return items;
    },
  };
}

/** The `attribute.<key> = <value>` lines `secret-tool search` prints on stderr. */
function attributeLines(stderr: string): Array<[string, string]> {
  const lines: Array<[string, string]> = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = /^attribute\.([a-z-]+) = (.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) lines.push([match[1], match[2]]);
  }
  return lines;
}
