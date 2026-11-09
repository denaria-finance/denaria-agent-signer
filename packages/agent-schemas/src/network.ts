import { z } from 'zod';
import { boundedString, caip2EvmChainIdSchema, envIdSchema } from './primitives.js';

/**
 * The closed table of chains an agent surface may serve, with what their funds
 * are worth. A chain missing here makes `describeAgentNetwork` throw: labelling
 * real funds as test funds (or the reverse) is the one mistake this stamp
 * exists to prevent, so it never guesses.
 */
export const AGENT_NETWORK_CHAINS = {
  42161: { network: 'mainnet', chainName: 'Arbitrum One' },
  421614: { network: 'testnet', chainName: 'Arbitrum Sepolia' },
} as const satisfies Record<number, { network: 'mainnet' | 'testnet'; chainName: string }>;

export type AgentNetworkChainId = keyof typeof AGENT_NETWORK_CHAINS;

const sharedShape = {
  env: envIdSchema,
  chainId: caip2EvmChainIdSchema,
  chainName: boundedString(64),
};

/**
 * Stamped on every tool answer (ADR-0062 §5): which deploy answered, on which
 * chain, and whether the funds are real. Testnet and test funds go together,
 * and a testnet notice always starts with "TEST FUNDS".
 */
export const agentNetworkSchema = z.discriminatedUnion('network', [
  z
    .object({
      ...sharedShape,
      network: z.literal('mainnet'),
      funds: z.literal('real'),
      notice: boundedString(256).regex(/^Real funds/),
    })
    .strict(),
  z
    .object({
      ...sharedShape,
      network: z.literal('testnet'),
      funds: z.literal('test'),
      notice: boundedString(256).regex(/^TEST FUNDS/),
    })
    .strict(),
]);

export type AgentNetwork = z.infer<typeof agentNetworkSchema>;

export function describeAgentNetwork(input: { env: string; chainId: number }): AgentNetwork {
  const chain = (
    AGENT_NETWORK_CHAINS as Record<number, (typeof AGENT_NETWORK_CHAINS)[AgentNetworkChainId]>
  )[input.chainId];
  if (!chain) {
    throw new Error(
      `Chain ${input.chainId} has no agent network label; add it to AGENT_NETWORK_CHAINS before serving agents on it.`,
    );
  }
  const shared = {
    env: input.env,
    chainId: `eip155:${input.chainId}`,
    chainName: chain.chainName,
  };
  return agentNetworkSchema.parse(
    chain.network === 'mainnet'
      ? {
          ...shared,
          network: 'mainnet',
          funds: 'real',
          notice: `Real funds: Denaria ${input.env} on ${chain.chainName}.`,
        }
      : {
          ...shared,
          network: 'testnet',
          funds: 'test',
          notice: `TEST FUNDS: Denaria ${input.env} on the ${chain.chainName} testnet. Nothing here has real value.`,
        },
  );
}

/**
 * The MCP server name a client lists the deploy under (spec: the user has two
 * entries, `denaria` and `denaria-testnet`). The tool names differ too
 * (`agentToolName`).
 */
export const AGENT_SERVER_NAMES = ['denaria', 'denaria-testnet'] as const;

export function agentServerName(network: AgentNetwork): (typeof AGENT_SERVER_NAMES)[number] {
  return network.network === 'mainnet' ? 'denaria' : 'denaria-testnet';
}
