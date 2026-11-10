import { AGENT_LABEL_MAX_LENGTH } from '@denaria/agent-schemas';
import { agentNameSchema } from './client-label.js';
import type { SignerTargetName } from './envs.js';
import { hasSystemKeyStore } from './store/system.js';

export type StoreKind = 'keychain' | 'file';

export type CliCommand =
  | {
      ok: true;
      command: 'serve';
      target: SignerTargetName;
      store: StoreKind;
      /** `--name`: this agent's Agent name, and how the Signer recognises it. */
      name: string | null;
    }
  | { ok: true; command: 'version' }
  | { ok: true; command: 'help' }
  | { ok: false; message: string };

/** Where `--store keychain` has a system keyring (store/os-keychain.ts). */
export const KEYCHAIN_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  'darwin',
  'linux',
  'win32',
]);

export const USAGE = [
  'Usage: denaria-agent-signer --env testnet|mainnet [--store keychain|file] [--name "<Agent name>"]',
  '',
  '  --env testnet   Denaria demo-staging on Arbitrum Sepolia (test funds)',
  '  --env mainnet   Denaria on Arbitrum One (real funds)',
  '  --store         where the key is kept: keychain (the default: the macOS Keychain,',
  '                  the Linux Secret Service through secret-tool, Windows DPAPI) or file',
  '                  (encrypted with DENARIA_SIGNER_PASSPHRASE: servers, containers, CI)',
  '  --name          the name of this agent in Denaria, with its own key on this computer',
  '                  (two agents of the same client; without it the first connect asks)',
].join('\n');

function refuse(message: string): CliCommand {
  return { ok: false, message: `${message}\n\n${USAGE}` };
}

/** The command line, or why the Signer refuses to start. Never guesses the
 *  Env: real and test funds must be a choice the user made at install. */
export function parseCliArgs(argv: readonly string[], platform: NodeJS.Platform): CliCommand {
  const values: Partial<Record<'env' | 'store' | 'name', string>> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--version') return { ok: true, command: 'version' };
    if (arg === '--help' || arg === '-h') return { ok: true, command: 'help' };
    const match = /^--(env|store|name)(?:=(.*))?$/.exec(arg);
    if (!match) return refuse(`Unknown argument: ${arg.slice(0, 64)}`);
    const name = match[1] as 'env' | 'store' | 'name';
    const value = match[2] ?? argv[++i];
    if (value === undefined || value === '' || value.startsWith('--')) {
      return refuse(`--${name} needs a value.`);
    }
    if (values[name] !== undefined) return refuse(`--${name} is given twice.`);
    values[name] = value;
  }

  if (values.env === undefined) {
    return refuse('The Denaria Agent Signer needs --env testnet|mainnet to start.');
  }
  if (values.env !== 'testnet' && values.env !== 'mainnet') {
    return refuse(`--env must be testnet or mainnet, not ${values.env.slice(0, 64)}.`);
  }

  // The system's own keyring wherever there is one (Q57); a host without it
  // (a server, a container) says so at connect and points at --store file.
  // Never chosen by probing: where the key lives must not change between runs.
  const store = values.store ?? 'keychain';
  if (store !== 'keychain' && store !== 'file') {
    return refuse(`--store must be keychain or file, not ${store.slice(0, 64)}.`);
  }
  if (store === 'keychain' && !hasSystemKeyStore(platform)) {
    return refuse(
      `There is no keychain store on ${platform.slice(0, 32)}. Use --store file with DENARIA_SIGNER_PASSPHRASE set.`,
    );
  }
  let agentName: string | null = null;
  if (values.name !== undefined) {
    const parsed = agentNameSchema.safeParse(values.name);
    if (!parsed.success) {
      return refuse(`--name must be 1 to ${AGENT_LABEL_MAX_LENGTH} characters on one line.`);
    }
    agentName = parsed.data;
  }
  return { ok: true, command: 'serve', target: values.env, store, name: agentName };
}
