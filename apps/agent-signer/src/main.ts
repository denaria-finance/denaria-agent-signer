import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileAgentIndex } from './agent-index.js';
import { createSignerApi } from './api.js';
import { parseCliArgs, type StoreKind, USAGE } from './cli.js';
import { apiBaseUrlOf, SIGNER_TARGETS, SIGNER_VERSION } from './envs.js';
import { createSignerServer } from './server.js';
import { fileKeyStore, PASSPHRASE_VARIABLE } from './store/file.js';
import { signerHome, systemKeyStore } from './store/system.js';
import type { KeyStore } from './store/types.js';

// stdout carries the MCP protocol: everything for humans goes to stderr.
const log = (line: string) => {
  process.stderr.write(`[denaria-agent-signer] ${line}\n`);
};

function keyStore(kind: StoreKind): KeyStore {
  if (kind === 'keychain') return systemKeyStore(process.platform);
  return fileKeyStore({
    home: signerHome(),
    // Read at use, not at start: without it the server still starts and
    // connect explains what to set.
    passphrase: () => process.env[PASSPHRASE_VARIABLE],
  });
}

async function main(): Promise<void> {
  const command = parseCliArgs(process.argv.slice(2), process.platform);
  if (!command.ok) {
    process.stderr.write(`${command.message}\n`);
    process.exit(2);
  }
  if (command.command === 'version') {
    process.stdout.write(`${SIGNER_VERSION}\n`);
    return;
  }
  if (command.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const target = SIGNER_TARGETS[command.target];
  const store = keyStore(command.store);
  const apiBaseUrl = apiBaseUrlOf(target, process.env.DENARIA_SIGNER_API_URL);
  const server = createSignerServer({
    target,
    store,
    index: fileAgentIndex({ home: signerHome(), env: target.env }),
    api: createSignerApi({ baseUrl: apiBaseUrl }),
    log,
    name: command.name,
  });
  await server.connect(new StdioServerTransport());
  log(
    `${SIGNER_VERSION} serving Denaria ${target.env} (eip155:${target.chainId}) through ${apiBaseUrl}; keys in ${command.store === 'file' ? `encrypted files in ${signerHome()}` : "the system's keyring"}${command.name === null ? '' : `; agent ${JSON.stringify(command.name)}`}`,
  );
}

main().catch((error: unknown) => {
  log(`stopped: ${error instanceof Error ? error.name : 'unexpected error'}`);
  process.exit(1);
});
