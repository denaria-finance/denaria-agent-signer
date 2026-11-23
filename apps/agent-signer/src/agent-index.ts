import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_REUSE_REFERENCE } from '@denaria/agent-schemas';
import { z } from 'zod';
import type { KeyItem } from './store/types.js';

/**
 * The Signer's local index of agents on this computer, one per Env (ADR-0062
 * §18, ticket 15): its keys (slot, latest Agent name, when made) and which
 * keys each caller uses (identity → a set of slots, one per agent of that
 * caller: multi-strategy agents). It holds no secret.
 *
 * Several Signer processes run at once (every MCP client spawns its own), so
 * the index is one small file per entry and never a file two processes
 * rewrite together:
 *
 *   <home>/agents/<env>/keys/<slot>.json                 { slot, name, createdAt }
 *   <home>/agents/<env>/clients/<sha256>[.n].json        { identity, slot, reuse? }
 *   <home>/agents/<env>/clients/<sha256>+<slot>[.n].json { identity, slot, reuse? }
 *   <home>/agents/<env>/legacy-claim.json                { identity }
 *   <home>/agents/<env>/names/<sha256>[.n].json          { identity, name, slot, claimedAt }
 *
 * `<sha256>[.n].json` is the caller's first agent: the one mapping every
 * Signer up to 0.1.3 wrote and reads. A home 0.1.3 made is therefore read as
 * callers with one agent each, with no migration, and a 0.1.3 Signer running
 * beside this one still finds its caller's first agent. Every agent added
 * after the first is an entry of its own, `<sha256>+<slot>[.n].json`, in the
 * same shape: a 0.1.3 Signer never opens it as a mapping (it reads
 * `<sha256>.json`, `.1`, … only) but lists it among who uses the key, which is
 * true.
 *
 * An entry is written whole under a private name and hard-linked to its own
 * (fails when it exists: the first writer wins, nothing is lost) or renamed
 * over it (a name update: the latest wins). A mapping is never changed once
 * made: one that cannot be read is followed by the next generation `.1`,
 * `.2`, … (made the same way, read in order up to the first gap), never
 * rewritten, so Signers that find it unreadable at once still agree on one
 * slot. An added agent's entry is made the same way and never rewritten
 * either: adding an agent writes a new file, so Signers adding agents at once
 * lose none. The stores carry each key's creation metadata, so a lost index
 * is rebuilt from them (`rebuild`), with every agent each caller made.
 *
 * One more agent of a caller (multi-strategy agents, ticket 02) first claims
 * its Agent name: a `names/` entry keyed by the identity, the name (trimmed,
 * lower-cased) and the slots of the caller's agents that had the name when
 * the Signer looked (`claimName`). Two Signers of one caller that make the
 * same name at once looked at the same agents, so they race on one file and
 * one of them makes the agent; the other answers that the name is in use.
 * A claim never blocks for good: once its agent is in the index with another
 * name (a rename in the app), or when its Signer stopped before adding the
 * agent (a claim older than `NAME_CLAIM_STALE_MS`), the next claim takes the
 * next generation, made the same create-if-absent way.
 *
 * A caller that took a key another agent made at `connect` (`reuse`) carries
 * the request in its mapping (ticket 20, grill Q102): when it asked and the
 * one-time reference its links carry. Until the owner installs a Grant of
 * that key enrolled with the reference, with the Passkey, the caller signs
 * nothing. The request is in the same immutable entry as the mapping of that
 * identity to that slot, so it can go only with it; a rebuilt index maps only
 * the agent that made each key.
 */
export type ReuseRequest = {
  /** When the caller asked, on this computer's clock (shown, never compared). */
  requestedAt: string;
  /** 16 random bytes, base64url (`AGENT_REUSE_REFERENCE`): the reuse link
   *  carries it, and only a Grant enrolled with it approves this caller. */
  reference: string;
};

export type IndexedKey = {
  slot: string;
  name: string | null;
  createdAt: string | null;
  /** The identities that use it. */
  usedBy: string[];
};

export interface AgentIndex {
  /** The slots of `identity`'s agents: its first agent first, then the ones
   *  added after it, by slot. Empty for a caller the index does not know. */
  slotsOf(identity: string): Promise<string[]>;
  /** The slot of `identity`'s first agent, or null. */
  slotOf(identity: string): Promise<string | null>;
  /** Makes `slot` the first agent of `identity` unless it has one: the slot
   *  of its first agent. A reuse request goes with a new mapping only. */
  map(identity: string, slot: string, reuse?: ReuseRequest): Promise<string>;
  /** Adds `slot` to the agents of `identity` unless it is one of them
   *  already (then nothing is written): as its first agent when it has none,
   *  else as an entry of its own. A reuse request goes with a new entry only. */
  add(identity: string, slot: string, reuse?: ReuseRequest): Promise<void>;
  /** The reuse request the entry of `identity` for `slot` carries (no slot:
   *  its first agent's), or null. */
  reuseOf(identity: string, slot?: string): Promise<ReuseRequest | null>;
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
  /** Claims `name` for one more agent of `identity`, in `slot` (see the
   *  comment above): true when this call holds the claim, false when another
   *  Signer of the caller makes an agent with this name, or made it. */
  claimName(claim: NameClaim): Promise<boolean>;
  /** Adds what the store items say and the index lacks: their keys, each as
   *  an agent of the identity that made it (the oldest first, so a caller's
   *  oldest key is its first agent), the 0.1.0 key's claim. */
  rebuild(items: readonly KeyItem[]): Promise<void>;
}

export type NameClaim = {
  identity: string;
  name: string;
  /** The caller's agents that had the name when the Signer looked. */
  observed: readonly string[];
  slot: string;
  /** On this computer's clock: compared only with other claims of it. */
  claimedAt: string;
};

/** A name claim this old belongs to a Signer that stopped before it added
 *  the agent: adding one is a few small file writes. */
const NAME_CLAIM_STALE_MS = 5 * 60_000;

/** How two Agent names of one caller are compared: trimmed, ignoring case. */
export const nameKey = (name: string) => name.trim().toLowerCase();

const nameClaimSchema = z.object({
  identity: z.string(),
  name: z.string(),
  slot: z.string(),
  claimedAt: z.string(),
});

const keySchema = z.object({
  slot: z.string(),
  name: z.string().nullable(),
  createdAt: z.string().nullable(),
});
const clientSchema = z.object({
  identity: z.string(),
  slot: z.string(),
  reuse: z
    .object({
      requestedAt: z.string(),
      reference: z.string().regex(AGENT_REUSE_REFERENCE),
    })
    .optional(),
});
type ClientEntry = z.infer<typeof clientSchema>;
const claimSchema = z.object({ identity: z.string() });

const SLOT_FILE = /^([a-z0-9][a-z0-9-]{0,63})\.json$/;
/** An added agent's entry: `<sha256>+<slot>[.n].json`. */
const AGENT_FILE = /^([0-9a-f]{32})\+([a-z0-9][a-z0-9-]{0,63})(?:\.([1-9][0-9]*))?\.json$/;

/** Unreadable entries of one identity (or of one of its agents) tolerated
 *  before a write gives up. */
const MAX_CLIENT_GENERATIONS = 8;

const identityHash = (identity: string) =>
  createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32);
const generationSuffix = (generation: number) => (generation === 0 ? '' : `.${generation}`);
const identityFile = (identity: string, generation: number) =>
  `${identityHash(identity)}${generationSuffix(generation)}.json`;
const agentFile = (identity: string, slot: string, generation: number) =>
  `${identityHash(identity)}+${slot}${generationSuffix(generation)}.json`;

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
  const namesDir = join(root, 'names');
  const nameClaimPath = (claim: NameClaim, generation: number) => {
    const hash = createHash('sha256')
      .update(
        [claim.identity, nameKey(claim.name), [...claim.observed].sort().join(',')].join('\n'),
      )
      .digest('hex')
      .slice(0, 32);
    return join(namesDir, `${hash}${generationSuffix(generation)}.json`);
  };
  const clientPath = (identity: string, generation: number) =>
    join(clientsDir, identityFile(identity, generation));
  const assertSlot = (slot: string) => {
    if (!SLOT_FILE.test(`${slot}.json`)) throw new Error('Invalid key slot');
  };
  const keyPath = (slot: string) => {
    assertSlot(slot);
    return join(keysDir, `${slot}.json`);
  };
  const agentPath = (identity: string, slot: string, generation: number) => {
    assertSlot(slot);
    return join(clientsDir, agentFile(identity, slot, generation));
  };

  const ready = async () => {
    await mkdir(keysDir, { recursive: true, mode: 0o700 });
    await mkdir(clientsDir, { recursive: true, mode: 0o700 });
  };

  /** The entry of `identity`'s first agent. */
  const mappingOf = async (identity: string) => {
    for (let generation = 0; generation < MAX_CLIENT_GENERATIONS; generation++) {
      const entry = await readEntry(clientPath(identity, generation), clientSchema);
      if (entry === undefined) return null;
      if (entry?.identity === identity) return entry;
    }
    return null;
  };

  /** The entries of the agents added to `identity` after its first, by slot:
   *  for each slot, its lowest generation that reads. */
  const addedOf = async (identity: string): Promise<ClientEntry[]> => {
    const hash = identityHash(identity);
    const found = new Map<string, { generation: number; entry: ClientEntry }>();
    for (const file of await listDir(clientsDir)) {
      const match = AGENT_FILE.exec(file);
      if (match?.[1] !== hash || match[2] === undefined) continue;
      const slot = match[2];
      const generation = Number(match[3] ?? 0);
      const held = found.get(slot);
      if (held !== undefined && held.generation < generation) continue;
      const entry = await readEntry(join(clientsDir, file), clientSchema);
      if (entry?.identity !== identity || entry.slot !== slot) continue;
      found.set(slot, { generation, entry });
    }
    return [...found.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, held]) => held.entry);
  };

  /** Every entry of `identity`, one per slot, its first agent first. */
  const entriesOf = async (identity: string): Promise<ClientEntry[]> => {
    const first = await mappingOf(identity);
    const added = (await addedOf(identity)).filter((entry) => entry.slot !== first?.slot);
    return first === null ? added : [first, ...added];
  };

  const index: AgentIndex = {
    async slotsOf(identity) {
      return (await entriesOf(identity)).map((entry) => entry.slot);
    },

    async slotOf(identity) {
      return (await entriesOf(identity))[0]?.slot ?? null;
    },

    async reuseOf(identity, slot) {
      const entries = await entriesOf(identity);
      const entry = slot === undefined ? entries[0] : entries.find((entry) => entry.slot === slot);
      return entry?.reuse ?? null;
    },

    async map(identity, slot, reuse) {
      await ready();
      for (let generation = 0; generation < MAX_CLIENT_GENERATIONS; generation++) {
        const path = clientPath(identity, generation);
        if (
          await createEntry(path, { identity, slot, ...(reuse === undefined ? {} : { reuse }) })
        ) {
          return slot;
        }
        const entry = await readEntry(path, clientSchema);
        if (entry?.identity === identity) return entry.slot;
        // A file that does not parse (or, never in practice, another
        // identity's hash): the next generation holds the mapping.
      }
      throw new Error('Too many unreadable mappings of one identity in the agent index');
    },

    async add(identity, slot, reuse) {
      assertSlot(slot);
      await ready();
      const first = await mappingOf(identity);
      if (first?.slot === slot) return;
      // No first agent yet: this one is it, unless another Signer of the same
      // caller made its own first a moment before.
      if (first === null && (await index.map(identity, slot, reuse)) === slot) return;
      const entry = { identity, slot, ...(reuse === undefined ? {} : { reuse }) };
      for (let generation = 0; generation < MAX_CLIENT_GENERATIONS; generation++) {
        const path = agentPath(identity, slot, generation);
        if (await createEntry(path, entry)) return;
        const held = await readEntry(path, clientSchema);
        if (held?.identity === identity && held.slot === slot) return;
        // A file that does not parse: the next generation holds the entry.
      }
      throw new Error('Too many unreadable entries of one agent in the agent index');
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
      const usedBy = new Map<string, Set<string>>();
      for (const file of await listDir(clientsDir)) {
        if (!file.endsWith('.json')) continue;
        const entry = await readEntry(join(clientsDir, file), clientSchema);
        if (!entry) continue;
        usedBy.set(entry.slot, (usedBy.get(entry.slot) ?? new Set()).add(entry.identity));
      }
      const keys: IndexedKey[] = [];
      for (const file of await listDir(keysDir)) {
        const slot = SLOT_FILE.exec(file)?.[1];
        if (slot === undefined) continue;
        const entry = await readEntry(join(keysDir, file), keySchema);
        if (!entry || entry.slot !== slot) continue;
        keys.push({ ...entry, usedBy: [...(usedBy.get(slot) ?? [])].sort() });
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

    async claimName(claim) {
      assertSlot(claim.slot);
      await mkdir(namesDir, { recursive: true, mode: 0o700 });
      const entry = {
        identity: claim.identity,
        name: nameKey(claim.name),
        slot: claim.slot,
        claimedAt: claim.claimedAt,
      };
      for (let generation = 0; generation < MAX_CLIENT_GENERATIONS; generation++) {
        const path = nameClaimPath(claim, generation);
        if (await createEntry(path, entry)) return true;
        const held = await readEntry(path, nameClaimSchema);
        if (held === null || held === undefined || held.identity !== claim.identity) continue;
        if (held.slot === claim.slot) return true;
        if ((await index.slotsOf(claim.identity)).includes(held.slot)) {
          // Its agent was made: the name is in use while that agent has it.
          const current = await index.nameOf(held.slot);
          if (current !== null && nameKey(current) === entry.name) return false;
          continue;
        }
        const age = Date.parse(claim.claimedAt) - Date.parse(held.claimedAt);
        if (age > NAME_CLAIM_STALE_MS) continue;
        return false;
      }
      throw new Error('Too many name claims of one agent in the agent index');
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
        await index.add(item.identity, item.slot);
        if (item.slot === options.env) await index.claimLegacy(item.identity);
      }
    },
  };
  return index;
}
