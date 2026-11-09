import { z } from 'zod';
import { agentNetworkSchema } from './network.js';
import {
  boundedString,
  ethAddressSchema,
  isoTimestampSchema,
  marketIdSchema,
  usdNumberSchema,
} from './primitives.js';

export const AGENT_OPEN_QUOTE_SCHEMA_VERSION = 'denaria.agent.gmx-open-quote.v1' as const;
export const AGENT_OPEN_SIMULATION_SCHEMA_VERSION = 'denaria.agent.gmx-open-simulation.v1' as const;

/** The app's default slippage (apps/pwa/src/trade/constants.ts DEFAULT_SLIPPAGE_PCT = 1). */
export const AGENT_DEFAULT_SLIPPAGE_BPS = 100;
export const AGENT_MAX_SLIPPAGE_BPS = 5_000;
export const AGENT_MAX_NOTES = 8;

/**
 * A hypothetical new GMX market position with USDC collateral, in the inputs
 * the app's order sheet takes: collateral, leverage, side, slippage.
 */
export const agentOpenIntentSchema = z
  .object({
    marketId: marketIdSchema.describe('marketId from denaria_get_markets.'),
    side: z.enum(['long', 'short']),
    collateralUsd: z
      .union([z.number().finite(), z.string()])
      .transform((value) => (typeof value === 'number' ? String(value) : value))
      .pipe(
        z
          .string()
          .regex(
            /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/,
            'must be a USDC amount with at most 6 decimals',
          )
          .refine((value) => Number(value) > 0, 'must be greater than 0'),
      )
      .describe('USDC collateral, e.g. "25" or 25.5. Normalised to a decimal string.'),
    leverage: z
      .number()
      .min(1)
      .max(1_000)
      .refine(
        (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9,
        'must have at most two decimals',
      )
      .describe('Leverage, e.g. 3 for 3x. Position size = collateral × leverage.'),
    slippageBps: z
      .number()
      .int()
      .min(1)
      .max(AGENT_MAX_SLIPPAGE_BPS)
      .default(AGENT_DEFAULT_SLIPPAGE_BPS)
      .describe('Maximum slippage in basis points. Defaults to the app default, 100 (1%).'),
  })
  .strict();

/** The market an estimate is for. */
export const agentOpenMarketSchema = z
  .object({
    marketId: marketIdSchema,
    assetTicker: boundedString(32),
    displayName: boundedString(128),
    gmxMarketAddress: ethAddressSchema,
    maxLeverage: z.number().positive().nullable(),
  })
  .strict();

/** The figures the app's GMX order sheet shows, in USD unless named otherwise. */
export const agentOpenEstimateSchema = z
  .object({
    markPriceUsd: usdNumberSchema.positive(),
    acceptablePriceUsd: usdNumberSchema.positive(),
    positionSizeUsd: usdNumberSchema.positive(),
    collateralUsd: usdNumberSchema.positive(),
    collateralAfterFeesUsd: usdNumberSchema.min(0),
    effectiveLeverage: z.number().min(0),
    liquidationPriceUsd: usdNumberSchema.positive().nullable(),
    priceImpactUsd: usdNumberSchema,
    priceImpactPct: z.number().finite(),
    tradingFeeUsd: usdNumberSchema,
    executionFeeUsd: usdNumberSchema.min(0),
    serviceFeeUsd: usdNumberSchema.min(0),
    /** Size GMX can still open on this side; null when it could not be computed. */
    availableLiquidityUsd: usdNumberSchema.min(0).nullable(),
    hasEnoughLiquidity: z.boolean(),
  })
  .strict();

const estimateEnvelope = {
  network: agentNetworkSchema,
  authorization: z.literal('none'),
  executionPayload: z.literal('none'),
  request: agentOpenIntentSchema,
  market: agentOpenMarketSchema,
  estimate: agentOpenEstimateSchema,
  observedAt: isoTimestampSchema,
  notes: z.array(boundedString(512)).max(AGENT_MAX_NOTES),
};

export const agentOpenQuoteSchema = z
  .object({
    schemaVersion: z.literal(AGENT_OPEN_QUOTE_SCHEMA_VERSION),
    kind: z.literal('estimate'),
    ...estimateEnvelope,
  })
  .strict();

export const AGENT_OPEN_CHECKS = [
  'side_liquidity',
  'minimum_collateral_after_fees',
  'leverage_within_market_max',
] as const;

export const AGENT_ACCOUNT_CHECKS_NOT_RUN = [
  'usdc_balance',
  'close_reserve',
  'aave_morpho_top_up',
  'existing_position',
] as const;

export const agentOpenCheckSchema = z
  .object({
    name: z.enum(AGENT_OPEN_CHECKS),
    status: z.enum(['pass', 'fail', 'unknown']),
    detail: boundedString(256),
  })
  .strict();

export const agentOpenSimulationSchema = z
  .object({
    schemaVersion: z.literal(AGENT_OPEN_SIMULATION_SCHEMA_VERSION),
    kind: z.literal('simulation'),
    ...estimateEnvelope,
    checks: z.array(agentOpenCheckSchema).length(AGENT_OPEN_CHECKS.length),
    /** True when no check failed: the app would let the user place this order, account permitting. */
    passesAppChecks: z.boolean(),
    /** The app's own blocking message for the first failing check, or null. */
    blockingReason: boundedString(256).nullable(),
    accountChecks: z
      .object({
        status: z.literal('not_checked'),
        notChecked: z.array(z.enum(AGENT_ACCOUNT_CHECKS_NOT_RUN)),
        reason: boundedString(256),
      })
      .strict(),
  })
  .strict();

export type AgentOpenIntent = z.output<typeof agentOpenIntentSchema>;
export type AgentOpenEstimate = z.infer<typeof agentOpenEstimateSchema>;
export type AgentOpenQuote = z.infer<typeof agentOpenQuoteSchema>;
export type AgentOpenCheck = z.infer<typeof agentOpenCheckSchema>;
export type AgentOpenSimulation = z.infer<typeof agentOpenSimulationSchema>;
