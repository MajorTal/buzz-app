import type { CommunitySetup } from "./api";
import type { CommunityAccount, PersonalProfile } from "./service";
import type { RelaySession } from "../relay/session";
import { newer, type EventData } from "../relay/events";
import type { Outbox } from "../relay/outbox";
import { byteSize } from "../relay/budget";

function parse(event?: EventData) {
  let existing: Record<string, unknown> = {};
  if (event) {
    try {
      const value: unknown = JSON.parse(event.content);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      existing = value as Record<string, unknown>;
    } catch {
      throw new Error("Community profile is invalid; it was not replaced");
    }
  }
  return {
    existing,
    profile: {
      name:
        typeof existing.display_name === "string"
          ? existing.display_name
          : typeof existing.name === "string"
            ? existing.name
            : "",
      picture: typeof existing.picture === "string" ? existing.picture : "",
    },
    exists: !!event,
  };
}
function pending(outbox?: Outbox) {
  const profiles =
    outbox?.snapshot().filter((item) => item.event.kind === 0) ?? [];
  if (profiles.length > 1)
    throw new Error(
      "Multiple saved profile writes need review in the outbox; no replacement was created",
    );
  return profiles[0];
}
const same = (left: PersonalProfile, right: PersonalProfile) =>
  left.name.trim() === right.name.trim() && left.picture === right.picture;
function settled(outbox: Outbox, id: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: Error) => {
      stop();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () =>
      finish(
        new Error(
          "Profile result could not be confirmed. Reopen this community to check the saved write.",
        ),
      );
    const check = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      if (signal.aborted) abort();
      else if (
        !item ||
        item.delivery === "seen" ||
        item.delivery === "accepted"
      )
        finish();
      else if (item.delivery !== "sending")
        finish(
          new Error(
            item.error ??
              "Profile result could not be confirmed. Retry uses the saved event, not a replacement.",
          ),
        );
    };
    stop = outbox.subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

/** No journal here: setup uses the community's hydrated origin/viewer outbox. */
export function createSetupProfile(
  acquire: () => Promise<RelaySession>,
  account: CommunityAccount,
): Pick<CommunitySetup, "inspectProfile" | "publishProfile"> {
  return {
    async inspectProfile() {
      const session = await acquire();
      account.signal.throwIfAborted();
      const saved = pending(session.outbox);
      const remote = await session.ownProfile(account.signal);
      account.signal.throwIfAborted();
      if (
        saved &&
        remote?.id !== saved.event.id &&
        (!remote || newer(remote, saved.event).id === saved.event.id)
      ) {
        return {
          ...parse(saved.event),
          exists: false,
          pending: true,
          notice:
            "A saved profile write is unresolved. Continue checks or retries that exact event; it does not create a replacement.",
        };
      }
      return {
        ...parse(remote),
        ...(saved && remote?.id !== saved.event.id
          ? {
              notice:
                "The relay has a newer profile. Opening keeps that current profile; the older saved write is not retried.",
            }
          : {}),
      };
    },
    async publishProfile(profile, existing) {
      const content = JSON.stringify({
        ...existing,
        name: profile.name.trim(),
        display_name: profile.name.trim(),
        picture: profile.picture,
      });
      if (
        !profile.name.trim() ||
        profile.name.length > 100 ||
        profile.picture.length > 2048 ||
        (profile.picture && !profile.picture.startsWith("https://")) ||
        byteSize(content) > 16000
      )
        throw new Error(
          "Profile needs a bounded name and an optional HTTPS picture URL",
        );
      const session = await acquire();
      account.signal.throwIfAborted();
      const outbox = session.outbox;
      if (!outbox?.supports(0))
        throw new Error("Profile publishing is unavailable in this host");
      // Capture before a confirmed remote read can move it out of pending retention.
      const saved = pending(outbox);
      const remote = await session.ownProfile(account.signal);
      account.signal.throwIfAborted();
      if (saved && !same(parse(saved.event).profile, profile))
        throw new Error(
          "A different profile write is already saved. Reopen setup to recover it before making a new edit.",
        );
      if (saved && remote?.id === saved.event.id) return;
      if (saved && remote && newer(saved.event, remote).id === remote.id)
        throw new Error(
          "The relay has a newer profile. Reopen setup to use it; no replacement was signed.",
        );
      // A lost setup callback followed by another click is not fresh write intent.
      if (!saved && remote && same(parse(remote).profile, profile)) return;
      // A concurrent submit may have created intent during the read. Re-check in
      // the same synchronous turn as send; only one of them creates an event ID.
      const current = pending(outbox);
      if (current && !same(parse(current.event).profile, profile))
        throw new Error("Another saved profile write must be resolved first");
      const id =
        current?.event.id ??
        saved?.event.id ??
        outbox.send({ kind: 0, content, tags: [] });
      if (
        current &&
        current.delivery !== "sending" &&
        current.delivery !== "accepted"
      )
        outbox.retry(id);
      const signal = AbortSignal.any([
        account.signal,
        AbortSignal.timeout(12000),
      ]);
      await settled(outbox, id, signal);
      account.signal.throwIfAborted();
      const confirmed = await session.ownProfile(account.signal);
      account.signal.throwIfAborted();
      if (confirmed?.id !== id)
        throw new Error(
          "Profile delivery was accepted, but this event is not confirmed as the current profile. Reopen setup to check; no replacement was created.",
        );
    },
  };
}
