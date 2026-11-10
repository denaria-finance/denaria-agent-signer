import { randomBytes } from 'node:crypto';

/**
 * Where the Signer keeps the secrets of its Session keys, one item per slot
 * (ADR-0062 §18, ticket 15). A slot is the Env name for the one key a 0.1.0
 * Signer made (`demo-staging`: same item, same file, same binding, so it still
 * opens), and `<env>-<key id>` for every key made since, one per Agent name.
 * The secret is an opaque printable token (`SessionKey.exportSecret`); a store
 * never parses it and never puts it in an error, a log or a process argument.
 */
export interface KeyStore {
  /** Where the key of `slot` lives, in words for the user. */
  describe(slot: string): string;
  /** The saved secret, or null when the slot has none. */
  load(slot: string): Promise<string | null>;
  /** Saves the secret with its item's metadata; resolves only once it is
   *  durably stored. Never replaces an existing key. */
  save(slot: string, secret: string, meta: KeyItemMeta): Promise<void>;
  /** Replaces the key of `slot` with a new one (rotation after a revoked
   *  Grant, ADR-0062 §11), with the metadata of the new item: atomic where the
   *  store allows it, resolves once the new secret is durable. */
  replace(slot: string, secret: string, meta: KeyItemMeta): Promise<void>;
  /** The items this store holds for `env`, without their secrets: what the
   *  local index is rebuilt from. */
  list(env: string): Promise<KeyItem[]>;
  /** Throws when this store cannot keep a key at all (the encrypted file
   *  without its passphrase): `connect` checks it first, before an agent is
   *  asked for a name. Absent: nothing to check. */
  ready?(): void;
}

/** What a key item carries besides its secret, written when the item is
 *  created and never rewritten for a rename (only a rotation makes a new
 *  item). Not secret. */
export type KeyItemMeta = {
  env: string;
  /** The Agent name the key was created with (null: the client declared none). */
  name: string | null;
  /** Who created it: `name:<--name>` or `client:<clientInfo.name>`. */
  identity: string;
  createdAt: string;
};

/** A listed item: the 0.1.0 key has no metadata. */
export type KeyItem = {
  slot: string;
  name: string | null;
  identity: string | null;
  createdAt: string | null;
};

const PLAIN_SLOT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KEY_ID = /^[a-z0-9]{12}$/;
const KEY_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Slots reach file names and keychain commands: keep them plain. */
export function assertPlainSlot(slot: string): void {
  if (!PLAIN_SLOT.test(slot)) throw new Error('Invalid key slot');
}

/** A new slot of `env`: `<env>-<12 random characters>`, fixed for the key's
 *  life (a rotation stays in it). */
export function newSlot(env: string): string {
  const id = [...randomBytes(12)].map((byte) => KEY_ID_ALPHABET[byte % 32]).join('');
  const slot = `${env}-${id}`;
  assertPlainSlot(slot);
  return slot;
}

/** Whether `slot` belongs to `env`: the 0.1.0 slot or one `newSlot` made. */
export function isSlotOf(env: string, slot: string): boolean {
  if (slot === env) return true;
  return slot.startsWith(`${env}-`) && KEY_ID.test(slot.slice(env.length + 1));
}

/** The way out every system keyring error gives: the encrypted file. */
export const FILE_STORE_HINT =
  'start the Denaria Agent Signer with --store file and DENARIA_SIGNER_PASSPHRASE set';
