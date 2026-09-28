// Manual browser fixture: all broker traffic is handled here; no remote writes or agreements.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CommunityDialog } from "../../src/features/communities/CommunityDialog";
import { createCommunities } from "../../src/features/communities/service";
import { communityDestination } from "../../src/features/communities/destination";
import { Context } from "@deepseek-ai/cordis";
import {
  keypair,
  profile as profileEvent,
} from "../../src/features/relay/testing";
import type { RelayEvent } from "../../src/features/relay/events";
import { useState, useSyncExternalStore } from "react";
import "../../src/shared/styles/globals.css";
const identity = keypair();
const viewer = identity.pubkey;
const profiles = new Map<string, RelayEvent>();
const admitted = new Set<string>();
let rejectProfile = true;
const calls: string[] = [];
window.fetch = async (input, init) => {
  const url = String(input);
  const route = url.split("/").at(-1);
  let id = "local";
  if (route !== "identity" && route !== "register") {
    const destination = url.split("/")[3];
    if (!destination) throw new Error("Missing fixture community destination");
    id = decodeURIComponent(destination);
  }
  calls.push(`${id}/${route}`);
  if (route === "identity") return Response.json({ viewer });
  if (route === "register")
    return Response.json(
      communityDestination(JSON.parse(String(init?.body)).url),
    );
  if (route === "info")
    return Response.json({
      name: id,
      icon: "https://invalid.example/fixture-icon.png",
      policy: {
        version: "fixture",
        terms_markdown: "Fixture only",
        privacy_markdown: "Fixture only",
        age_attestation_required: true,
      },
    });
  if (route === "session")
    return Response.json({
      viewer,
      relayAuthor: "e".repeat(64),
      relayUrl: communityDestination(id).url,
    });
  if (route === "accept-policy")
    return Response.json({ receipt: "fixture-receipt" });
  if (route === "claim") {
    admitted.add(id);
    return Response.json({ status: "joined" });
  }
  if (route === "query") {
    if (!admitted.has(id))
      return Response.json({ error: "Invite required" }, { status: 403 });
    const filters = JSON.parse(String(init?.body));
    const saved = profiles.get(id);
    return Response.json(
      saved &&
        filters.some((filter: { kinds?: number[] }) =>
          filter.kinds?.includes(0),
        )
        ? [saved]
        : [],
    );
  }
  if (route === "profile") {
    if (rejectProfile) {
      rejectProfile = false;
      return Response.json({
        accepted: false,
        message: "Fixture profile rejection: retry to continue",
      });
    }
    const body = JSON.parse(String(init?.body));
    calls.push(`published ${id}: ${body.name}`);
    const saved = profileEvent(identity, {
      ...body.existing,
      name: body.name,
      picture: body.picture,
      about: body.about,
    });
    profiles.set(id, saved);
    return Response.json({ accepted: true, event_id: saved.id });
  }
  throw new Error(`Unexpected fixture request: ${url}`);
};
localStorage.removeItem(`buzz-client.v1:${viewer}`);
const ctx = new Context();
const communities = createCommunities(ctx, true);
function Fixture() {
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const [mode, setMode] = useState<"join" | "profile">();
  return (
    <div className="p-8">
      <h1>Local join fixture — no remote requests or binding agreements</h1>
      <p>
        Use any invite code. The first profile publication is deliberately
        rejected.
      </p>
      <button type="button" onClick={() => setMode("profile")}>
        Edit local profile
      </button>
      <button type="button" onClick={() => setMode("join")}>
        Join fixture community
      </button>
      <p>Local profile: {client.profile.name || "unset"}</p>
      <p>
        Memberships: {client.memberships.map((m) => m.id).join(", ") || "none"}
      </p>
      <p>Selected: {client.selected ?? "none"}</p>
      <pre>{calls.join("\n")}</pre>
      {mode && (
        <CommunityDialog
          mode={mode}
          communities={communities}
          close={() => setMode(undefined)}
        />
      )}
    </div>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
