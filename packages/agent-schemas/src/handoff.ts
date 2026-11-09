import { z } from 'zod';
import { agentNetworkSchema } from './network.js';
import { boundedString, caip2EvmChainIdSchema, envIdSchema, marketIdSchema } from './primitives.js';

/**
 * The QR handoff. An agent without an Agent signer turns an open intent into a
 * **Proposal**: unsigned, account-less, short-lived, with no calldata, no nonce
 * and no calls. The API stores it under an opaque **Handoff reference**; the
 * PWA opens it, rebuilds and verifies the order with its own order sheet, and
 * the user signs once with the Passkey. The agent then reads the **Operation
 * status** by reference.
 *
 * Pure code: it runs unchanged in Node and in the browser (Web Crypto
 * `crypto.subtle` and `crypto.getRandomValues`), so the API and the PWA hash
 * the same canonical bytes.
 */

export const AGENT_PROPOSAL_SCHEMA_VERSION = 'denaria.agent.proposal.v1' as const;
export const AGENT_OPERATION_STATUS_SCHEMA_VERSION = 'denaria.agent.operation-status.v1' as const;

/** How long a Proposal can wait to be signed: short and absolute, so stale prices never wait. */
export const AGENT_PROPOSAL_TTL_MS = 10 * 60_000;
export const AGENT_CLIENT_INTENT_ID_MAX_LENGTH = 64;
export const AGENT_HANDOFF_REFERENCE_PREFIX = 'dhr_' as const;
/** The PWA route that opens a handoff: `/agent/handoff/<reference>#<digest hint>`. */
export const AGENT_HANDOFF_PATH_PREFIX = '/agent/handoff/' as const;
export const AGENT_PROPOSAL_DIGEST_HINT_LENGTH = 8;

/** Canonical ISO-8601 UTC instant, exactly as `Date#toISOString` writes it. */
export const agentUtcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'must be a canonical UTC timestamp')
  .refine((value) => {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && new Date(ms).toISOString() === value;
  }, 'must be a real instant');

export const agentBytes32HexSchema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, 'must be a lowercase 32-byte hex string');

/** `dhr_` + 43 base64url characters: 32 random bytes. A locator, never a credential. */
export const agentHandoffReferenceSchema = z
  .string()
  .regex(/^dhr_[A-Za-z0-9_-]{43}$/, 'must be a Denaria handoff reference (dhr_…)');

export const agentClientIntentIdSchema = z
  .string()
  .min(1)
  .max(AGENT_CLIENT_INTENT_ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be an opaque id in a URL-safe charset');

/** A decimal amount as text: hashing admits no floats. */
const decimalString = z
  .string()
  .max(40)
  .regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'must be a plain decimal string');

/**
 * What the user is asked to sign: a new GMX market position (or an increase of
 * the one on that side) with USDC collateral, in the order sheet's terms.
 * `slippageBps` is absent unless the agent set it: the app then applies the
 * user's own slippage setting.
 */
export const agentProposalIntentSchema = z
  .object({
    venue: z.literal('gmx'),
    action: z.literal('open_market'),
    marketId: marketIdSchema,
    assetTicker: boundedString(32),
    side: z.enum(['long', 'short']),
    collateralUsd: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/, 'must be a USDC amount')
      .refine((value) => Number(value) > 0, 'must be greater than 0'),
    leverage: z
      .string()
      .regex(/^[1-9][0-9]{0,3}(\.[0-9]{1,2})?$/, 'must be a leverage like "3" or "2.5"'),
    slippageBps: z.number().int().min(1).max(5_000).optional(),
  })
  .strict();

/**
 * The figures the agent was shown when it prepared the Proposal. Provenance
 * only: the app re-quotes everything fresh and never uses these to build the
 * order. Anyone can create a Proposal, so they are untrusted display data.
 */
export const agentProposalSnapshotSchema = z
  .object({
    observedAt: agentUtcTimestampSchema,
    markPriceUsd: decimalString,
    acceptablePriceUsd: decimalString,
    liquidationPriceUsd: decimalString.nullable(),
    positionSizeUsd: decimalString,
    collateralAfterFeesUsd: decimalString,
    tradingFeeUsd: decimalString,
    executionFeeUsd: decimalString,
    serviceFeeUsd: decimalString,
  })
  .strict();

/** What the agent service sends the API; the API adds the clock and the hash. */
export const agentProposalDraftSchema = z
  .object({
    env: envIdSchema,
    chainId: caip2EvmChainIdSchema,
    intent: agentProposalIntentSchema,
    snapshot: agentProposalSnapshotSchema,
    clientIntentId: agentClientIntentIdSchema.optional(),
  })
  .strict();

const proposalBodyShape = {
  schemaVersion: z.literal(AGENT_PROPOSAL_SCHEMA_VERSION),
  ...agentProposalDraftSchema.shape,
  createdAt: agentUtcTimestampSchema,
  expiresAt: agentUtcTimestampSchema,
};

function refineTimes(value: { createdAt: string; expiresAt: string }, ctx: z.RefinementCtx) {
  if (!(Date.parse(value.createdAt) < Date.parse(value.expiresAt))) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'must be after createdAt' });
  }
}

/** The hashed body: everything in a Proposal but `proposalHash`. */
export const agentProposalBodySchema = z
  .object(proposalBodyShape)
  .strict()
  .superRefine(refineTimes);

export const agentProposalSchema = z
  .object({ ...proposalBodyShape, proposalHash: agentBytes32HexSchema })
  .strict()
  .superRefine(refineTimes);

export type AgentProposalIntent = z.infer<typeof agentProposalIntentSchema>;
export type AgentProposalSnapshot = z.infer<typeof agentProposalSnapshotSchema>;
export type AgentProposalDraft = z.infer<typeof agentProposalDraftSchema>;
export type AgentProposalBody = z.infer<typeof agentProposalBodySchema>;
export type AgentProposal = z.infer<typeof agentProposalSchema>;

/**
 * Canonical JSON (a JCS-compatible subset): keys sorted, no whitespace,
 * undefined keys dropped, numbers only as safe integers (amounts are strings).
 * The hash covers the UTF-8 bytes of this text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new TypeError('canonical JSON admits only safe integers; encode amounts as strings');
      }
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonical JSON cannot encode a ${typeof value}`);
  }
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** `0x` + sha256 of the canonical body. Parses the body strictly first. */
export async function hashAgentProposal(body: AgentProposalBody): Promise<string> {
  const text = canonicalJson(agentProposalBodySchema.parse(body));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `0x${toHex(new Uint8Array(digest))}`;
}

/** The Proposal, parsed, when its hash is the hash of its own body; else null. */
export async function parseVerifiedAgentProposal(proposal: unknown): Promise<AgentProposal | null> {
  const parsed = agentProposalSchema.safeParse(proposal);
  if (!parsed.success) return null;
  const { proposalHash, ...body } = parsed.data;
  return (await hashAgentProposal(body)) === proposalHash ? parsed.data : null;
}

export async function verifyAgentProposal(proposal: unknown): Promise<boolean> {
  return (await parseVerifiedAgentProposal(proposal)) !== null;
}

export function createAgentHandoffReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64url = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${AGENT_HANDOFF_REFERENCE_PREFIX}${base64url}`;
}

/** The first hex characters of the hash: a mismatch hint, never trusted as proof. */
export function digestHintOf(proposalHash: string): string {
  return proposalHash.slice(2, 2 + AGENT_PROPOSAL_DIGEST_HINT_LENGTH);
}

/** The link the QR encodes: the env's PWA origin, the reference, the digest hint. */
export function agentHandoffUrl(pwaOrigin: string, reference: string, proposalHash: string) {
  return `${new URL(pwaOrigin).origin}${AGENT_HANDOFF_PATH_PREFIX}${reference}#${digestHintOf(proposalHash)}`;
}

/** Reads a handoff link back (PWA side). Null when it is not one. */
export function parseAgentHandoffUrl(
  pathname: string,
  hash: string,
): { reference: string; digestHint: string | null } | null {
  if (!pathname.startsWith(AGENT_HANDOFF_PATH_PREFIX)) return null;
  const reference = agentHandoffReferenceSchema.safeParse(
    pathname.slice(AGENT_HANDOFF_PATH_PREFIX.length),
  );
  if (!reference.success) return null;
  const hint = hash.replace(/^#/, '');
  return {
    reference: reference.data,
    digestHint: /^[0-9a-f]{8}$/.test(hint) ? hint : null,
  };
}

/**
 * The lifecycle an agent reads. `submitted` is an order on chain, not a
 * position; `unknown` is a conclusion, not a retry signal: a second Proposal
 * could open a second position.
 */
export const AGENT_OPERATION_STATES = {
  awaiting_review: {
    terminal: false,
    detail: 'Prepared, not opened yet. The user scans the QR or opens the link before it expires.',
  },
  in_review: {
    terminal: false,
    detail: 'The user opened it in the Denaria app and is reviewing it. Nothing is signed yet.',
  },
  signing: {
    terminal: false,
    detail: 'The user confirmed and is signing with the Passkey, or the order is being sent.',
  },
  submitted: {
    terminal: false,
    detail:
      'The order is on chain and waits for the GMX keeper. It is not a position until it is executed.',
  },
  executed: {
    terminal: true,
    detail: 'The GMX keeper executed the order: the position is open (or increased).',
  },
  cancelled: {
    terminal: true,
    detail: 'GMX cancelled or froze the order; the collateral went back to the account.',
  },
  failed: {
    terminal: true,
    detail: 'The signed operation reverted on chain: nothing changed in the account.',
  },
  declined: {
    terminal: true,
    detail: 'The user declined it in the app. Ask before preparing anything else.',
  },
  expired: {
    terminal: true,
    detail: 'Nobody signed it before it expired. Prepare a new one if the user still wants it.',
  },
  unknown: {
    terminal: true,
    detail:
      'The app did not report an outcome in time. Ask the user to check the Denaria app; do not prepare it again before they do.',
  },
} as const satisfies Record<string, { terminal: boolean; detail: string }>;

export type AgentOperationState = keyof typeof AGENT_OPERATION_STATES;
export const agentOperationStateSchema = z.enum(
  Object.keys(AGENT_OPERATION_STATES) as [AgentOperationState, ...AgentOperationState[]],
);

export function describeOperationState(state: AgentOperationState): {
  terminal: boolean;
  detail: string;
} {
  const { terminal, detail } = AGENT_OPERATION_STATES[state];
  return { terminal, detail };
}

/**
 * What anyone holding the reference reads: no account, no position, no
 * amounts. `orderKey` is a public GMX correlator once the order is on chain.
 */
export const agentOperationStatusSchema = z
  .object({
    schemaVersion: z.literal(AGENT_OPERATION_STATUS_SCHEMA_VERSION),
    network: agentNetworkSchema,
    reference: agentHandoffReferenceSchema,
    state: agentOperationStateSchema,
    terminal: z.boolean(),
    detail: boundedString(256),
    createdAt: agentUtcTimestampSchema,
    expiresAt: agentUtcTimestampSchema,
    updatedAt: agentUtcTimestampSchema,
    orderKey: agentBytes32HexSchema.nullable(),
    observedAt: agentUtcTimestampSchema,
  })
  .strict();

export type AgentOperationStatus = z.infer<typeof agentOperationStatusSchema>;

/**
 * What the Denaria API answers about a Proposal by reference (`agentHandoff.status`):
 * the agent service adds the network and the meaning of the state.
 */
export const agentHandoffRecordSchema = z
  .object({
    reference: agentHandoffReferenceSchema,
    state: agentOperationStateSchema,
    proposalHash: agentBytes32HexSchema,
    createdAt: agentUtcTimestampSchema,
    expiresAt: agentUtcTimestampSchema,
    updatedAt: agentUtcTimestampSchema,
    orderKey: agentBytes32HexSchema.nullable(),
  })
  .strict();

export type AgentHandoffRecord = z.infer<typeof agentHandoffRecordSchema>;
