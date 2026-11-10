import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { SignerError } from '../errors.js';
import {
  assertPlainSlot,
  isSlotOf,
  type KeyItem,
  type KeyItemMeta,
  type KeyStore,
} from './types.js';

/**
 * A key kept as one sealed file per slot, `<home>/<slot>.<extension>`: the
 * encrypted file of headless hosts and the Windows DPAPI blob share it. How the
 * secret is sealed is the caller's; the file rules are here. The directory is
 * 0700 and the file 0600 (POSIX; on Windows the profile's ACLs apply); a file is
 * written once and never replaced by `save`, so a wrong passphrase or a second
 * connect can never destroy the key a Grant may already trust. Only `replace`
 * (rotation after a revoked Grant) swaps it, keeping the old file aside as
 * `<slot>.<extension>.replaced-<ms>`.
 *
 * Format version 2 (ticket 15) adds, in clear, the slot and the item's
 * metadata (`agent`: Agent name, who created it, when); version 1 (the 0.1.0
 * key, `<env>.<extension>`) has neither and still opens. The listing reads
 * only those clear fields, never the sealed secret.
 */
export type Sealer = {
  /** The sealed fields of the file for `secret`, bound to `slot`. */
  seal(slot: string, secret: string): Promise<Record<string, unknown>>;
  /** The secret in `file`, the parsed JSON of `path`; throws a SignerError
   *  that says why it cannot be opened and that the file was left untouched. */
  open(slot: string, file: unknown, path: string): Promise<string>;
};

/** The clear part of every version: what the listing reads. */
const clearFieldsSchema = z.union([
  z.object({ version: z.literal(1), env: z.string() }),
  z.object({
    version: z.literal(2),
    env: z.string(),
    slot: z.string(),
    agent: z.object({
      name: z.string().nullable(),
      identity: z.string(),
      createdAt: z.string(),
    }),
  }),
]);

const FILE_NAME = /^([a-z0-9][a-z0-9-]{0,63})\.([a-z]+)$/;

export function sealedFileKeyStore(options: {
  home: string;
  extension: string;
  /** Where the key lives, in words for the user, from the file's path. */
  describe: (path: string) => string;
  /** Checked before the file is read or written (the passphrase rules). */
  ready?: () => void;
  sealer: Sealer;
}): KeyStore {
  const pathOf = (slot: string) => {
    assertPlainSlot(slot);
    return join(options.home, `${slot}.${options.extension}`);
  };

  /** The sealed file for `secret`, written and fsynced under a private
   *  temporary name next to its final one. */
  const writeTemporary = async (
    slot: string,
    secret: string,
    meta: KeyItemMeta,
  ): Promise<string> => {
    const path = pathOf(slot);
    options.ready?.();
    const file = {
      version: 2,
      env: meta.env,
      slot,
      agent: { name: meta.name, identity: meta.identity, createdAt: meta.createdAt },
      ...(await options.sealer.seal(slot, secret)),
    };
    await mkdir(options.home, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return temporary;
  };

  const notReadable = (path: string) =>
    new SignerError(
      `${path} is not a Denaria Agent Signer key file this version can read. It was left untouched.`,
    );

  /** The listed item of a file, or null when it is not one of `env`. */
  const itemOf = (env: string, slot: string, raw: string): KeyItem | null => {
    let parsed: z.infer<typeof clearFieldsSchema>;
    try {
      parsed = clearFieldsSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
    if (parsed.version === 1) {
      return slot === env && parsed.env === env
        ? { slot, name: null, identity: null, createdAt: null }
        : null;
    }
    if (parsed.env !== env || parsed.slot !== slot) return null;
    return { slot, ...parsed.agent };
  };

  return {
    describe: (slot) => options.describe(pathOf(slot)),

    async load(slot) {
      const path = pathOf(slot);
      options.ready?.();
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new SignerError(`The key file ${path} cannot be read.`);
      }
      let file: unknown;
      try {
        file = JSON.parse(raw);
      } catch {
        throw notReadable(path);
      }
      // A version 2 file names its slot: one copied over another's name does
      // not open (the sealed secret is bound to the slot as well).
      const clear = clearFieldsSchema.safeParse(file);
      if (clear.success && clear.data.version === 2 && clear.data.slot !== slot) {
        throw notReadable(path);
      }
      return options.sealer.open(slot, file, path);
    },

    async save(slot, secret, meta) {
      const path = pathOf(slot);
      const temporary = await writeTemporary(slot, secret, meta);
      // Atomic and never replacing: the whole file is written under a private
      // name, then hard-linked to its final name, which fails if one exists.
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new SignerError(`A key file already exists at ${path}; it was not overwritten.`);
        }
        throw new SignerError(`The key file could not be written to ${path}.`);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },

    async replace(slot, secret, meta) {
      const path = pathOf(slot);
      const temporary = await writeTemporary(slot, secret, meta);
      try {
        // The old file stays aside under a new name (a hard link, so it is
        // never copied or rewritten), then the new one takes the name in one
        // rename: there is no instant without a key file.
        try {
          await link(path, `${path}.replaced-${Date.now()}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await rename(temporary, path);
      } catch {
        await unlink(temporary).catch(() => undefined);
        throw new SignerError(`The new key file could not be written to ${path}.`);
      }
    },

    async list(env) {
      let names: string[];
      try {
        names = await readdir(options.home);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw new SignerError(`The folder ${options.home} cannot be read.`);
      }
      const items: KeyItem[] = [];
      for (const name of names.sort()) {
        const match = FILE_NAME.exec(name);
        const slot = match?.[1];
        if (slot === undefined || match?.[2] !== options.extension || !isSlotOf(env, slot)) {
          continue;
        }
        // A file that cannot be read now is left out, not a failure: the
        // listing only rebuilds the index, and `load` says what is wrong.
        const raw = await readFile(join(options.home, name), 'utf8').catch(() => null);
        const item = raw === null ? null : itemOf(env, slot, raw);
        if (item !== null) items.push(item);
      }
      return items;
    },
  };
}
