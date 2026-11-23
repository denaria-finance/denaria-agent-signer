import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  AGENT_ABANDON_OPERATION_PROCEDURE,
  AGENT_ACCOUNT_READ_WITH_LABEL,
  AGENT_ACCOUNT_TOOLS,
  AGENT_EXECUTION_TOOLS,
  AGENT_LABEL_MAX_LENGTH,
  AGENT_REUSE_APPROVAL_PROCEDURE,
  AGENT_SUBMIT_OPERATION_PROCEDURE,
  type AgentAccountTool,
  type AgentExecutionAction,
  type AgentGrant,
  type AgentNetwork,
  type AgentOperation,
  type AgentOperationStep,
  type AgentSetupClient,
  agentConnectCode,
  agentConnectNonce,
  agentConnectUrl,
  agentGrantSchema,
  agentKeyFingerprint,
  agentNetworkSchema,
  agentOperationStepSchema,
  agentRenewUrl,
  agentReuseApprovalSchema,
  agentSetupUrl,
  agentToolJsonSchemas,
  agentToolName,
  denariaGetAgentOperationStatus,
  denariaGetGrant,
  describeAgentNetwork,
} from '@denaria/agent-schemas';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type AgentIndex, nameKey, type ReuseRequest } from './agent-index.js';
import { agentKeys } from './agent-keys.js';
import { ApiRefusal, ApiUnreachable, type SignerApi } from './api.js';
import { agentNameSchema, clientIdentity, labelFromClient } from './client-label.js';
import { SIGNER_CONTRACTS } from './contracts.js';
import { SIGNER_NAME, SIGNER_VERSION, type SignerTarget } from './envs.js';
import { SignerError } from './errors.js';
import {
  checkStepToSign,
  type GrantToCheck,
  SignRefusal,
  type SignStep,
  type ToolRequest,
} from './operation-check.js';
import { qrPng } from './qr-image.js';
import type { QrWindow } from './qr-window.js';
import { createAgentSession } from './session.js';
import { publicKeyRefOf, SessionKey } from './session-key.js';
import { MAX_ROTATION_ATTEMPTS } from './store/rotation.js';
import type { KeyItemMeta, KeyStore } from './store/types.js';
import { terminalQr } from './terminal-qr.js';

/** Signatures one execution call may give: the first, one more after a relay
 *  fault, and a margin; the API never needs more. */
const MAX_SIGNATURES_PER_OPERATION = 3;

/** A winner writes its key a moment after its claim (one rename, or one or
 *  two keyring commands), so a loser waits a few seconds for it. A keyring
 *  may hold the winner on its unlock prompt for longer: only a claim older
 *  than `staleClaimMs` belongs to a Signer that stopped (Q135). */
const DEFAULT_ROTATION_WAIT = { timeoutMs: 5_000, intervalMs: 200, staleClaimMs: 5 * 60_000 };

const samePublicKey = (a: SessionKey, b: SessionKey) =>
  a.publicKey.x === b.publicKey.x && a.publicKey.y === b.publicKey.y;

/** The guide's tab for a declared MCP client. */
function guideClient(clientName: string | undefined): AgentSetupClient {
  const name = (clientName ?? '').trim().toLowerCase();
  if (name === 'claude-code') return 'claude-code';
  return name.startsWith('codex') ? 'codex' : 'other';
}

/** The app's install guide (ADR-0062 §18, ticket 16), the tab of each client:
 *  the same words in the tool description and the instructions. */
const guideLinks = (pwaOrigin: string) =>
  `${agentSetupUrl(pwaOrigin, 'claude-code')} (Claude Code), ${agentSetupUrl(pwaOrigin, 'codex')} (Codex), ${agentSetupUrl(pwaOrigin, 'other')} (any other client)`;

/** How the model shows the QR (Q107): MCP does not say whether a client shows
 *  tool images, so the model chooses, with the window as the way out. */
const QR_CHOICE =
  'connect gives the QR code twice, as an image and as text: if your client shows tool images to the user, say the QR code is above and do not repeat it; in a terminal, show the text QR code in a code block, unchanged; otherwise, or when the user says they cannot see the QR code, call connect again with qr "window", which opens it in a window on this computer. Always give the link and the connection code (for a renewal, the fingerprint), exactly as returned.';

const connectDescription = (pwaOrigin: string) =>
  [
    "Connect this agent to the user's Denaria account through the Denaria Agent Signer.",
    'Each agent on this computer has its own key, named by its Agent name, kept on this computer.',
    "The first time an agent connects, connect answers status choose_agent: ask the user for this agent's name (propose the one it gives) or which key already on this computer to reuse, then call connect again with name or reuse.",
    'Reusing a key asks the user to approve this agent in Denaria with their Passkey: until then this agent reads and trades nothing.',
    "Until the user has confirmed, it returns a link, a QR code of the link and a connection code, new with every link (a renewal gives the key's fingerprint instead).",
    'The user opens the link on their phone, checks that the phone shows the same connection code, chooses the limits and confirms with their Passkey; then call connect again.',
    'Once connected, it says what this agent may trade, up to which size and leverage, and until when, with no new link.',
    'If the Grant was revoked, it makes a new key and a new link.',
    'One client can have several agents, each with its own key, Grant and Account: connect with a new name makes one more. With two or more, connect needs agent (the key id or Agent name of the one to check), and so does every Denaria tool.',
    QR_CHOICE,
    'The private key never leaves this computer and is never part of the answer.',
    `If the Signer does not start or keeps failing, the user follows the Denaria setup guide: ${guideLinks(pwaOrigin)}.`,
  ].join(' ');

function instructions(network: AgentNetwork, pwaOrigin: string): string {
  return [
    network.notice,
    `Denaria Agent Signer for Denaria ${network.env}, ${network.chainName} (${network.chainId}).`,
    'It keeps the key this agent will trade with, inside the limits the user approves with their Passkey.',
    'When the user wants this agent to trade on Denaria, call connect and show its QR code, link and connection code.',
    QR_CHOICE,
    "The first connect of this agent asks for its name: ask the user, proposing the name connect gives, or which key already on this computer to reuse, and call connect again with the user's choice.",
    'Reusing a key asks the user to approve this agent in the Denaria app with their Passkey; until then this agent reads and trades nothing.',
    // Several strategies (multi-strategy agents, ticket 06, Q208): the normal
    // path, the same in every client; --name is for the README only.
    'When the user starts a new strategy, propose a dedicated Denaria agent on a new Account, then call connect with {"name": "<Agent name>"}; tell the user to choose "New account" on the phone (it may be already selected), where they can also set an initial capital.',
    "Write the Agent name and the key id in the strategy's notes, and read them when the user picks the strategy up again.",
    `Once this client has two or more agents, pass agent on every call, preferably the key id (${agentToolName({ name: 'denaria_list_agents' }, network)} lists them). When a call is refused with the list of agents, ask the user which one, never pick one.`,
    'Another client (Claude Code, Codex) uses an existing strategy with connect {"reuse": "<key id>"}, the key id from its notes, once the user approves it with their Passkey.',
    'Once connected, the account tools read the Grant, the positions, the open orders and the USDC of the account. Every answer states the network and when the Grant expires: tell the user before it does.',
    // Prudence (agent-trading Stage 2 Q69, ADR-0062 §17): the core of the
    // denaria-trading skill, for an agent that does not have it.
    "Before the first trade, explain the Grant's limits to the user, and start small.",
    'Tell the user the summary of every operation and follow it to its outcome.',
    // Ticket 19 (grill Q91, Q103): a pending order outlives the conversation.
    // A revoke cancels the orders Denaria's index attributes to the Grant and
    // GMX shows live, not one it does not know yet (ticket 25, Q120).
    "A limit or stop order waits for its price: tell the user it may execute after this conversation, after the Grant expires, or after a revoke unless the revoke cancels it (a revoke in the Denaria app cancels the agent's pending limit and stop orders that Denaria finds; tell the user to check Orders afterwards).",
    "In the Grant's markets GMX merges the user's own positions with the agent's: ask before changing a position you did not open.",
    `If the Signer does not install or stops answering, send the user to the app's guide: ${guideLinks(pwaOrigin)}.`,
  ].join(' ');
}

/** The `agent` connect, every account tool and every trade take
 *  (multi-strategy agents): a key id, or an Agent name. */
const agentInputSchema = z.string().trim().min(1).max(80);

const connectInput = z.object({
  name: agentNameSchema
    .optional()
    .describe(
      'The Agent name the user chose for a new agent of this client: at its first connect, after connect answered choose_agent, or later for one more agent, with its own key, Grant and Account (a new strategy). When an agent of this client whose Grant is not revoked already has that name (trimmed, any case), no agent is made: connect answers about that one, or, when two have it, refuses with the list. The user sees it in Denaria; it is renamed there, in the app. A Signer started with --name has one agent and takes no other name.',
    ),
  agent: agentInputSchema
    .optional()
    .describe(
      'Which agent of this client to check or link: its key id, or its Agent name (trimmed, any case, the latest name the user gave it in Denaria). Needed once this client has two or more agents; with one, it may be omitted.',
    ),
  reuse: z
    .string()
    .max(80)
    .optional()
    .describe(
      "The key id of a key already on this computer the user chose to reuse: from the list connect gave with choose_agent, or, for a client that has agents already, another client's agent (a strategy's notes give its key id), added as one more agent of this client. The user then approves it in the Denaria app with their Passkey; until then that agent reads and trades nothing, and this client's other agents go on. Refused by a Signer started with --name.",
    ),
  qr: z
    .enum(['window'])
    .optional()
    .describe(
      'window: also open the QR code in a window on this computer, for a client that shows neither the image nor the text QR code, or when the user cannot see it.',
    ),
});

const grantStates = ['active', 'expired', 'revoked', 'not_confirmed', 'unchecked'] as const;
type GrantState = (typeof grantStates)[number];

/** Where a key stands when the API refuses its Grant read; undefined for a
 *  refusal that says nothing about the Grant. */
const REFUSED_GRANT_STATES: Readonly<
  Record<string, Extract<GrantState, 'revoked' | 'expired' | 'not_confirmed'>>
> = {
  'AGENT_SIGNER.GRANT_REVOKED': 'revoked',
  'AGENT_SIGNER.GRANT_EXPIRED': 'expired',
  'AGENT_SIGNER.UNKNOWN_KEY': 'not_confirmed',
  'AGENT_SIGNER.GRANT_PENDING': 'not_confirmed',
};

const keyOnComputerSchema = z.object({
  keyId: z.string(),
  name: z.string().nullable(),
  fingerprint: z.string(),
  grant: z.enum(grantStates),
  expiresAt: z.string().optional(),
  /** Who uses it: `name:<--name>` or `client:<MCP client name>`. */
  usedBy: z.array(z.string()),
});

const connectOutput = z.object({
  /** `connected`: the Grant is live, no link. `confirm_on_phone`: open the
   *  link. `choose_agent`: ask the user for a name or a key to reuse. */
  status: z.enum(['connected', 'confirm_on_phone', 'choose_agent']),
  network: agentNetworkSchema,
  /** The Agent name of this agent's key (connected, confirm_on_phone). */
  name: z.string().nullable().optional(),
  keyId: z.string().optional(),
  /** The key's fingerprint, its stable name (`XXXX-XXXX`). */
  fingerprint: z.string().optional(),
  /** A connect link: the code the user compares on the phone, bound to a
   *  one-time value in the link (Q147). Absent for a renewal link, which
   *  shows the key's fingerprint. */
  connectionCode: z.string().optional(),
  /** Why a link is given: a first key, a key not confirmed yet, a new key after
   *  a revoked Grant, an expired Grant, Denaria could not be asked, or this
   *  agent reuses a key and the owner approves it by renewing its Grant. */
  reason: z
    .enum(['new_key', 'not_confirmed', 'rotated', 'expired', 'unchecked', 'reuse'])
    .optional(),
  link: z.string().optional(),
  /** qr window: where the image of the QR code was saved on this computer. */
  qrFile: z.string().optional(),
  /** qr window: whether the window opened. */
  qrWindow: z.enum(['opened', 'failed']).optional(),
  grant: agentGrantSchema.shape.grant.optional(),
  /** choose_agent: the name to propose, from the MCP client's own name. */
  proposedName: z.string().nullable().optional(),
  /** choose_agent: the keys already on this computer for this Env. */
  keys: z.array(keyOnComputerSchema).optional(),
});

type ConnectOutput = z.infer<typeof connectOutput>;

/** Which agent an account answer or an operation is about: its key id, its
 *  Agent name, the Account its Grant is on and that Account's label (`Main`
 *  for the Main account, else its Account title), each null when not known:
 *  an API from before the label does not give it (ticket 05). */
const agentRefSchema = z
  .object({
    keyId: z.string(),
    name: z.string().nullable(),
    account: z.string().nullable(),
    accountLabel: z.string().nullable(),
  })
  .strict();
type AgentRef = z.infer<typeof agentRefSchema>;

const agentRowGrants = [
  'active',
  'expired',
  'revoked',
  'not_confirmed',
  'approval_pending',
  'unknown',
] as const;
type AgentRowGrant = (typeof agentRowGrants)[number];

/** One agent of the caller, as the list tool and the refusals give it. */
const agentRowSchema = z
  .object({
    name: z.string().nullable(),
    keyId: z.string(),
    fingerprint: z.string().nullable(),
    /** The Account its Grant is on; null when not known. */
    account: z.string().nullable(),
    /** That Account's label, `Main` for the Main account; null when not known. */
    accountLabel: z.string().nullable(),
    grant: z.enum(agentRowGrants),
    /** When the Grant expires, for an active one. */
    expiresAt: z.string().nullable(),
  })
  .strict();
type AgentRow = z.infer<typeof agentRowSchema>;

const listAgentsOutput = z
  .object({ network: agentNetworkSchema, agents: z.array(agentRowSchema) })
  .strict();

const ROW_WORDS: Record<AgentRowGrant, string> = {
  active: 'Grant active',
  expired: 'Grant expired',
  revoked: 'Grant revoked',
  not_confirmed: 'not confirmed on the phone yet',
  approval_pending: 'its reuse waits for the owner to approve it with the Passkey',
  unknown: 'Grant state unknown (it could not be read now)',
};

function rowLine(row: AgentRow): string {
  const until =
    row.grant === 'active' && row.expiresAt !== null ? ` until ${shortInstant(row.expiresAt)}` : '';
  const fingerprint = row.fingerprint === null ? '' : `, fingerprint ${row.fingerprint}`;
  return `- ${row.name === null ? 'unnamed' : `"${row.name}"`} (key id ${row.keyId}${fingerprint}): account ${row.account === null ? 'unknown' : accountWords(row.account, row.accountLabel)}, ${ROW_WORDS[row.grant]}${until}.`;
}

const agentsText = (rows: readonly AgentRow[]) =>
  ['The agents of this client on this computer, oldest first:', ...rows.map(rowLine)].join('\n');

/** `"Gamble" (0x…)` with the Account's label, else the address alone. */
const accountWords = (account: string, label: string | null) =>
  label === null ? account : `"${label}" (${account})`;

/** "Agent: "Gamble" (key id …), account "Gamble" (0x…)." */
function agentLine(ref: AgentRef): string {
  const who = ref.name === null ? `key id ${ref.keyId}` : `"${ref.name}" (key id ${ref.keyId})`;
  return `Agent: ${who}${ref.account === null ? '' : `, account ${accountWords(ref.account, ref.accountLabel)}`}.`;
}

/** What this process knows of a key's Account: its address, and its label
 *  when the API gave one (ticket 05). */
type KnownAccount = { account: string; label: string | null };

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused or stripped
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
/** The Account an answer names. The label reaches the agent's text, so one
 *  with control characters is not shown: the address is enough. */
type AccountNamed = { account: string; accountLabel?: string | undefined };
function knownAccountOf(answer: AccountNamed): KnownAccount {
  const label = answer.accountLabel;
  return {
    account: answer.account,
    label: label === undefined || CONTROL_CHARACTER.test(label) ? null : label,
  };
}

/** Whether an agent's Agent name is `given`, both trimmed and in any case. */
const sameAgentName = (name: string | null, given: string) =>
  name !== null && nameKey(name) === nameKey(given);

// The same pattern, global, for `replace` only (`test` on a global regex
// moves its lastIndex).
const CONTROL_CHARACTERS = new RegExp(CONTROL_CHARACTER.source, 'g');
/** What the agent gave, quoted for an answer. */
const quoted = (given: string) => JSON.stringify(given.replace(CONTROL_CHARACTERS, ''));
type QrMode = z.infer<typeof connectInput>['qr'];

const joinLeads = (...leads: Array<string | null>): string | null => {
  const given = leads.filter((lead) => lead !== null);
  return given.length === 0 ? null : given.join('\n\n');
};
type LinkReason = NonNullable<ConnectOutput['reason']>;
type KeyOnComputer = z.infer<typeof keyOnComputerSchema>;

const RENEW_WHERE = 'Settings → Access & security → Agents';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "11 Nov, 10:00 UTC". */
function shortInstant(iso: string): string {
  const at = new Date(iso);
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}, ${hh}:${mm} UTC`;
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** "Connected. I can trade BTC and ETH, up to $50 per operation, max 3x,
 *  until 11 Nov, 10:00 UTC. No pending limit or stop orders, no margin
 *  withdrawal." Per operation: the size cap bounds the orders of one
 *  operation together (policy v4, review 2026-11-10 F4, grill Q104). */
export function restateGrant(grant: AgentGrant['grant']): string {
  const until = `until ${shortInstant(grant.expiresAt)}`;
  const limits = grant.limits;
  if (limits === null) return `Connected. I can trade within the limits you approved, ${until}.`;
  const markets =
    limits.markets === 'any'
      ? 'any market'
      : listOf(
          limits.markets.map(
            (market) => market.assetTicker ?? market.displayName ?? market.gmxMarketAddress,
          ),
        );
  const pending = limits.pendingIncreaseOrdersAllowed
    ? 'Pending limit and stop orders allowed'
    : 'No pending limit or stop orders';
  const margin = limits.marginWithdrawalAllowed
    ? 'margin withdrawal allowed'
    : 'no margin withdrawal';
  return `Connected. I can trade ${markets}, up to $${limits.maxOrderUsd.toLocaleString('en-US')} per operation, max ${limits.maxLeverage}x, ${until}. ${pending}, ${margin}.`;
}

type JsonObjectSchema = { type: 'object'; [key: string]: unknown };

function objectJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonObjectSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io });
  if (json.type !== 'object') throw new Error('Tool schemas must describe JSON objects');
  return json as JsonObjectSchema;
}

/** How the QR reaches the user: the text QR (and the image beside it), or a
 *  line saying where the window and the file are. */
type QrShown = { text: string; note: null } | { text: string | null; note: string };

function connectText(options: {
  network: AgentNetwork;
  link: string;
  /** What the user compares on the phone: the connect link's connection
   *  code, or the fingerprint of the key a renewal shows. */
  code: { kind: 'connection code' | 'fingerprint'; value: string };
  name: string | null;
  where: string;
  lead: string | null;
  qr: QrShown;
  /** `renew`: the owner approves a reused key by renewing its Grant. */
  approval: 'connect' | 'renew';
  /** The key id to name when calling connect again: given when the caller
   *  has several agents. */
  again: string | null;
}): string {
  const { network, link, code, name, where, lead, qr, approval, again } = options;
  const renew = approval === 'renew';
  return [
    network.notice,
    '',
    ...(lead === null ? [] : [lead, '']),
    renew
      ? `Denaria Agent Signer: approve this agent on the key of ${name === null ? 'this agent' : `"${name}"`}.`
      : 'Denaria Agent Signer: connect this agent to your Denaria account.',
    '',
    ...(name === null ? [] : [`Agent name: ${name}`]),
    `${code.kind === 'fingerprint' ? 'Fingerprint' : 'Connection code'}: ${code.value}`,
    `Link: ${link}`,
    '',
    ...(qr.note === null ? [] : [qr.note, '']),
    ...(qr.text === null
      ? []
      : [
          'The QR code of the link, also as the image of this answer; as text, for a terminal (in a code block, unchanged):',
          '',
          qr.text,
          '',
        ]),
    '1. Open the link on your phone, or scan the QR code. You can also open it in the Denaria desktop app, which asks your phone to confirm.',
    `2. Check that the code shown there is the same ${code.kind}: ${code.value}. If it is different, stop and do not confirm.`,
    renew
      ? '3. Check the limits: every agent that uses this key trades within them.'
      : '3. Choose the limits.',
    renew ? '4. Renew with your Passkey.' : '4. Confirm with your Passkey.',
    '',
    `After you ${renew ? 'approve' : 'confirm'} on your phone, call connect again${again === null ? '' : ` with {"agent": "${again}"}`}: it checks the Grant and says what this agent may do.`,
    '',
    `The private key stays on this computer, in ${where}. Denaria never sees it.`,
  ].join('\n');
}

const LEADS: Record<LinkReason, (detail: string | null) => string | null> = {
  new_key: () => null,
  reuse: () => null,
  not_confirmed: () =>
    'This agent is not connected yet: Denaria has no installed Grant of its key.',
  rotated: () =>
    'The Grant of the previous key was revoked, so this agent has a new key. Connect it again with this link.',
  expired: (detail) =>
    `${detail ?? 'The Grant of this key expired.'} Or open this link to grant the same key again.`,
  unchecked: (detail) =>
    `Could not reach Denaria to check the Grant of this key${detail ? ` (${detail})` : ''}. If you already confirmed it, call connect again later.`,
};

const GRANT_WORDS: Record<GrantState, string> = {
  active: 'Grant active',
  expired: 'Grant expired',
  revoked: 'Grant revoked (reusing it makes a new key)',
  not_confirmed: 'not confirmed on the phone yet',
  unchecked: 'Grant not checked (Denaria could not be reached)',
};

/** How a caller is named in the list: its `--name` or its MCP client. */
function callerWords(identity: string): string {
  if (identity.startsWith('name:')) return `--name "${identity.slice('name:'.length)}"`;
  return `the MCP client "${identity.slice('client:'.length)}"`;
}

function chooseText(options: {
  network: AgentNetwork;
  identity: string;
  proposedName: string | null;
  keys: readonly KeyOnComputer[];
  guide: string;
}): string {
  const { network, identity, proposedName, keys, guide } = options;
  const propose =
    proposedName === null ? 'ask for one' : `propose "${proposedName}", the client's own name`;
  return [
    network.notice,
    '',
    `This agent (${callerWords(identity)}) has no key of its own yet in the Denaria Agent Signer on this computer. Ask the user, before connecting:`,
    `- the name of this agent in Denaria (${propose}), then call connect again with {"name": "<the name>"} to make its own key;`,
    ...(keys.length === 0
      ? []
      : [
          '- or which key already on this computer to reuse, then call connect again with {"reuse": "<key id>"}.',
          '',
          `Keys already on this computer for ${network.env}:`,
          ...keys.map((key) => {
            const until =
              key.grant === 'active' && key.expiresAt
                ? ` until ${shortInstant(key.expiresAt)}`
                : '';
            const users =
              key.usedBy.length === 0
                ? 'used by no agent now'
                : `used by ${listOf(key.usedBy.map(callerWords))}`;
            return `- "${key.name ?? 'unnamed'}" (key id ${key.keyId}, fingerprint ${key.fingerprint}): ${GRANT_WORDS[key.grant]}${until}; ${users}.`;
          }),
          '',
          "A reused key shares that agent's Grant, limits, operations and revocation. The user approves the reuse in the Denaria app with their Passkey (connect gives the link): until then this agent reads and trades nothing, and the agents already using the key go on as before.",
        ]),
    'A new agent gets its own key and its own Grant, which the user confirms on the phone.',
    '',
    `If something does not work, the app's guide for this agent: ${guide}`,
  ].join('\n');
}

/**
 * The Denaria Agent Signer as an MCP server (ADR-0062 §2, §11, §18):
 * `connect`, which keeps this agent's Session key (one per Agent name on this
 * computer, asked at the agent's first connect) and either restates its live
 * Grant or returns the link that enrols it (a new key when the Grant was
 * revoked), the account reads of `AGENT_ACCOUNT_TOOLS` and the execution
 * tools, answered by the API under the Signer's login. Every answer starts
 * with the network notice.
 */
export function createSignerServer(options: {
  target: SignerTarget;
  store: KeyStore;
  index: AgentIndex;
  api: SignerApi;
  log: (line: string) => void;
  /** `--name`: the Agent name the MCP command gives this agent. */
  name?: string | null;
  /** `connect` with qr "window": saves the QR image and opens it (Q107). */
  qrWindow?: QrWindow;
  now?: () => number;
  /** How long a Signer that lost the claim of a rotation waits for the
   *  winner's key, how often it looks, and how old the winner's claim must be
   *  before it takes the rotation over (default 5 s, every 200 ms, 5 min). */
  rotationWait?: { timeoutMs: number; intervalMs: number; staleClaimMs?: number };
}): Server {
  const { target, store, api, log } = options;
  const rotationWait = { ...DEFAULT_ROTATION_WAIT, ...options.rotationWait };
  const commandName = options.name ?? null;
  const now = options.now ?? Date.now;
  const network = describeAgentNetwork({ env: target.env, chainId: target.chainId });
  const session = createAgentSession({ target, api, now });
  const keys = agentKeys({ env: target.env, store, index: options.index });
  const server = new Server(
    { name: SIGNER_NAME, version: SIGNER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: instructions(network, target.pwaOrigin),
    },
  );

  const clientName = () => server.getClientVersion()?.name;
  const identityOf = () =>
    commandName !== null ? `name:${commandName}` : `client:${clientIdentity(clientName())}`;

  /**
   * The caller's agents (multi-strategy agents), read from the index on
   * every call, never held for the life of the process, since other Signers
   * of this caller may add agents: none when the caller must choose at
   * connect. `inputName` names the 0.1.0 key when this call claims it
   * (`claimed`). A Signer started with `--name` has one agent, its first
   * (ticket 03, Q207): it knows no other, whatever the index holds.
   */
  const theAgents = async (inputName?: string) => {
    const found = await keys.agentsAndClaim(
      identityOf(),
      commandName ?? inputName ?? labelFromClient(clientName()),
    );
    return commandName === null ? found : { ...found, slots: found.slots.slice(0, 1) };
  };

  const listAgentsName = agentToolName({ name: 'denaria_list_agents' }, network);
  // What this process learnt of each key, in memory only: the Account its
  // Grant is on (a key's Grant stays on one Account) with its label as last
  // read (every account read refreshes it, so a rename in the app shows from
  // the next one), and that its Grant was revoked (a revoked key never gets a
  // Grant again: the list does not sign in with it).
  const accounts = new Map<string, KnownAccount>();
  const learnAccount = (key: SessionKey, answer: AccountNamed) => {
    const known = knownAccountOf(answer);
    accounts.set(publicKeyRefOf(key), known);
    return known;
  };
  // Every account read asks for the Account's label: an API from before it
  // ignores the ask (ticket 05).
  const accountRead = (key: SessionKey, procedure: string) =>
    session.read(key, procedure, AGENT_ACCOUNT_READ_WITH_LABEL);
  const revokedKeys = new Set<string>();

  // The reuse request of each of this caller's agents (ticket 20, Q102), read
  // once per slot: the entry of an identity for a slot never changes.
  // Approved once Denaria says a Grant of the key enrolled with the request's
  // reference was installed (review round 1 A2): the owner opened this
  // caller's link and approved it with the Passkey. Another renewal of the key
  // (the expiry push, Agents) approves no caller. The approval holds for the
  // key it was given for (ticket 25, Q109): the slot is read on every call,
  // and a key another process put there after a revoke is pending again, as
  // after a restart.
  type ReuseGate = { request: ReuseRequest; approvedFor: SessionKey['publicKey'] | null };
  const reuseGates = new Map<string, ReuseGate | null>();
  /** The reuse of the agent in `slot` still to approve for `key` (null: a
   *  key not loaded yet). */
  const pendingReuse = async (slot: string, key: SessionKey | null) => {
    let reuseGate = reuseGates.get(slot);
    if (reuseGate === undefined) {
      const request = await keys.reuseOf(identityOf(), slot);
      reuseGate = request === null ? null : { request, approvedFor: null };
      reuseGates.set(slot, reuseGate);
    }
    if (reuseGate === null) return null;
    const approved = reuseGate.approvedFor;
    const sameKey =
      key !== null &&
      approved !== null &&
      approved.x === key.publicKey.x &&
      approved.y === key.publicKey.y;
    return sameKey ? null : reuseGate;
  };
  const reuseApproved = async (key: SessionKey, request: ReuseRequest): Promise<boolean> =>
    answerOf(
      { output: agentReuseApprovalSchema },
      await session.read(key, AGENT_REUSE_APPROVAL_PROCEDURE, { reference: request.reference }),
    ).approved;
  /** What a link given to a caller whose reuse is pending carries: its
   *  reference, and its name for the screen to show. */
  const reuseOfLink = (request: ReuseRequest) => ({
    reference: request.reference,
    client: commandName ?? labelFromClient(clientName()),
  });
  const keyWords = async (slot: string) => {
    const name = await keys.nameOf(slot);
    return name === null ? `key ${slot}` : `key of "${name}" (key id ${slot})`;
  };
  /** A caller whose reuse of a key is not approved yet. */
  class ReusePending extends SignerError {}

  /** With several agents, only the one whose reuse waits is held up
   *  (ticket 04). */
  const othersGoOn = async () =>
    (await theAgents()).slots.length > 1
      ? " This client's other agents are not held up: they go on reading and trading."
      : '';
  const pendingLead = async (slot: string) =>
    `This agent asked to reuse the ${await keyWords(slot)}, which another agent on this computer made. The approval is pending: the owner approves this agent in the Denaria app with their Passkey, and until then it reads and trades nothing. The agents already using the key go on as before.${await othersGoOn()}`;

  // One connect at a time: two calls must not both find no key and make two.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  /** Who made the key in `slot`, from its item: a rotation never changes it,
   *  whoever rotates (Q109, Q123), so an index rebuilt from the store maps no
   *  reuser as the key's owner. Null when the item names no one (the 0.1.0
   *  key) or cannot be read; reuse roles are never in an item. */
  const creatorOf = async (slot: string): Promise<string | null> => {
    try {
      return (await store.list(target.env)).find((item) => item.slot === slot)?.identity ?? null;
    } catch {
      log(`connect: the item of ${slot} could not be read, so the new key names no creator`);
      return null;
    }
  };

  const metaOf = async (slot: string, identity: string | null): Promise<KeyItemMeta> => ({
    env: target.env,
    name: await keys.nameOf(slot),
    identity,
    createdAt: new Date(now()).toISOString(),
  });

  // The link goes out only for a key the store has durably kept: a link to a
  // key that is lost would make the phone grant an orphan.
  const readBack = async (slot: string, created: SessionKey): Promise<void> => {
    const saved = await store.load(slot);
    if (saved === null || !samePublicKey(SessionKey.fromSecret(saved), created)) {
      throw new SignerError(
        `The new key could not be read back from ${store.describe(slot)}, so no link was made. Try connect again.`,
      );
    }
  };

  const createKey = async (slot: string): Promise<SessionKey> => {
    const created = SessionKey.generate();
    try {
      await store.save(slot, created.exportSecret(), await metaOf(slot, identityOf()));
    } catch (error) {
      // Another Signer process of the same agent may have saved this slot's
      // key a moment before: that key is the one to link.
      const raced = await store.load(slot).catch(() => null);
      if (raced === null) throw error;
      log(`connect: another Signer saved the key in ${store.describe(slot)} first`);
      return SessionKey.fromSecret(raced);
    }
    await readBack(slot, created);
    log(`connect: created a ${target.env} key in ${store.describe(slot)}`);
    return created;
  };

  /** The key in `slot` once it is no longer `old`: null when the slot still
   *  holds `old` (or nothing) after the wait. */
  const keyAfter = async (slot: string, old: SessionKey): Promise<SessionKey | null> => {
    const polls = Math.max(1, Math.ceil(rotationWait.timeoutMs / rotationWait.intervalMs));
    for (let poll = 0; poll <= polls; poll++) {
      if (poll > 0) await sleep(rotationWait.intervalMs);
      const secret = await store.load(slot);
      if (secret === null) continue;
      const key = SessionKey.fromSecret(secret);
      if (!samePublicKey(key, old)) return key;
    }
    return null;
  };

  /**
   * Rotation after a revoked Grant (ADR-0062 §11), once per old key across
   * every Signer process on this computer (Q125). The `serialized` queue
   * orders this process's calls only: the store's claim, named after the key
   * this process loaded, lets one process write the new key; another that
   * found the same key revoked writes nothing and answers with the link of
   * the winner's key. A winner whose key does not appear within the wait may
   * still be writing it (Q135): this call answers without a link, and only a
   * claim older than `staleClaimMs` (its Signer stopped half-way) is taken
   * over by the next claim.
   */
  const rotateKey = async (slot: string, revoked: SessionKey): Promise<SessionKey> => {
    const from = await agentKeyFingerprint(revoked.publicKey);
    const meta = await metaOf(slot, await creatorOf(slot));
    for (let attempt = 0; attempt < MAX_ROTATION_ATTEMPTS; attempt++) {
      const created = SessionKey.generate();
      if (await store.replace(slot, { from, attempt }, created.exportSecret(), meta)) {
        await readBack(slot, created);
        log(`connect: rotated to a ${target.env} key in ${store.describe(slot)}`);
        return created;
      }
      log(`connect: another Signer is rotating the key in ${store.describe(slot)}`);
      const winner = await keyAfter(slot, revoked);
      if (winner !== null) {
        log(`connect: another Signer rotated the key in ${store.describe(slot)} first`);
        return winner;
      }
      const claimedAt = await store.rotationClaimedAt(slot, { from, attempt });
      if (claimedAt === null || now() - claimedAt < rotationWait.staleClaimMs) {
        throw new SignerError(
          `Another Denaria Agent Signer on this computer is rotating the revoked key in ${store.describe(slot)}, and has not written the new key yet (its keyring may be waiting to be unlocked). Nothing was changed. Call connect again in a minute: it answers with the new key's link.`,
        );
      }
      log(`connect: the other Signer did not finish rotating ${slot}; this one takes it over`);
    }
    throw new SignerError(
      `The revoked key in ${store.describe(slot)} could not be rotated: ${MAX_ROTATION_ATTEMPTS} Signers claimed its rotation and none finished it. Remove the files ${slot}.*.replaced-${from}* in the Denaria Agent Signer's folder, then call connect again.`,
    );
  };

  const failure = (message: string): CallToolResult => ({
    isError: true,
    content: [{ type: 'text', text: `${network.notice}\n\n${message}` }],
  });

  const report = (what: string, error: unknown): CallToolResult => {
    // Only a SignerError is written for the user; any other message could
    // carry anything, so it stays out of the answer and the log.
    log(
      `${what} failed: ${error instanceof SignerError ? error.message : `unexpected ${error instanceof Error ? error.name : typeof error}`}`,
    );
    return failure(
      error instanceof SignerError
        ? error.message
        : `The Denaria Agent Signer hit an unexpected error (${what}). Try again.`,
    );
  };

  /** The agent `given` names among the caller's agents (multi-strategy
   *  agents, Q209, Q210): its key id exactly, else its Agent name, trimmed and
   *  in any case, against the latest name Denaria gave each, matching one.
   *  With one agent `given` may be missing; with several it may not. Refused
   *  with the list, before anything of the call is sent. */
  const resolveAgent = async (given: string | undefined, slots: string[]): Promise<string> => {
    if (commandName !== null) return resolvePinned(given, slots);
    if (given === undefined) {
      const [only] = slots;
      if (slots.length === 1 && only !== undefined) return only;
      throw await choiceRefusal(
        `This client has ${slots.length} Denaria agents, so the call must say which one acts, with agent: its key id or its Agent name. Nothing was sent. Ask the user which agent this is for (never pick one), then call again with {"agent": "<key id>"}.`,
      );
    }
    if (slots.includes(given)) return given;
    const named = (await keys.described(slots)).filter((agent) => sameAgentName(agent.name, given));
    const [match] = named;
    if (named.length === 1 && match !== undefined) return match.slot;
    throw await choiceRefusal(
      named.length === 0
        ? `No agent of this client has the key id or the Agent name ${quoted(given)}. Nothing was sent. Ask the user which agent this is for, then call again with its key id in agent.`
        : `${named.length} agents of this client have the Agent name ${quoted(given)}. Nothing was sent. Ask the user which one this is for, then call again with its key id in agent.`,
    );
  };

  /** A refusal of a Signer started with `--name` (ticket 03, Q207): it acts
   *  for that one agent and for no other, so a session wired to it cannot
   *  reach another strategy. It reads nothing from Denaria. */
  const pinnedRefusal = (why: string, slot: string | undefined): SignerError =>
    new SignerError(
      `This Denaria Agent Signer was started for one agent, ${quoted(commandName ?? '')}${slot === undefined ? '' : ` (key id ${slot})`}, and acts for no other: ${why} Another agent acts through the Agent signer started for it (with its own --name), or through one started without --name. Ask the user which agent this is for, and never act as another.`,
    );

  /** Whether `given` names the agent of a `--name` Signer: its key id, its
   *  Agent name (the latest Denaria gave it) or the `--name` itself, the
   *  names trimmed and in any case. */
  const namesPinned = async (given: string, slot: string | undefined): Promise<boolean> => {
    if (commandName !== null && nameKey(given) === nameKey(commandName)) return true;
    if (slot === undefined) return false;
    if (given === slot) return true;
    const name = (await keys.described([slot]))[0]?.name ?? null;
    return sameAgentName(name, given);
  };

  const resolvePinned = async (given: string | undefined, slots: string[]): Promise<string> => {
    const [only] = slots;
    if (only === undefined) {
      throw new SignerError(
        'This agent is not connected to Denaria yet: call connect first, then confirm on the phone.',
      );
    }
    if (given === undefined || (await namesPinned(given, only))) return only;
    throw pinnedRefusal(`${quoted(given)} is not that agent. Nothing was sent.`, only);
  };

  /** Where an agent stands, for the list: the Grant is read only for an
   *  agent whose Grant may be live (not one this process saw revoked, not a
   *  reuse waiting for its approval), and a read that fails says unknown. */
  const rowOf = async (agent: { slot: string; name: string | null }): Promise<AgentRow> => {
    const { slot } = agent;
    let key: SessionKey | null = null;
    try {
      const secret = await store.load(slot);
      key = secret === null ? null : SessionKey.fromSecret(secret);
    } catch {
      key = null;
    }
    const base = { keyId: slot, name: agent.name, expiresAt: null };
    if (key === null) {
      return { ...base, fingerprint: null, account: null, accountLabel: null, grant: 'unknown' };
    }
    const id = publicKeyRefOf(key);
    const cached = accounts.get(id);
    const known = {
      ...base,
      fingerprint: await agentKeyFingerprint(key.publicKey),
      account: cached?.account ?? null,
      accountLabel: cached?.label ?? null,
    };
    if (revokedKeys.has(id)) return { ...known, grant: 'revoked' };
    try {
      await admitReuse(slot, key);
      const answer = await grantRead(slot, key);
      const read = knownAccountOf(answer);
      return {
        ...known,
        name: (await keys.nameOf(slot)) ?? agent.name,
        account: read.account,
        accountLabel: read.label,
        grant: 'active',
        expiresAt: answer.grant.expiresAt,
      };
    } catch (error) {
      if (error instanceof ReusePending) return { ...known, grant: 'approval_pending' };
      const refused = error instanceof ApiRefusal ? REFUSED_GRANT_STATES[error.code] : undefined;
      if (refused === 'revoked') revokedKeys.add(id);
      return { ...known, grant: refused ?? 'unknown' };
    }
  };

  const rowsOf = async (agents: ReadonlyArray<{ slot: string; name: string | null }>) => {
    const rows: AgentRow[] = [];
    for (const agent of agents) rows.push(await rowOf(agent));
    return rows;
  };

  /** A refusal that lists the caller's agents, so the agent asks the user. */
  const choiceRefusal = async (why: string): Promise<SignerError> => {
    const { slots } = await theAgents();
    const rows = await rowsOf(await keys.described(slots));
    return new SignerError(`${why}\n\n${agentsText(rows)}`);
  };

  /** The `agent` of a tool call, and the rest of its input. */
  const splitAgent = (
    args: unknown,
  ): { agent: string | undefined; rest: Record<string, unknown> } => {
    const { agent, ...rest } = (args ?? {}) as Record<string, unknown>;
    if (agent === undefined) return { agent: undefined, rest };
    const parsed = agentInputSchema.safeParse(agent);
    if (!parsed.success) {
      throw new SignerError(
        `agent must be the key id or the Agent name of one of this client's agents, 1 to 80 characters (${listAgentsName} lists them). Nothing was sent.`,
      );
    }
    return { agent: parsed.data, rest };
  };

  const stored = async (given?: string): Promise<{ slot: string; key: SessionKey }> => {
    const { slots } = await theAgents();
    const slot = slots.length === 0 ? null : await resolveAgent(given, slots);
    const secret = slot === null ? null : await store.load(slot);
    if (slot === null || secret === null) {
      throw new SignerError(
        'This agent is not connected to Denaria yet: call connect first, then confirm on the phone.',
      );
    }
    const key = SessionKey.fromSecret(secret);
    await admitReuse(slot, key);
    return { slot, key };
  };

  /** A caller that reused a key does nothing before the owner approved it. */
  const admitReuse = async (slot: string, key: SessionKey): Promise<void> => {
    const gate = await pendingReuse(slot, key);
    if (gate === null) return;
    if (gate.approvedFor !== null) {
      log(`the key in ${slot} changed: this agent's reuse waits for the owner's approval again`);
      gate.approvedFor = null;
    }
    const pending = async () => {
      const others = await othersGoOn();
      const connectCall = others === '' ? 'connect' : `connect with {"agent": "${slot}"}`;
      return new ReusePending(
        `The approval of this agent is pending: it asked to reuse the ${await keyWords(slot)}, and the owner has not approved it yet in the Denaria app with their Passkey. Until then this agent reads and trades nothing, so nothing was sent. Call ${connectCall} for the link and the QR code that approve it.${others}`,
      );
    };
    let approved: boolean;
    try {
      approved = await reuseApproved(key, gate.request);
    } catch (error) {
      if (error instanceof ApiRefusal) throw await pending();
      throw error;
    }
    if (!approved) throw await pending();
    gate.approvedFor = key.publicKey;
    log(`the owner approved this agent's reuse of ${slot}`);
  };

  /** The API answer as the tool's shape, for this Signer's network only. */
  const answerOf = <S extends z.ZodType>(tool: { output: S }, data: unknown): z.infer<S> => {
    const parsed = tool.output.safeParse(data);
    if (!parsed.success) {
      throw new SignerError('The Denaria API answered in a shape this Signer does not know.');
    }
    const stamp = (parsed.data as { network: AgentNetwork }).network;
    if (
      stamp.env !== network.env ||
      stamp.chainId !== network.chainId ||
      stamp.network !== network.network
    ) {
      throw new SignerError(
        `The Denaria API answered for ${stamp.env} (${stamp.chainId}), not for ${network.env} (${network.chainId}). Nothing was shown.`,
      );
    }
    return parsed.data;
  };

  /** The server is the source of the Agent name (Q86): a Grant read whose
   *  label differs updates the index, never the store item. The label is held
   *  to the same rule as a name the user gives: it reaches the link and the
   *  agent's text. */
  const followName = async (slot: string, grant: AgentGrant['grant']): Promise<void> => {
    if (grant.label === null) return;
    const parsed = agentNameSchema.safeParse(grant.label);
    if (!parsed.success) {
      log(
        `the Agent name Denaria has for ${slot} is not a valid Agent name; the local one is kept`,
      );
      return;
    }
    const label = parsed.data;
    try {
      if ((await keys.nameOf(slot)) === label) return;
      await keys.rename(slot, label);
      log(`the Agent name of ${slot} is now the one Denaria has`);
    } catch {
      log(`the Agent name of ${slot} could not be updated in the local index`);
    }
  };

  /** This key's Grant, with the name and the Account it gives. */
  const grantRead = async (slot: string, key: SessionKey): Promise<AgentGrant> => {
    const grant = answerOf(denariaGetGrant, await accountRead(key, denariaGetGrant.api.procedure));
    learnAccount(key, grant);
    await followName(slot, grant.grant);
    return grant;
  };

  /** This key's Grant, read after a fresh login. */
  const readGrant = async (slot: string, key: SessionKey): Promise<AgentGrant> => {
    await session.login(key);
    return grantRead(slot, key);
  };

  /** The Account of this key's Grant, with its label: as known, else read;
   *  null when it cannot be read. */
  const accountOf = async (key: SessionKey): Promise<KnownAccount | null> => {
    const known = accounts.get(publicKeyRefOf(key));
    if (known !== undefined) return known;
    try {
      return learnAccount(
        key,
        answerOf(denariaGetGrant, await accountRead(key, denariaGetGrant.api.procedure)),
      );
    } catch {
      return null;
    }
  };

  const agentRef = async (slot: string, account: KnownAccount | null): Promise<AgentRef> => ({
    keyId: slot,
    name: await keys.nameOf(slot),
    account: account?.account ?? null,
    accountLabel: account?.label ?? null,
  });

  /** The QR of a link (Q107), made here and never sent anywhere: the image
   *  and the text QR, or with qr "window" the image opened on this computer. */
  const showQr = async (slot: string, link: string, qr: QrMode) => {
    const png = qrPng(link);
    const image = {
      type: 'image' as const,
      data: Buffer.from(png).toString('base64'),
      mimeType: 'image/png',
    };
    if (qr !== 'window') {
      return { image, shown: { text: terminalQr(link), note: null } satisfies QrShown, output: {} };
    }
    const shown = options.qrWindow
      ? await options.qrWindow(slot, png)
      : { opened: false as const, path: null, why: 'this Signer cannot open windows here' };
    if (shown.opened) {
      log('connect: the QR code is open in a window');
      return {
        image: null,
        shown: {
          text: null,
          note: `The QR code is open in a window on this computer: ask the user to scan it there. The image is ${shown.path}.`,
        } satisfies QrShown,
        output: { qrFile: shown.path, qrWindow: 'opened' as const },
      };
    }
    log('connect: the QR code window did not open');
    return {
      image,
      shown: {
        text: terminalQr(link),
        note: `The QR code could not be opened in a window: ${shown.why}.${shown.path === null ? '' : ` The image is ${shown.path}: the user can open it.`}`,
      } satisfies QrShown,
      output: {
        ...(shown.path === null ? {} : { qrFile: shown.path }),
        qrWindow: 'failed' as const,
      },
    };
  };

  const linkAnswer = async (
    slot: string,
    key: SessionKey,
    reason: LinkReason,
    lead: string | null,
    detail: string | null,
    qr: QrMode,
    /** reuse: the live Grant whose renewal approves this agent. */
    renews?: string,
  ): Promise<CallToolResult> => {
    const name = await keys.nameOf(slot);
    const gate = await pendingReuse(slot, key);
    const reuse = gate === null ? undefined : reuseOfLink(gate.request);
    // A connect link draws its own one-time value, so its code is new with
    // every link (Q147); a renewal shows the key of the user's Grant, named
    // by its fingerprint.
    let link: string;
    let connectionCode: string | null = null;
    if (renews === undefined) {
      const nonce = agentConnectNonce();
      link = agentConnectUrl(target.pwaOrigin, {
        publicKey: key.publicKey,
        chainId: network.chainId,
        label: name,
        nonce,
        ...(reuse === undefined ? {} : { reuse }),
      });
      connectionCode = await agentConnectCode(key.publicKey, nonce);
    } else {
      link = agentRenewUrl(target.pwaOrigin, renews, reuse);
    }
    const fingerprint = await agentKeyFingerprint(key.publicKey);
    const where = store.describe(slot);
    const several = (await theAgents()).slots.length > 1;
    const { image, shown, output: qrOutput } = await showQr(slot, link, qr);
    const output: ConnectOutput = {
      status: 'confirm_on_phone',
      network,
      name,
      keyId: slot,
      fingerprint,
      ...(connectionCode === null ? {} : { connectionCode }),
      reason,
      link,
      ...qrOutput,
    };
    const leads = [lead, LEADS[reason](detail)].filter((line) => line !== null).join('\n\n');
    const text = connectText({
      network,
      link,
      code:
        connectionCode === null
          ? { kind: 'fingerprint', value: fingerprint }
          : { kind: 'connection code', value: connectionCode },
      name,
      where,
      lead: leads === '' ? null : leads,
      qr: shown,
      approval: renews === undefined ? 'connect' : 'renew',
      again: several ? slot : null,
    });
    return {
      content: [...(image === null ? [] : [image]), { type: 'text', text }],
      structuredContent: output,
    };
  };

  /** Today's connect for a key slot: restate a live Grant, link otherwise,
   *  rotate within the slot after a revocation. */
  const connectSlot = async (
    slot: string,
    given: string | null,
    qr: QrMode,
  ): Promise<CallToolResult> => {
    const existing = await store.load(slot);
    const key = existing === null ? null : SessionKey.fromSecret(existing);
    const gate = await pendingReuse(slot, key);
    let lead = gate === null ? given : joinLeads(given, await pendingLead(slot));
    if (key === null) {
      return linkAnswer(slot, await createKey(slot), 'new_key', lead, null, qr);
    }
    log(`connect: checking the ${target.env} key kept in ${store.describe(slot)}`);
    try {
      const grant = await readGrant(slot, key);
      if (gate !== null) {
        if (!(await reuseApproved(key, gate.request))) {
          return linkAnswer(slot, key, 'reuse', lead, null, qr, grant.grant.permissionId);
        }
        gate.approvedFor = key.publicKey;
        lead = joinLeads(
          given,
          `Approved: this agent now uses the ${await keyWords(slot)}, with the same Grant as the other agents that use it.`,
        );
      }
      const fingerprint = await agentKeyFingerprint(key.publicKey);
      const name = await keys.nameOf(slot);
      const output: ConnectOutput = {
        status: 'connected',
        network,
        name,
        keyId: slot,
        fingerprint,
        grant: grant.grant,
      };
      const text = [
        network.notice,
        '',
        ...(lead === null ? [] : [lead, '']),
        restateGrant(grant.grant),
        '',
        `${name === null ? '' : `Agent name: ${name}. `}Key fingerprint: ${fingerprint}. The user manages, renames or revokes this agent in the Denaria app: ${RENEW_WHERE}.`,
      ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: output };
    } catch (error) {
      if (error instanceof ApiRefusal) {
        switch (REFUSED_GRANT_STATES[error.code]) {
          case 'revoked': {
            // Rotation is "revoke and reconnect" (spec, Agent signer): the
            // revoked key never signs again, a new key gets a new Grant, in
            // the same slot and with the same Agent name.
            revokedKeys.add(publicKeyRefOf(key));
            const fresh = await rotateKey(slot, key);
            session.forget(key);
            return linkAnswer(slot, fresh, 'rotated', lead, null, qr);
          }
          case 'expired':
            return linkAnswer(slot, key, 'expired', lead, error.message, qr);
          case 'not_confirmed':
            return linkAnswer(slot, key, 'not_confirmed', lead, null, qr);
        }
        throw error;
      }
      if (error instanceof ApiUnreachable) {
        return linkAnswer(slot, key, 'unchecked', lead, error.message, qr);
      }
      throw error;
    }
  };

  /** Where a key on this computer stands, for the reuse list. */
  const grantStateOf = async (
    slot: string,
    key: SessionKey,
  ): Promise<{ grant: GrantState; expiresAt?: string }> => {
    try {
      const grant = await readGrant(slot, key);
      return { grant: 'active', expiresAt: grant.grant.expiresAt };
    } catch (error) {
      const refused = error instanceof ApiRefusal ? REFUSED_GRANT_STATES[error.code] : undefined;
      return { grant: refused ?? 'unchecked' };
    }
  };

  const chooseAgent = async (): Promise<CallToolResult> => {
    const listed: KeyOnComputer[] = [];
    for (const entry of await keys.onComputer()) {
      // A key that does not open now is left out of the list, not a failure.
      const secret = await store.load(entry.slot).catch(() => null);
      if (secret === null) continue;
      let key: SessionKey;
      try {
        key = SessionKey.fromSecret(secret);
      } catch {
        continue;
      }
      const state = await grantStateOf(entry.slot, key);
      listed.push({
        keyId: entry.slot,
        name: await keys.nameOf(entry.slot),
        fingerprint: await agentKeyFingerprint(key.publicKey),
        ...state,
        usedBy: entry.usedBy,
      });
    }
    const proposedName = labelFromClient(clientName());
    const output: ConnectOutput = { status: 'choose_agent', network, proposedName, keys: listed };
    const text = chooseText({
      network,
      identity: identityOf(),
      proposedName,
      keys: listed,
      guide: agentSetupUrl(target.pwaOrigin, guideClient(clientName())),
    });
    log(`connect: a new agent, ${listed.length} key(s) on this computer offered for reuse`);
    return { content: [{ type: 'text', text }], structuredContent: output };
  };

  /** Checks that the key a caller with agents asks to add is on this
   *  computer, else refuses with the other keys on it, none of the caller's
   *  own (ticket 04). */
  const checkKeyToAdd = async (slot: string, among: readonly string[]): Promise<void> => {
    const onComputer = await keys.onComputer();
    if (onComputer.some((key) => key.slot === slot)) return;
    const others = onComputer.filter((key) => !among.includes(key.slot));
    throw new SignerError(
      [
        `There is no key ${quoted(slot)} on this computer for ${target.env}, so nothing was added. Call connect again with {"reuse": "<key id>"} and the key id of another agent's key, or with {"name": "<Agent name>"} for a new agent with a key of its own.`,
        '',
        ...(others.length === 0
          ? ['No other agent has a key on this computer.']
          : [
              'The keys of other agents on this computer:',
              ...others.map((key) => {
                const users =
                  key.usedBy.length === 0
                    ? 'used by no agent now'
                    : `used by ${listOf(key.usedBy.map(callerWords))}`;
                return `- ${key.name === null ? 'unnamed' : `"${key.name}"`} (key id ${key.slot}): ${users}.`;
              }),
            ]),
      ].join('\n'),
    );
  };

  /** A reused key joins a caller's agents only under a name none of its live
   *  agents has (trimmed, any case): a name means one agent of a client. The
   *  user renames in the app, never the Signer. */
  const refuseNameInUse = async (slot: string, among: readonly string[]): Promise<void> => {
    const name = await keys.nameOf(slot);
    if (name === null) return;
    const same = (await keys.described(among)).filter((agent) => sameAgentName(agent.name, name));
    const live = (await rowsOf(same)).filter((row) => row.grant !== 'revoked');
    const [taken] = live;
    if (taken === undefined) return;
    throw new SignerError(
      `The key ${slot} is the agent ${quoted(name)}, and this client already has an agent named ${quoted(taken.name ?? name)} (key id ${taken.keyId}), so the key was not added: two agents of one client never share a name. Ask the user to rename one of them in the Denaria app (${RENEW_WHERE}), then call connect again with {"reuse": "${slot}"}.`,
    );
  };

  /**
   * A caller taking a key another agent made (ticket 20, Q102, scan P-08): it
   * never inherits the key's live Grant. The request is recorded with a
   * one-time reference, and the answer is the renewal of the key's Grant (QR,
   * link, fingerprint), the link carrying the reference and this caller's
   * name: the Grant the owner enrols from it, with the Passkey, approves this
   * agent and no other (review round 1 A2). A key with no live Grant
   * (expired, revoked, never installed) gets the usual link, carrying the
   * reference too. A Grant written at sponsorship but not confirmed yet, or a
   * Grant Denaria cannot be asked about, is not reused now.
   *
   * A caller that has agents already (`among`) keeps them: the key is added
   * as one more agent, its request on that agent's entry (multi-strategy
   * agents, ticket 04, Q211), so only that agent waits for the approval. Its
   * Agent name must not be the name of one of the caller's live agents.
   */
  const reuseKey = async (
    identity: string,
    slot: string,
    qr: QrMode,
    among: readonly string[] = [],
  ): Promise<CallToolResult> => {
    if (among.length === 0) await keys.find(slot);
    else await checkKeyToAdd(slot, among);
    const secret = await store.load(slot);
    if (secret === null) {
      throw new SignerError(
        `The key ${slot} does not open on this computer now. Call connect again with another key id it lists, or with a name for a new agent.`,
      );
    }
    const key = SessionKey.fromSecret(secret);
    let live: AgentGrant['grant'] | null = null;
    try {
      live = (await readGrant(slot, key)).grant;
    } catch (error) {
      if (error instanceof ApiRefusal && error.code === 'AGENT_SIGNER.GRANT_PENDING') {
        throw new SignerError(
          `The ${await keyWords(slot)} has a Grant that is not confirmed yet, so it cannot be reused now. Once the agent that made it is connected, call connect again with {"reuse": "${slot}"}; or give this agent its own key, with a name.`,
        );
      }
      if (error instanceof ApiUnreachable) {
        throw new SignerError(
          `Could not reach Denaria to check the Grant of the ${await keyWords(slot)}, so this agent did not take it (${error.message}). Call connect again with {"reuse": "${slot}"} later.`,
        );
      }
      if (!(error instanceof ApiRefusal) || REFUSED_GRANT_STATES[error.code] === undefined) {
        throw error;
      }
    }
    const request = {
      requestedAt: new Date(now()).toISOString(),
      reference: randomBytes(16).toString('base64url'),
    };
    let mapped = slot;
    if (among.length === 0) {
      mapped = await keys.reuse(identity, slot, request);
    } else {
      await refuseNameInUse(slot, among);
      await keys.reuseAsAgent(identity, slot, request);
    }
    // Another Signer of this caller may have mapped it first: its entry holds.
    reuseGates.delete(mapped);
    log(
      `connect: this agent asks to reuse the key in ${store.describe(mapped)}; the owner approves it with the Passkey`,
    );
    if (mapped !== slot || live === null) return connectSlot(mapped, null, qr);
    return linkAnswer(slot, key, 'reuse', await pendingLead(slot), null, qr, live.permissionId);
  };

  /**
   * `connect` of a Signer started with `--name` (ticket 03, Q207): its one
   * agent, made at its first connect as before, and no other. Another name,
   * another agent or any reuse is refused; its own name or key id answers
   * about its agent, as a connect without arguments does.
   */
  const connectPinned = async (
    pinnedName: string,
    identity: string,
    slot: string | undefined,
    input: z.infer<typeof connectInput>,
  ): Promise<CallToolResult> => {
    const { name, agent, reuse, qr } = input;
    if (reuse !== undefined) {
      throw pinnedRefusal(
        `it reuses no key (${quoted(reuse)} was asked), so nothing was changed.`,
        slot,
      );
    }
    if (name !== undefined && !(await namesPinned(name, slot))) {
      throw pinnedRefusal(`${quoted(name)} is not its name, so no agent was made.`, slot);
    }
    if (agent !== undefined && !(await namesPinned(agent, slot))) {
      throw pinnedRefusal(`${quoted(agent)} is not that agent. Nothing was sent.`, slot);
    }
    if (slot !== undefined) return connectSlot(slot, null, qr);
    if (agent !== undefined) {
      throw new SignerError(
        `This agent has no key on this computer yet, so none is ${quoted(agent)}. Call connect without agent: it makes this agent's key.`,
      );
    }
    const made = await keys.create(identity, pinnedName, new Date(now()).toISOString());
    return connectSlot(made, null, qr);
  };

  const connect = async (args: unknown): Promise<CallToolResult> => {
    // Clients may send no arguments at all for a tool without required ones.
    const input = connectInput.safeParse(args ?? {});
    if (!input.success) {
      return failure(
        `The name must be 1 to ${AGENT_LABEL_MAX_LENGTH} characters, with no control characters, reuse a key id connect listed, and agent the key id or Agent name of one of this client's agents (1 to 80 characters). Call connect again with a valid name, or without one.`,
      );
    }
    const { name, reuse, agent, qr } = input.data;
    if (name !== undefined && reuse !== undefined) {
      return failure(
        'Give either a name for a new agent or the key id to reuse, not both. Call connect again with one of them.',
      );
    }
    if (agent !== undefined && (name !== undefined || reuse !== undefined)) {
      return failure(
        'Give agent to check one of the agents of this client, or a name for a new agent, or the key id to reuse, not two of them. Call connect again with one of them.',
      );
    }
    try {
      return await serialized(async () => {
        store.ready?.();
        const identity = identityOf();
        const { slots, claimed } = await theAgents(name);
        const [first] = slots;
        if (commandName !== null) return connectPinned(commandName, identity, first, input.data);
        if (first === undefined) {
          if (agent !== undefined) {
            throw new SignerError(
              `This client has no Denaria agent on this computer yet, so none is ${quoted(agent)}. Call connect without agent: it asks for this agent's name.`,
            );
          }
          if (reuse !== undefined) return reuseKey(identity, reuse, qr);
          if (name === undefined) return chooseAgent();
          const slot = await keys.create(identity, name, new Date(now()).toISOString());
          return connectSlot(slot, null, qr);
        }
        // This call took the 0.1.0 key: it is this caller's first connect.
        if (claimed && agent === undefined && reuse === undefined) {
          return connectSlot(first, null, qr);
        }
        if (agent !== undefined) return connectSlot(await resolveAgent(agent, slots), null, qr);
        if (name !== undefined) return newAgent(identity, name, slots, qr);
        if (reuse !== undefined) {
          if (!slots.includes(reuse)) return reuseKey(identity, reuse, qr, slots);
          return connectSlot(
            reuse,
            `This client already has the key id ${reuse} among its agents, so nothing was added: this is that agent.`,
            qr,
          );
        }
        if (slots.length > 1) {
          throw await choiceRefusal(
            `This client has ${slots.length} Denaria agents. Call connect with {"agent": "<key id>"} for the one to check or link (ask the user which, never pick one), or with {"name": "<Agent name>"} for one more agent. Nothing was changed.`,
          );
        }
        return connectSlot(first, null, qr);
      });
    } catch (error) {
      return report('connect', error);
    }
  };

  /**
   * `connect` with a name, for a caller that has agents (multi-strategy
   * agents, ticket 02). A name means one agent: when one live agent of the
   * caller has it (trimmed, any case; live unless its Grant was revoked, and
   * one whose Grant cannot be read counts as live), the answer is that
   * agent's, as with `agent`, so a resent connect makes nothing new; two or
   * more is refused with the list. Otherwise one more agent: a new key in a
   * new slot, the name claimed in the index first, so of two Signers of this
   * caller making it at once one makes it and the other answers about it.
   */
  const newAgent = async (
    identity: string,
    name: string,
    slots: readonly string[],
    qr: QrMode,
  ): Promise<CallToolResult> => {
    /** The caller's agents with this name, and the live ones among them. */
    const named = async (among: readonly string[]) => {
      const same = (await keys.described(among)).filter((agent) => sameAgentName(agent.name, name));
      const rows = await rowsOf(same);
      return { same, live: rows.filter((row) => row.grant !== 'revoked') };
    };
    const existing = (keyId: string) =>
      connectSlot(
        keyId,
        `This client already has an agent named ${quoted(name)} (key id ${keyId}), so no new agent was made: this is that agent.`,
        qr,
      );
    const ambiguous = () =>
      choiceRefusal(
        `${quoted(name)} is the Agent name of several agents of this client, so no new agent was made. Call connect with {"agent": "<key id>"} for the one to check or link (ask the user which); for a new agent, ask the user for another name.`,
      );
    const { same, live } = await named(slots);
    const [one] = live;
    if (live.length > 1) throw await ambiguous();
    if (one !== undefined) return existing(one.keyId);
    const slot = await keys.addAgent(
      identity,
      name,
      same.map((agent) => agent.slot),
      new Date(now()).toISOString(),
    );
    if (slot !== null) {
      log(`connect: one more agent of this client, in ${store.describe(slot)}`);
      return connectSlot(slot, null, qr);
    }
    // Another Signer of this caller holds the claim: its agent is in the
    // index a moment later (a few small file writes).
    const polls = Math.max(1, Math.ceil(rotationWait.timeoutMs / rotationWait.intervalMs));
    for (let poll = 0; poll <= polls; poll++) {
      if (poll > 0) await sleep(rotationWait.intervalMs);
      const current = await named((await theAgents()).slots);
      const [winner] = current.live;
      if (current.live.length > 1) throw await ambiguous();
      if (winner !== undefined) return existing(winner.keyId);
    }
    throw await choiceRefusal(
      `Another Denaria Agent Signer of this client is making an agent named ${quoted(name)} and has not finished, so no new agent was made. Call connect again in a moment, with {"name": ${quoted(name)}}.`,
    );
  };

  const readTool = async (tool: AgentAccountTool, args: unknown): Promise<CallToolResult> => {
    try {
      const { slot, key } = await stored(splitAgent(args).agent);
      // Every account answer has these (agent-schemas account.ts).
      const output = tool.output as z.ZodType<{
        network: AgentNetwork;
        account: string;
        accountLabel?: string | undefined;
        grant: { expiresAt: string };
      }>;
      const answer = answerOf({ output }, await accountRead(key, tool.api.procedure));
      const account = learnAccount(key, answer);
      if (tool === denariaGetGrant) await followName(slot, (answer as AgentGrant).grant);
      const structured = { ...answer, agent: await agentRef(slot, account) };
      const text = [
        network.notice,
        '',
        agentLine(structured.agent),
        `The Grant expires at ${answer.grant.expiresAt}.`,
        '',
        JSON.stringify(structured, null, 2),
      ].join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: structured as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return report(agentToolName(tool, network), error);
    }
  };

  const stepOf = (data: unknown): AgentOperationStep => {
    const parsed = agentOperationStepSchema.safeParse(data);
    if (!parsed.success) {
      throw new SignerError('The Denaria API answered in a shape this Signer does not know.');
    }
    return parsed.data;
  };

  const operationAnswer = (operation: AgentOperation, agent: AgentRef): CallToolResult => {
    const structured = { ...operation, agent };
    const text = [
      network.notice,
      '',
      agentLine(agent),
      ...(operation.summary !== null ? [operation.summary] : []),
      `State: ${operation.state}. ${operation.detail}`,
      ...(operation.failure !== null ? [`Why: ${operation.failure}`] : []),
      `Reference: ${operation.reference} (${agentToolName(denariaGetAgentOperationStatus, network)}).`,
      `The Grant expires at ${operation.grantExpiresAt}.`,
      '',
      JSON.stringify(structured, null, 2),
    ].join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: structured as unknown as Record<string, unknown>,
    };
  };

  const inputOf = (tool: { input: z.ZodType }, args: unknown): unknown => {
    const parsed = tool.input.safeParse(args ?? {});
    if (!parsed.success) {
      throw new SignerError(`Invalid input: ${z.prettifyError(parsed.error).slice(0, 400)}`);
    }
    return parsed.data;
  };

  /** The Grant's account, markets and v4 settings, read before the first signature of an
   *  operation: what its UserOp is held to (ticket 20). */
  const grantToCheck = async (key: SessionKey): Promise<GrantToCheck> => {
    const answer = answerOf(denariaGetGrant, await accountRead(key, denariaGetGrant.api.procedure));
    const limits = answer.grant.limits;
    learnAccount(key, answer);
    return {
      account: answer.account,
      markets: limits?.markets ?? 'any',
      pendingIncreaseOrdersAllowed: limits?.pendingIncreaseOrdersAllowed ?? false,
      marginWithdrawalAllowed: limits?.marginWithdrawalAllowed ?? false,
    };
  };

  /**
   * A step the Signer refused: nothing signed, the operation abandoned at the
   * API so the Grant's slot is free, and the answer says what did not match.
   * After a relay fault (`sent`), the first UserOp may still land.
   */
  const refused = async (
    key: SessionKey,
    step: SignStep,
    refusal: SignRefusal,
    sent: string | null,
  ): Promise<SignerError> => {
    log(`refused to sign ${step.reference}: ${refusal.reason}`);
    let abandoned = true;
    try {
      await session.mutate(key, AGENT_ABANDON_OPERATION_PROCEDURE, {
        reference: step.reference,
        reason: refusal.reason.slice(0, 400),
      });
    } catch {
      abandoned = false;
    }
    const status = agentToolName(denariaGetAgentOperationStatus, network);
    return new SignerError(
      [
        `The Signer refused to sign the operation ${step.reference}: ${refusal.reason}.`,
        sent === null
          ? 'Nothing was signed, so nothing was sent.'
          : `Nothing more was signed; its first UserOp was signed and sent before and may still land: read its state with ${status}.`,
        abandoned
          ? 'Denaria was told and abandoned the operation.'
          : 'Denaria could not be told: the operation expires on its own within two minutes.',
        'The Denaria API prepared something other than what the tool asked: tell the user, and do not try it again until it is explained.',
      ].join(' '),
    );
  };

  /**
   * An execution tool (ADR-0062 §13): the API prepares it within the Grant
   * and answers the whole UserOp; this key signs the hash the Signer computes
   * for it, once its calls are the tool's request (`checkStepToSign`, ticket
   * 20); the API relays it. A relay fault asks for one more signature (the
   * next provider's UserOp, the same call data on the same nonce); never more
   * than three, whatever the API says.
   */
  const executeTool = async (
    tool: (typeof AGENT_EXECUTION_TOOLS)[number],
    args: unknown,
  ): Promise<CallToolResult> => {
    const name = agentToolName(tool, network);
    // The reference of the operation once a signature of it was sent: from
    // then on it may land even when its answer is lost.
    let sent: string | null = null;
    try {
      const { agent, rest } = splitAgent(args);
      const request = {
        action: tool.name.slice('denaria_'.length) as AgentExecutionAction,
        input: inputOf(tool, rest),
      } as ToolRequest;
      const { slot, key } = await stored(agent);
      let step = stepOf(await session.mutate(key, tool.api.procedure, rest));
      let grant: GrantToCheck | null = null;
      let first: { reference: string; userOp: SignStep['userOp'] } | null = null;
      for (let signatures = 0; step.step === 'sign'; signatures++) {
        if (signatures >= MAX_SIGNATURES_PER_OPERATION) {
          throw new SignerError(
            `The Denaria API asked for more than ${MAX_SIGNATURES_PER_OPERATION} signatures; nothing more was signed. Read the operation status (${step.reference}).`,
          );
        }
        grant ??= await grantToCheck(key);
        let hash: `0x${string}`;
        try {
          const contracts = SIGNER_CONTRACTS[target.chainId];
          if (contracts === undefined) {
            throw new SignRefusal(`this Signer knows no contracts on chain ${target.chainId}`);
          }
          hash = checkStepToSign({
            request,
            step,
            chainId: target.chainId,
            contracts,
            grant,
            first,
          });
        } catch (error) {
          if (!(error instanceof SignRefusal)) throw error;
          return report(name, await refused(key, step, error, sent));
        }
        const signature = await key.signUserOpHash(hash);
        log(`${name}: signed ${step.reference}`);
        sent = step.reference;
        first ??= { reference: step.reference, userOp: step.userOp };
        step = stepOf(
          await session.mutate(key, AGENT_SUBMIT_OPERATION_PROCEDURE, {
            reference: step.reference,
            userOpHash: hash,
            signature,
          }),
        );
      }
      const operation = answerOf(tool, step.operation);
      return operationAnswer(operation, await agentRef(slot, await accountOf(key)));
    } catch (error) {
      if (error instanceof ApiUnreachable) {
        return report(name, lostAnswer(error, sent));
      }
      return report(name, error);
    }
  };

  /** A lost answer says whether anything signed may have been sent: an
   *  operation repeated after one that landed would trade twice. */
  const lostAnswer = (error: ApiUnreachable, sent: string | null): SignerError =>
    new SignerError(
      sent === null
        ? `${error.message} Nothing was signed, so nothing was sent: the operation can be asked again.`
        : [
            `The operation ${sent} was signed and sent to Denaria, but its answer did not arrive (${error.message.replace(/ Try again shortly\.$/, '')}).`,
            `It may have been executed. Do not repeat it: read its state with ${agentToolName(denariaGetAgentOperationStatus, network)} (reference ${sent}) first.`,
          ].join(' '),
    );

  const statusTool = async (args: unknown): Promise<CallToolResult> => {
    const tool = denariaGetAgentOperationStatus;
    try {
      const { agent, rest } = splitAgent(args);
      inputOf(tool, rest);
      const { slot, key } = await stored(agent);
      const ref = await agentRef(slot, await accountOf(key));
      return operationAnswer(
        answerOf(tool, await session.read(key, tool.api.procedure, rest)),
        ref,
      );
    } catch (error) {
      return report(agentToolName(tool, network), error);
    }
  };

  const executionTools = new Map(
    AGENT_EXECUTION_TOOLS.map((tool) => [agentToolName(tool, network), tool] as const),
  );
  const statusToolName = agentToolName(denariaGetAgentOperationStatus, network);

  const accountTools = new Map<string, AgentAccountTool>(
    AGENT_ACCOUNT_TOOLS.map((tool) => [agentToolName(tool, network), tool]),
  );

  const listAgents = async (): Promise<CallToolResult> => {
    try {
      const { slots } = await theAgents();
      const rows = await rowsOf(await keys.described(slots));
      const output: z.infer<typeof listAgentsOutput> = { network, agents: rows };
      const text = [
        network.notice,
        '',
        rows.length === 0
          ? 'This client has no Denaria agent on this computer yet: call connect.'
          : agentsText(rows),
        ...(rows.length > 1
          ? [
              '',
              'Every Denaria tool needs agent, the key id or the Agent name of the agent that acts: ask the user which one when it is not clear, never pick one.',
            ]
          : []),
      ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: output };
    } catch (error) {
      return report(listAgentsName, error);
    }
  };

  // `agent` on every account tool and trade, and the agent each answer is
  // about: the shared shapes in @denaria/agent-schemas stay the API's.
  const agentProperty = {
    type: 'string',
    minLength: 1,
    maxLength: 80,
    description: `Which of this client's Denaria agents acts: its key id, or its Agent name (trimmed, any case, the latest name the user gave it in Denaria). Required when this client has two or more agents: never guess it, ask the user. With one agent it may be omitted; if given, it must name that agent. A Signer started with --name acts for its one agent only. ${listAgentsName} lists the agents.`,
  };
  const { $schema: _refDialect, ...agentRefJson } = objectJsonSchema(agentRefSchema, 'output');
  const withAgent = (schemas: ReturnType<typeof agentToolJsonSchemas>) => {
    const properties = (schema: { [key: string]: unknown }) =>
      (schema.properties ?? {}) as Record<string, unknown>;
    return {
      inputSchema: {
        ...schemas.inputSchema,
        properties: { ...properties(schemas.inputSchema), agent: agentProperty },
      },
      outputSchema: {
        ...schemas.outputSchema,
        properties: { ...properties(schemas.outputSchema), agent: agentRefJson },
        required: [...(schemas.outputSchema.required ?? []), 'agent'],
      },
    };
  };

  const tools = [
    {
      name: 'connect',
      title: 'Connect this agent to Denaria',
      description: connectDescription(target.pwaOrigin),
      inputSchema: objectJsonSchema(connectInput, 'input'),
      outputSchema: objectJsonSchema(connectOutput, 'output'),
      annotations: {
        title: 'Connect this agent to Denaria',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ...[...accountTools].map(([name, tool]) => ({
      name,
      title: tool.title,
      description: tool.description,
      ...withAgent(agentToolJsonSchemas(tool)),
      annotations: { title: tool.title, ...tool.annotations },
    })),
    {
      name: listAgentsName,
      title: "This client's Denaria agents",
      description:
        "The Denaria agents of this client on this computer, oldest first: for each, its Agent name, key id and key fingerprint, the Account its Grant is on (address), and its Grant's state and expiry (unknown when they cannot be read now). Every agent has its own key, Grant and Account, one per strategy of the user. With two or more agents every Denaria tool needs agent, the key id or Agent name of the one that acts: ask the user which one, never pick one. It needs no Grant, and signs in only with agents whose Grant may be live.",
      inputSchema: objectJsonSchema(z.object({}).strict(), 'input'),
      outputSchema: objectJsonSchema(listAgentsOutput, 'output'),
      annotations: {
        title: "This client's Denaria agents",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ...[...executionTools, [statusToolName, denariaGetAgentOperationStatus] as const].map(
      ([name, tool]) => ({
        name,
        title: tool.title,
        description: tool.description,
        ...withAgent(agentToolJsonSchemas(tool)),
        annotations: { title: tool.title, ...tool.annotations },
      }),
    ),
  ];
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (call) => {
    if (call.params.name === 'connect') return connect(call.params.arguments);
    const tool = accountTools.get(call.params.name);
    if (tool) return readTool(tool, call.params.arguments);
    if (call.params.name === listAgentsName) return listAgents();
    const execution = executionTools.get(call.params.name);
    if (execution) return executeTool(execution, call.params.arguments);
    if (call.params.name === statusToolName) return statusTool(call.params.arguments);
    return failure(`The Denaria Agent Signer has no tool named ${call.params.name.slice(0, 64)}.`);
  });
  return server;
}
