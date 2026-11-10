import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type ScryptOptions,
  scrypt,
} from 'node:crypto';
import { z } from 'zod';
import { SignerError } from '../errors.js';
import { sealedFileKeyStore } from './sealed-file.js';
import type { KeyStore } from './types.js';

/**
 * The key store for hosts without a usable keychain (cloud sandboxes, CI):
 * `<home>/<slot>.key`, AES-256-GCM under a key scrypt derives from
 * `DENARIA_SIGNER_PASSPHRASE` (agent-trading Stage 2 Q57). Written once, never
 * overwritten, rotated aside (sealed-file.ts).
 */

export const PASSPHRASE_VARIABLE = 'DENARIA_SIGNER_PASSPHRASE';
export const PASSPHRASE_MIN_LENGTH = 12;
/** scrypt N = 2^17, r = 8, p = 1: the OWASP floor for scrypt. About 128 MiB. */
export const DEFAULT_SCRYPT_COST = 1 << 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);

/** Version 1 is the 0.1.0 file; version 2 adds the clear slot and metadata
 *  (sealed-file.ts). The sealed part is the same in both. */
const keyFileSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    env: z.string(),
    slot: z.string().optional(),
    agent: z.unknown().optional(),
    kdf: z
      .object({
        name: z.literal('scrypt'),
        N: z
          .number()
          .int()
          .min(1024)
          .max(1 << 20),
        r: z.number().int().min(1).max(32),
        p: z.number().int().min(1).max(16),
        salt: base64,
      })
      .strict(),
    cipher: z.object({ name: z.literal('aes-256-gcm'), iv: base64, tag: base64 }).strict(),
    ciphertext: base64,
  })
  .strict();

type KeyFile = z.infer<typeof keyFileSchema>;

function deriveKey(passphrase: string, salt: Buffer, N: number, r: number, p: number) {
  const options: ScryptOptions = { N, r, p, maxmem: 256 * N * r + 1024 * 1024 };
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(passphrase.normalize('NFC'), salt, 32, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** Binds a file to its slot: a testnet file copied over the mainnet one, or
 *  one agent's over another's, does not open. The 0.1.0 slot is the Env, so
 *  its binding is unchanged. */
function associatedData(slot: string): Buffer {
  return Buffer.from(`denaria-agent-signer/key-file/v1/${slot}`, 'utf8');
}

function missingPassphrase(): SignerError {
  return new SignerError(
    `The encrypted key file needs a passphrase: set ${PASSPHRASE_VARIABLE} (at least ${PASSPHRASE_MIN_LENGTH} characters) in the environment the Denaria Agent Signer runs in, for example in the MCP server entry of your agent (claude mcp add -e ${PASSPHRASE_VARIABLE}=…), then try again. Keep the same passphrase afterwards: it is the only way to open the key.`,
  );
}

export function fileKeyStore(options: {
  home: string;
  passphrase: () => string | undefined;
  scryptCost?: number;
}): KeyStore {
  const cost = options.scryptCost ?? DEFAULT_SCRYPT_COST;
  const passphrase = (): string => {
    const value = options.passphrase();
    if (value === undefined || value.length === 0) throw missingPassphrase();
    if (value.length < PASSPHRASE_MIN_LENGTH) {
      throw new SignerError(
        `${PASSPHRASE_VARIABLE} is shorter than ${PASSPHRASE_MIN_LENGTH} characters. Choose a longer one before the first connect.`,
      );
    }
    return value;
  };

  return sealedFileKeyStore({
    home: options.home,
    extension: 'key',
    describe: (path) => `an encrypted file, ${path}`,
    ready: () => {
      passphrase();
    },
    sealer: {
      async seal(slot, secret) {
        const salt = randomBytes(16);
        const iv = randomBytes(12);
        const key = await deriveKey(passphrase(), salt, cost, SCRYPT_R, SCRYPT_P);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(associatedData(slot));
        const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
        const sealed: Omit<KeyFile, 'version' | 'env' | 'slot' | 'agent'> = {
          kdf: { name: 'scrypt', N: cost, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString('base64') },
          cipher: {
            name: 'aes-256-gcm',
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
          },
          ciphertext: ciphertext.toString('base64'),
        };
        return sealed;
      },

      async open(slot, raw, path) {
        let file: KeyFile;
        try {
          file = keyFileSchema.parse(raw);
        } catch {
          throw new SignerError(
            `${path} is not a Denaria Agent Signer key file this version can read. It was left untouched.`,
          );
        }
        const key = await deriveKey(
          passphrase(),
          Buffer.from(file.kdf.salt, 'base64'),
          file.kdf.N,
          file.kdf.r,
          file.kdf.p,
        );
        try {
          const decipher = createDecipheriv(
            'aes-256-gcm',
            key,
            Buffer.from(file.cipher.iv, 'base64'),
          );
          decipher.setAAD(associatedData(slot));
          decipher.setAuthTag(Buffer.from(file.cipher.tag, 'base64'));
          return Buffer.concat([
            decipher.update(Buffer.from(file.ciphertext, 'base64')),
            decipher.final(),
          ]).toString('utf8');
        } catch {
          throw new SignerError(
            `The passphrase in ${PASSPHRASE_VARIABLE} does not open ${path}. Set the passphrase used when this key was created. The file was left untouched.`,
          );
        }
      },
    },
  });
}
