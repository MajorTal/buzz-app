import { expect, it } from "vitest";
import { DiscoveryState } from "./discovery";
import { keypair, roster, signed } from "./testing";
import { SESSION_CHANNEL_DESCRIPTION } from "../sessions/metadata";
it("recognizes only relay-authorized private channel session metadata and keeps ordinary thread reads", () => {
  const viewer = keypair(),
    relay = keypair();
  const discovery = new DiscoveryState(viewer.pubkey, relay.pubkey);
  discovery.accept(roster(relay, "work", [viewer.pubkey]));
  const metadata = (
    author: typeof relay,
    privateChannel: boolean,
    time: number,
  ) =>
    signed(author, {
      kind: 39000,
      created_at: time,
      content: "",
      tags: [
        ["d", "work"],
        ["name", "Work"],
        ["t", "stream"],
        ["about", SESSION_CHANNEL_DESCRIPTION],
        ...(privateChannel ? [["private"]] : []),
      ],
    });
  discovery.accept(metadata(viewer, true, 1));
  expect(discovery.isSession("work")).toBe(false);
  discovery.accept(metadata(relay, false, 1));
  expect(discovery.isSession("work")).toBe(false);
  discovery.accept(metadata(relay, true, 2));
  expect(discovery.channels()[0]?.channelType).toBe("session");
  discovery.accept(
    signed(relay, {
      kind: 39000,
      created_at: 3,
      content: "",
      tags: [
        ["d", "work"],
        ["t", "session"],
      ],
    }),
  );
  expect(discovery.isSession("work")).toBe(false);
});

it("restores an ordinary child from signed metadata without inheriting parent access", () => {
  const viewer = keypair(),
    relay = keypair();
  const parent = "11111111-1111-4111-8111-111111111111";
  const child = "22222222-2222-4222-8222-222222222222";
  const discovery = new DiscoveryState(viewer.pubkey, relay.pubkey);
  discovery.accept(roster(relay, parent, [viewer.pubkey]));
  discovery.accept(
    signed(relay, {
      kind: 39000,
      content: "",
      tags: [
        ["d", child],
        ["t", "stream"],
        ["private"],
        ["name", "Work"],
        ["about", `${SESSION_CHANNEL_DESCRIPTION}\nparent:${parent}`],
      ],
    }),
  );
  expect(discovery.authorized(child)).toBe(false);
  discovery.accept(roster(relay, child, [viewer.pubkey]));
  expect(discovery.channels().find((item) => item.id === child)).toMatchObject({
    channelType: "session",
    parentChannelId: parent,
  });
  discovery.accept(roster(relay, parent, [], 1800000000));
  expect(discovery.authorized(parent)).toBe(false);
  expect(discovery.authorized(child)).toBe(true);
});
