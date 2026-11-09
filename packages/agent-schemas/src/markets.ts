import { z } from 'zod';
import { agentNetworkSchema } from './network.js';
import {
  boundedString,
  ethAddressSchema,
  isoTimestampSchema,
  marketIdSchema,
  usdNumberSchema,
} from './primitives.js';

export const AGENT_MARKETS_SCHEMA_VERSION = 'denaria.agent.markets.v1' as const;
export const AGENT_MARKETS_MAX = 256;

export const agentMarketSchema = z
  .object({
    marketId: marketIdSchema,
    venue: z.literal('gmx'),
    assetTicker: boundedString(32),
    displayName: boundedString(128),
    gmxMarketAddress: ethAddressSchema,
    /** The live price the app's market list shows; null when it is unavailable. */
    priceUsd: usdNumberSchema.positive().nullable(),
    /** GMX's per-market cap the app's order sheet uses; null when GMX did not answer. */
    maxLeverage: z.number().positive().nullable(),
  })
  .strict();

export const agentMarketsSchema = z
  .object({
    schemaVersion: z.literal(AGENT_MARKETS_SCHEMA_VERSION),
    network: agentNetworkSchema,
    usage: z.literal('market_data_only_not_trading_authorization'),
    observedAt: isoTimestampSchema,
    markets: z.array(agentMarketSchema).max(AGENT_MARKETS_MAX),
  })
  .strict();

export type AgentMarket = z.infer<typeof agentMarketSchema>;
export type AgentMarkets = z.infer<typeof agentMarketsSchema>;
