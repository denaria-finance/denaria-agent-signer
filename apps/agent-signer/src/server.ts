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
  agentConnectUrl,
  agentGrantSchema,
  agentKeyFingerprint,
  agentNetworkSchema,
  agentOperationStepSchema,
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
import { ApiRefusal, ApiUnreachable, type SignerApi } from './api.js';
import { labelFromClient } from './client-label.js';
import { SIGNER_NAME, SIGNER_VERSION, type SignerTarget } from './envs.js';
import { SignerError } from './errors.js';
import { createAgentSession } from './session.js';
import { SessionKey } from './session-key.js';
import type { KeyStore } from './store/types.js';
import { terminalQr } from './terminal-qr.js';

/** Signatures one execution call may give: the first, one more after a relay
 *  fault, and a margin; the API never needs more. */
const MAX_SIGNATURES_PER_OPERATION = 3;

const CONNECT_DESCRIPTION = [
  "Connect this agent to the user's Denaria account through the Denaria Agent Signer.",
  'The first time, it creates the agent key on this computer and keeps it there; afterwards it reuses the same key.',
  'Until the user has confirmed, it returns a link, a QR code of the link and a fingerprint.',
  'The user opens the link on their phone, checks that the phone shows the same fingerprint, chooses the limits and confirms with their Passkey; then call connect again.',
  'Once connected, it says what this agent may trade, up to which size and leverage, and until when, with no new link.',
  'If the Grant was revoked, it makes a new key and a new link.',
  'Show the user the QR code in a code block, then the link and the fingerprint, exactly as returned.',
  'The private key never leaves this computer and is never part of the answer.',
].join(' ');

function instructions(network: AgentNetwork): string {
  return [
    network.notice,
    `Denaria Agent Signer for Denaria ${network.env}, ${network.chainName} (${network.chainId}).`,
    'It keeps the key this agent will trade with, inside the limits the user approves with their Passkey.',
    'When the user wants this agent to trade on Denaria, call connect and show its QR code, link and fingerprint.',
    'Once connected, the account tools read the Grant, the positions, the open orders and the USDC of the account. Every answer states the network and when the Grant expires: tell the user before it does.',
    // Prudence (agent-trading Stage 2 Q69, ADR-0062 §17): the core of the
    // denaria-trading skill, for an agent that does not have it.
    "Before the first trade, explain the Grant's limits to the user, and start small.",
    'Tell the user the summary of every operation and follow it to its outcome.',
    "In the Grant's markets GMX merges the user's own positions with the agent's: ask before changing a position you did not open.",
  ].join(' ');
}

const connectInput = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(AGENT_LABEL_MAX_LENGTH)
    .optional()
    .describe(
      'The name the user will see for this agent in Denaria. Leave it out to use the name of this agent.',
    ),
});

const connectOutput = z.object({
  /** `connected`: the Grant is live, no link. `confirm_on_phone`: open the link. */
  status: z.enum(['connected', 'confirm_on_phone']),
  network: agentNetworkSchema,
  fingerprint: z.string(),
  /** Why a link is given: a first key, a key not confirmed yet, a new key after
   *  a revoked Grant, an expired Grant, or Denaria could not be asked. */
  reason: z.enum(['new_key', 'not_confirmed', 'rotated', 'expired', 'unchecked']).optional(),
  link: z.string().optional(),
  grant: agentGrantSchema.shape.grant.optional(),
});

type LinkReason = NonNullable<z.infer<typeof connectOutput>['reason']>;

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
  where: string;
  lead: string | null;
}): string {
  const { network, link, fingerprint, where, lead } = options;
  return [
    network.notice,
    '',
    ...(lead === null ? [] : [lead, '']),
    'Denaria Agent Signer: connect this agent to your Denaria account.',
    '',
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

/**
 * The Denaria Agent Signer as an MCP server (ADR-0062 §2, §11): `connect`,
 * which keeps this Env's Session key and either restates its live Grant or
 * returns the link that enrols it (a new key when the Grant was revoked), and
 * the account reads of `AGENT_ACCOUNT_TOOLS`, answered by the API under the
 * Signer's login. Every answer starts with the network notice.
 */
export function createSignerServer(options: {
  target: SignerTarget;
  store: KeyStore;
  api: SignerApi;
  log: (line: string) => void;
  now?: () => number;
}): Server {
  const { target, store, api, log } = options;
  const now = options.now ?? Date.now;
  const network = describeAgentNetwork({ env: target.env, chainId: target.chainId });
  const session = createAgentSession({ target, api, now });
  const server = new Server(
    { name: SIGNER_NAME, version: SIGNER_VERSION },
    { capabilities: { tools: { listChanged: false } }, instructions: instructions(network) },
  );

  // One connect at a time: two calls must not both find no key and make two.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  // The link goes out only for a key the store has durably kept: a link to a
  // key that is lost would make the phone grant an orphan.
  const createKey = async (how: 'save' | 'replace'): Promise<SessionKey> => {
    const created = SessionKey.generate();
    await store[how](target.env, created.exportSecret());
    const saved = await store.load(target.env);
    if (saved === null || SessionKey.fromSecret(saved).publicKey.x !== created.publicKey.x) {
      throw new SignerError(
        `The new key could not be read back from ${store.describe(target.env)}, so no link was made. Try connect again.`,
      );
    }
    log(
      `connect: ${how === 'save' ? 'created' : 'rotated to'} a ${target.env} key in ${store.describe(target.env)}`,
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

  const stored = async (): Promise<SessionKey> => {
    const secret = await store.load(target.env);
    if (secret === null) {
      throw new SignerError(
        'This agent is not connected to Denaria yet: call connect first, then confirm on the phone.',
      );
    }
    return SessionKey.fromSecret(secret);
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

  const linkAnswer = async (
    key: SessionKey,
    reason: LinkReason,
    label: string | undefined,
    detail: string | null = null,
  ): Promise<CallToolResult> => {
    const link = agentConnectUrl(target.pwaOrigin, {
      publicKey: key.publicKey,
      chainId: network.chainId,
      label: label ?? labelFromClient(server.getClientVersion()?.name),
    });
    const fingerprint = await agentKeyFingerprint(key.publicKey);
    const where = store.describe(target.env);
    const output: z.infer<typeof connectOutput> = {
      status: 'confirm_on_phone',
      network,
      fingerprint,
      reason,
      link,
    };
    const text = connectText({ network, link, fingerprint, where, lead: LEADS[reason](detail) });
    return { content: [{ type: 'text', text }], structuredContent: output };
  };

  const connect = async (args: unknown): Promise<CallToolResult> => {
    // Clients may send no arguments at all for a tool without required ones.
    const input = connectInput.safeParse(args ?? {});
    if (!input.success) {
      return failure(
        `The label must be 1 to ${AGENT_LABEL_MAX_LENGTH} characters. Call connect again with a shorter label, or without one.`,
      );
    }
    const label = input.data.label;
    try {
      return await serialized(async () => {
        const existing = await store.load(target.env);
        if (existing === null) return linkAnswer(await createKey('save'), 'new_key', label);
        const key = SessionKey.fromSecret(existing);
        log(`connect: checking the ${target.env} key kept in ${store.describe(target.env)}`);
        try {
          await session.login(key);
          const grant = answerOf(
            denariaGetGrant,
            await session.read(key, denariaGetGrant.api.procedure),
          );
          const fingerprint = await agentKeyFingerprint(key.publicKey);
          const output: z.infer<typeof connectOutput> = {
            status: 'connected',
            network,
            fingerprint,
            grant: grant.grant,
          };
          const text = [
            network.notice,
            '',
            restateGrant(grant.grant),
            '',
            `Key fingerprint: ${fingerprint}. The user manages or revokes this agent in the Denaria app: ${RENEW_WHERE}.`,
          ].join('\n');
          return { content: [{ type: 'text', text }], structuredContent: output };
        } catch (error) {
          if (error instanceof ApiRefusal) {
            switch (error.code) {
              case 'AGENT_SIGNER.GRANT_REVOKED': {
                // Rotation is "revoke and reconnect" (spec, Agent signer): the
                // revoked key never signs again, a new key gets a new Grant.
                const fresh = await createKey('replace');
                session.reset();
                return linkAnswer(fresh, 'rotated', label);
              }
              case 'AGENT_SIGNER.GRANT_EXPIRED':
                return linkAnswer(key, 'expired', label, error.message);
              case 'AGENT_SIGNER.UNKNOWN_KEY':
              case 'AGENT_SIGNER.GRANT_PENDING':
                return linkAnswer(key, 'not_confirmed', label);
            }
            throw error;
          }
          if (error instanceof ApiUnreachable) {
            return linkAnswer(key, 'unchecked', label, error.message);
          }
          throw error;
        }
      });
    } catch (error) {
      return report('connect', error);
    }
  };

  const readTool = async (tool: AgentAccountTool): Promise<CallToolResult> => {
    try {
      const key = await stored();
      // Every account answer has these two (agent-schemas account.ts).
      const output = tool.output as z.ZodType<{
        network: AgentNetwork;
        grant: { expiresAt: string };
      }>;
      const answer = answerOf({ output }, await session.read(key, tool.api.procedure));
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

  /** The API's next step, checked: a hash to sign or the operation. */
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
      const key = await stored();
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
      const key = await stored();
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
      description: CONNECT_DESCRIPTION,
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
