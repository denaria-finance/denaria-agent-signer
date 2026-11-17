import { z } from 'zod';
import type { AgentAccountToolDefinition } from './account-tools.js';
import {
  agentBytes32HexSchema,
  agentClientIntentIdSchema,
  agentUtcTimestampSchema,
} from './handoff.js';
import {
  agentLeverageSchema,
  agentPrepareCreatePositionInputSchema,
  agentUsdcAmountSchema,
} from './handoff-prepare.js';
import { agentNetworkSchema } from './network.js';
import { boundedString, ethAddressSchema, marketIdSchema } from './primitives.js';

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
  'place_limit_order',
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

/** A uint256 as decimal text, as `agent_operations.user_op` stores it. */
const uintTextSchema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/, 'must be a decimal uint256');
const bytesHexSchema = (maxBytes: number) =>
  z
    .string()
    .regex(/^0x([0-9a-f]{2})*$/, 'must be lowercase hex bytes')
    .max(2 + maxBytes * 2);

/**
 * The ERC-4337 v0.7 UserOp the API prepared, every field the hash covers
 * (ticket 20, grill Q101): the Signer recomputes the hash for its own chain
 * and EntryPoint and decodes the call data before it signs. Addresses and
 * bytes lowercase, integers decimal text. `signature` is the placeholder the
 * hash ignores.
 */
export const agentUserOpSchema = z
  .object({
    sender: ethAddressSchema,
    nonce: uintTextSchema,
    factory: ethAddressSchema.optional(),
    factoryData: bytesHexSchema(32_000).optional(),
    callData: bytesHexSchema(64_000),
    callGasLimit: uintTextSchema,
    verificationGasLimit: uintTextSchema,
    preVerificationGas: uintTextSchema,
    maxFeePerGas: uintTextSchema,
    maxPriorityFeePerGas: uintTextSchema,
    paymaster: ethAddressSchema.optional(),
    paymasterVerificationGasLimit: uintTextSchema.optional(),
    paymasterPostOpGasLimit: uintTextSchema.optional(),
    paymasterData: bytesHexSchema(4_000).optional(),
    signature: bytesHexSchema(4_000),
  })
  .strict();

export type AgentUserOp = z.infer<typeof agentUserOpSchema>;

/** The catalog market the API resolved the tool's market to (a trade, a
 *  margin change, a TP/SL); the Signer holds the call data to it. */
export const agentOperationMarketSchema = z
  .object({
    marketId: marketIdSchema,
    /** Quoted in the Signer's refusals, so plain ticker characters only. */
    assetTicker: z.string().regex(/^[A-Za-z0-9._+/-]{1,32}$/, 'must be a ticker'),
    gmxMarketAddress: ethAddressSchema,
    /** For a limit or stop order and a TP/SL: GMX stores a trigger as
     *  USD × 10^(30 − these decimals), so the Signer needs them to read it. */
    indexTokenDecimals: z.number().int().min(0).max(30).optional(),
  })
  .strict();

export type AgentOperationMarket = z.infer<typeof agentOperationMarketSchema>;

/**
 * Between the API and the Signer, not shown to the agent: what to sign next
 * (the whole UserOp and the hash the API computed; one more after a relay
 * fault, the same call data on the same nonce) or the operation as it stands.
 * The Signer checks the UserOp against the tool's request, computes the hash
 * itself and builds the WebAuthn envelope from it (ADR-0062 §13).
 */
export const agentOperationStepSchema = z.discriminatedUnion('step', [
  z
    .object({
      step: z.literal('sign'),
      reference: agentOperationReferenceSchema,
      userOp: agentUserOpSchema,
      userOpHash: agentBytes32HexSchema,
      /** Null for an action with no market of its own (a cancel, a claim). */
      market: agentOperationMarketSchema.nullable(),
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

const orderKeyField = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .pipe(agentBytes32HexSchema);

/**
 * `denaria_place_limit_order` (ticket 19, grill Q91): a GMX limit or stop
 * increase that opens or adds to a position when the price reaches its
 * trigger, with the open's inputs (collateral × leverage is the size). The
 * acceptable price is the trigger moved against the order by the slippage, at
 * most the user's setting. `replacesOrderKey` moves a pending one: a cancel
 * and a new order in one operation (policy v4 refuses `updateOrder` for an
 * agent), so the new one passes every cap again. Never dated: GMX's
 * `validFromTime` is always 0.
 */
export const agentPlaceLimitOrderInputSchema = z
  .object({
    ...positionFields,
    side: z.enum(['long', 'short']).describe('The side of the position it opens or adds to.'),
    orderType: z
      .enum(['limit', 'stop'])
      .describe(
        'limit: a long waits below the current price, a short above it (a better entry). stop: a long waits above it, a short below it (a breakout).',
      ),
    collateralUsd: agentUsdcAmountSchema.describe('USDC collateral, e.g. "25".'),
    leverage: agentLeverageSchema.describe(
      'Leverage, e.g. 3 or "3". Position size = collateral × leverage.',
    ),
    triggerPriceUsd: priceUsd.describe('The trigger price in USD, e.g. "60000".'),
    slippageBps: slippageField.describe(
      "How far past the trigger it may fill, in bps, at most the user's setting. Omit it to use the setting.",
    ),
    replacesOrderKey: orderKeyField
      .optional()
      .describe(
        'To move a pending limit or stop open of this market and side: its orderKey (denaria_get_open_orders). It is cancelled and the new one placed in the same operation.',
      ),
    clientIntentId: clientIntentIdField,
  })
  .strict()
  .superRefine(checkPosition)
  .transform((value) => ({
    market: marketOf(value),
    side: value.side,
    orderType: value.orderType,
    collateralUsd: value.collateralUsd,
    leverage: value.leverage,
    triggerPriceUsd: value.triggerPriceUsd,
    ...optional('slippageBps', value.slippageBps),
    ...optional('replacesOrderKey', value.replacesOrderKey),
    ...optional('clientIntentId', value.clientIntentId),
  }));

export type AgentPlaceLimitOrderInput = z.output<typeof agentPlaceLimitOrderInputSchema>;

/**
 * What a limit or stop order's operation means in each state where it differs
 * from a market order's (ticket 19): placed, it waits for its price, maybe
 * long after the conversation; executed, it is a position; cancelled, by the
 * account or by GMX, its collateral is back. Null where the generic detail holds.
 */
export function agentPendingOrderDetail(state: AgentExecutionState): string | null {
  switch (state) {
    case 'submitted':
      return 'On chain, waiting for its price: it opens or adds to the position only when the price reaches its trigger, maybe after this conversation or after the Grant expires. Cancel it with denaria_cancel_order.';
    case 'executed':
      return 'The price reached the trigger and the GMX keeper executed the order: it is part of the position now.';
    case 'cancelled':
      return 'The order was cancelled before its price was reached (by the account, or by GMX); its collateral is back in the account.';
    default:
      return null;
  }
}

/** `denaria_cancel_order`: one pending or frozen GMX order of the account. */
export const agentCancelOrderInputSchema = z
  .object({
    orderKey: orderKeyField.describe(
      'The orderKey from denaria_get_open_orders (or a TP/SL of denaria_get_positions).',
    ),
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
    "Open (or add to) a GMX market position with USDC collateral, signed by this Signer within the Grant the user approved: no phone. Same input as denaria_prepare_create_position. Refused before anything is sent when it is outside the Grant (market, size per operation, leverage), when the Grant's window has no operation left, or when slippageBps is above the user's setting (omit it to use the setting). Tell the user the summary, then follow the order with denaria_get_operation_status: submitted is an order on chain, not yet a position.",
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
    'Add USDC collateral to a GMX position of the account (lower leverage, further liquidation) or remove some (higher leverage), its size unchanged, signed by this Signer within the Grant. Market and side name the position (denaria_get_positions). Adding draws on the free USDC of the account only, never on savings. Removing needs Margin withdrawal in the Grant (denaria_get_grant): without it, it is refused, and the user turns it on with Renew in the Denaria app. Refused before anything is sent when it is outside the Grant. Tell the user the summary, then follow it with denaria_get_operation_status.',
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

export const denariaPlaceLimitOrder = {
  name: 'denaria_place_limit_order',
  title: 'Place a Denaria limit or stop order to open or add to a position',
  description:
    'Place a GMX limit or stop order that opens (or adds to) a position with USDC collateral when the price reaches its trigger, signed by this Signer within the Grant: a limit to enter at a better price than now, a stop to follow a breakout. Use a market order (denaria_create_position) to trade now. Needs the Grant setting "Pending limit and stop orders": without it, it is refused before anything is signed and the user turns it on by renewing the agent in the Denaria app (Renew). The size and leverage caps and the markets of the Grant apply as for denaria_create_position. To move one, send its orderKey as replacesOrderKey: it is cancelled and the new one placed in one operation; to remove one, denaria_cancel_order. Tell the user that it waits for its price and may execute after this conversation, after the Grant expires, or after a revoke unless the revoke cancels it (a revoke in the Denaria app cancels the agent\'s pending limit and stop orders that Denaria finds; tell the user to check Orders afterwards).',
  input: agentPlaceLimitOrderInputSchema,
  output: agentOperationSchema,
  annotations: EXECUTES,
  api: { procedure: 'agentSigner.placeLimitOrder' },
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
  denariaPlaceLimitOrder,
  denariaCancelOrder,
  denariaClaimFunding,
] as const;

/** Where the Signer sends the signature of the hash a step asked for. */
export const AGENT_SUBMIT_OPERATION_PROCEDURE = 'agentSigner.submitOperation' as const;

/** Where the Signer says it refused a step and signed nothing (ticket 20):
 *  the API fails the operation with the reason, and frees the Grant's slot. */
export const AGENT_ABANDON_OPERATION_PROCEDURE = 'agentSigner.abandonOperation' as const;

export const agentAbandonOperationInputSchema = z
  .object({
    reference: agentOperationReferenceSchema,
    /** What did not match the tool's request, in the Signer's words. */
    reason: boundedString(400),
  })
  .strict();
