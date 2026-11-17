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
 * (Q53). What the user compares between the terminal and the phone before
 * the Passkey signs is the connection code (Q147): a hash of the key and of
 * a one-time value `connect` draws for each link, which no one else knows
 * before the link exists. The key's fingerprint is public once a Grant of
 * the key is on-chain, so a key with the same 40 bits can be ground for it;
 * it stays the key's name where the key comes from the user's own Grant.
 */

export const AGENT_CONNECT_PATH = '/agent/connect';
/** 2: the link carries the one-time value of the connection code (Q147). */
export const AGENT_CONNECT_LINK_VERSION = '2';
/** A link's one-time value: 16 random bytes in canonical base64url. */
export const AGENT_CONNECT_NONCE = /^[A-Za-z0-9_-]{21}[AQgw]$/;
/** Its key in the fragment: `r` is the reuse reference's. */
const NONCE_PARAM = 's';
/** The registry's label bound (`session_keys.device_label`). */
export const AGENT_LABEL_MAX_LENGTH = 64;

/**
 * The PWA's "Connect an agent" guide (agent-trading Stage 2 ticket 16,
 * ADR-0062 §18), which the Signer's messages link to: a page of Settings
 * (Access & security → Connect an agent), opened over Portfolio by the
 * Settings deep link `?settings=connect-agent`. Portfolio, not Trade: Trade
 * redirects to a market and would drop the query. The tab is in `?client=`,
 * so a link opens a client's own tab. A link opened logged out leads to the
 * login, not to the guide.
 */
export const AGENT_SETUP_SETTINGS_PAGE = 'connect-agent';

/** The guide's tabs, in their order. */
export const AGENT_SETUP_CLIENTS = ['claude-code', 'codex', 'other'] as const;
export type AgentSetupClient = (typeof AGENT_SETUP_CLIENTS)[number];

export function agentSetupPath(client?: AgentSetupClient): string {
  const page = `/portfolio?settings=${AGENT_SETUP_SETTINGS_PAGE}`;
  return client === undefined ? page : `${page}&client=${client}`;
}

/** The guide on a PWA origin (`auth.rpOrigin` of the Env), on a tab if given. */
export function agentSetupUrl(pwaOrigin: string, client?: AgentSetupClient): string {
  return new URL(agentSetupPath(client), pwaOrigin).toString();
}

/**
 * The renewal screen of an agent's Grant (ADR-0062 §12, ticket 09), the path
 * the expiry push opens (`AGENT_GRANT_RENEWAL_PATH_PREFIX` in
 * `@denaria/core`). The Signer links to it when an agent asks to reuse a key
 * whose Grant is live (ticket 20, Q102): the owner approves that agent by
 * renewing the key's Grant with the Passkey. It carries no key: the screen
 * renews the registry row's.
 */
export const AGENT_RENEW_PATH_PREFIX = '/agent/renew/';

/**
 * A reuse request (ticket 20, Q102; review round 1 A2): the one-time reference
 * the Signer drew for the client that asked to reuse a key (16 random bytes,
 * base64url), and that client's name. The renewal or connect link it gives
 * carries both after the #; the screen names the client and enrols the Grant
 * with the reference, and only a Grant of the key carrying it approves that
 * client. Another renewal of the key (the expiry push, Agents) approves none.
 */
export type AgentReuse = { reference: string; client: string | null };

export const AGENT_REUSE_REFERENCE = /^[A-Za-z0-9_-]{22}$/;

function setReuse(params: URLSearchParams, reuse: AgentReuse): void {
  if (!AGENT_REUSE_REFERENCE.test(reuse.reference)) throw new Error('Invalid reuse reference');
  params.set('r', reuse.reference);
  if (reuse.client !== null) params.set('c', reuse.client);
}

export function agentRenewUrl(pwaOrigin: string, permissionId: string, reuse?: AgentReuse): string {
  if (!/^0x[0-9a-f]{8}$/.test(permissionId)) throw new Error('Invalid permission id');
  const url = new URL(`${AGENT_RENEW_PATH_PREFIX}${permissionId}`, pwaOrigin).toString();
  if (reuse === undefined) return url;
  const params = new URLSearchParams();
  setReuse(params, reuse);
  return `${url}#${params.toString()}`;
}

/** A client name the screen can show: a label's length, no control characters. */
function clientOf(raw: string | null): string | null {
  const client = raw?.trim() ?? '';
  if (client.length === 0 || client.length > AGENT_LABEL_MAX_LENGTH) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  return /[\u0000-\u001f\u007f-\u009f]/.test(client) ? null : client;
}

/** The reuse request a renewal or connect link's fragment carries, or null:
 *  none, or a reference that is not one (the screen then approves no client). */
export function parseAgentReuse(fragment: string): AgentReuse | null {
  const params = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment);
  const reference = params.get('r');
  if (reference === null || !AGENT_REUSE_REFERENCE.test(reference)) return null;
  return { reference, client: clientOf(params.get('c')) };
}

/** A P-256 coordinate: `0x` + 64 lowercase hex, as the registry stores it. */
export type AgentKeyCoordinate = `0x${string}`;
export type AgentPublicKey = { x: AgentKeyCoordinate; y: AgentKeyCoordinate };

export type AgentConnectLink = {
  publicKey: AgentPublicKey;
  /** CAIP-2, one of `AGENT_NETWORK_CHAINS`. */
  chainId: string;
  label: string | null;
  /** The one-time value of the connection code (`AGENT_CONNECT_NONCE`). */
  nonce: string;
  /** A reuse request's link (ticket 20): the key's Grant approves this client. */
  reuse?: AgentReuse;
};

/** `version` also refuses a link without the one-time value: the 0.1.2
 *  Signer's, which has no connection code (Q147). */
export type AgentConnectLinkRefusal = 'version' | 'key' | 'nonce' | 'network' | 'label';

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

/** A new one-time value for a link: `connect` draws one for every link. */
export function agentConnectNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

function nonceBytes(nonce: string): Uint8Array {
  const bytes = AGENT_CONNECT_NONCE.test(nonce) ? fromBase64url(nonce) : null;
  if (bytes === null || bytes.length !== 16) throw new Error('Invalid connect link value');
  return bytes;
}

/** The Connect agent URL on a PWA origin (`auth.rpOrigin` of the Env). */
export function agentConnectUrl(pwaOrigin: string, link: AgentConnectLink): string {
  nonceBytes(link.nonce);
  const params = new URLSearchParams({
    v: AGENT_CONNECT_LINK_VERSION,
    [NONCE_PARAM]: link.nonce,
    k: base64url(agentPublicKeyBytes(link.publicKey)),
    n: link.chainId,
  });
  if (link.label !== null) params.set('l', link.label);
  if (link.reuse !== undefined) setReuse(params, link.reuse);
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
  const nonce = params.get(NONCE_PARAM);
  if (nonce === null) return { ok: false, reason: 'version' };
  if (!AGENT_CONNECT_NONCE.test(nonce)) return { ok: false, reason: 'nonce' };
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
  const reuse = parseAgentReuse(fragment);
  return {
    ok: true,
    link: { publicKey, chainId, label, nonce, ...(reuse === null ? {} : { reuse }) },
  };
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The fingerprint of a Session key, its stable name: the first 40 bits of
 *  sha256(04 ‖ x ‖ y) in Crockford base32, `XXXX-XXXX`. It names a key that
 *  comes from the user's own Grant (the Signer's key list, Renew, another
 *  computer's key); a connect link is checked with `agentConnectCode`. */
export async function agentKeyFingerprint(publicKey: AgentPublicKey): Promise<string> {
  return shortCode(agentPublicKeyBytes(publicKey));
}

/** The connection code of a connect link (Q147), what the terminal and the
 *  Connect agent screen show and the user compares: the first 40 bits of
 *  sha256(04 ‖ x ‖ y ‖ the link's 16 one-time bytes), `XXXX-XXXX`. */
export async function agentConnectCode(publicKey: AgentPublicKey, nonce: string): Promise<string> {
  const bytes = nonceBytes(nonce);
  const input = new Uint8Array(65 + bytes.length);
  input.set(agentPublicKeyBytes(publicKey));
  input.set(bytes, 65);
  return shortCode(input);
}

async function shortCode(input: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', input as Uint8Array<ArrayBuffer>),
  );
  let bits = 0n;
  for (const b of digest.slice(0, 5)) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 7; i >= 0; i--) out += CROCKFORD[Number((bits >> BigInt(5 * i)) & 31n)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}
