import { z } from 'zod';
import { AGENT_SERVER_NAMES, agentNetworkSchema } from './network.js';
import { boundedString, caip2EvmChainIdSchema } from './primitives.js';

export const AGENT_CAPABILITIES_SCHEMA_VERSION = 'denaria.agent.capabilities.v1' as const;

/**
 * Zero authority (ADR-0062 §4): the remote service holds no account, no key
 * and no credential, and never produces anything executable. Its QR handoff
 * is an unsigned Proposal with no calldata: the app builds the transaction
 * and the user signs it.
 */
export const agentAuthoritySchema = z
  .object({
    mode: z.literal('zero_authority'),
    buildsTransactions: z.literal(false),
    signs: z.literal(false),
    submits: z.literal(false),
    delegates: z.literal(false),
    holdsCredentials: z.literal(false),
  })
  .strict();

export const AGENT_ZERO_AUTHORITY = {
  mode: 'zero_authority',
  buildsTransactions: false,
  signs: false,
  submits: false,
  delegates: false,
  holdsCredentials: false,
} as const satisfies z.infer<typeof agentAuthoritySchema>;

export const agentCapabilitiesSchema = z
  .object({
    schemaVersion: z.literal(AGENT_CAPABILITIES_SCHEMA_VERSION),
    network: agentNetworkSchema,
    server: z
      .object({
        name: z.enum(AGENT_SERVER_NAMES),
        version: boundedString(32),
      })
      .strict(),
    authority: agentAuthoritySchema,
    venues: z.array(z.object({ venue: z.literal('gmx'), chainId: caip2EvmChainIdSchema }).strict()),
    tools: z.array(
      z
        .object({
          name: boundedString(64),
          title: boundedString(128),
          rest: z.object({ method: z.enum(['GET', 'POST']), path: boundedString(64) }).strict(),
        })
        .strict(),
    ),
    /** How a trade can happen, since this server never executes one. */
    execution: z
      .object({
        handoff: z.object({ available: z.boolean(), detail: boundedString(512) }).strict(),
        autonomous: z
          .object({
            available: z.boolean(),
            requires: z.literal('denaria_agent_signer'),
            detail: boundedString(512),
          })
          .strict(),
      })
      .strict(),
    guidance: z.array(boundedString(512)).max(8),
  })
  .strict();

export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;
