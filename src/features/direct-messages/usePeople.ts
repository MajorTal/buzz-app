import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import type { Profile } from "../relay/contracts";
import { peopleOrder } from "../profiles/people-order";

export type Recipient = Profile & { pubkey: string };
const normalize = (value: string) =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

type PeopleState = {
  session: RelaySession;
  query: string;
  people: Recipient[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  error: string;
};
// Account/community lifetime only. Keep a bounded set of completed searches,
// not drafts or an additional persistent profile store.
const directories = new WeakMap<RelaySession, Map<string, PeopleState>>();
function empty(session: RelaySession, query: string): PeopleState {
  return {
    session,
    query,
    people: [],
    page: 0,
    hasMore: true,
    loading: true,
    error: "",
  };
}
function matching(people: Recipient[], query: string) {
  const needle = normalize(query.trim());
  return people.filter(
    (person) =>
      normalize(person.name).includes(needle) ||
      (/^[0-9a-f]{64}$/.test(needle) && person.pubkey === needle),
  );
}
export function usePeople(session: RelaySession, query: string) {
  const cache = useMemo(() => {
    const existing = directories.get(session);
    if (existing) return existing;
    const created = new Map<string, PeopleState>();
    directories.set(session, created);
    return created;
  }, [session]);
  const initial = useMemo(() => {
    const cached = cache.get(query);
    if (!query.trim()) return cached ?? empty(session, query);
    const complete = cache.get("")?.hasMore === false;
    const known = new Map(
      [...cache.values()]
        .flatMap((entry) => entry.people)
        .map((person) => [person.pubkey, person]),
    );
    return {
      ...(cached ?? empty(session, query)),
      people: matching([...known.values()], query).sort(peopleOrder(query)),
      loading: !complete && (cached?.loading ?? true),
      hasMore: !complete && (cached?.hasMore ?? true),
    };
  }, [cache, session, query]);
  const [state, setState] = useState(initial);
  const request = useRef<
    | {
        controller: AbortController;
        loading: boolean;
        people: Recipient[];
      }
    | undefined
  >(undefined);
  const load = useCallback(
    async function load(
      page: number,
      owned: NonNullable<typeof request.current>,
    ) {
      if (owned.loading || owned.controller.signal.aborted) return;
      owned.loading = true;
      setState((current) => ({ ...current, loading: true, error: "" }));
      try {
        const result = await session.directMessages.people(
          query,
          page,
          owned.controller.signal,
        );
        if (owned.controller.signal.aborted) return;
        const next: PeopleState = {
          session,
          query,
          page,
          hasMore: result.hasMore,
          loading: false,
          error: "",
          people: [
            ...new Map(
              [
                ...owned.people,
                ...matching(result.people, query).sort(peopleOrder(query)),
              ].map((person) => [person.pubkey, person]),
            ).values(),
          ],
        };
        owned.people = next.people;
        cache.delete(query);
        cache.set(query, next);
        if (cache.size > 20) {
          const oldest = [...cache.keys()].find((key) => key !== "");
          if (oldest !== undefined) cache.delete(oldest);
        }
        setState(next);
      } catch (reason) {
        if (!owned.controller.signal.aborted) {
          if (import.meta.env.DEV)
            console.warn("[people] Directory read failed", {
              page,
              searching: !!query.trim(),
              error: reason instanceof Error ? reason.message : "Unknown error",
            });
          setState((current) => ({
            ...current,
            loading: false,
            error:
              reason instanceof Error
                ? reason.message
                : "Could not load people.",
          }));
        }
      } finally {
        owned.loading = false;
      }
    },
    [session, query, cache],
  );
  useEffect(() => {
    const owned: NonNullable<typeof request.current> = {
      controller: new AbortController(),
      loading: false,
      people: initial.people,
    };
    request.current = owned;
    setState(initial);
    // Returning to a completed query resumes its pages without reshuffling.
    const timer =
      initial.page || !initial.hasMore
        ? undefined
        : setTimeout(() => void load(1, owned), query ? 150 : 0);
    return () => {
      clearTimeout(timer);
      owned.controller.abort();
    };
  }, [load, query, initial]);
  useEffect(() => {
    if (
      state.session !== session ||
      state.query !== query ||
      !state.page ||
      state.loading ||
      state.error ||
      !state.hasMore
    )
      return;
    const owned = request.current;
    // Continue both browsing and searching: an entire page may be filtered out
    // by recipient eligibility without exhausting the matching directory.
    const timer = setTimeout(() => {
      if (owned) void load(state.page + 1, owned);
    }, 100);
    return () => clearTimeout(timer);
  }, [state, session, query, load]);
  const visible =
    state.session === session && state.query === query ? state : initial;
  return {
    people: visible.people,
    loading: visible.loading || (visible.hasMore && !visible.error),
    error: visible.error,
    hasMore: visible.hasMore,
    loadMore() {
      if (
        state.session === session &&
        state.query === query &&
        state.hasMore &&
        request.current
      )
        void load(state.page + 1, request.current);
    },
  };
}
