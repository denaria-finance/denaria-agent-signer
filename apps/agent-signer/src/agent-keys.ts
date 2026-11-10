import type { AgentIndex, IndexedKey } from './agent-index.js';
import { SignerError } from './errors.js';
import { type KeyStore, newSlot } from './store/types.js';

/**
 * Which key a caller trades with (ADR-0062 §18, ticket 15): the index says
 * which slot an identity uses; a caller it does not know takes the key a 0.1.0
 * Signer made, if nobody has it yet (so no 0.1.0 user loses a Grant), or is
 * unknown until it chooses at `connect`: a new key with an Agent name, or one
 * already on this computer.
 *
 * The identity is how the caller is recognised, never shown as its name:
 * `name:<--name>` when the MCP command names the agent, else
 * `client:<clientInfo.name>`. A rename in the app changes the Agent name, not
 * the identity, so `--name X` still finds its key after the rename.
 */
export function agentKeys(options: { env: string; store: KeyStore; index: AgentIndex }) {
  const { env, store, index } = options;
  // Once per process, the first time an identity is not found: the index may
  // be missing (a new home, a deleted folder) or have unreadable entries. The
  // listing carries no secret, and says whether the 0.1.0 key exists: deciding
  // who gets it reads no key (a Keychain that refuses is met only by the
  // caller that trades with it).
  let listed: Set<string> | null = null;
  const merge = async () => {
    const items = await store.list(env);
    await index.rebuild(items);
    listed = new Set(items.map((item) => item.slot));
    return items;
  };

  return {
    /** The slot `identity` uses, claiming the 0.1.0 key when it is free;
     *  null when the caller must choose at connect. */
    async resolve(identity: string, claimName: string | null): Promise<string | null> {
      const known = await index.slotOf(identity);
      if (known !== null) return known;
      if (listed === null) {
        await merge();
        const rebuilt = await index.slotOf(identity);
        if (rebuilt !== null) return rebuilt;
      }
      if (!listed?.has(env)) return null;
      if (!(await index.claimLegacy(identity))) return null;
      // The rebuild may have recorded it unnamed (it has no metadata): the
      // claimer names it, until the first Grant read brings Denaria's label.
      await index.addKey({ slot: env, name: claimName, createdAt: null });
      if (claimName !== null && (await index.nameOf(env)) === null) {
        await index.rename(env, claimName);
      }
      return index.map(identity, env);
    },

    /** A new slot for `identity` with this Agent name, in the index before the
     *  key exists (the key is made by the caller). Another process of the same
     *  identity may have mapped it first: then its slot is the answer. */
    async create(identity: string, name: string, createdAt: string): Promise<string> {
      const slot = newSlot(env);
      await index.addKey({ slot, name, createdAt });
      const mapped = await index.map(identity, slot);
      if (mapped !== slot) await index.removeKey(slot);
      return mapped;
    },

    /** Maps `identity` to a key already on this computer. */
    async reuse(identity: string, slot: string): Promise<string> {
      const onComputer = await this.onComputer();
      if (!onComputer.some((key) => key.slot === slot)) {
        throw new SignerError(
          `There is no key ${slot.slice(0, 80)} on this computer for ${env}. Call connect again with one of the key ids it lists, or with a name for a new agent.`,
        );
      }
      return index.map(identity, slot);
    },

    /** The keys the store holds for this Env, with their latest names and
     *  who uses them, oldest first. */
    async onComputer(): Promise<IndexedKey[]> {
      const items = await merge();
      const present = new Set(items.map((item) => item.slot));
      return (await index.keys())
        .filter((key) => present.has(key.slot))
        .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    },

    nameOf: (slot: string) => index.nameOf(slot),
    rename: (slot: string, name: string) => index.rename(slot, name),
  };
}

export type AgentKeys = ReturnType<typeof agentKeys>;
