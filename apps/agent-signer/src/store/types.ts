/**
 * Where the Signer keeps the secret of its Session key, one per Env. The
 * secret is an opaque printable token (`SessionKey.exportSecret`); a store
 * never parses it and never puts it in an error, a log or a process argument.
 */
export interface KeyStore {
  /** Where the key lives, in words for the user. */
  describe(env: string): string;
  /** The saved secret, or null when this Env has none yet. */
  load(env: string): Promise<string | null>;
  /** Saves the secret; resolves only once it is durably stored. Never
   *  replaces an existing key. */
  save(env: string, secret: string): Promise<void>;
  /** Replaces the key of `env` with a new one (rotation after a revoked
   *  Grant, ADR-0062 §11): atomic, resolves once the new secret is durable. */
  replace(env: string, secret: string): Promise<void>;
}

/** Env names reach file names and keychain commands: keep them plain. */
export function assertPlainEnv(env: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(env)) throw new Error('Invalid env name');
}

/** The way out every system keyring error gives: the encrypted file. */
export const FILE_STORE_HINT =
  'start the Denaria Agent Signer with --store file and DENARIA_SIGNER_PASSPHRASE set';
