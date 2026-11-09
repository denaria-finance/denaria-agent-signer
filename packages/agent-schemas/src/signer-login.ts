import { type AgentPublicKey, agentPublicKeyBytes } from './connect-link.js';

/**
 * How the Denaria Agent Signer signs in to the API with its Session key
 * (ADR-0062 §11): it signs this text, the API rebuilds it from its own Env
 * and chain and checks the signature. Stateless: no challenge is stored, the
 * instant bounds the replay window. The Signer and the API both use this
 * module, so the two ends cannot disagree on the bytes.
 *
 * The text can never be a WebAuthn assertion, so a login signature never
 * authorises a UserOp: the WebAuthnSigner of the Grant verifies a signature
 * over `authenticatorData ‖ sha256(clientDataJSON)`, and for this text to be
 * those bytes its last 32 bytes (printable ASCII of the instant) would have
 * to be a SHA-256 output of a chosen clientDataJSON, a preimage.
 */

export const AGENT_SIGNER_LOGIN_PREFIX = 'Denaria Agent Signer login';
/** How far the signed instant may be from the API's clock, either way. */
export const AGENT_SIGNER_LOGIN_MAX_SKEW_MS = 120_000;

export type AgentSignerLoginStatement = {
  /** The Denaria Env (`config.env`), e.g. `demo-staging`. */
  env: string;
  /** CAIP-2, e.g. `eip155:421614`. */
  chainId: string;
  publicKey: AgentPublicKey;
  /** ISO 8601 instant, as the Signer sends it. */
  signedAt: string;
};

export function agentSignerLoginMessage(statement: AgentSignerLoginStatement): string {
  return [
    AGENT_SIGNER_LOGIN_PREFIX,
    `env: ${statement.env}`,
    `chain: ${statement.chainId}`,
    `key-x: ${statement.publicKey.x}`,
    `key-y: ${statement.publicKey.y}`,
    `signed-at: ${statement.signedAt}`,
  ].join('\n');
}

const SIGNATURE = /^0x[0-9a-f]{128}$/;

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * Whether `signature` (`0x` + r ‖ s, 64 bytes, IEEE P1363) is the key's
 * ECDSA P-256 / SHA-256 signature of the statement's login text. False for
 * any malformed signature or a key off the curve; never throws.
 */
export async function verifyAgentSignerLoginSignature(
  statement: AgentSignerLoginStatement,
  signature: string,
): Promise<boolean> {
  if (!SIGNATURE.test(signature)) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      agentPublicKeyBytes(statement.publicKey) as Uint8Array<ArrayBuffer>,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      hexToBytes(signature),
      new TextEncoder().encode(agentSignerLoginMessage(statement)),
    );
  } catch {
    return false;
  }
}
