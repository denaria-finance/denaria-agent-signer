import { SignerError } from '../errors.js';
import { runTool, type ToolResult } from './run-tool.js';
import { assertPlainEnv, type KeyStore } from './types.js';

/**
 * The macOS Keychain through Apple's own `/usr/bin/security`, no native
 * module (agent-trading Stage 2 Q57). The tool runs in interactive mode
 * (`security -i`) and reads its command from stdin, so the secret is never in
 * a process argument another user could list. One generic password per Env:
 * service `denaria-agent-signer`, account = Env name.
 */

export const KEYCHAIN_SERVICE = 'denaria-agent-signer';
const SECURITY_PATH = '/usr/bin/security';

/** `security` exit codes are the low byte of the OSStatus. */
const ITEM_NOT_FOUND = 44; // errSecItemNotFound, -25300
const ACCESS_REFUSED = new Set([
  36, // errSecInteractionNotAllowed, -25308: locked keychain, no GUI session
  51, // errSecAuthFailed, -25293
  128, // errSecUserCanceled, -128
]);

/** `security -i` splits its command line on spaces and quotes. */
const PLAIN_TOKEN = /^[A-Za-z0-9._:-]+$/;

export type SecurityRunner = (argv: readonly string[], stdin: string) => Promise<ToolResult>;

export const runSecurity: SecurityRunner = (argv, stdin) => runTool(SECURITY_PATH, argv, stdin);

function plain(token: string): string {
  if (!PLAIN_TOKEN.test(token)) throw new Error('Keychain command token is not plain');
  return token;
}

export function keychainKeyStore(options: { run: SecurityRunner; service?: string }): KeyStore {
  const service = plain(options.service ?? KEYCHAIN_SERVICE);

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
      return await options.run(['-i'], `${command}\n`);
    } catch {
      throw new SignerError(
        `${SECURITY_PATH} could not be started. Start the Denaria Agent Signer with --store file and DENARIA_SIGNER_PASSPHRASE set.`,
      );
    }
  };

  const add = async (env: string, secret: string) => {
    assertPlainEnv(env);
    if (!PLAIN_TOKEN.test(secret)) throw new Error('Keychain secret is not a plain token');
    const result = await run(`add-generic-password -U -s ${service} -a ${env} -w ${secret}`);
    if (result.code !== 0) throw failure('save the key', result.code);
  };

  return {
    describe: (env) => `the macOS Keychain (service ${service}, account ${env})`,

    async load(env) {
      assertPlainEnv(env);
      const result = await run(`find-generic-password -s ${service} -a ${env} -w`);
      if (result.code === ITEM_NOT_FOUND) return null;
      if (result.code !== 0) throw failure('read the key', result.code);
      return result.stdout.replace(/\r?\n$/, '');
    },

    save: (env, secret) => add(env, secret),
    // `-U` updates the item in place: the Keychain keeps no old version, and
    // the old key's Grant is revoked anyway when the Signer rotates.
    replace: (env, secret) => add(env, secret),
  };
}
