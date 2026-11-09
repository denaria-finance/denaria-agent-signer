import { z } from 'zod';
import type { AgentAccountToolDefinition } from './account-tools.js';
import {
  agentBytes32HexSchema,
  agentClientIntentIdSchema,
  agentUtcTimestampSchema,
} from './handoff.js';
import { agentPrepareCreatePositionInputSchema, agentUsdcAmountSchema } from './handoff-prepare.js';
import { agentNetworkSchema } from './network.js';
import { boundedString } from './primitives.js';

/**
 * The Denaria Agent Signer's execution tools (ADR-0062 §13, agent-trading
 * Stage 2 tickets 08a and 08b, Q60): one tool per action, each one call that the API
 * prepares within the Grant, the Signer signs and the API relays. The answer
 * is the operation: a readable summary and a `dop_…` reference to follow.
 */

export const AGENT_OPERATION_SCHEMA_VERSION = 'denaria.agent.operation.v1' as const;
export const AGENT_OPERATION_REFERENCE_PREFIX = 'dop_' as const;

export const agentOperationReferenceSchema = z
  .string()
  .regex(/^dop_[A-Za-z0-9_-]{43}$/, 'must be a dop_ reference from an execution tool');

/** What an agent operation can be, as the agent reads it. */
export const AGENT_EXECUTION_STATES = {
  sending: {
    terminal: false,
    detail: 'Signed and being sent. Read the status again in a few seconds.',
  },
  submitted: {
    terminal: false,
    detail:
      'On chain: the GMX order waits for the keeper (seconds for a market order; a limit, take profit or stop loss waits for its price). It is not a position until executed.',
  },
  executed: { terminal: true, detail: 'The GMX keeper executed the order.' },
  cancelled: {
    terminal: true,
    detail: 'GMX cancelled or froze the order; the collateral is back in the account.',
  },
  failed: { terminal: true, detail: 'It did not happen: nothing changed in the account.' },
  expired: {
    terminal: true,
    detail: 'It was never signed in time; nothing was sent.',
  },
  unknown: {
    terminal: true,
    detail:
      'The send was lost track of. Read the positions and orders before doing it again: it may have landed.',
  },
} as const satisfies Record<string, { terminal: boolean; detail: string }>;

export type AgentExecutionState = keyof typeof AGENT_EXECUTION_STATES;
export const agentExecutionStateSchema = z.enum(
  Object.keys(AGENT_EXECUTION_STATES) as [AgentExecutionState, ...AgentExecutionState[]],
);

export const AGENT_EXECUTION_ACTIONS = [
  'create_position',
  'close_position',
  'adjust_margin',
  'set_tpsl',
  'cancel_order',
  'claim_funding',
] as const;
export const agentExecutionActionSchema = z.enum(AGENT_EXECUTION_ACTIONS);
export type AgentExecutionAction = z.infer<typeof agentExecutionActionSchema>;

export const agentOperationSchema = z
  .object({
    schemaVersion: z.literal(AGENT_OPERATION_SCHEMA_VERSION),
    network: agentNetworkSchema,
    reference: agentOperationReferenceSchema,
    action: agentExecutionActionSchema,
    state: agentExecutionStateSchema,
    terminal: z.boolean(),
    detail: boundedString(256),
    /** "Opened BTC long $75 at 3x": tell the user. */
    summary: boundedString(256).nullable(),
    /** Why it failed, when it did. */
    failure: boundedString(512).nullable(),
    transactionHash: agentBytes32HexSchema.nullable(),
    orderKey: agentBytes32HexSchema.nullable(),
    createdAt: agentUtcTimestampSchema,
    updatedAt: agentUtcTimestampSchema,
    grantExpiresAt: agentUtcTimestampSchema,
  })
  .strict();

export type AgentOperation = z.infer<typeof agentOperationSchema>;

/**
 * Between the API and the Signer, not shown to the agent: what to sign next
 * (a userOp hash; one more after a relay fault) or the operation as it
 * stands. The Signer builds the WebAuthn envelope from the hash itself.
 */
export const agentOperationStepSchema = z.discriminatedUnion('step', [
  z
    .object({
      step: z.literal('sign'),
      reference: agentOperationReferenceSchema,
      userOpHash: agentBytes32HexSchema,
      summary: boundedString(256).nullable(),
    })
    .strict(),
  z.object({ step: z.literal('done'), operation: agentOperationSchema }).strict(),
]);

export type AgentOperationStep = z.infer<typeof agentOperationStepSchema>;

export const agentSubmitOperationInputSchema = z
  .object({
    reference: agentOperationReferenceSchema,
    userOpHash: agentBytes32HexSchema,
    /** The WebAuthnSigner signature of the hash (`signHashWithSessionKey`). */
    signature: z
      .string()
      .regex(/^0x[0-9a-f]+$/)
      .max(4_000),
  })
  .strict();

const MARKET_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARKET_SYMBOL = /^([A-Za-z0-9]{1,16})-USD$/i;

/** The fields that name one position of the account: its market and side. */
const positionFields = {
  marketId: z
    .string()
    .trim()
    .max(64)
    .optional()
    .describe('The market: a marketId from denaria_get_positions or a symbol like "BTC-USD".'),
  assetTicker: z.string().trim().max(16).optional().describe('Alias: the ticker, e.g. "BTC".'),
  side: z.enum(['long', 'short']).describe('The side of the position.'),
};

const slippageField = z
  .number()
  .int()
  .min(1)
  .max(5_000)
  .optional()
  .describe("Maximum slippage in bps, at most the user's setting. Omit it to use the setting.");

const clientIntentIdField = agentClientIntentIdSchema
  .optional()
  .describe('Your id for this intent: the same id again returns the same operation.');

function checkPosition(
  value: { marketId?: string | undefined; assetTicker?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if ((value.marketId === undefined) === (value.assetTicker === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['marketId'], message: 'send marketId or assetTicker' });
  } else if (
    value.marketId !== undefined &&
    !MARKET_UUID.test(value.marketId) &&
    !MARKET_SYMBOL.test(value.marketId)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['marketId'],
      message: 'must be a marketId or a symbol like "BTC-USD"',
    });
  }
}

/** The market as the API looks it up: a catalog id, or a ticker. */
function marketOf(value: {
  marketId?: string | undefined;
  assetTicker?: string | undefined;
}): { marketId: string } | { assetTicker: string } {
  return value.marketId !== undefined && MARKET_UUID.test(value.marketId)
    ? { marketId: value.marketId }
    : {
        assetTicker: (
          value.assetTicker ??
          MARKET_SYMBOL.exec(value.marketId ?? '')?.[1] ??
          ''
        ).toUpperCase(),
      };
}

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  (value !== undefined ? { [key]: value } : {}) as Partial<Record<K, V>>;

/** `denaria_close_position`: the whole position (GMX has no partial close in
 *  the app to share a builder with). */
export const agentClosePositionInputSchema = z
  .object({
    ...positionFields,
    slippageBps: slippageField,
    clientIntentId: clientIntentIdField,
  })
  .strict()
  .superRefine(checkPosition)
  .transform((value) => ({
    market: marketOf(value),
    side: value.side,
    ...optional('slippageBps', value.slippageBps),
    ...optional('clientIntentId', value.clientIntentId),
  }));

export type AgentClosePositionInput = z.output<typeof agentClosePositionInputSchema>;

/** `denaria_adjust_margin`: USDC in or out of a position's collateral, its
 *  size unchanged. */
export const agentAdjustMarginInputSchema = z
  .object({
    ...positionFields,
    change: z
      .enum(['add', 'remove'])
      .describe('add: deposit USDC as collateral (lower leverage); remove: withdraw it.'),
    amountUsd: agentUsdcAmountSchema.describe('USDC to add or remove, e.g. "10".'),
    slippageBps: slippageField,
    clientIntentId: clientIntentIdField,
  })
  .strict()
  .superRefine(checkPosition)
  .transform((value) => ({
    market: marketOf(value),
    side: value.side,
    change: value.change,
    amountUsd: value.amountUsd,
    ...optional('slippageBps', value.slippageBps),
    ...optional('clientIntentId', value.clientIntentId),
  }));

export type AgentAdjustMarginInput = z.output<typeof agentAdjustMarginInputSchema>;

/** A trigger price in USD, a number or decimal text, normalised to text. */
const priceUsd = z
  .union([z.number().finite(), z.string()])
  .transform((value) => (typeof value === 'number' ? String(value) : value.trim()))
  .pipe(
    z
      .string()
      .regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$/, 'must be a USD price like "64250.5"')
      .refine((value) => Number(value) > 0, 'must be greater than 0'),
  );

/** `denaria_set_tpsl`: a position's take profit and/or stop loss, set or moved. */
export const agentSetTpSlInputSchema = z
  .object({
    ...positionFields,
    takeProfitPriceUsd: priceUsd
      .optional()
      .describe('The take profit trigger price in USD. Moves the existing one if there is one.'),
    stopLossPriceUsd: priceUsd
      .optional()
      .describe('The stop loss trigger price in USD. Moves the existing one if there is one.'),
    slippageBps: slippageField,
    clientIntentId: clientIntentIdField,
  })
  .strict()
  .superRefine((value, ctx) => {
    checkPosition(value, ctx);
    if (value.takeProfitPriceUsd === undefined && value.stopLossPriceUsd === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['takeProfitPriceUsd'],
        message: 'send takeProfitPriceUsd, stopLossPriceUsd or both',
      });
    }
  })
  .transform((value) => ({
    market: marketOf(value),
    side: value.side,
    ...optional('takeProfitPriceUsd', value.takeProfitPriceUsd),
    ...optional('stopLossPriceUsd', value.stopLossPriceUsd),
    ...optional('slippageBps', value.slippageBps),
    ...optional('clientIntentId', value.clientIntentId),
  }));

export type AgentSetTpSlInput = z.output<typeof agentSetTpSlInputSchema>;

/** `denaria_cancel_order`: one pending or frozen GMX order of the account. */
export const agentCancelOrderInputSchema = z
  .object({
    orderKey: z
      .string()
      .trim()
      .transform((value) => value.toLowerCase())
      .pipe(agentBytes32HexSchema)
      .describe('The orderKey from denaria_get_open_orders (or a TP/SL of denaria_get_positions).'),
    clientIntentId: clientIntentIdField,
  })
  .strict()
  .transform((value) => ({
    orderKey: value.orderKey,
    ...optional('clientIntentId', value.clientIntentId),
  }));

export type AgentCancelOrderInput = z.output<typeof agentCancelOrderInputSchema>;

/** `denaria_claim_funding`: every funding fee GMX holds for the account. */
export const agentClaimFundingInputSchema = z
  .object({ clientIntentId: clientIntentIdField })
  .strict()
  .transform((value) => ({ ...optional('clientIntentId', value.clientIntentId) }));

export type AgentClaimFundingInput = z.output<typeof agentClaimFundingInputSchema>;

export const agentOperationReferenceInputSchema = z
  .object({ reference: agentOperationReferenceSchema })
  .strict();

const EXECUTES = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const denariaCreatePosition = {
  name: 'denaria_create_position',
  title: 'Open or add to a Denaria position',
  description:
    "Open (or add to) a GMX market position with USDC collateral, signed by this Signer within the Grant the user approved: no phone. Same input as denaria_prepare_create_position. Refused before anything is sent when it is outside the Grant (market, order size, leverage), when the Grant's window has no operation left, or when slippageBps is above the user's setting (omit it to use the setting). Tell the user the summary, then follow the order with denaria_get_operation_status: submitted is an order on chain, not yet a position.",
  input: agentPrepareCreatePositionInputSchema,
  output: agentOperationSchema,
  annotations: EXECUTES,
  api: { procedure: 'agentSigner.createPosition' },
} as const satisfies AgentAccountToolDefinition;

export const denariaClosePosition = {
  name: 'denaria_close_position',
  title: 'Close a Denaria position',
  description:
    "Close a whole GMX position of the account, signed by this Signer within the Grant: market and side name the position (denaria_get_positions). The position is the account's: in the Grant's markets it may include what the user opened by hand, so ask before touching what you did not open. Tell the user the summary, then follow it with denaria_get_operation_status.",
  input: agentClosePositionInputSchema,
  output: agentOperationSchema,
  annotations: EXECUTES,
  api: { procedure: 'agentSigner.closePosition' },
} as const satisfies AgentAccountToolDefinition;

export const denariaAdjustMargin = {
  name: 'denaria_adjust_margin',
  title: "Add or remove a Denaria position's collateral",
  description:
    'Add USDC collateral to a GMX position of the account (lower leverage, further liquidation) or remove some (higher leverage), its size unchanged, signed by this Signer within the Grant. Market and side name the position (denaria_get_positions). Adding draws on the free USDC, and on savings only if the user allowed it in the Grant. Refused before anything is sent when it is outside the Grant. Tell the user the summary, then follow it with denaria_get_operation_status.',
  input: agentAdjustMarginInputSchema,
  output: agentOperationSchema,
  annotations: EXECUTES,
  api: { procedure: 'agentSigner.adjustMargin' },
} as const satisfies AgentAccountToolDefinition;

export const denariaSetTpSl = {
  name: 'denaria_set_tpsl',
  title: "Set or move a Denaria position's take profit and stop loss",
  description:
    'Set the take profit and/or the stop loss of a GMX position of the account, signed by this Signer within the Grant: each closes the whole position when the price reaches it. One that already exists is moved to the new price. To remove one, cancel its orderKey with denaria_cancel_order. Tell the user the summary: the orders wait for their price (submitted), they are not executed yet.',
  input: agentSetTpSlInputSchema,
  output: agentOperationSchema,
  annotations: EXECUTES,
  api: { procedure: 'agentSigner.setTpSl' },
} as const satisfies AgentAccountToolDefinition;

export const denariaCancelOrder = {
  name: 'denaria_cancel_order',
  title: 'Cancel a Denaria order',
  description:
    "Cancel one pending or frozen GMX order of the account by its orderKey (denaria_get_open_orders, or a take profit or stop loss in denaria_get_positions), signed by this Signer: a limit open gives its collateral back, a take profit or stop loss stops protecting the position. The orders are the account's, so ask before cancelling what you did not place.",
  input: agentCancelOrderInputSchema,
  output: agentOperationSchema,
  annotations: EXECUTES,
  api: { procedure: 'agentSigner.cancelOrder' },
} as const satisfies AgentAccountToolDefinition;

export const denariaClaimFunding = {
  name: 'denaria_claim_funding',
  title: 'Claim the funding fees GMX holds for the account',
  description:
    'Claim every funding fee GMX holds for the account into its USDC, signed by this Signer. Refused when there is nothing to claim. The user may have auto-claim on, in which case the app claims them with each trade.',
  input: agentClaimFundingInputSchema,
  output: agentOperationSchema,
  annotations: EXECUTES,
  api: { procedure: 'agentSigner.claimFunding' },
} as const satisfies AgentAccountToolDefinition;

export const denariaGetAgentOperationStatus = {
  name: 'denaria_get_operation_status',
  title: 'Status of an operation of this agent',
  description:
    'Where an operation of this Signer stands, by its dop_ reference: sending, submitted (an order on chain, not yet a position), executed, cancelled, failed, expired or unknown. "unknown" is final: read the positions and orders before doing it again.',
  input: agentOperationReferenceInputSchema,
  output: agentOperationSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  api: { procedure: 'agentSigner.operation' },
} as const satisfies AgentAccountToolDefinition;

/** Every execution tool the Signer exposes, in `tools/list` order; the
 *  status read (`denariaGetAgentOperationStatus`) follows them. */
export const AGENT_EXECUTION_TOOLS = [
  denariaCreatePosition,
  denariaClosePosition,
  denariaAdjustMargin,
  denariaSetTpSl,
  denariaCancelOrder,
  denariaClaimFunding,
] as const;

/** Where the Signer sends the signature of the hash a step asked for. */
export const AGENT_SUBMIT_OPERATION_PROCEDURE = 'agentSigner.submitOperation' as const;
