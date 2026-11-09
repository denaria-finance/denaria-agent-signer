import { z } from 'zod';
import { agentNetworkSchema } from './network.js';
import {
  boundedString,
  ethAddressSchema,
  isoTimestampSchema,
  marketIdSchema,
  usdNumberSchema,
} from './primitives.js';

/**
 * What the Denaria Agent Signer reads of the user's account once signed in
 * with its Session key (ADR-0062 §3, §11): its own Grant, and the account the
 * Grant is on. The API answers these shapes and the Signer passes them on as
 * tool answers, so both validate the same schema. Every answer carries the
 * network stamp (§5) and the Grant's expiry, so the agent can warn the user
 * before it ends.
 */

export const AGENT_GRANT_SCHEMA_VERSION = 'denaria.agent.grant.v1' as const;
/** The policy's bound on the markets of one Grant (`SESSION_KEY_MAX_MARKETS`). */
export const AGENT_GRANT_MAX_MARKETS = 64;

export const agentPermissionIdSchema = z
  .string()
  .regex(/^0x[0-9a-f]{8}$/, 'must be a lowercase Kernel permission id');

/** The Grant an authenticated answer was read under. */
export const agentGrantStampSchema = z
  .object({
    permissionId: agentPermissionIdSchema,
    /** After this instant the agent can no longer sign in or trade. */
    expiresAt: isoTimestampSchema,
  })
  .strict();

export const agentGrantMarketSchema = z
  .object({
    gmxMarketAddress: ethAddressSchema,
    /** Null when the catalog no longer lists the market. */
    assetTicker: boundedString(32).nullable(),
    displayName: boundedString(128).nullable(),
  })
  .strict();

/** The limits the user approved with the Passkey, enforced on-chain. */
export const agentGrantLimitsSchema = z
  .object({
    markets: z.union([
      z.literal('any'),
      z.array(agentGrantMarketSchema).min(1).max(AGENT_GRANT_MAX_MARKETS),
    ]),
    /** Largest size of one order, in whole USD. */
    maxOrderUsd: z.number().int().positive(),
    /** Largest leverage of a position, e.g. 3 for 3x. */
    maxLeverage: z.number().positive(),
    /** At most this many operations in any window of `windowSeconds`. */
    maxOperationsPerWindow: z.number().int().positive(),
    windowSeconds: z.number().int().positive(),
  })
  .strict();

export const agentGrantSchema = z
  .object({
    schemaVersion: z.literal(AGENT_GRANT_SCHEMA_VERSION),
    network: agentNetworkSchema,
    /** The Denaria smart account the Grant is installed on. */
    account: ethAddressSchema,
    grant: agentGrantStampSchema
      .extend({
        label: boundedString(64).nullable(),
        /** `installed_unconfirmed`: on-chain, but the app has not confirmed it yet. */
        state: z.enum(['active', 'installed_unconfirmed']),
        grantedAt: isoTimestampSchema,
        /** Null only for a Grant from before enrollments, which an agent never has. */
        limits: agentGrantLimitsSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export type AgentGrantStamp = z.infer<typeof agentGrantStampSchema>;
export type AgentGrantLimits = z.infer<typeof agentGrantLimitsSchema>;
export type AgentGrant = z.infer<typeof agentGrantSchema>;
export const AGENT_POSITIONS_SCHEMA_VERSION = 'denaria.agent.positions.v1' as const;
export const AGENT_ORDERS_SCHEMA_VERSION = 'denaria.agent.orders.v1' as const;
export const AGENT_BALANCES_SCHEMA_VERSION = 'denaria.agent.balances.v1' as const;
export const AGENT_ACCOUNT_MAX_ROWS = 256;

const bytes32Schema = z.string().regex(/^0x[0-9a-f]{64}$/, 'must be 32 bytes of lowercase hex');
const marketIdentityShape = {
  marketId: marketIdSchema,
  assetTicker: boundedString(32),
  displayName: boundedString(128),
  gmxMarketAddress: ethAddressSchema,
};

/**
 * Which of the account's markets answered. A GMX read can fail for one
 * market: the answer then lists what it has and names the rest, never
 * pretending to be complete.
 */
export const agentAccountCoverageSchema = z
  .object({
    complete: z.boolean(),
    /** Tickers of the markets that could not be read. */
    unavailableMarkets: z.array(boundedString(32)).max(AGENT_ACCOUNT_MAX_ROWS),
  })
  .strict();

const accountAnswerShape = {
  network: agentNetworkSchema,
  grant: agentGrantStampSchema,
  account: ethAddressSchema,
  observedAt: isoTimestampSchema,
};

/** A TP or SL order attached to a position (GMX LimitDecrease / StopLossDecrease). */
export const agentTriggerOrderSchema = z
  .object({
    orderKey: bytes32Schema,
    triggerPriceUsd: usdNumberSchema.positive(),
    /** USD size it closes; 0 means the whole position. */
    sizeUsd: usdNumberSchema.min(0),
  })
  .strict();

export const agentPositionSchema = z
  .object({
    ...marketIdentityShape,
    side: z.enum(['long', 'short']),
    sizeUsd: usdNumberSchema.min(0),
    collateralUsd: usdNumberSchema.min(0),
    /** GMX's leverage of the position, e.g. 3 for 3x. */
    leverage: z.number().min(0).nullable(),
    entryPriceUsd: usdNumberSchema.positive().nullable(),
    markPriceUsd: usdNumberSchema.positive(),
    liquidationPriceUsd: usdNumberSchema.positive().nullable(),
    /** Before fees. */
    unrealizedPnlUsd: usdNumberSchema,
    pendingBorrowingFeesUsd: usdNumberSchema.min(0),
    /** Positive: the position pays; negative: it receives. */
    pendingFundingFeesUsd: usdNumberSchema,
    lastIncreasedAt: isoTimestampSchema.nullable(),
    takeProfitOrders: z.array(agentTriggerOrderSchema).max(16),
    stopLossOrders: z.array(agentTriggerOrderSchema).max(16),
  })
  .strict();

export const agentPositionsSchema = z
  .object({
    schemaVersion: z.literal(AGENT_POSITIONS_SCHEMA_VERSION),
    ...accountAnswerShape,
    positions: z.array(agentPositionSchema).max(AGENT_ACCOUNT_MAX_ROWS),
    coverage: agentAccountCoverageSchema,
  })
  .strict();

/** GMX order types as the app names them (`OrderType` in the GMX contracts). */
export const AGENT_ORDER_KINDS = [
  'market_open',
  'limit_open',
  'stop_open',
  'market_close',
  'take_profit',
  'stop_loss',
  'liquidation',
  'swap',
  'other',
] as const;

export const agentOrderSchema = z
  .object({
    orderKey: bytes32Schema,
    ...marketIdentityShape,
    side: z.enum(['long', 'short']),
    kind: z.enum(AGENT_ORDER_KINDS),
    /** `frozen`: GMX could not execute it and keeps it until it is cancelled or updated. */
    status: z.enum(['pending', 'frozen']),
    sizeUsd: usdNumberSchema.min(0),
    /** USDC the order carries (an open's collateral). */
    collateralUsd: usdNumberSchema.min(0),
    /** Null for a market order. */
    triggerPriceUsd: usdNumberSchema.positive().nullable(),
    updatedAt: isoTimestampSchema.nullable(),
  })
  .strict();

export const agentOrdersSchema = z
  .object({
    schemaVersion: z.literal(AGENT_ORDERS_SCHEMA_VERSION),
    ...accountAnswerShape,
    orders: z.array(agentOrderSchema).max(AGENT_ACCOUNT_MAX_ROWS),
    coverage: agentAccountCoverageSchema,
  })
  .strict();

export const agentBalancesSchema = z
  .object({
    schemaVersion: z.literal(AGENT_BALANCES_SCHEMA_VERSION),
    ...accountAnswerShape,
    usdc: z
      .object({
        /** USDC held by the smart account, the collateral token of every GMX market here. */
        balance: usdNumberSchema.min(0),
        /** Kept back for closing positions (the user's Trading setting); 0 when off. */
        closeReserve: usdNumberSchema.min(0),
        /** What a new order can take as collateral: balance − close reserve, at least 0. */
        availableForCollateral: usdNumberSchema.min(0),
      })
      .strict(),
    notes: z.array(boundedString(512)).max(8),
  })
  .strict();

export type AgentAccountCoverage = z.infer<typeof agentAccountCoverageSchema>;
export type AgentTriggerOrder = z.infer<typeof agentTriggerOrderSchema>;
export type AgentPosition = z.infer<typeof agentPositionSchema>;
export type AgentPositions = z.infer<typeof agentPositionsSchema>;
export type AgentOrderKind = (typeof AGENT_ORDER_KINDS)[number];
export type AgentOrder = z.infer<typeof agentOrderSchema>;
export type AgentOrders = z.infer<typeof agentOrdersSchema>;
export type AgentBalances = z.infer<typeof agentBalancesSchema>;
