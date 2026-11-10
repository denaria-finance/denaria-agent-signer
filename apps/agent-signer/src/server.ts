import {
  AGENT_ACCOUNT_TOOLS,
  AGENT_EXECUTION_TOOLS,
  AGENT_LABEL_MAX_LENGTH,
  AGENT_SUBMIT_OPERATION_PROCEDURE,
  type AgentAccountTool,
  type AgentGrant,
  type AgentNetwork,
  type AgentOperation,
  type AgentOperationStep,
  type AgentSetupClient,
  agentConnectUrl,
  agentGrantSchema,
  agentKeyFingerprint,
  agentNetworkSchema,
  agentOperationStepSchema,
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
import type { AgentIndex } from './agent-index.js';
import { agentKeys } from './agent-keys.js';
import { ApiRefusal, ApiUnreachable, type SignerApi } from './api.js';
import { agentNameSchema, clientIdentity, labelFromClient } from './client-label.js';
import { SIGNER_NAME, SIGNER_VERSION, type SignerTarget } from './envs.js';
import { SignerError } from './errors.js';
import { createAgentSession } from './session.js';
import { SessionKey } from './session-key.js';
import type { KeyStore } from './store/types.js';
import { terminalQr } from './terminal-qr.js';

/** Signatures one execution call may give: the first, one more after a relay
 *  fault, and a margin; the API never needs more. */
const MAX_SIGNATURES_PER_OPERATION = 3;

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

const connectDescription = (pwaOrigin: string) =>
  [
    "Connect this agent to the user's Denaria account through the Denaria Agent Signer.",
    'Each agent on this computer has its own key, named by its Agent name, kept on this computer.',
    "The first time an agent connects, connect answers status choose_agent: ask the user for this agent's name (propose the one it gives) or which key already on this computer to reuse, then call connect again with name or reuse.",
    'Until the user has confirmed, it returns a link, a QR code of the link and a fingerprint.',
    'The user opens the link on their phone, checks that the phone shows the same fingerprint, chooses the limits and confirms with their Passkey; then call connect again.',
    'Once connected, it says what this agent may trade, up to which size and leverage, and until when, with no new link.',
    'If the Grant was revoked, it makes a new key and a new link.',
    'Show the user the QR code in a code block, then the link and the fingerprint, exactly as returned.',
    'The private key never leaves this computer and is never part of the answer.',
    `If the Signer does not start or keeps failing, the user follows the Denaria setup guide: ${guideLinks(pwaOrigin)}.`,
  ].join(' ');

function instructions(network: AgentNetwork, pwaOrigin: string): string {
  return [
    network.notice,
    `Denaria Agent Signer for Denaria ${network.env}, ${network.chainName} (${network.chainId}).`,
    'It keeps the key this agent will trade with, inside the limits the user approves with their Passkey.',
    'When the user wants this agent to trade on Denaria, call connect and show its QR code, link and fingerprint.',
    "The first connect of this agent asks for its name: ask the user, proposing the name connect gives, or which key already on this computer to reuse, and call connect again with the user's choice.",
    'Once connected, the account tools read the Grant, the positions, the open orders and the USDC of the account. Every answer states the network and when the Grant expires: tell the user before it does.',
    // Prudence (agent-trading Stage 2 Q69, ADR-0062 §17): the core of the
    // denaria-trading skill, for an agent that does not have it.
    "Before the first trade, explain the Grant's limits to the user, and start small.",
    'Tell the user the summary of every operation and follow it to its outcome.',
    "In the Grant's markets GMX merges the user's own positions with the agent's: ask before changing a position you did not open.",
    `If the Signer does not install or stops answering, send the user to the app's guide: ${guideLinks(pwaOrigin)}.`,
  ].join(' ');
}

const connectInput = z.object({
  name: agentNameSchema
    .optional()
    .describe(
      'The Agent name the user chose for a new agent on this computer, after connect answered choose_agent. The user sees it in Denaria; it is renamed there, in the app.',
    ),
  reuse: z
    .string()
    .max(80)
    .optional()
    .describe(
      'The key id of a key already on this computer the user chose to reuse, from the list connect gave with choose_agent.',
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
  fingerprint: z.string().optional(),
  /** Why a link is given: a first key, a key not confirmed yet, a new key after
   *  a revoked Grant, an expired Grant, or Denaria could not be asked. */
  reason: z.enum(['new_key', 'not_confirmed', 'rotated', 'expired', 'unchecked']).optional(),
  link: z.string().optional(),
  grant: agentGrantSchema.shape.grant.optional(),
  /** choose_agent: the name to propose, from the MCP client's own name. */
  proposedName: z.string().nullable().optional(),
  /** choose_agent: the keys already on this computer for this Env. */
  keys: z.array(keyOnComputerSchema).optional(),
});

type ConnectOutput = z.infer<typeof connectOutput>;
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

/** "Connected. I can trade BTC and ETH, up to $50 per order, max 3x, until 11 Nov, 10:00 UTC." */
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
  return `Connected. I can trade ${markets}, up to $${limits.maxOrderUsd.toLocaleString('en-US')} per order, max ${limits.maxLeverage}x, ${until}.`;
}

type JsonObjectSchema = { type: 'object'; [key: string]: unknown };

function objectJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonObjectSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io });
  if (json.type !== 'object') throw new Error('Tool schemas must describe JSON objects');
  return json as JsonObjectSchema;
}

function connectText(options: {
  network: AgentNetwork;
  link: string;
  fingerprint: string;
  name: string | null;
  where: string;
  lead: string | null;
}): string {
  const { network, link, fingerprint, name, where, lead } = options;
  return [
    network.notice,
    '',
    ...(lead === null ? [] : [lead, '']),
    'Denaria Agent Signer: connect this agent to your Denaria account.',
    '',
    ...(name === null ? [] : [`Agent name: ${name}`]),
    `Fingerprint: ${fingerprint}`,
    `Link: ${link}`,
    '',
    terminalQr(link),
    '',
    '1. Open the link on your phone, or scan the QR code. You can also open it in the Denaria desktop app, which asks your phone to confirm.',
    `2. Check that the code shown there is the same fingerprint: ${fingerprint}. If it is different, stop and do not confirm.`,
    '3. Choose the limits.',
    '4. Confirm with your Passkey.',
    '',
    'After you confirm on your phone, call connect again: it checks the Grant and says what this agent may do.',
    '',
    `The private key stays on this computer, in ${where}. Denaria never sees it.`,
  ].join('\n');
}

const LEADS: Record<LinkReason, (detail: string | null) => string | null> = {
  new_key: () => null,
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
          "A reused key shares that agent's Grant, limits, operations and revocation; one whose Grant is active trades at once, with no new signature.",
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
  now?: () => number;
}): Server {
  const { target, store, api, log } = options;
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

  // The slot this process's caller uses, once known: a mapping is never
  // changed once made, so it holds for the life of the process.
  let resolved: string | null = null;
  const slotOf = async (inputName?: string): Promise<string | null> => {
    if (resolved === null) {
      resolved = await keys.resolve(
        identityOf(),
        commandName ?? inputName ?? labelFromClient(clientName()),
      );
    }
    return resolved;
  };

  // One connect at a time: two calls must not both find no key and make two.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  // The link goes out only for a key the store has durably kept: a link to a
  // key that is lost would make the phone grant an orphan.
  const createKey = async (how: 'save' | 'replace', slot: string): Promise<SessionKey> => {
    const created = SessionKey.generate();
    const meta = {
      env: target.env,
      name: await keys.nameOf(slot),
      identity: identityOf(),
      createdAt: new Date(now()).toISOString(),
    };
    try {
      await store[how](slot, created.exportSecret(), meta);
    } catch (error) {
      // Another Signer process of the same agent may have saved this slot's
      // key a moment before: that key is the one to link.
      const raced = how === 'save' ? await store.load(slot).catch(() => null) : null;
      if (raced === null) throw error;
      log(`connect: another Signer saved the key in ${store.describe(slot)} first`);
      return SessionKey.fromSecret(raced);
    }
    const saved = await store.load(slot);
    if (saved === null || SessionKey.fromSecret(saved).publicKey.x !== created.publicKey.x) {
      throw new SignerError(
        `The new key could not be read back from ${store.describe(slot)}, so no link was made. Try connect again.`,
      );
    }
    log(
      `connect: ${how === 'save' ? 'created' : 'rotated to'} a ${target.env} key in ${store.describe(slot)}`,
    );
    return created;
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

  const stored = async (): Promise<{ slot: string; key: SessionKey }> => {
    const slot = await slotOf();
    const secret = slot === null ? null : await store.load(slot);
    if (slot === null || secret === null) {
      throw new SignerError(
        'This agent is not connected to Denaria yet: call connect first, then confirm on the phone.',
      );
    }
    return { slot, key: SessionKey.fromSecret(secret) };
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

  /** This key's Grant, read after a fresh login. */
  const readGrant = async (slot: string, key: SessionKey): Promise<AgentGrant> => {
    await session.login(key);
    const grant = answerOf(denariaGetGrant, await session.read(key, denariaGetGrant.api.procedure));
    await followName(slot, grant.grant);
    return grant;
  };

  const linkAnswer = async (
    slot: string,
    key: SessionKey,
    reason: LinkReason,
    lead: string | null,
    detail: string | null = null,
  ): Promise<CallToolResult> => {
    const name = await keys.nameOf(slot);
    const link = agentConnectUrl(target.pwaOrigin, {
      publicKey: key.publicKey,
      chainId: network.chainId,
      label: name,
    });
    const fingerprint = await agentKeyFingerprint(key.publicKey);
    const where = store.describe(slot);
    const output: ConnectOutput = {
      status: 'confirm_on_phone',
      network,
      name,
      keyId: slot,
      fingerprint,
      reason,
      link,
    };
    const leads = [lead, LEADS[reason](detail)].filter((line) => line !== null).join('\n\n');
    const text = connectText({
      network,
      link,
      fingerprint,
      name,
      where,
      lead: leads === '' ? null : leads,
    });
    return { content: [{ type: 'text', text }], structuredContent: output };
  };

  /** Today's connect for a key slot: restate a live Grant, link otherwise,
   *  rotate within the slot after a revocation. */
  const connectSlot = async (slot: string, lead: string | null): Promise<CallToolResult> => {
    const existing = await store.load(slot);
    if (existing === null) {
      return linkAnswer(slot, await createKey('save', slot), 'new_key', lead);
    }
    const key = SessionKey.fromSecret(existing);
    log(`connect: checking the ${target.env} key kept in ${store.describe(slot)}`);
    try {
      const grant = await readGrant(slot, key);
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
            const fresh = await createKey('replace', slot);
            session.reset();
            return linkAnswer(slot, fresh, 'rotated', lead);
          }
          case 'expired':
            return linkAnswer(slot, key, 'expired', lead, error.message);
          case 'not_confirmed':
            return linkAnswer(slot, key, 'not_confirmed', lead);
        }
        throw error;
      }
      if (error instanceof ApiUnreachable) {
        return linkAnswer(slot, key, 'unchecked', lead, error.message);
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

  const connect = async (args: unknown): Promise<CallToolResult> => {
    // Clients may send no arguments at all for a tool without required ones.
    const input = connectInput.safeParse(args ?? {});
    if (!input.success) {
      return failure(
        `The name must be 1 to ${AGENT_LABEL_MAX_LENGTH} characters, with no control characters, and reuse a key id connect listed. Call connect again with a valid name, or without one.`,
      );
    }
    const { name, reuse } = input.data;
    if (name !== undefined && reuse !== undefined) {
      return failure(
        'Give either a name for a new agent or the key id to reuse, not both. Call connect again with one of them.',
      );
    }
    try {
      return await serialized(async () => {
        store.ready?.();
        const identity = identityOf();
        const known = await slotOf(name);
        if (known !== null) {
          const current = await keys.nameOf(known);
          const lead =
            reuse !== undefined && reuse !== known
              ? `This agent already has its own key (key id ${known}), so it was kept. Another agent with another key starts its own Signer with --name "<Agent name>".`
              : name !== undefined && commandName === null && name !== current
                ? `This agent already has its name${current === null ? '' : `, ${current}`}. The user renames it in the Denaria app: ${RENEW_WHERE}.`
                : null;
          return connectSlot(known, lead);
        }
        let slot: string;
        if (reuse !== undefined) {
          slot = await keys.reuse(identity, reuse);
          log(`connect: this agent reuses the key in ${store.describe(slot)}`);
        } else {
          const chosen = commandName ?? name;
          if (chosen === undefined) return chooseAgent();
          slot = await keys.create(identity, chosen, new Date(now()).toISOString());
        }
        resolved = slot;
        return connectSlot(slot, null);
      });
    } catch (error) {
      return report('connect', error);
    }
  };

  const readTool = async (tool: AgentAccountTool): Promise<CallToolResult> => {
    try {
      const { slot, key } = await stored();
      // Every account answer has these two (agent-schemas account.ts).
      const output = tool.output as z.ZodType<{
        network: AgentNetwork;
        grant: { expiresAt: string };
      }>;
      const answer = answerOf({ output }, await session.read(key, tool.api.procedure));
      if (tool === denariaGetGrant) await followName(slot, (answer as AgentGrant).grant);
      const text = [
        network.notice,
        '',
        `The Grant expires at ${answer.grant.expiresAt}.`,
        '',
        JSON.stringify(answer, null, 2),
      ].join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: answer as unknown as Record<string, unknown>,
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

  const operationAnswer = (operation: AgentOperation): CallToolResult => {
    const text = [
      network.notice,
      '',
      ...(operation.summary !== null ? [operation.summary] : []),
      `State: ${operation.state}. ${operation.detail}`,
      ...(operation.failure !== null ? [`Why: ${operation.failure}`] : []),
      `Reference: ${operation.reference} (${agentToolName(denariaGetAgentOperationStatus, network)}).`,
      `The Grant expires at ${operation.grantExpiresAt}.`,
      '',
      JSON.stringify(operation, null, 2),
    ].join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: operation as unknown as Record<string, unknown>,
    };
  };

  const inputOf = (tool: { input: z.ZodType }, args: unknown): void => {
    const parsed = tool.input.safeParse(args ?? {});
    if (!parsed.success) {
      throw new SignerError(`Invalid input: ${z.prettifyError(parsed.error).slice(0, 400)}`);
    }
  };

  /**
   * An execution tool (ADR-0062 §13): the API prepares it within the Grant,
   * this key signs the userOp hash it answers, the API relays it. A relay
   * fault asks for one more signature (the next provider's UserOp on the same
   * nonce); never more than three, whatever the API says.
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
      inputOf(tool, args);
      const { key } = await stored();
      let step = stepOf(await session.mutate(key, tool.api.procedure, args ?? {}));
      for (let signatures = 0; step.step === 'sign'; signatures++) {
        if (signatures >= MAX_SIGNATURES_PER_OPERATION) {
          throw new SignerError(
            `The Denaria API asked for more than ${MAX_SIGNATURES_PER_OPERATION} signatures; nothing more was signed. Read the operation status (${step.reference}).`,
          );
        }
        const signature = await key.signUserOpHash(step.userOpHash as `0x${string}`);
        log(`${name}: signed ${step.reference}`);
        sent = step.reference;
        step = stepOf(
          await session.mutate(key, AGENT_SUBMIT_OPERATION_PROCEDURE, {
            reference: step.reference,
            userOpHash: step.userOpHash,
            signature,
          }),
        );
      }
      return operationAnswer(answerOf(tool, step.operation));
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
      inputOf(tool, args);
      const { key } = await stored();
      return operationAnswer(
        answerOf(tool, await session.read(key, tool.api.procedure, args ?? {})),
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
    ...[
      ...accountTools,
      ...executionTools,
      [statusToolName, denariaGetAgentOperationStatus] as const,
    ].map(([name, tool]) => ({
      name,
      title: tool.title,
      description: tool.description,
      ...agentToolJsonSchemas(tool),
      annotations: { title: tool.title, ...tool.annotations },
    })),
  ];
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (call) => {
    if (call.params.name === 'connect') return connect(call.params.arguments);
    const tool = accountTools.get(call.params.name);
    if (tool) return readTool(tool);
    const execution = executionTools.get(call.params.name);
    if (execution) return executeTool(execution, call.params.arguments);
    if (call.params.name === statusToolName) return statusTool(call.params.arguments);
    return failure(`The Denaria Agent Signer has no tool named ${call.params.name.slice(0, 64)}.`);
  });
  return server;
}
