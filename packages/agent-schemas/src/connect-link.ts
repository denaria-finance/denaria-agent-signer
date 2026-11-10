import { AGENT_NETWORK_CHAINS } from './network.js';

/**
 * The link the Denaria Agent Signer's `connect` returns (ADR-0062,
 * agent-trading Stage 2 Q56, Q58): it opens the PWA's Connect agent screen
 * on its Env's origin with the Signer's public key, the chain it serves and
 * the label the agent proposed. Everything rides in the URL fragment, which
 * the Browser never sends to a server. The Signer and the PWA both use this
 * module, so the two ends cannot disagree on the format.
 *
 * The key is a P-256 point, the Session key the WebAuthnSigner verifies
 * (Q53). The fingerprint is what the user compares between the terminal and
 * the phone before the Passkey signs: a link carrying someone else's key
 * shows another fingerprint.
 */

export const AGENT_CONNECT_PATH = '/agent/connect';
export const AGENT_CONNECT_LINK_VERSION = '1';
/** The registry's label bound (`session_keys.device_label`). */
export const AGENT_LABEL_MAX_LENGTH = 64;

/**
 * The PWA's "Connect an agent" guide (agent-trading Stage 2 ticket 16,
 * ADR-0062 §18), which the Signer's messages link to. `/agents/setup`, not
 * `/agents/connect`: the two would differ from `AGENT_CONNECT_PATH` by one
 * letter. The tab is in `?client=`, so a link opens a client's own tab.
 */
export const AGENT_SETUP_PATH = '/agents/setup';

/** The guide's tabs, in their order. */
export const AGENT_SETUP_CLIENTS = ['claude-code', 'codex', 'other'] as const;
export type AgentSetupClient = (typeof AGENT_SETUP_CLIENTS)[number];

export function agentSetupPath(client?: AgentSetupClient): string {
  return client === undefined ? AGENT_SETUP_PATH : `${AGENT_SETUP_PATH}?client=${client}`;
}

/** The guide on a PWA origin (`auth.rpOrigin` of the Env), on a tab if given. */
export function agentSetupUrl(pwaOrigin: string, client?: AgentSetupClient): string {
  return new URL(agentSetupPath(client), pwaOrigin).toString();
}

/** A P-256 coordinate: `0x` + 64 lowercase hex, as the registry stores it. */
export type AgentKeyCoordinate = `0x${string}`;
export type AgentPublicKey = { x: AgentKeyCoordinate; y: AgentKeyCoordinate };

export type AgentConnectLink = {
  publicKey: AgentPublicKey;
  /** CAIP-2, one of `AGENT_NETWORK_CHAINS`. */
  chainId: string;
  label: string | null;
};

export type AgentConnectLinkRefusal = 'version' | 'key' | 'network' | 'label';

const COORDINATE = /^0x[0-9a-f]{64}$/;

/** The uncompressed SEC 1 encoding of the key, `04 ‖ x ‖ y`. */
export function agentPublicKeyBytes(key: AgentPublicKey): Uint8Array {
  const bytes = new Uint8Array(65);
  bytes[0] = 0x04;
  bytes.set(hexBytes(key.x), 1);
  bytes.set(hexBytes(key.y), 33);
  return bytes;
}

function hexBytes(hex: string): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(body.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function bytesHex(bytes: Uint8Array): AgentKeyCoordinate {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The Connect agent URL on a PWA origin (`auth.rpOrigin` of the Env). */
export function agentConnectUrl(pwaOrigin: string, link: AgentConnectLink): string {
  const params = new URLSearchParams({
    v: AGENT_CONNECT_LINK_VERSION,
    k: base64url(agentPublicKeyBytes(link.publicKey)),
    n: link.chainId,
  });
  if (link.label !== null) params.set('l', link.label);
  return `${new URL(AGENT_CONNECT_PATH, pwaOrigin).toString()}#${params.toString()}`;
}

/** True when the bytes are an uncompressed point of P-256 (WebCrypto checks
 *  the curve equation on import). */
async function isP256Point(point: Uint8Array): Promise<boolean> {
  try {
    await crypto.subtle.importKey(
      'raw',
      point as Uint8Array<ArrayBuffer>,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return true;
  } catch {
    return false;
  }
}

/** The link a Connect agent URL's fragment (`location.hash`) carries, or why
 *  the screen must refuse it. The chain is checked against the chains agents
 *  are served on; whether it is this PWA's own Env is the screen's check. */
export async function parseAgentConnectLink(
  fragment: string,
): Promise<{ ok: true; link: AgentConnectLink } | { ok: false; reason: AgentConnectLinkRefusal }> {
  const params = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment);
  if (params.get('v') !== AGENT_CONNECT_LINK_VERSION) return { ok: false, reason: 'version' };
  const point = fromBase64url(params.get('k') ?? '');
  if (point === null || point.length !== 65 || point[0] !== 0x04 || !(await isP256Point(point))) {
    return { ok: false, reason: 'key' };
  }
  const chainId = params.get('n') ?? '';
  const numeric = /^eip155:([1-9][0-9]*)$/.exec(chainId)?.[1];
  if (numeric === undefined || !(Number(numeric) in AGENT_NETWORK_CHAINS)) {
    return { ok: false, reason: 'network' };
  }
  const rawLabel = params.get('l');
  const label = rawLabel === null ? null : rawLabel.trim();
  if (label !== null && (label.length === 0 || label.length > AGENT_LABEL_MAX_LENGTH)) {
    return { ok: false, reason: 'label' };
  }
  const publicKey = { x: bytesHex(point.slice(1, 33)), y: bytesHex(point.slice(33)) };
  if (!COORDINATE.test(publicKey.x) || !COORDINATE.test(publicKey.y)) {
    return { ok: false, reason: 'key' };
  }
  return { ok: true, link: { publicKey, chainId, label } };
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The verification fingerprint of a Session key: the first 40 bits of
 *  sha256(04 ‖ x ‖ y) in Crockford base32, `XXXX-XXXX`. */
export async function agentKeyFingerprint(publicKey: AgentPublicKey): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      agentPublicKeyBytes(publicKey) as Uint8Array<ArrayBuffer>,
    ),
  );
  let bits = 0n;
  for (const b of digest.slice(0, 5)) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 7; i >= 0; i--) out += CROCKFORD[Number((bits >> BigInt(5 * i)) & 31n)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}
