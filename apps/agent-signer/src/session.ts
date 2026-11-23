import { ApiRefusal, type SignerApi, type SignerSession } from './api.js';
import type { SignerTarget } from './envs.js';
import { publicKeyRefOf, type SessionKey } from './session-key.js';

/** A token this close to its end is renewed before the call, not after a refusal. */
const RENEW_BEFORE_MS = 30_000;
const UNAUTHENTICATED = 'AGENT_SIGNER.UNAUTHENTICATED';

/**
 * The Signer signed in to the API with its Session keys (ADR-0062 §11): it
 * logs in on demand, keeps the token in memory only (never on disk: it is
 * worth 15 minutes and a login costs one signature), renews it before it
 * runs out, and logs in once more when the API asks (a renewal superseded the
 * Grant the token named). A token belongs to one key, and each key keeps its
 * own (multi-strategy agents: one login per agent), so a call for one agent
 * never uses another's token and never ends another's session. A rotated key
 * logs in afresh.
 */
export function createAgentSession(options: {
  target: SignerTarget;
  api: SignerApi;
  now: () => number;
}) {
  const { target, api, now } = options;
  const chainId = `eip155:${target.chainId}`;
  const tokens = new Map<string, { token: string; expiresAtMs: number }>();
  const pending = new Map<string, Promise<SignerSession>>();

  async function signIn(key: SessionKey): Promise<SignerSession> {
    const signedAt = new Date(now()).toISOString();
    const session = await api.login({
      env: target.env,
      chainId,
      publicKey: key.publicKey,
      signedAt,
      signature: key.signLogin({ env: target.env, chainId, signedAt }),
    });
    tokens.set(publicKeyRefOf(key), {
      token: session.token,
      expiresAtMs: Date.parse(session.expiresAt),
    });
    return session;
  }

  /** A fresh login with `key`; parallel callers for the same key share one. */
  function login(key: SessionKey): Promise<SignerSession> {
    const id = publicKeyRefOf(key);
    const running = pending.get(id);
    if (running !== undefined) return running;
    const run = signIn(key).finally(() => {
      if (pending.get(id) === run) pending.delete(id);
    });
    pending.set(id, run);
    return run;
  }

  async function token(key: SessionKey): Promise<string> {
    const current = tokens.get(publicKeyRefOf(key));
    if (current !== undefined && current.expiresAtMs - now() > RENEW_BEFORE_MS) {
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
      tokens.delete(publicKeyRefOf(key));
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
    /** Forget the token of `key` (it was rotated away). */
    forget(key: SessionKey): void {
      tokens.delete(publicKeyRefOf(key));
    },
  };
}

export type AgentSession = ReturnType<typeof createAgentSession>;
