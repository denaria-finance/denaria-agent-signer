import { AGENT_LABEL_MAX_LENGTH } from '@denaria/agent-schemas';

/** MCP client names (`initialize.clientInfo.name`) of the agents we know. */
const KNOWN_CLIENTS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  'codex-mcp-client': 'Codex',
  codex: 'Codex',
};

/** The label `connect` proposes when the user gave none: the declared
 *  client, named the way a user knows it. User-declared and unverified
 *  (ADR-0062 §6), so it is only tidied, never trusted. */
export function labelFromClient(clientName: string | undefined): string | null {
  if (clientName === undefined) return null;
  const known = KNOWN_CLIENTS[clientName.trim().toLowerCase()];
  if (known !== undefined) return known;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is stripped
  const tidy = clientName.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const label = tidy.slice(0, AGENT_LABEL_MAX_LENGTH).trim();
  return label.length > 0 ? label : null;
}
