import { expect, it, vi } from "vitest";
import { selectProfiles } from "./profile-selection";
import { foldProfiles } from "./profiles";
import { createProfileDirectory } from "./profile-directory";
import { createRelayReader } from "./reader";
import { keypair, profile, scriptedTransport, signed } from "./testing";
const user = keypair();
it("projects about safely and publishes an about-only replacement/removal", () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  try {
    directory.accept([profile(user, { name: "Mic", about: "First" }, 1)]);
    const before = directory.queries.snapshot().get(user.pubkey);
    expect(before?.about).toBe("First");
    directory.accept([profile(user, { name: "Mic", about: "Second" }, 2)]);
    expect(directory.queries.snapshot().get(user.pubkey)?.about).toBe("Second");
    expect(directory.queries.snapshot().get(user.pubkey)).not.toBe(before);
    directory.accept([profile(user, { name: "Mic" }, 3)]);
    expect(
      directory.queries.snapshot().get(user.pubkey)?.about,
    ).toBeUndefined();
    expect(
      foldProfiles([
        profile(user, { name: "Mic", about: { unsafe: true } }),
      ]).get(user.pubkey),
    ).toEqual({ name: "Mic" });
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("retains self-authored agent metadata without inferring it from display names", () => {
  const author = keypair();
  const profiles = foldProfiles([
    signed(author, {
      kind: 0,
      content: JSON.stringify({ name: "Agent-looking human", is_agent: true }),
      tags: [],
    }),
  ]);
  expect(profiles.get(author.pubkey)?.isAgent).toBe(true);
});

it.each([
  { field: "is_agent", removal: { is_agent: false } },
  { field: "isAgent", removal: {} },
])(
  "notifies the directory and selected profile on $field-only addition/removal",
  ({ field, removal }) => {
    const wire = scriptedTransport(user.pubkey, keypair().pubkey);
    const reader = createRelayReader(wire.transport);
    const directory = createProfileDirectory(reader.reader);
    const selection = selectProfiles(directory.queries, [user.pubkey]);
    const directoryChanged = vi.fn();
    const selectedChanged = vi.fn();
    const unsubscribeDirectory = directory.queries.subscribe(directoryChanged);
    const unsubscribeSelection = selection.subscribe(selectedChanged);
    try {
      directory.accept([profile(user, { name: "Mic" }, 1)]);
      const before = selection.snapshot();
      directoryChanged.mockClear();
      selectedChanged.mockClear();

      directory.accept([profile(user, { name: "Mic", [field]: true }, 2)]);
      const added = selection.snapshot();
      expect(added).not.toBe(before);
      expect(added.get(user.pubkey)).toBe(
        directory.queries.snapshot().get(user.pubkey),
      );
      expect(added.get(user.pubkey)).toEqual({ name: "Mic", isAgent: true });
      expect(directoryChanged).toHaveBeenCalledTimes(1);
      expect(selectedChanged).toHaveBeenCalledTimes(1);

      // A newer event with identical display values must still preserve identity.
      directory.accept([profile(user, { name: "Mic", [field]: true }, 3)]);
      expect(selection.snapshot()).toBe(added);
      expect(directoryChanged).toHaveBeenCalledTimes(1);
      expect(selectedChanged).toHaveBeenCalledTimes(1);

      directory.accept([profile(user, { name: "Mic", ...removal }, 4)]);
      const removed = selection.snapshot();
      expect(removed).not.toBe(added);
      expect(removed.get(user.pubkey)).toBe(
        directory.queries.snapshot().get(user.pubkey),
      );
      expect(removed.get(user.pubkey)).toEqual({ name: "Mic" });
      expect(directoryChanged).toHaveBeenCalledTimes(2);
      expect(selectedChanged).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribeSelection();
      unsubscribeDirectory();
      directory.dispose();
      reader.dispose();
    }
  },
);
