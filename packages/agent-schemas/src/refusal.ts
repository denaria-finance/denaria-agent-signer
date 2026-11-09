import { z } from 'zod';
import { agentNetworkSchema } from './network.js';
import { boundedString } from './primitives.js';

export const AGENT_REFUSAL_SCHEMA_VERSION = 'denaria.agent.refusal.v1' as const;
export const AGENT_REFUSAL_MAX_DETAILS = 8;

const REFUSAL_CATEGORIES = ['user', 'system', 'dependency'] as const;
/**
 * What the agent may do next. Never "sign", "submit" or "pay". `prepare_new`:
 * prepare a new handoff, if the user still wants the trade.
 */
const REFUSAL_NEXT_ACTIONS = ['correct_request', 'retry_later', 'prepare_new', 'none'] as const;

type RefusalDefinition = {
  readonly httpStatus: 400 | 404 | 405 | 409 | 410 | 413 | 429 | 500 | 503;
  readonly category: (typeof REFUSAL_CATEGORIES)[number];
  readonly retryable: boolean;
  readonly message: string;
  readonly nextAction: (typeof REFUSAL_NEXT_ACTIONS)[number];
};

/**
 * What a zero-authority agent surface can refuse. Messages are display text,
 * never instructions; the code is the contract. The `HANDOFF.*` codes are the
 * QR handoff's: the agent service, the API and the PWA refuse with them.
 */
export const AGENT_REFUSALS = {
  'REQUEST.INVALID': {
    httpStatus: 400,
    category: 'user',
    retryable: false,
    message: 'The request does not match this endpoint contract.',
    nextAction: 'correct_request',
  },
  'REQUEST.NOT_FOUND': {
    httpStatus: 404,
    category: 'user',
    retryable: false,
    message: 'This endpoint or tool does not exist on this server.',
    nextAction: 'correct_request',
  },
  'REQUEST.METHOD_NOT_ALLOWED': {
    httpStatus: 405,
    category: 'user',
    retryable: false,
    message: 'This endpoint does not support this HTTP method.',
    nextAction: 'correct_request',
  },
  'REQUEST.TOO_LARGE': {
    httpStatus: 413,
    category: 'user',
    retryable: false,
    message: 'The request body exceeds the supported size.',
    nextAction: 'correct_request',
  },
  'TOOL.INPUT_INVALID': {
    httpStatus: 400,
    category: 'user',
    retryable: false,
    message: 'The tool arguments do not match its input schema; see details.',
    nextAction: 'correct_request',
  },
  'MARKET.NOT_FOUND': {
    httpStatus: 404,
    category: 'user',
    retryable: false,
    message: 'No enabled GMX market has this marketId here. Read the markets tool first.',
    nextAction: 'correct_request',
  },
  'MARKET.AMBIGUOUS': {
    httpStatus: 400,
    category: 'user',
    retryable: false,
    message: 'Several enabled markets match this ticker. Use a marketId from the markets tool.',
    nextAction: 'correct_request',
  },
  'ORDER.BLOCKED': {
    httpStatus: 400,
    category: 'user',
    retryable: false,
    message: 'The Denaria app would not let the user place this order; see details.',
    nextAction: 'correct_request',
  },
  'HANDOFF.NOT_FOUND': {
    httpStatus: 404,
    category: 'user',
    retryable: false,
    message: 'No handoff has this reference on this network.',
    nextAction: 'correct_request',
  },
  'HANDOFF.EXPIRED': {
    httpStatus: 410,
    category: 'user',
    retryable: false,
    message: 'This handoff expired before it was signed.',
    nextAction: 'prepare_new',
  },
  'HANDOFF.CLAIMED_BY_OTHER': {
    httpStatus: 409,
    category: 'user',
    retryable: false,
    message: 'Another Denaria account already opened this handoff; it belongs to that account.',
    nextAction: 'none',
  },
  'HANDOFF.ALREADY_USED': {
    httpStatus: 409,
    category: 'user',
    retryable: false,
    message: 'This handoff was already signed or declined, so it cannot be used again.',
    nextAction: 'none',
  },
  'HANDOFF.IN_PROGRESS': {
    httpStatus: 409,
    category: 'user',
    retryable: false,
    message: 'This handoff is already being signed; wait for its outcome.',
    nextAction: 'none',
  },
  'HANDOFF.WRONG_NETWORK': {
    httpStatus: 409,
    category: 'user',
    retryable: false,
    message: 'This handoff was prepared for another Denaria network.',
    nextAction: 'none',
  },
  'HANDOFF.TAMPERED': {
    httpStatus: 409,
    category: 'system',
    retryable: false,
    message:
      'The handoff the app received does not match the one the agent prepared. Nothing was signed.',
    nextAction: 'none',
  },
  'SOURCE.UNAVAILABLE': {
    httpStatus: 503,
    category: 'dependency',
    retryable: true,
    message:
      'A market data source did not answer or answered something unexpected. Try again later.',
    nextAction: 'retry_later',
  },
  'LIMIT.RATE_EXCEEDED': {
    httpStatus: 429,
    category: 'system',
    retryable: true,
    message: 'Too many requests to this server. Try again in a minute.',
    nextAction: 'retry_later',
  },
  'LIMIT.CONCURRENCY_EXCEEDED': {
    httpStatus: 503,
    category: 'system',
    retryable: true,
    message: 'This server is at capacity. Try again shortly.',
    nextAction: 'retry_later',
  },
  'SYSTEM.INTERNAL': {
    httpStatus: 500,
    category: 'system',
    retryable: true,
    message: 'The server could not complete the request.',
    nextAction: 'retry_later',
  },
} as const satisfies Record<string, RefusalDefinition>;

export type AgentRefusalCode = keyof typeof AGENT_REFUSALS;

const refusalCodes = Object.keys(AGENT_REFUSALS) as [AgentRefusalCode, ...AgentRefusalCode[]];

export const agentRefusalSchema = z
  .object({
    schemaVersion: z.literal(AGENT_REFUSAL_SCHEMA_VERSION),
    network: agentNetworkSchema,
    requestId: boundedString(128),
    code: z.enum(refusalCodes),
    category: z.enum(REFUSAL_CATEGORIES),
    retryable: z.boolean(),
    message: boundedString(512),
    nextAction: z.enum(REFUSAL_NEXT_ACTIONS),
    details: z.array(boundedString(256)).max(AGENT_REFUSAL_MAX_DETAILS).optional(),
  })
  .strict();

export type AgentRefusal = z.infer<typeof agentRefusalSchema>;

export function createAgentRefusal(
  code: AgentRefusalCode,
  context: {
    requestId: string;
    network: z.input<typeof agentNetworkSchema>;
    details?: readonly string[];
  },
): { httpStatus: RefusalDefinition['httpStatus']; body: AgentRefusal } {
  const { httpStatus, ...definition } = AGENT_REFUSALS[code];
  const details = context.details
    ?.slice(0, AGENT_REFUSAL_MAX_DETAILS)
    .map((detail) => detail.slice(0, 256))
    .filter((detail) => detail.length > 0);
  return {
    httpStatus,
    body: agentRefusalSchema.parse({
      schemaVersion: AGENT_REFUSAL_SCHEMA_VERSION,
      network: context.network,
      requestId: context.requestId,
      code,
      ...definition,
      ...(details && details.length > 0 ? { details } : {}),
    }),
  };
}
