import type { AgentIndex, IndexedKey, ReuseRequest } from './agent-index.js';
import { SignerError } from './errors.js';
import { type KeyItem, type KeyStore, newSlot } from './store/types.js';

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
  // Every time an identity is not found (multi-strategy agents: nothing holds
  // a caller's agents for the life of the process, so a deleted folder heals
  // at the next call): the index may be missing (a new home, a deleted folder)
  // or have unreadable entries. The listing carries no secret, and says
  // whether the 0.1.0 key exists as 0.1.0 made it: deciding who gets it reads
  // no key (a Keychain that refuses is met only by the caller that trades with
  // it). A rotated one carries metadata naming its creator, or no one (Q123),
  // and is never taken unasked.
  const merge = async () => {
    const items = await store.list(env);
    await index.rebuild(items);
    return items;
  };
  const isLegacyKey = (item: KeyItem) =>
    item.slot === env && item.identity === null && item.createdAt === null;

  /** The slots of `identity`'s agents, its first agent first, claiming the
   *  0.1.0 key when it is free (`claimed`: by this call); empty when the
   *  caller must choose at connect. Read from the index on every call. */
  const agentsAndClaim = async (
    identity: string,
    claimName: string | null,
  ): Promise<{ slots: string[]; claimed: boolean }> => {
    const none = { slots: [], claimed: false };
    const known = await index.slotsOf(identity);
    if (known.length > 0) return { slots: known, claimed: false };
    const items = await merge();
    const rebuilt = await index.slotsOf(identity);
    if (rebuilt.length > 0) return { slots: rebuilt, claimed: false };
    if (!items.some(isLegacyKey)) return none;
    if (!(await index.claimLegacy(identity))) return none;
    // The rebuild may have recorded it unnamed (it has no metadata): the
    // claimer names it, until the first Grant read brings Denaria's label.
    await index.addKey({ slot: env, name: claimName, createdAt: null });
    if (claimName !== null && (await index.nameOf(env)) === null) {
      await index.rename(env, claimName);
    }
    return { slots: [await index.map(identity, env)], claimed: true };
  };

  const agentsOf = async (identity: string, claimName: string | null): Promise<string[]> =>
    (await agentsAndClaim(identity, claimName)).slots;

  return {
    agentsOf,
    agentsAndClaim,

    /** The slot of `identity`'s first agent, claiming the 0.1.0 key when it
     *  is free; null when the caller must choose at connect. */
    async resolve(identity: string, claimName: string | null): Promise<string | null> {
      return (await agentsOf(identity, claimName))[0] ?? null;
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

    /**
     * One more agent of `identity` (multi-strategy agents, ticket 02): a new
     * slot with this Agent name, added to the caller's agents before its key
     * exists (the key is made by the caller). The name is claimed first
     * (`AgentIndex.claimName`), with the caller's agents that have it now
     * (`observed`, none of them live): null when another Signer of this
     * caller holds the claim, so two Signers never both make the name.
     */
    async addAgent(
      identity: string,
      name: string,
      observed: readonly string[],
      createdAt: string,
    ): Promise<string | null> {
      const slot = newSlot(env);
      const claim = { identity, name, observed, slot, claimedAt: createdAt };
      if (!(await index.claimName(claim))) return null;
      await index.addKey({ slot, name, createdAt });
      await index.add(identity, slot);
      return slot;
    },

    /** The keys of `slots` with their latest names (the creation name in the
     *  store item when the index has none), oldest first. */
    async described(
      slots: readonly string[],
    ): Promise<Array<{ slot: string; name: string | null; createdAt: string | null }>> {
      const indexed = new Map((await index.keys()).map((key) => [key.slot, key]));
      let items: readonly KeyItem[] | null = null;
      const described = [];
      for (const slot of slots) {
        const key = indexed.get(slot);
        let name = key?.name ?? null;
        let createdAt = key?.createdAt ?? null;
        if (name === null || key === undefined) {
          items ??= await store.list(env).catch(() => []);
          const item = items.find((candidate) => candidate.slot === slot);
          name ??= item?.name ?? null;
          createdAt ??= item?.createdAt ?? null;
        }
        described.push({ slot, name, createdAt });
      }
      return described.sort(
        (a, b) =>
          (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.slot.localeCompare(b.slot),
      );
    },

    /** A key on this computer, or a refusal that says to choose another. */
    async find(slot: string): Promise<IndexedKey> {
      const found = (await this.onComputer()).find((key) => key.slot === slot);
      if (found === undefined) {
        throw new SignerError(
          `There is no key ${slot.slice(0, 80)} on this computer for ${env}. Call connect again with one of the key ids it lists, or with a name for a new agent.`,
        );
      }
      return found;
    },

    /** Maps `identity` to a key already on this computer, with the request
     *  that keeps it from signing until the owner approves (ticket 20). */
    async reuse(identity: string, slot: string, request: ReuseRequest): Promise<string> {
      await this.find(slot);
      return index.map(identity, slot, request);
    },

    /** Adds a key already on this computer to the agents of `identity`, which
     *  has agents already (multi-strategy agents, ticket 04, Q211), with the
     *  request on that agent's own entry. Another Signer of the caller may
     *  have added it first: its entry, and its request, hold. */
    async reuseAsAgent(identity: string, slot: string, request: ReuseRequest): Promise<void> {
      await this.find(slot);
      await index.add(identity, slot, request);
    },

    /** The reuse request on the entry of `identity` for `slot` (no slot: its
     *  first agent's), or null. */
    reuseOf: (identity: string, slot?: string) => index.reuseOf(identity, slot),

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
