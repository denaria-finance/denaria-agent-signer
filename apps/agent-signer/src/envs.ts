/** Kept equal to `package.json` by `test/envs.test.ts`. */
export const SIGNER_VERSION = '0.1.1';

export const SIGNER_NAME = 'denaria-agent-signer';

export type SignerTargetName = 'testnet' | 'mainnet';

export type SignerTarget = {
  /** The Denaria Env this target talks to. */
  readonly env: string;
  /** The PWA origin the connect link opens (the Env's `auth.rpOrigin`). */
  readonly pwaOrigin: string;
  /** The Denaria API the Signer signs in to and reads from (the Env's `apiBaseUrl`). */
  readonly apiBaseUrl: string;
  /** The chain its Grants live on (the Env's `markets.chainId`). */
  readonly chainId: number;
};

/**
 * The two Envs the Signer serves (agent-trading Stage 2 Q56), chosen once at
 * install with `--env`. A copy of `@denaria/config`, which the single file
 * does not carry; `test/envs.test.ts` keeps it equal.
 */
export const SIGNER_TARGETS: Readonly<Record<SignerTargetName, SignerTarget>> = {
  testnet: {
    env: 'demo-staging',
    pwaOrigin: 'https://pwa-demo-staging.denaria.finance',
    apiBaseUrl: 'https://api.demo-staging.denaria.finance',
    chainId: 421614,
  },
  mainnet: {
    env: 'mainnet',
    pwaOrigin: 'https://denaria.app',
    apiBaseUrl: 'https://api.denaria.finance',
    chainId: 42161,
  },
};

/**
 * The API the Signer talks to: its Env's, or a loopback one for a local API
 * or the end-to-end test (`DENARIA_SIGNER_API_URL`). Any other override is
 * refused: an agent's environment must not point the key at another host.
 */
export function apiBaseUrlOf(target: SignerTarget, override: string | undefined): string {
  if (override === undefined || override === '') return target.apiBaseUrl;
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Error('DENARIA_SIGNER_API_URL is not a URL');
  }
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'http:' || !loopback) {
    throw new Error(
      'DENARIA_SIGNER_API_URL may only point at http://127.0.0.1 or http://localhost',
    );
  }
  return url.origin;
}
