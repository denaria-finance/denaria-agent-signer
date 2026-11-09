import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { SignerError } from '../errors.js';
import { assertPlainEnv, type KeyStore } from './types.js';

/**
 * A key kept as one sealed file per Env, `<home>/<env>.<extension>`: the
 * encrypted file of headless hosts and the Windows DPAPI blob share it. How the
 * secret is sealed is the caller's; the file rules are here. The directory is
 * 0700 and the file 0600 (POSIX; on Windows the profile's ACLs apply); a file is
 * written once and never replaced by `save`, so a wrong passphrase or a second
 * connect can never destroy the key a Grant may already trust. Only `replace`
 * (rotation after a revoked Grant) swaps it, keeping the old file aside as
 * `<env>.<extension>.replaced-<ms>`.
 */
export type Sealer = {
  /** The file's text for `secret`. */
  seal(env: string, secret: string): Promise<string>;
  /** The secret in `raw`, the text of `path`; throws a SignerError that says
   *  why it cannot be opened and that the file was left untouched. */
  open(env: string, raw: string, path: string): Promise<string>;
};

export function sealedFileKeyStore(options: {
  home: string;
  extension: string;
  /** Where the key lives, in words for the user, from the file's path. */
  describe: (path: string) => string;
  /** Checked before the file is read or written (the passphrase rules). */
  ready?: () => void;
  sealer: Sealer;
}): KeyStore {
  const pathOf = (env: string) => {
    assertPlainEnv(env);
    return join(options.home, `${env}.${options.extension}`);
  };

  /** The sealed file for `secret`, written and fsynced under a private
   *  temporary name next to its final one. */
  const writeTemporary = async (env: string, secret: string): Promise<string> => {
    const path = pathOf(env);
    options.ready?.();
    const contents = await options.sealer.seal(env, secret);
    await mkdir(options.home, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return temporary;
  };

  return {
    describe: (env) => options.describe(pathOf(env)),

    async load(env) {
      const path = pathOf(env);
      options.ready?.();
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new SignerError(`The key file ${path} cannot be read.`);
      }
      return options.sealer.open(env, raw, path);
    },

    async save(env, secret) {
      const path = pathOf(env);
      const temporary = await writeTemporary(env, secret);
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

    async replace(env, secret) {
      const path = pathOf(env);
      const temporary = await writeTemporary(env, secret);
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
  };
}
