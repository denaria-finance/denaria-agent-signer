import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { KeyItem } from './store/types.js';

/**
 * The Signer's local index of agents on this computer, one per Env (ADR-0062
 * §18, ticket 15): its keys (slot, latest Agent name, when made) and which
 * caller uses which key (identity → slot). It holds no secret.
 *
 * Several Signer processes run at once (every MCP client spawns its own), so
 * the index is one small file per entry and never a file two processes
 * rewrite together:
 *
 *   <home>/agents/<env>/keys/<slot>.json          { slot, name, createdAt }
 *   <home>/agents/<env>/clients/<sha256>[.n].json { identity, slot }
 *   <home>/agents/<env>/legacy-claim.json         { identity }
 *
 * An entry is written whole under a private name and hard-linked to its own
 * (fails when it exists: the first writer wins, nothing is lost) or renamed
 * over it (a name update: the latest wins). A mapping is never changed once
 * made: one that cannot be read is followed by the next generation `.1`,
 * `.2`, … (made the same way, read in order up to the first gap), never
 * rewritten, so Signers that find it unreadable at once still agree on one
 * slot. The stores carry each key's creation metadata, so a lost index is
 * rebuilt from them (`rebuild`).
 */
export type IndexedKey = {
  slot: string;
  name: string | null;
  createdAt: string | null;
  /** The identities that use it. */
  usedBy: string[];
};

export interface AgentIndex {
  /** The slot `identity` uses, or null. */
  slotOf(identity: string): Promise<string | null>;
  /** Maps `identity` to `slot` unless it already maps: the slot it maps to. */
  map(identity: string, slot: string): Promise<string>;
  /** Records a key unless it is there already. */
  addKey(key: { slot: string; name: string | null; createdAt: string | null }): Promise<void>;
  /** Forgets a key entry nobody maps to (one made by a lost race). */
  removeKey(slot: string): Promise<void>;
  keys(): Promise<IndexedKey[]>;
  nameOf(slot: string): Promise<string | null>;
  /** The latest Agent name of a key, as the server has it (Q86). */
  rename(slot: string, name: string): Promise<void>;
  /** Takes the 0.1.0 key for `identity`: true when it is that identity's
   *  (now or already), false when another identity has it. */
  claimLegacy(identity: string): Promise<boolean>;
  /** Adds what the store items say and the index lacks: their keys, the
   *  mapping of the identity that made each, the 0.1.0 key's claim. */
  rebuild(items: readonly KeyItem[]): Promise<void>;
}

const keySchema = z.object({
  slot: z.string(),
  name: z.string().nullable(),
  createdAt: z.string().nullable(),
});
const clientSchema = z.object({ identity: z.string(), slot: z.string() });
const claimSchema = z.object({ identity: z.string() });

const SLOT_FILE = /^([a-z0-9][a-z0-9-]{0,63})\.json$/;

/** Unreadable mappings of one identity tolerated before `map` gives up. */
const MAX_CLIENT_GENERATIONS = 8;

const identityFile = (identity: string, generation: number) =>
  `${createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32)}${generation === 0 ? '' : `.${generation}`}.json`;

/** `undefined`: no such file; `null`: a file that does not parse. */
async function readEntry<T>(path: string, schema: z.ZodType<T>): Promise<T | null | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return null;
  }
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeTemporary(path: string, value: unknown): Promise<string> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return temporary;
}

/** True when this call created the file; false when one was there. */
async function createEntry(path: string, value: unknown): Promise<boolean> {
  const temporary = await writeTemporary(path, value);
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function replaceEntry(path: string, value: unknown): Promise<void> {
  const temporary = await writeTemporary(path, value);
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function fileAgentIndex(options: { home: string; env: string }): AgentIndex {
  const root = join(options.home, 'agents', options.env);
  const keysDir = join(root, 'keys');
  const clientsDir = join(root, 'clients');
  const claimPath = join(root, 'legacy-claim.json');
  const clientPath = (identity: string, generation: number) =>
    join(clientsDir, identityFile(identity, generation));
  const keyPath = (slot: string) => {
    if (!SLOT_FILE.test(`${slot}.json`)) throw new Error('Invalid key slot');
    return join(keysDir, `${slot}.json`);
  };

  const ready = async () => {
    await mkdir(keysDir, { recursive: true, mode: 0o700 });
    await mkdir(clientsDir, { recursive: true, mode: 0o700 });
  };

  const index: AgentIndex = {
    async slotOf(identity) {
      for (let generation = 0; generation < MAX_CLIENT_GENERATIONS; generation++) {
        const entry = await readEntry(clientPath(identity, generation), clientSchema);
        if (entry === undefined) return null;
        if (entry?.identity === identity) return entry.slot;
      }
      return null;
    },

    async map(identity, slot) {
      await ready();
      for (let generation = 0; generation < MAX_CLIENT_GENERATIONS; generation++) {
        const path = clientPath(identity, generation);
        if (await createEntry(path, { identity, slot })) return slot;
        const entry = await readEntry(path, clientSchema);
        if (entry?.identity === identity) return entry.slot;
        // A file that does not parse (or, never in practice, another
        // identity's hash): the next generation holds the mapping.
      }
      throw new Error('Too many unreadable mappings of one identity in the agent index');
    },

    async addKey(key) {
      await ready();
      const path = keyPath(key.slot);
      if (await createEntry(path, key)) return;
      if ((await readEntry(path, keySchema)) === null) await replaceEntry(path, key);
    },

    async removeKey(slot) {
      await unlink(keyPath(slot)).catch(() => undefined);
    },

    async keys() {
      const usedBy = new Map<string, string[]>();
      for (const file of await listDir(clientsDir)) {
        if (!file.endsWith('.json')) continue;
        const entry = await readEntry(join(clientsDir, file), clientSchema);
        if (!entry) continue;
        usedBy.set(entry.slot, [...(usedBy.get(entry.slot) ?? []), entry.identity]);
      }
      const keys: IndexedKey[] = [];
      for (const file of await listDir(keysDir)) {
        const slot = SLOT_FILE.exec(file)?.[1];
        if (slot === undefined) continue;
        const entry = await readEntry(join(keysDir, file), keySchema);
        if (!entry || entry.slot !== slot) continue;
        keys.push({ ...entry, usedBy: (usedBy.get(slot) ?? []).sort() });
      }
      return keys;
    },

    async nameOf(slot) {
      return (await readEntry(keyPath(slot), keySchema))?.name ?? null;
    },

    async rename(slot, name) {
      await ready();
      const entry = await readEntry(keyPath(slot), keySchema);
      if (entry?.name === name) return;
      await replaceEntry(keyPath(slot), { slot, name, createdAt: entry?.createdAt ?? null });
    },

    async claimLegacy(identity) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      if (await createEntry(claimPath, { identity })) return true;
      return (await readEntry(claimPath, claimSchema))?.identity === identity;
    },

    async rebuild(items) {
      // Nothing to add writes nothing: a Signer that has not made a key yet
      // leaves no folder behind (a refused first connect).
      if (items.length === 0) return;
      await ready();
      const byAge = [...items].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
      for (const item of byAge) {
        await index.addKey({ slot: item.slot, name: item.name, createdAt: item.createdAt });
        if (item.identity === null) continue;
        await index.map(item.identity, item.slot);
        if (item.slot === options.env) await index.claimLegacy(item.identity);
      }
    },
  };
  return index;
}
