import type { AgentGrantStamp, AgentPublicKey } from '@denaria/agent-schemas';
import { z } from 'zod';
import { SignerError } from './errors.js';

/**
 * The Signer's client of the Denaria API (ADR-0062 §11): tRPC over plain
 * fetch, no client library, no redirect followed. The login is the one call
 * without a credential; every read carries the Signer's token as a Bearer
 * header. Errors are `SignerError`s, so their text may reach the user.
 */

export type SignerLoginInput = {
  env: string;
  chainId: string;
  publicKey: AgentPublicKey;
  signedAt: string;
  signature: string;
};

export type SignerSession = { token: string; expiresAt: string; grant: AgentGrantStamp };

export interface SignerApi {
  login(input: SignerLoginInput): Promise<SignerSession>;
  /** An `agentSigner.*` query; the caller validates the answer. */
  read(procedure: string, token: string, input?: unknown): Promise<unknown>;
  /** An `agentSigner.*` mutation (the execution tools, ADR-0062 §13). */
  mutate(procedure: string, token: string, input: unknown): Promise<unknown>;
}

/** The API refused, with one of its codes (`AGENT_SIGNER.*`). */
export class ApiRefusal extends SignerError {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

/** The API could not be reached or did not answer in its own format. */
export class ApiUnreachable extends SignerError {}

const sessionSchema = z.object({
  token: z.string().min(1).max(4096),
  expiresAt: z.iso.datetime(),
  grant: z.object({
    permissionId: z.string().regex(/^0x[0-9a-f]{8}$/),
    expiresAt: z.iso.datetime(),
  }),
});

const errorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    data: z
      .object({ appCode: z.string().max(64).optional() })
      .partial()
      .optional(),
  }),
});

const MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_MESSAGE = 512;

/** API text is shown to the user through the agent: printable and bounded. */
function cleanMessage(text: string): string {
  let clean = '';
  for (const char of text.slice(0, MAX_MESSAGE)) {
    const code = char.charCodeAt(0);
    clean += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return clean;
}

/** How long the Signer waits for the login and a read. */
const READ_TIMEOUT_MS = 10_000;
/**
 * How long it waits for an operation's step. The API may hold the call while
 * another operation of the Grant is in flight (30 s), until the rate window
 * opens (up to 35 s), or while it waits for the UserOp to land (60 s): its
 * slot lasts 120 s (`AGENT_OPERATION_IN_FLIGHT_MS`), so this waits past it.
 */
const OPERATION_TIMEOUT_MS = 150_000;

export function createSignerApi(options: {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  operationTimeoutMs?: number;
}): SignerApi {
  const doFetch = options.fetch ?? fetch;
  const readTimeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  const operationTimeoutMs = options.operationTimeoutMs ?? OPERATION_TIMEOUT_MS;
  const where = new URL(options.baseUrl).host;

  async function call(
    procedure: string,
    init: RequestInit,
    timeoutMs = readTimeoutMs,
  ): Promise<unknown> {
    const url = new URL(`/trpc/${procedure}`, options.baseUrl);
    let response: Response;
    let text: string;
    try {
      response = await doFetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch {
      throw new ApiUnreachable(`The Denaria API (${where}) did not answer. Try again shortly.`);
    }
    if (text.length > MAX_ANSWER_BYTES) {
      throw new ApiUnreachable(`The Denaria API (${where}) answered too much.`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiUnreachable(
        `The Denaria API (${where}) did not answer (HTTP ${response.status}). Try again shortly.`,
      );
    }
    if (!response.ok) {
      const parsed = errorSchema.safeParse(json);
      const code = parsed.data?.error.data?.appCode;
      if (code === undefined) {
        throw new ApiUnreachable(`The Denaria API (${where}) failed (HTTP ${response.status}).`);
      }
      throw new ApiRefusal(
        code,
        response.status,
        cleanMessage(parsed.data?.error.message ?? `Refused: ${code}.`),
      );
    }
    const result = z.object({ result: z.object({ data: z.unknown() }) }).safeParse(json);
    if (!result.success) {
      throw new ApiUnreachable(`The Denaria API (${where}) answered in an unexpected shape.`);
    }
    return result.data.result.data;
  }

  return {
    async login(input) {
      const data = await call('agentSigner.login', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const session = sessionSchema.safeParse(data);
      if (!session.success) {
        throw new ApiUnreachable(
          `The Denaria API (${where}) answered the login in an unexpected shape.`,
        );
      }
      return session.data;
    },
    read: (procedure, token, input) =>
      call(
        input === undefined
          ? procedure
          : `${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`,
        {
          method: 'GET',
          headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        },
      ),
    mutate: (procedure, token, input) =>
      call(
        procedure,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(input),
        },
        operationTimeoutMs,
      ),
  };
}
