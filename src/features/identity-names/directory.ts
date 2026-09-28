import type { NamingIdentity } from "./policy";
import type { NameProvider, NameSource, NamingPolicy } from "./service";
import type { AgentControl } from "../agents/control";
import { relayOrigin } from "../communities/destination";

function sameCommunity(left: string, right: string) {
  try {
    return relayOrigin(left) === relayOrigin(right);
  } catch {
    return false;
  }
}

/** Native configuration wins only in its community. Names never grant control. */
export function createNameProvider(
  policy: NamingPolicy,
  control?: Pick<AgentControl, "snapshot" | "subscribe" | "refresh">,
): NameProvider {
  let base:
    | {
        inputs: readonly unknown[];
        names: Map<string, string>;
        identities: Map<string, NamingIdentity>;
        // Recently used scopes (LRU), so a hot scope survives interleaved lookups.
        scopes: Map<
          string | undefined,
          { displayFacts: unknown; labels: ReturnType<NamingPolicy["resolve"]> }
        >;
      }
    | undefined;
  const current = (source: NameSource) => {
    const native = control?.snapshot();
    const relayUrl = source.relayUrl;
    const library = source.agentLibrary.snapshot();
    const profiles = source.profiles.snapshot();
    const inputs = [library, native, profiles, relayUrl, source.viewer];
    if (base && inputs.every((input, index) => input === base?.inputs[index]))
      return base;
    const names = new Map<string, string>();
    if (library.status === "ready") {
      for (const row of library.identities) {
        const key = row.pubkey.toLowerCase();
        if (!names.has(key))
          names.set(
            key,
            row.name.trim() || profiles.get(key)?.name.trim() || "Agent",
          );
      }
    }
    if (relayUrl && native?.status === "ready") {
      const seen = new Set<string>();
      for (const agent of native.data?.agents ?? []) {
        const key = agent.pubkey.toLowerCase();
        if (seen.has(key) || !sameCommunity(agent.relayUrl, relayUrl)) continue;
        seen.add(key);
        const name = agent.name.trim();
        if (name) names.set(key, name);
      }
    }
    const identities = new Map<string, NamingIdentity>(
      [...profiles].map(([pubkey, profile]) => [
        pubkey,
        { pubkey, ...profile },
      ]),
    );
    for (const [pubkey, name] of names) {
      identities.set(pubkey, {
        ...profiles.get(pubkey),
        pubkey,
        name,
        isAgent: true,
      });
    }
    base = { inputs, names, identities, scopes: new Map() };
    return base;
  };
  const labels = (
    source: NameSource,
    selection: readonly string[] | undefined,
    id: string | undefined,
    displayFacts: readonly NamingIdentity[] | undefined,
  ) => {
    const { identities, scopes } = current(source);
    const cached = scopes.get(id);
    if (cached && cached.displayFacts === displayFacts) {
      scopes.delete(id);
      scopes.set(id, cached);
      return cached.labels;
    }
    // View-local labels (authored draft text or cross-community management rows)
    // supplement display facts only; they never select recipients or grant control.
    const displayed = (displayFacts ?? []).map((fact) => {
      const key = fact.pubkey.toLowerCase();
      return { ...identities.get(key), ...fact, pubkey: key };
    });
    const displayedKeys = new Set(displayed.map((fact) => fact.pubkey));
    const resolved = policy.resolve(
      [
        ...[...identities.values()].filter(
          (row) => !displayedKeys.has(row.pubkey),
        ),
        ...displayed,
      ],
      source.viewer,
      selection,
    );
    scopes.delete(id);
    if (scopes.size >= 8) scopes.delete(scopes.keys().next().value);
    scopes.set(id, { displayFacts, labels: resolved });
    return resolved;
  };
  return {
    id: policy.id,
    ...(control ? { subscribe: control.subscribe } : {}),
    activate(source) {
      void control?.refresh();
      return source.agentLibrary.retain();
    },
    scope(source, candidates, displayFacts) {
      const selected =
        candidates && new Set(candidates.map((key) => key.toLowerCase()));
      const selection = selected && [...selected].sort();
      const id = selection?.join(":");
      return (pubkey) => {
        const key = pubkey.toLowerCase();
        // Include the requested identity even for historical non-member references.
        const outside =
          selected && !selected.has(key) && [...selected, key].sort();
        const label = (
          outside
            ? labels(source, outside, outside.join(":"), displayFacts)
            : labels(source, selection, id, displayFacts)
        ).get(key);
        if (label) return label;
        const name = current(source).names.get(key);
        return name ? { name } : undefined;
      };
    },
  };
}
