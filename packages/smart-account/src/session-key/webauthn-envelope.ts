import {
  bytesToBigInt,
  bytesToHex,
  concatBytes,
  encodeAbiParameters,
  type Hex,
  hexToBytes,
  sha256,
  stringToBytes,
  zeroHash,
} from 'viem';
import type { SessionKeySignerPublicKey } from './grant.js';

// A Session key's signature as ZeroDev's WebAuthnSigner v0.0.4 (the patched
// one) verifies it on-chain; the ModularSigner around it is
// `webauthn-signer.ts`. viem only, so the Agent signer bundles nothing else.
// The key is a plain P-256 key, not a passkey, so there is no authenticator: we build the WebAuthn
// assertion ourselves, byte for byte what the contract checks. One module for
// every Holder (agent-trading Stage 2 ticket 08a): the Browser signs with
// WebCrypto, the Agent signer with node:crypto, and the API wraps a signature
// the Agent signer made into the UserOp it prepared.
//
// What the contract checks (`WebAuthnSigner._verifySignature` + `WebAuthn.verifySignature`,
// verified source of 0x65DEeC8fEe717dc044D0CFD63cCf55F02cCaC2b3, identical bytecode
// on Arbitrum Sepolia and One):
// - signature = abi.encode(bytes authenticatorData, string clientDataJSON,
//   uint256 responseTypeLocation, uint256 r, uint256 s, bool usePrecompiled);
// - authenticatorData is at least 37 bytes, byte 32 has UP (0x01) and UV (0x04),
//   and BS (0x10) only together with BE (0x08);
// - `"type":"webauthn.get"` sits at responseTypeLocation in clientDataJSON;
// - `"challenge":"<base64url(hash), no padding>"` sits at the FIXED offset 23,
//   so clientDataJSON must open with `{"type":"webauthn.get","challenge":"`;
// - s <= n/2 (high-s is refused, not normalised);
// - P-256 verify of sha256(authenticatorData || sha256(clientDataJSON)), through the
//   RIP-7212 precompile at 0x100 when usePrecompiled is true.

/** P-256 group order. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/** The contract's malleability bound (`P256_N_DIV_2`): s above it is refused. */
export const P256_HALF_N = P256_N / 2n;

const RESPONSE_TYPE_LOCATION = 1n;

// UP | UV. BE/BS stay clear: a key that never leaves the browser is not backed up.
const AUTHENTICATOR_FLAGS = 0x05;
// The contract does not read the rpIdHash; a fixed tag makes session-key
// assertions recognisable on-chain and keeps the envelope independent of the page origin.
const RP_ID_HASH = sha256(stringToBytes('denaria-session-key'), 'bytes');
const SIGN_COUNT = new Uint8Array(4);

export type WebAuthnEnvelope = {
  authenticatorData: Uint8Array;
  clientDataJSON: string;
  /** What WebCrypto signs (it SHA-256-hashes it once more, as WebAuthn does). */
  signedData: Uint8Array;
};

function base64UrlNoPad(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function assertHash32(hash: Uint8Array): void {
  if (hash.length !== 32)
    throw new Error(`Session key signs 32-byte hashes only, got ${hash.length}`);
}

/** The synthetic assertion for `hash` (the userOp hash). Deterministic. */
export function buildWebAuthnEnvelope(hash: Hex | Uint8Array): WebAuthnEnvelope {
  const hashBytes = typeof hash === 'string' ? hexToBytes(hash) : hash;
  assertHash32(hashBytes);
  const authenticatorData = concatBytes([
    RP_ID_HASH,
    new Uint8Array([AUTHENTICATOR_FLAGS]),
    SIGN_COUNT,
  ]);
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${base64UrlNoPad(hashBytes)}"}`;
  const signedData = concatBytes([
    authenticatorData,
    sha256(stringToBytes(clientDataJSON), 'bytes'),
  ]);
  return { authenticatorData, clientDataJSON, signedData };
}

/** The contract refuses s > n/2; (r, n - s) is the same signature. */
export function toLowS(s: bigint): bigint {
  return s > P256_HALF_N ? P256_N - s : s;
}

/** WebCrypto ECDSA returns IEEE P1363 `r || s` (64 bytes), never DER. */
export function parseP1363Signature(raw: Uint8Array): { r: bigint; s: bigint } {
  if (raw.length !== 64) throw new Error(`Expected a 64-byte P-256 signature, got ${raw.length}`);
  const r = bytesToBigInt(raw.subarray(0, 32));
  const s = bytesToBigInt(raw.subarray(32));
  if (r === 0n || r >= P256_N || s === 0n || s >= P256_N) {
    throw new Error('P-256 signature out of range');
  }
  return { r, s: toLowS(s) };
}

const SIGNATURE_PARAMS = [
  { name: 'authenticatorData', type: 'bytes' },
  { name: 'clientDataJSON', type: 'string' },
  { name: 'responseTypeLocation', type: 'uint256' },
  { name: 'r', type: 'uint256' },
  { name: 's', type: 'uint256' },
  { name: 'usePrecompiled', type: 'bool' },
] as const;

function encodeSignature(envelope: WebAuthnEnvelope, r: bigint, s: bigint): Hex {
  return encodeAbiParameters(SIGNATURE_PARAMS, [
    bytesToHex(envelope.authenticatorData),
    envelope.clientDataJSON,
    RESPONSE_TYPE_LOCATION,
    r,
    s,
    // Only RIP-7212 chains get a signer (see `toSessionKeySigner`).
    true,
  ]);
}

/** ECDSA P-256 over SHA-256 of `data`, IEEE P1363 `r ‖ s` (64 bytes): what
 *  WebCrypto's `sign` and node:crypto's `sign(…, { dsaEncoding: 'ieee-p1363' })`
 *  return. */
export type SessionKeyP256Sign = (data: Uint8Array) => Promise<Uint8Array>;

/** The WebAuthnSigner signature over `hash` (a userOp hash): the envelope is
 *  built here from the hash, so a Holder only ever signs WebAuthn envelopes of
 *  32-byte hashes, never bytes someone else chose. */
export async function signHashWithSessionKey(
  sign: SessionKeyP256Sign,
  hash: Hex | Uint8Array,
): Promise<Hex> {
  const envelope = buildWebAuthnEnvelope(hash);
  const { r, s } = parseP1363Signature(await sign(new Uint8Array(envelope.signedData)));
  return encodeSignature(envelope, r, s);
}

/** The signer init data the Grant registers: `abi.encode((pubKeyX, pubKeyY), authenticatorIdHash)`,
 *  the layout of ZeroDev's `toWebAuthnSigner.getSignerData`. The contract decodes and
 *  discards the bytes32; there is no authenticator, so it is zero. */
export function sessionKeySignerData(publicKey: SessionKeySignerPublicKey): Hex {
  return encodeAbiParameters(
    [
      {
        name: 'WebAuthnSignerData',
        type: 'tuple',
        components: [
          { name: 'pubKeyX', type: 'uint256' },
          { name: 'pubKeyY', type: 'uint256' },
        ],
      },
      { name: 'authenticatorIdHash', type: 'bytes32' },
    ],
    [{ pubKeyX: publicKey.x, pubKeyY: publicKey.y }, zeroHash],
  );
}

// Same envelope shape and length as a real signature, r and s at the top of the
// accepted range, so the bundler's gas estimate runs the same precompile path.
// The precompile returns nothing for it, so it fails verification without reverting.
export const SESSION_KEY_DUMMY_SIGNATURE = encodeSignature(
  buildWebAuthnEnvelope(zeroHash),
  P256_HALF_N,
  P256_HALF_N,
);
