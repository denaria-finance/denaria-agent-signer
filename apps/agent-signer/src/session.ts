import { ApiRefusal, type SignerApi, type SignerSession } from './api.js';
import type { SignerTarget } from './envs.js';
import type { SessionKey } from './session-key.js';

/** A token this close to its end is renewed before the call, not after a refusal. */
const RENEW_BEFORE_MS = 30_000;
const UNAUTHENTICATED = 'AGENT_SIGNER.UNAUTHENTICATED';

/**
 * The Signer signed in to the API with its Session key (ADR-0062 §11): it
 * logs in on demand, keeps the token in memory only (never on disk: it is
 * worth 15 minutes and a login costs one signature), renews it before it
 * runs out, and logs in once more when the API asks (a renewal superseded the
 * Grant the token named). A token belongs to one key: a rotated key logs in
 * afresh.
 */
export function createAgentSession(options: {
  target: SignerTarget;
  api: SignerApi;
  now: () => number;
}) {
  const { target, api, now } = options;
  const chainId = `eip155:${target.chainId}`;
  let current: { keyX: string; token: string; expiresAtMs: number } | null = null;
  let pending: { keyX: string; login: Promise<SignerSession> } | null = null;

  async function signIn(key: SessionKey): Promise<SignerSession> {
    const signedAt = new Date(now()).toISOString();
    const session = await api.login({
      env: target.env,
      chainId,
      publicKey: key.publicKey,
      signedAt,
      signature: key.signLogin({ env: target.env, chainId, signedAt }),
    });
    current = {
      keyX: key.publicKey.x,
      token: session.token,
      expiresAtMs: Date.parse(session.expiresAt),
    };
    return session;
  }

  /** A fresh login with `key`; parallel callers share one. */
  function login(key: SessionKey): Promise<SignerSession> {
    if (pending?.keyX === key.publicKey.x) return pending.login;
    const run = signIn(key).finally(() => {
      if (pending?.login === run) pending = null;
    });
    pending = { keyX: key.publicKey.x, login: run };
    return run;
  }

  async function token(key: SessionKey): Promise<string> {
    if (
      current !== null &&
      current.keyX === key.publicKey.x &&
      current.expiresAtMs - now() > RENEW_BEFORE_MS
    ) {
      return current.token;
    }
    return (await login(key)).token;
  }

  /** A call with the key's token; once more after a fresh login when the API
   *  no longer takes it. */
  async function asKey<T>(key: SessionKey, run: (token: string) => Promise<T>): Promise<T> {
    try {
      return await run(await token(key));
    } catch (error) {
      if (!(error instanceof ApiRefusal) || error.code !== UNAUTHENTICATED) throw error;
      current = null;
      return run((await login(key)).token);
    }
  }

  return {
    login,
    /** An `agentSigner.*` read as `key`, signing in as needed. */
    read(key: SessionKey, procedure: string, input?: unknown): Promise<unknown> {
      return asKey(key, (t) => api.read(procedure, t, input));
    },
    /** An `agentSigner.*` mutation as `key`, signing in as needed. */
    mutate(key: SessionKey, procedure: string, input: unknown): Promise<unknown> {
      return asKey(key, (t) => api.mutate(procedure, t, input));
    },
    /** Forget the token (the key was rotated). */
    reset(): void {
      current = null;
    },
  };
}

export type AgentSession = ReturnType<typeof createAgentSession>;
