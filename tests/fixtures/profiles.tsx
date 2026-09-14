// Real ChannelsPage, thread reader, shared directory, panel registry and plugin lifecycle.
// Only the transport is synthetic. No dev broker, saved identity or live relay.
import { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { createPluginManager } from "../../src/plugins/manager";
import { bundledPlugins } from "../../src/bundled";
import {
  PanelsService,
  type PanelContext,
  type PanelProps,
} from "../../src/features/panels/service";
import { ChannelsPage } from "../../src/bundled/channels/ChannelsPage";
import { createRelaySession } from "../../src/features/relay/session";
import type {
  RelayData,
  RelaySnapshot,
} from "../../src/features/relay/service";
import {
  bounds,
  keypair,
  message,
  metadata,
  profile,
  roster,
  summary,
} from "../../src/features/relay/testing";
import { profileTarget } from "../../src/features/profiles/target";
import "../../src/shared/styles/globals.css";

const viewer = keypair(),
  authority = keypair(),
  mic = keypair(),
  pinky = keypair(),
  missing = keypair();
const root = message(viewer, "one", "Hello @Mic", 10, [["p", mic.pubkey]]);
const unknown = message(missing, "one", "Unknown author", 11);
const reply = message(viewer, "one", "Thread @Pinky", 12, [
  ["e", root.id, "", "reply"],
  ["p", pinky.pubkey],
]);
const report = { profileReads: [] as string[][], publications: 0 };
let failMissing = true;
const data = [
  profile(viewer, { name: "Viewer", about: "Human profile" }),
  profile(mic, { name: "Mic", about: "Mic biography" }),
  profile(pinky, { name: "Pinky", about: "Agent profile" }),
];
function session() {
  return createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: authority.pubkey,
    media: () => undefined,
    async query(filters) {
      return filters.flatMap((filter) => {
        if (filter.kinds?.includes(39002))
          return [
            roster(authority, "one", [viewer.pubkey, mic.pubkey, pinky.pubkey]),
            roster(authority, "two", [viewer.pubkey]),
          ];
        if (filter.kinds?.includes(39000))
          return [
            metadata(authority, "one", "One"),
            metadata(authority, "two", "Two"),
          ];
        if (filter.kinds?.includes(0)) {
          report.profileReads.push([...(filter.authors ?? [])]);
          if (
            failMissing &&
            filter.authors?.length === 1 &&
            filter.authors[0] === missing.pubkey
          )
            throw new Error("Fixture profile failure");
          return data.filter((event) => filter.authors?.includes(event.pubkey));
        }
        if (filter.ids)
          return [root, unknown, reply].filter((event) =>
            filter.ids?.includes(event.id),
          );
        if (filter.depth_limit) return [reply];
        if (filter.kinds?.includes(9))
          return filter["#h"]?.includes("two")
            ? [
                bounds(authority, "two", "head", {
                  has_more: false,
                  next_cursor: null,
                }),
              ]
            : [
                root,
                unknown,
                summary(authority, "one", root.id, {
                  reply_count: 1,
                  participants: [viewer.pubkey],
                }),
                bounds(authority, "one", "head", {
                  has_more: false,
                  next_cursor: null,
                }),
              ];
        return [];
      });
    },
  });
}
let owner = session();
let snapshot: RelaySnapshot = {
  status: "ready",
  generation: 1,
  scope: "fixture:viewer",
  viewer: viewer.pubkey,
  session: owner.session,
};
const listeners = new Set<() => void>();
const relay: RelayData = {
  snapshot: () => snapshot,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  retry() {},
  disconnect() {},
  clearCache: () => owner.clearCache(),
};
const context = new Context();
context.provide("relay", relay);
const contexts: PanelContext[] = [];
function ContextProbe({ context }: PanelProps) {
  useLayoutEffect(() => {
    if (context && contexts.at(-1) !== context) contexts.push(context);
  }, [context]);
  return <p>Context probe</p>;
}
const probing = new URLSearchParams(location.search).has("context-probe");
const manager = createPluginManager(context, {
  bundled: probing
    ? [
        {
          manifest: {
            id: "context.probe",
            name: "Context probe",
            apiVersion: 1,
          },
          module: {
            inject: ["panels"],
            apply(ctx) {
              ctx.panels.register({
                id: "probe",
                title: "Context probe",
                matches: (target) => target.startsWith("nostr:"),
                component: ContextProbe,
              });
            },
          },
        },
      ]
    : bundledPlugins.filter(({ manifest }) => manifest.id === "buzz.profiles"),
});
const panels = new PanelsService(context);
Object.assign(window, {
  profilesFixture: {
    report,
    contexts,
    targets: {
      viewer: profileTarget(viewer.pubkey),
      mic: profileTarget(mic.pubkey),
    },
    disconnect() {
      snapshot = { ...snapshot, status: "disconnected" };
      for (const listener of listeners) listener();
    },
    npubs: Object.fromEntries(
      Object.entries({ viewer, mic, pinky, missing }).map(([name, key]) => [
        name,
        profileTarget(key.pubkey)?.slice(6),
      ]),
    ),
    keys: {
      viewer: viewer.pubkey,
      mic: mic.pubkey,
      pinky: pinky.pubkey,
      missing: missing.pubkey,
    },
    change: manager.change,
    recover() {
      failMissing = false;
      data.push(
        profile(missing, { name: "Recovered", about: "Recovered biography" }),
      );
    },
    replace() {
      owner.dispose();
      owner = session();
      snapshot = {
        ...snapshot,
        generation: snapshot.generation + 1,
        session: owner.session,
      };
      for (const listener of listeners) listener();
    },
  },
});
function Fixture() {
  const [dark, setDark] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          document.documentElement.dataset.colorMode = dark ? "light" : "dark";
          setDark(!dark);
        }}
      >
        Toggle appearance
      </button>
      <div style={{ height: "calc(100vh - 50px)", padding: 16 }}>
        <ChannelsPage relay={relay} panels={panels} />
      </div>
    </>
  );
}
const element = document.getElementById("root");
if (!element) throw new Error("Missing root");
createRoot(element).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
