// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import type { ComposerAccessoryProps, ComposerAccessory } from "./contracts";
import type { Contribution } from "../../plugins/contributions";
import { ComposerAccessories } from "./ComposerAccessories";
import type { RelaySession } from "../relay/session";

afterEach(cleanup);

it("revokes navigation after contribution removal, replacement and composer unmount", () => {
  let commands!: ComposerAccessoryProps;
  function Accessory(props: ComposerAccessoryProps) {
    useLayoutEffect(() => {
      commands = props;
    });
    return null;
  }
  const entry: Contribution<ComposerAccessory> = {
    id: "activity",
    key: "test:activity",
    pluginId: "test",
    revision: "one",
    title: "Activity",
    component: Accessory,
  };
  let entries = [entry];
  const listeners = new Set<() => void>();
  const registry = {
    snapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const publish = () =>
    act(() => {
      for (const listener of listeners) listener();
    });
  const open = vi.fn(() => true);
  const canOpen = vi.fn(() => true);
  const view = render(
    <ComposerAccessories
      registry={registry}
      session={{} as RelaySession}
      scope="scope"
      channelId="channel"
      open={open}
      canOpen={canOpen}
    />,
    { reactStrictMode: true },
  );
  const original = commands;
  expect(original.open("target")).toBe(true);
  expect(original.canOpen("target")).toBe(true);
  entries = [];
  // Registry invalidation must reject saved commands even before React commits.
  expect(original.open("target")).toBe(false);
  expect(original.canOpen("target")).toBe(false);
  publish();
  entries = [entry];
  publish();
  const restored = commands;
  expect(original.open("target")).toBe(false);
  expect(restored.open("target")).toBe(true);
  entries = [{ ...entry, revision: "two" }];
  expect(restored.open("target")).toBe(false);
  expect(restored.canOpen("target")).toBe(false);
  publish();
  const replacement = commands;
  expect(replacement.open("target")).toBe(true);
  view.unmount();
  expect(replacement.open("target")).toBe(false);
  expect(replacement.canOpen("target")).toBe(false);
  expect(listeners.size).toBe(0);
  expect(open).toHaveBeenCalledTimes(3);
  expect(canOpen).toHaveBeenCalledTimes(1);
});
