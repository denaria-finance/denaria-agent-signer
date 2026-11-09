import { SignerError } from '../errors.js';
import type { ToolRunner } from './run-tool.js';
import { assertPlainEnv, FILE_STORE_HINT, type KeyStore } from './types.js';

/**
 * The Linux keyring (GNOME Keyring, KWallet, KeePassXC: any Secret Service)
 * through libsecret's own `secret-tool`, no native module (agent-trading
 * Stage 2 Q57). `store` reads the secret from stdin, so it is never in a
 * process argument. One item per Env: attributes service
 * `denaria-agent-signer`, account = Env name, the same as the macOS Keychain.
 * Found through PATH: distributions install it in different places.
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

  const store = async (env: string, secret: string) => {
    assertPlainEnv(env);
    const result = await run(
      ['store', `--label=Denaria Agent Signer (${env})`, 'service', service, 'account', env],
      secret,
    );
    if (result.code !== 0) throw failure('save the key');
  };

  return {
    describe: (env) => `the Secret Service keyring (service ${service}, account ${env})`,

    async load(env) {
      assertPlainEnv(env);
      const result = await run(['lookup', 'service', service, 'account', env], '');
      if (result.code === 0) return result.stdout.replace(/\r?\n$/, '');
      // secret-tool exits 1 for "no such item" without a word; anything it
      // says is a keyring it could not reach.
      if (result.code === 1 && result.stderr.trim() === '') return null;
      throw failure('read the key');
    },

    async save(env, secret) {
      assertPlainEnv(env);
      const found = await run(['search', 'service', service, 'account', env], '');
      if (found.code !== 0) throw failure('check for a key before saving one');
      if (found.stdout.trim() !== '') {
        throw new SignerError(
          `The Linux keyring already holds a key for ${env} (service ${service}); it was not overwritten. If the keyring is locked, unlock it and try again.`,
        );
      }
      await store(env, secret);
    },
    // Rotation after a revoked Grant: `store` replaces the item in place; the
    // keyring keeps no old version, and the old key's Grant is revoked anyway.
    replace: (env, secret) => store(env, secret),
  };
}
