import { z } from 'zod';
import { agentOpenEstimateSchema, agentOpenMarketSchema } from './gmx-open.js';
import {
  agentBytes32HexSchema,
  agentClientIntentIdSchema,
  agentHandoffReferenceSchema,
  agentProposalIntentSchema,
  agentUtcTimestampSchema,
} from './handoff.js';
import { agentNetworkSchema } from './network.js';
import { boundedString } from './primitives.js';

export const AGENT_HANDOFF_SCHEMA_VERSION = 'denaria.agent.handoff.v1' as const;

const MARKET_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARKET_SYMBOL = /^([A-Za-z0-9]{1,16})-USD$/i;
const TICKER = /^[A-Za-z0-9]{1,16}$/;

/** A USDC amount, a number or decimal text, normalised to text (6 decimals at most). */
export const agentUsdcAmountSchema = z
  .union([z.number().finite(), z.string()])
  .transform((value) => (typeof value === 'number' ? String(value) : value.trim()))
  .pipe(
    z
      .string()
      .regex(
        /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/,
        'must be a USDC amount with at most 6 decimals',
      )
      .refine((value) => Number(value) > 0, 'must be greater than 0'),
  );

const leverage = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .regex(/^[0-9]+(\.[0-9]+)?$/, 'must be a number like "3"'),
  ])
  .transform(Number)
  .pipe(
    z
      .number()
      .min(1)
      .max(1_000)
      .refine(
        (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9,
        'must have at most two decimals',
      ),
  );

const slippage = z.number().int().min(1).max(5_000);

/**
 * `denaria_prepare_create_position` input: a superset of the external server's
 * (`marketId: "BTC-USD"` or `assetTicker`, `collateralAsset: "USDC"`,
 * `collateralAmount` and `leverage` as strings) and of the quote tool's
 * (`marketId` UUID, `collateralUsd`, numeric leverage). It normalises to one
 * shape. No slippage means the app applies the user's own setting, as the
 * external server documented.
 */
export const agentPrepareCreatePositionInputSchema = z
  .object({
    marketId: z
      .string()
      .max(64)
      .optional()
      .describe('marketId from denaria_get_markets, or a symbol like "BTC-USD".'),
    assetTicker: z
      .string()
      .max(16)
      .optional()
      .describe('Ticker like "BTC", when no marketId is given.'),
    side: z.enum(['long', 'short']),
    collateralAsset: z.literal('USDC').optional().describe('Only USDC. Defaults to USDC.'),
    collateralAmount: agentUsdcAmountSchema
      .optional()
      .describe('USDC collateral, e.g. "30". Same as collateralUsd; send one of them.'),
    collateralUsd: agentUsdcAmountSchema.optional().describe('USDC collateral, e.g. "25" or 25.5.'),
    leverage: leverage.describe('Leverage, e.g. 3 or "3". Position size = collateral × leverage.'),
    slippageBps: slippage
      .optional()
      .describe(
        'Maximum slippage in basis points. Omit it: the Denaria app applies the user setting.',
      ),
    maxSlippageBps: slippage.optional().describe('Alias of slippageBps.'),
    clientIntentId: agentClientIntentIdSchema
      .optional()
      .describe('Your own correlation id, echoed in the proposal.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const symbolTicker = MARKET_SYMBOL.exec(value.marketId ?? '')?.[1]?.toUpperCase();
    if (value.marketId === undefined && value.assetTicker === undefined) {
      ctx.addIssue({ code: 'custom', path: ['marketId'], message: 'send marketId or assetTicker' });
    } else if (
      value.marketId !== undefined &&
      value.assetTicker !== undefined &&
      symbolTicker !== value.assetTicker.toUpperCase()
    ) {
      // Both are accepted (the external server's schema allowed it) only when they agree.
      ctx.addIssue({
        code: 'custom',
        path: ['assetTicker'],
        message: 'marketId and assetTicker name different markets: send one of them',
      });
    } else if (
      value.marketId !== undefined &&
      !MARKET_UUID.test(value.marketId) &&
      !MARKET_SYMBOL.test(value.marketId)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['marketId'],
        message: 'must be a marketId from denaria_get_markets or a symbol like "BTC-USD"',
      });
    } else if (value.assetTicker !== undefined && !TICKER.test(value.assetTicker)) {
      ctx.addIssue({ code: 'custom', path: ['assetTicker'], message: 'must be a ticker like BTC' });
    }
    const amounts = [value.collateralAmount, value.collateralUsd].filter((v) => v !== undefined);
    if (amounts.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['collateralAmount'],
        message: 'send collateralAmount or collateralUsd',
      });
    }
    if (value.slippageBps !== undefined && value.maxSlippageBps !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxSlippageBps'],
        message: 'send slippageBps or maxSlippageBps, not both',
      });
    }
  })
  .transform((value) => {
    const market: { marketId: string } | { assetTicker: string } =
      value.marketId !== undefined && MARKET_UUID.test(value.marketId)
        ? { marketId: value.marketId }
        : {
            assetTicker: (
              value.assetTicker ??
              MARKET_SYMBOL.exec(value.marketId ?? '')?.[1] ??
              ''
            ).toUpperCase(),
          };
    const slippageBps = value.slippageBps ?? value.maxSlippageBps;
    return {
      market,
      side: value.side,
      collateralUsd: (value.collateralUsd ?? value.collateralAmount) as string,
      leverage: value.leverage,
      ...(slippageBps !== undefined ? { slippageBps } : {}),
      ...(value.clientIntentId !== undefined ? { clientIntentId: value.clientIntentId } : {}),
    };
  });

export type AgentPrepareCreatePositionInput = z.output<
  typeof agentPrepareCreatePositionInputSchema
>;

const httpsUrl = z.string().url().max(512);

/** What a client renders: the shape the external server's skill reads. */
export const agentHandoffDisplaySchema = z
  .object({
    qrMarkdown: boundedString(600),
    qrPageUrl: httpsUrl,
    qrImageUrl: httpsUrl,
    handoffUrl: httpsUrl,
    nextStep: boundedString(512),
    summary: boundedString(256),
  })
  .strict();

/**
 * `denaria_prepare_create_position` answer. `result.clientDisplay` and
 * `result.handoff` keep the external server's fields (`qrMarkdown`,
 * `qrPageUrl`, `qrImageUrl`, `nextStep`), so its skill and wrapper keep
 * working; the rest is new.
 */
export const agentHandoffPreparedSchema = z
  .object({
    schemaVersion: z.literal(AGENT_HANDOFF_SCHEMA_VERSION),
    kind: z.literal('handoff'),
    network: agentNetworkSchema,
    /** A handoff authorizes nothing: the user reviews and signs in the app. */
    authorization: z.literal('none'),
    executionPayload: z.literal('none'),
    reference: agentHandoffReferenceSchema,
    proposalHash: agentBytes32HexSchema,
    createdAt: agentUtcTimestampSchema,
    expiresAt: agentUtcTimestampSchema,
    intent: agentProposalIntentSchema,
    clientIntentId: agentClientIntentIdSchema.optional(),
    market: agentOpenMarketSchema,
    estimate: agentOpenEstimateSchema,
    status: z.object({ state: z.literal('awaiting_review'), tool: boundedString(64) }).strict(),
    result: z
      .object({
        clientDisplay: agentHandoffDisplaySchema,
        handoff: z
          .object({
            reference: agentHandoffReferenceSchema,
            handoffUrl: httpsUrl,
            qrMarkdown: boundedString(600),
            qrPageUrl: httpsUrl,
            qrImageUrl: httpsUrl,
            expiresAt: agentUtcTimestampSchema,
          })
          .strict(),
      })
      .strict(),
    notes: z.array(boundedString(512)).max(8),
  })
  .strict();

export type AgentHandoffPrepared = z.infer<typeof agentHandoffPreparedSchema>;

export const agentOperationStatusInputSchema = z
  .object({
    reference: agentHandoffReferenceSchema.describe(
      'The reference denaria_prepare_create_position returned (dhr_…).',
    ),
  })
  .strict();
