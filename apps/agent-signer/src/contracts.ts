/** A lowercase EVM address. */
export type Address = `0x${string}`;

/**
 * The contracts an agent operation may call on each chain the Signer serves
 * (agent-trading Stage 2 ticket 20, grill Q101): the targets of the Grant's
 * call legs, as the Env's config and the GMX and Uniswap deployments name
 * them (`resolveSessionKeyGrantParametersV5`, policy v5, ADR-0065: no
 * Aave, Morpho or USDG leg). The Signer refuses any call to another address,
 * an allowance to another spender and an order that swaps through another
 * market than the Grant's [USDC-USDG] one, before it signs, whatever the API
 * says. A copy, as the
 * single file carries no config package; `test/contracts.test.ts` keeps it
 * equal to the Grant the API builds.
 *
 * The ExchangeRouters are GMX v2.2.1's since Signer 0.2.1 (ADR-0069, ticket
 * 30; 0.1.4 had them first but was never published): v2.2c's stop working
 * around 2026-11-26, so a Signer before 0.2.1 refuses every order of a Grant
 * made on the new router.
 */
export type SignerContracts = {
  readonly usdc: Address;
  readonly weth: Address;
  /** Where every agent operation's flat service fee goes, in USDC. */
  readonly serviceFeeReceiver: Address;
  readonly gmx: {
    readonly exchangeRouter: Address;
    readonly referralStorage: Address;
    /** The spender of the USDC and WETH an order sends (policy v4 pins it). */
    readonly syntheticsRouter: Address;
  };
  /** The keeper-fee swap (USDC → WETH). */
  readonly swapRouter02: Address;
  /** GMX's swap-only [USDC-USDG] market, the one swap hop an order on a USDG
   *  pool may name (policy v5 pins it); null where the chain has no USDG pool. */
  readonly usdcUsdgSwapMarket: Address | null;
  /** USDG, the collateral of the chain's USDG pools: the only collateral a
   *  decrease with that hop may name; null where there is no USDG pool. */
  readonly usdg: Address | null;
};

export const SIGNER_CONTRACTS: Readonly<Record<number, SignerContracts>> = {
  // Arbitrum Sepolia (testnet, demo-staging).
  421614: {
    usdc: '0x3253a335e7bffb4790aa4c25c4250d206e9b9773',
    weth: '0x980b62da83eff3d4576c647993b0c1d7faf17c73',
    serviceFeeReceiver: '0x316f17a37e6ce68d91a761aee087fb3f7195f67b',
    gmx: {
      exchangeRouter: '0x3fb6d5429612588510341ea60aacc282db264295',
      referralStorage: '0xbbcda58c228bb29b5769778181c81ac8ac546c11',
      syntheticsRouter: '0x72f13a44c8ba16a678cad549f17bc9e06d2b8bd2',
    },
    swapRouter02: '0x101f443b4d1b059569d643917553c771e1b9663e',
    usdcUsdgSwapMarket: null,
    usdg: null,
  },
  // Arbitrum One (mainnet).
  42161: {
    usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    weth: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    serviceFeeReceiver: '0xf723f3f37f4a0639ce8daa681ab1762d2ddad485',
    gmx: {
      exchangeRouter: '0x6776c2b52179bc737193de3bc75262681006aa27',
      referralStorage: '0xe6fab3f0c7199b0d34d7fbe83394fc0e0d06e99d',
      syntheticsRouter: '0x7452c558d45f8afc8c83dae62c3f8a5be19c71f6',
    },
    swapRouter02: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
    usdcUsdgSwapMarket: '0x408e8e83d4b8ac4bdeffdf896b49268a5fe5ef44',
    usdg: '0x004b506865409877c9fa29bfb1eba929984b9bbc',
  },
};
