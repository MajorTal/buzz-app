import { expect } from "@playwright/test";
import { verifyEvent } from "nostr-tools";
import { createHash } from "node:crypto";

/** Model the relay boundaries that matter to this journey, not a replacement
 * session: AUTH, explicit channel fan-out, EOSE, CLOSED and HTTP quota reasons.
 * The production broker owns all pacing, signing, SSE and retry controls. */
export function policyRelay({
  viewer,
  answer,
  report,
  pending,
  discovery,
  acceptPublication,
  presenceSnapshot,
  enforceQuotas = false,
  now = () => performance.now(),
}) {
  const presence = new Map();
  report.presencePublications = [];
  const sockets = [];
  const requests = [];
  const rejected = [];
  report.liveRequests = requests;
  report.quotaRefusals = rejected;
  const quotas = new Map();
  // Audited buzz 78618804: admission.rs, rejection.rs and RedisRateLimiter.
  // Windows start on the first charged operation; rejected attempts still count.
  // This is opt-in modeled policy, not discovery of the deployed configuration.
  const limits = {
    ApiCalls: [300, 60000],
    WsEvents: [50, 5000],
    Messages: [60, 60000],
  };
  const counters = new Map();
  report.quotaCharges = [];
  function charge(community, category, operation) {
    if (!enforceQuotas) return;
    const at = now(),
      [limit, windowMs] = limits[category];
    const key = `${community}:${viewer}:${category}`;
    let counter = counters.get(key);
    if (!counter || at >= counter.until) {
      counter = { count: 0, until: at + windowMs };
      counters.set(key, counter);
    }
    counter.count++;
    const accepted = counter.count <= limit;
    report.quotaCharges.push({
      community,
      category,
      operation,
      at,
      count: counter.count,
      limit,
      until: counter.until,
      accepted,
    });
    if (accepted) return;
    const seconds = Math.ceil((counter.until - at) / 1000);
    const reason = `rate-limited: quota exceeded; retry in ${seconds}s`;
    rejected.push({
      community,
      category,
      operation,
      at,
      until: counter.until,
      reason,
    });
    return reason;
  }
  let heldPresence = false;
  let presenceStarted;
  const pendingPresence = [];
  report.presenceHolds = [];
  const heldEose = new Set();
  const pendingEose = [];
  const pendingProfiles = [];
  const pendingUnread = [];
  const unreadHolds = [];
  report.unreadHolds = unreadHolds;
  let heldUnread = false;
  const profileHolds = [];
  report.profileHolds = profileHolds;
  let heldAuthors = new Set();
  // Fixture targets distinguish the two explicit production globals from channels.
  const routeOf = (filter) =>
    filter["#h"]?.[0] ??
    (filter.kinds.length === 1 && filter.kinds[0] === 0
      ? "profiles"
      : filter.kinds.includes(44100)
        ? "membership"
        : filter.kinds.includes(24200)
          ? "observer"
          : filter.kinds.includes(20001)
            ? "presence"
            : undefined);
  report.wireFrames = [];
  let emptyRoster = false;
  let heldContent = false;
  const communityOf = (url) =>
    String(url).includes("secondary") ? "secondary" : "primary";
  const fault = (error) => {
    report.unexpected.push(String(error));
    throw error;
  };
  function emit(socket, frame) {
    report.wireFrames.push(frame);
    if (socket.readyState === 1)
      socket.onmessage?.({ data: JSON.stringify(frame) });
  }
  return {
    presence(community, event, updateSnapshot = true) {
      expect(event.kind).toBe(20001);
      expect(verifyEvent(event)).toBe(true);
      if (updateSnapshot)
        presence.set(`${community}:${event.pubkey}`, {
          status: event.content,
          expires: Date.now() + 180000,
        });
      let deliveries = 0;
      for (const socket of sockets) {
        if (socket.readyState !== 1 || socket.community !== community) continue;
        for (const [id, filter] of socket.routes) {
          if (
            !filter.kinds.includes(20001) ||
            !filter.authors?.includes(event.pubkey)
          )
            continue;
          emit(socket, ["EVENT", id, event]);
          deliveries++;
        }
      }
      expect(deliveries).toBeGreaterThan(0);
    },
    holdPresence(onStart) {
      heldPresence = true;
      presenceStarted = onStart;
    },
    releasePresence() {
      heldPresence = false;
      presenceStarted = undefined;
      for (const release of pendingPresence.splice(0)) release();
    },
    holdContent() {
      heldContent = true;
    },
    holdProfiles(authors) {
      heldAuthors = new Set(authors);
    },
    releaseProfiles() {
      heldAuthors.clear();
      for (const release of pendingProfiles.splice(0)) release();
    },
    holdUnread() {
      heldUnread = true;
    },
    releaseUnread() {
      heldUnread = false;
      for (const release of pendingUnread.splice(0)) release();
    },
    holdEose(channel) {
      heldEose.add(channel);
    },
    releaseEose(channel) {
      heldEose.delete(channel);
      for (let i = pendingEose.length - 1; i >= 0; i--) {
        if (pendingEose[i].channel !== channel) continue;
        const [item] = pendingEose.splice(i, 1);
        emit(item.socket, ["EOSE", item.id]);
      }
    },
    sockets,
    requests,
    rejected,
    expectedHttpErrors: () => rejected.length > 0,
    emptyRoster() {
      emptyRoster = true;
    },
    quotaNextRoster(seconds = 1) {
      quotas.set("roster", seconds);
    },
    quotaNextHead(channel, seconds = 1) {
      quotas.set(channel, seconds);
    },
    quotaNextOlder(channel, seconds = 1) {
      quotas.set(`older:${channel}`, seconds);
    },
    async fetch(url, init) {
      try {
        if (!init?.body && discovery)
          return Response.json(discovery(communityOf(url)));
        expect(["/query", ...(acceptPublication ? ["/events"] : [])]).toContain(
          new URL(url).pathname,
        );
        const auth = JSON.parse(
          Buffer.from(init.headers.Authorization.slice(6), "base64").toString(),
        );
        expect(verifyEvent(auth)).toBe(true);
        expect(auth.pubkey).toBe(viewer);
        expect(auth.kind).toBe(27235);
        expect(auth.tags).toContainEqual(["u", String(url)]);
        expect(auth.tags).toContainEqual([
          "payload",
          createHash("sha256").update(init.body).digest("hex"),
        ]);
        const filters = JSON.parse(init.body);
        const reason = charge(
          communityOf(url),
          "ApiCalls",
          new URL(url).pathname,
        );
        if (reason) return Response.json({ error: reason }, { status: 429 });
        if (new URL(url).pathname === "/events") {
          acceptPublication(communityOf(url), filters);
          return Response.json({ accepted: true, event_id: filters.id });
        }
        if (filters.length === 2 && filters[1].depth_limit) {
          const [root, replies] = filters;
          expect(root).toEqual({
            ids: replies["#e"],
            "#h": replies["#h"],
            limit: 1,
          });
          expect(replies.kinds.toSorted((a, b) => a - b)).toEqual([9, 40002]);
          for (const filter of filters)
            report.queries.push({
              community: communityOf(url),
              filter,
              at: performance.now(),
            });
          return Response.json(
            filters.flatMap((filter) => answer(communityOf(url), filter)),
          );
        }
        if (filters.length !== 1) {
          // The read-only sidebar projection reads the two exact coordinates.
          expect(filters).toHaveLength(2);
          expect(filters.map((filter) => filter["#d"]?.[0]).sort()).toEqual([
            "channel-sections",
            "channel-stars",
          ]);
          for (const filter of filters) {
            expect(filter.kinds).toEqual([30078]);
            expect(filter.authors).toEqual([viewer]);
            expect(filter.limit).toBe(1);
            report.queries.push({
              community: communityOf(url),
              filter,
              at: performance.now(),
            });
          }
          return Response.json(
            filters.flatMap((filter) => answer(communityOf(url), filter)),
          );
        }
        const filter = filters[0],
          community = communityOf(url);
        report.queries.push({ community, filter, at: performance.now() });
        if (filter.kinds?.includes(20001)) {
          expect(filter.kinds).toEqual([20001]);
          expect(filter.authors.length).toBeGreaterThan(0);
          expect(filter.authors.length).toBeLessThanOrEqual(256);
          expect(filter.limit).toBe(filter.authors.length);
          const result = filter.authors.flatMap((author) => {
            const value = presence.get(`${community}:${author}`);
            return value && value.expires > Date.now()
              ? [presenceSnapshot(author, value.status)]
              : [];
          });
          if (heldPresence)
            return new Promise((resolve, reject) => {
              const held = {
                at: performance.now(),
                pending: true,
                aborted: false,
              };
              report.presenceHolds.push(held);
              const abort = () => {
                held.pending = false;
                held.aborted = true;
                held.completedAt = performance.now();
                reject(init.signal.reason);
              };
              if (init.signal.aborted) return abort();
              init.signal.addEventListener("abort", abort, { once: true });
              pendingPresence.push(() => {
                init.signal.removeEventListener("abort", abort);
                if (!held.pending) return;
                held.pending = false;
                held.completedAt = performance.now();
                resolve(Response.json(result));
              });
              const started = presenceStarted;
              presenceStarted = undefined;
              started?.(held);
            });
          return Response.json(result);
        }
        if (heldContent && filter.kinds?.includes(9))
          return new Promise((_resolve, reject) => {
            if (init.signal.aborted) reject(init.signal.reason);
            else
              init.signal.addEventListener(
                "abort",
                () => reject(init.signal.reason),
                { once: true },
              );
          });
        const channel = filter["#h"]?.[0];
        // Head catch-up is an exact top-level channel window, not a batched
        // sidebar preview that happens to contain that channel.
        const quota = filter.kinds?.includes(39002)
          ? "roster"
          : filter.kinds?.includes(9)
            ? filter.until === undefined
              ? filter["#h"]?.length === 1 && filter.top_level === true
                ? channel
                : undefined
              : `older:${channel}`
            : undefined;
        if (quotas.has(quota)) {
          const seconds = quotas.get(quota);
          quotas.delete(quota);
          rejected.push({
            channel,
            until: performance.now() + (seconds + 1) * 1000,
          });
          return Response.json(
            { error: `rate-limited: quota exceeded; retry in ${seconds}s` },
            { status: 429 },
          );
        }
        const result =
          emptyRoster && filter.kinds?.includes(39002)
            ? []
            : answer(community, filter);
        if (
          heldUnread &&
          filter.kinds?.includes(9) &&
          filter["#h"]?.length &&
          filter.top_level === undefined &&
          filter.depth_limit === undefined &&
          filter.until === undefined
        )
          return new Promise((resolve, reject) => {
            const held = { pending: true, aborted: false };
            unreadHolds.push(held);
            const abort = () => {
              held.pending = false;
              held.aborted = true;
              reject(init.signal.reason);
            };
            if (init.signal.aborted) return abort();
            init.signal.addEventListener("abort", abort, { once: true });
            pendingUnread.push(() => {
              held.pending = false;
              init.signal.removeEventListener("abort", abort);
              if (!held.aborted) resolve(Response.json(result));
            });
          });
        if (
          filter.kinds?.includes(0) &&
          filter.authors?.some((id) => heldAuthors.has(id))
        )
          return new Promise((resolve, reject) => {
            const held = { pending: true, aborted: false };
            profileHolds.push(held);
            const abort = () => {
              held.pending = false;
              held.aborted = true;
              reject(init.signal.reason);
            };
            init.signal.addEventListener("abort", abort, { once: true });
            pendingProfiles.push(() => {
              held.pending = false;
              init.signal.removeEventListener("abort", abort);
              resolve(Response.json(result));
            });
          });
        if (filter.until !== undefined)
          return new Promise((resolve, reject) => {
            const abort = () => reject(init.signal.reason);
            init.signal.addEventListener("abort", abort, { once: true });
            pending.push({
              community,
              channel,
              filter,
              events: result.filter((event) => event.kind === 9),
              release() {
                init.signal.removeEventListener("abort", abort);
                resolve(Response.json(result));
              },
            });
          });
        return Response.json(result);
      } catch (error) {
        return fault(error);
      }
    },
    socket(url) {
      const socket = {
        community: communityOf(url),
        readyState: 1,
        authenticated: false,
        routes: new Map(),
        send(text) {
          try {
            const [kind, id, filter] = JSON.parse(text);
            if (kind === "AUTH") {
              expect(verifyEvent(id)).toBe(true);
              expect(id.pubkey).toBe(viewer);
              expect(id.tags).toContainEqual(["challenge", "policy-fixture"]);
              this.authenticated = true;
              queueMicrotask(() => emit(this, ["OK", id.id, true]));
              return;
            }
            if (kind === "CLOSE") {
              this.routes.delete(id);
              return;
            }
            if (kind === "REQ" || kind === "EVENT") {
              expect(this.authenticated).toBe(true);
              const reason =
                charge(this.community, "WsEvents", kind) ||
                (kind === "EVENT" && charge(this.community, "Messages", kind));
              if (reason) {
                queueMicrotask(() =>
                  emit(
                    this,
                    kind === "REQ"
                      ? ["CLOSED", id, reason]
                      : ["OK", id.id, false, reason],
                  ),
                );
                return;
              }
            }
            if (kind === "EVENT") {
              expect(this.authenticated).toBe(true);
              expect(verifyEvent(id)).toBe(true);
              expect(id.pubkey).toBe(viewer);
              expect(id.kind).toBe(20001);
              expect(id.tags).toEqual([]);
              expect(["online", "away"]).toContain(id.content);
              presence.set(`${this.community}:${id.pubkey}`, {
                status: id.content,
                expires: Date.now() + 180000,
              });
              report.presencePublications.push({
                community: this.community,
                event: id,
                at: performance.now(),
              });
              queueMicrotask(() => emit(this, ["OK", id.id, true]));
              return;
            }
            expect(kind).toBe("REQ");
            expect(this.authenticated).toBe(true);
            requests.push({
              socket: sockets.indexOf(this),
              community: this.community,
              id,
              filter,
              route: routeOf(filter),
              at: performance.now(),
            });
            const channel = filter["#h"]?.[0];
            // A broad channel REQ cannot substitute for explicit #h fan-out.
            if (
              filter.kinds.includes(9) &&
              (!channel || filter["#h"].length !== 1)
            ) {
              queueMicrotask(() =>
                emit(this, [
                  "CLOSED",
                  id,
                  "restricted: channel filter required",
                ]),
              );
              return;
            }
            if (filter.kinds.includes(20001)) {
              expect(filter.kinds).toEqual([20001]);
              expect(filter.authors.length).toBeGreaterThan(0);
              expect(filter.authors.length).toBeLessThanOrEqual(256);
              expect(
                filter.authors.every((author) => /^[0-9a-f]{64}$/.test(author)),
              ).toBe(true);
              expect(filter.limit).toBe(0);
              expect(filter["#h"]).toBeUndefined();
            }
            if (filter.kinds.includes(44100))
              expect(filter["#p"]).toEqual([viewer]);
            if (filter.kinds.includes(24200)) {
              expect(filter["#p"]).toEqual([viewer]);
              expect(filter["#h"]).toBeUndefined();
              expect(filter.limit).toBeUndefined();
              expect(filter.since).toBeGreaterThanOrEqual(
                Math.floor(Date.now() / 1000) - 1,
              );
            }
            this.routes.set(id, filter);
            const route = routeOf(filter);
            if (heldEose.has(route))
              pendingEose.push({ socket: this, id, channel: route });
            else queueMicrotask(() => emit(this, ["EOSE", id]));
          } catch (error) {
            fault(error);
          }
        },
        close() {
          this.readyState = 3;
          this.routes.clear();
          this.onclose?.();
        },
      };
      sockets.push(socket);
      queueMicrotask(() => emit(socket, ["AUTH", "policy-fixture"]));
      return socket;
    },
    hasRoute(community, channel) {
      return sockets.some(
        (s) =>
          s.readyState === 1 &&
          s.community === community &&
          [...s.routes.values()].some((f) => routeOf(f) === channel),
      );
    },
    observer(community, event) {
      let deliveries = 0;
      for (const socket of sockets) {
        if (socket.readyState !== 1 || socket.community !== community) continue;
        for (const [id, filter] of socket.routes) {
          if (!filter.kinds.includes(24200) || !filter["#p"]?.includes(viewer))
            continue;
          emit(socket, ["EVENT", id, event]);
          deliveries++;
        }
      }
      expect(
        deliveries,
        "observer must traverse the production owner-only route",
      ).toBeGreaterThan(0);
    },
    publish(community, event) {
      let deliveries = 0;
      for (const socket of sockets) {
        if (socket.readyState !== 1 || socket.community !== community) continue;
        for (const [id, filter] of socket.routes) {
          if (
            !filter.kinds.includes(event.kind) ||
            !filter["#h"]?.some((h) =>
              event.tags.some(([k, v]) => k === "h" && h === v),
            )
          )
            continue;
          emit(socket, ["EVENT", id, event]);
          deliveries++;
        }
      }
      expect(
        deliveries,
        "event must traverse an explicit production channel REQ",
      ).toBeGreaterThan(0);
    },
    failRoute(
      community,
      channel,
      reason = "temporary: fixture stream interrupted",
    ) {
      let failures = 0;
      for (const socket of sockets) {
        if (socket.readyState !== 1 || socket.community !== community) continue;
        for (const [id, filter] of [...socket.routes]) {
          if (routeOf(filter) !== channel) continue;
          socket.routes.delete(id);
          emit(socket, ["CLOSED", id, reason]);
          failures++;
        }
      }
      expect(failures).toBeGreaterThan(0);
    },
    disconnect(community) {
      for (const socket of sockets)
        if (socket.community === community && socket.readyState === 1)
          socket.close();
    },
  };
}
