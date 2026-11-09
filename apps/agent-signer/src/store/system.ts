import { homedir } from 'node:os';
import { join } from 'node:path';
import { dpapiKeyStore, windowsPowerShellPath } from './dpapi.js';
import { keychainKeyStore, runSecurity } from './keychain.js';
import { runTool } from './run-tool.js';
import { secretServiceKeyStore } from './secret-service.js';
import type { KeyStore } from './types.js';

/** Where the Signer keeps its files: the encrypted key and the DPAPI blob. */
export const signerHome = (): string =>
  process.env.DENARIA_SIGNER_HOME ?? join(homedir(), '.denaria-agent-signer');

/**
 * `--store keychain`: the system's own keyring, by platform (ADR-0062 §17,
 * agent-trading Stage 2 Q57). The one list of the platforms that have one.
 */
const SYSTEM_KEY_STORES: Partial<Record<NodeJS.Platform, () => KeyStore>> = {
  darwin: () => keychainKeyStore({ run: runSecurity }),
  linux: () => secretServiceKeyStore({ run: runTool }),
  win32: () =>
    dpapiKeyStore({ home: signerHome(), run: runTool, powershell: windowsPowerShellPath() }),
};

export const hasSystemKeyStore = (platform: NodeJS.Platform): boolean =>
  SYSTEM_KEY_STORES[platform] !== undefined;

export function systemKeyStore(platform: NodeJS.Platform): KeyStore {
  const make = SYSTEM_KEY_STORES[platform];
  if (!make) throw new Error(`No system keyring on ${platform}`);
  return make();
}
