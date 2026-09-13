import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountSettings } from "./AccountSettings";
import {
  createIdentity,
  STATUS_TIMEOUT_MS,
  type Identity,
} from "../features/identity/service";
import type {
  IdentityBackend,
  IdentityStatus,
} from "../features/identity/contracts";

const A = "a".repeat(64);
const signedOut: IdentityStatus = {
  state: "signedOut",
  pubkey: null,
  generation: "0",
  revocation: "00000000-0000-4000-8000-000000000001",
  busy: false,
  reason: null,
};
const owners: Identity[] = [];
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function host(current: IdentityStatus = signedOut): IdentityBackend {
  return {
    status: async () => current,
    importLegacy: async () => current,
    unlockSaved: async () => current,
    signOut: async () => current,
  };
}
function owner(backend?: IdentityBackend) {
  const identity = createIdentity(backend, {
    storage: { getItem: () => A, setItem() {} },
  });
  owners.push(identity);
  return identity;
}
const render = (identity: Identity) =>
  renderToStaticMarkup(<AccountSettings identity={identity} />);
afterEach(() => {
  for (const identity of owners.splice(0)) identity.dispose();
  vi.useRealTimers();
});
it("shows the remembered public selection, explicit copy consent and independent-copy warning", async () => {
  const identity = owner(host());
  await flush();
  const html = render(identity);
  expect(html).toContain(`value="${A}"`);
  expect(html).toContain("Existing public key");
  expect(html).toContain("Unlock saved identity");
  expect(html).toContain("Credential source (macOS)");
  expect(html).toMatch(
    /<button[^>]*disabled[^>]*>Copy my existing Buzz identity/,
  );
  expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
  expect(html).toContain("I authorize copying");
  expect(html).toContain("will not update this independent copy");
  expect(html).toContain("it does not unlock anything by itself");
  expect(html).not.toContain('type="password"');
  expect(html).toContain("Reloading this window keeps the native identity");
});
it("shows native ready plus sign-out, not a private-key/import form", async () => {
  const identity = owner(host({ ...signedOut, state: "ready", pubkey: A }));
  await flush();
  const html = render(identity);
  expect(html).toContain(`<code>${A}</code>`);
  expect(html).toContain("Sign out</button>");
  expect(html).not.toContain("<form");
});
it("does not advertise unavailable platform controls", async () => {
  const identity = owner();
  const html = render(identity);
  expect(html).toContain("not supported on this host yet");
  expect(html).not.toContain("<button");
  expect(html).not.toContain("<input");
});
it.each(["status", "unlock"] as const)(
  "keeps sign-out reachable during hung %s with a captured token",
  async (kind) => {
    const backend = host();
    const identity = owner(backend);
    await flush();
    if (kind === "status") {
      backend.status = () => new Promise(() => {});
      void identity.refresh();
    } else {
      backend.unlockSaved = () => new Promise(() => {});
      void identity.unlockSaved(A);
    }
    const html = render(identity);
    expect(html).toContain("Sign out</button>");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Sign out/);
    expect(html).not.toContain("<form");
  },
);
it("shows recovery after missing initial status without pretending it can revoke without a token", async () => {
  vi.useFakeTimers();
  const backend = host();
  backend.status = () => new Promise(() => {});
  const identity = owner(backend);
  await vi.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS);
  const html = render(identity);
  expect(html).toContain("Check identity status</button>");
  expect(html).toContain("quit the app to revoke");
  expect(html).not.toContain("Sign out</button>");
  expect(html).toContain("missing reply does not cancel");
});
it("busy native state exposes status/sign-out but never another activation form", async () => {
  const identity = owner(host({ ...signedOut, busy: true, generation: "1" }));
  await flush();
  const html = render(identity);
  expect(html).toContain("Check status when it finishes");
  expect(html).toContain("Check identity status</button>");
  expect(html).toContain("Sign out</button>");
  expect(html).not.toContain("<form");
});
