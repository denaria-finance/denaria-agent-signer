import {
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from 'node:crypto';
import {
  type AgentKeyCoordinate,
  type AgentPublicKey,
  type AgentSignerLoginStatement,
  agentSignerLoginMessage,
} from '@denaria/agent-schemas';
import { signHashWithSessionKey } from '@denaria/smart-account/session-key/webauthn-envelope';
import { SignerError } from './errors.js';

/**
 * The Session key the Signer holds: P-256, the curve the WebAuthnSigner of the
 * Grant verifies on-chain, as for Quick trading (agent-trading Stage 2 Q53).
 * The private half lives only in a private field; serialising or inspecting
 * the object shows the public key alone, and the stores get the secret
 * through `exportSecret` and nothing else.
 */

const SECRET_FORMAT = /^p256:([0-9a-f]{64})$/;

function coordinate(bytes: Buffer): AgentKeyCoordinate {
  return `0x${bytes.toString('hex')}`;
}

function malformed(): SignerError {
  return new SignerError('The stored secret is not a Denaria Agent Signer key.');
}

export class SessionKey {
  readonly publicKey: AgentPublicKey;
  readonly #privateKey: KeyObject;

  private constructor(privateKey: KeyObject, publicKey: AgentPublicKey) {
    this.#privateKey = privateKey;
    this.publicKey = publicKey;
  }

  static generate(): SessionKey {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' });
    return new SessionKey(privateKey, {
      x: coordinate(Buffer.from(jwk.x ?? '', 'base64url')),
      y: coordinate(Buffer.from(jwk.y ?? '', 'base64url')),
    });
  }

  /** The key a store saved with `exportSecret`; the public key is derived
   *  from the private scalar, so the two can never disagree. */
  static fromSecret(secret: string): SessionKey {
    const hex = SECRET_FORMAT.exec(secret)?.[1];
    if (hex === undefined) throw malformed();
    const d = Buffer.from(hex, 'hex');
    let point: Buffer;
    try {
      const ecdh = createECDH('prime256v1');
      ecdh.setPrivateKey(d);
      point = ecdh.getPublicKey();
    } catch {
      throw malformed();
    }
    const x = point.subarray(1, 33);
    const y = point.subarray(33, 65);
    const privateKey = createPrivateKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: d.toString('base64url'),
        x: x.toString('base64url'),
        y: y.toString('base64url'),
      },
      format: 'jwk',
    });
    return new SessionKey(privateKey, { x: coordinate(x), y: coordinate(y) });
  }

  /** The login signature (ADR-0062 §11): ECDSA P-256 / SHA-256 of the login
   *  text this key builds for the statement, `0x` + r ‖ s. Besides userOp
   *  hashes (`signUserOpHash`), the only bytes this key signs. */
  signLogin(statement: Omit<AgentSignerLoginStatement, 'publicKey'>): string {
    const message = agentSignerLoginMessage({ ...statement, publicKey: this.publicKey });
    const signature = sign('sha256', Buffer.from(message, 'utf8'), {
      key: this.#privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `0x${signature.toString('hex')}`;
  }

  /** The WebAuthnSigner signature of a userOp hash the API prepared
   *  (ADR-0062 §13). The envelope is built here from the 32-byte hash, so the
   *  key never signs bytes someone else chose. */
  signUserOpHash(hash: `0x${string}`): Promise<`0x${string}`> {
    return signHashWithSessionKey(
      async (data) =>
        new Uint8Array(sign('sha256', data, { key: this.#privateKey, dsaEncoding: 'ieee-p1363' })),
      hash,
    );
  }

  /** The secret a store keeps: `p256:` + the 32-byte scalar in hex. */
  exportSecret(): string {
    const d = Buffer.from(this.#privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');
    return `p256:${Buffer.concat([Buffer.alloc(32 - d.length), d]).toString('hex')}`;
  }

  toJSON(): { publicKey: AgentPublicKey } {
    return { publicKey: this.publicKey };
  }

  toString(): string {
    return `SessionKey(${this.publicKey.x})`;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}
