import { chromium, expect } from "@playwright/test";
import { watchPageErrors } from "../../browser/page-errors.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
const out = process.env.DEMO_OUTPUT ?? "test-results/identity-names-demo";
await mkdir(out, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = watchPageErrors(p);
await p.addInitScript(() => {
  window.demoNotifications = [];
  window.Notification = class {
    static permission = "granted";
    static requestPermission = async () => "granted";
    constructor(title, options) {
      window.demoNotifications.push({ title, options });
    }
    close() {}
  };
});
await p.goto("http://127.0.0.1:1435");
const data = await (await fetch("http://127.0.0.1:1435/demo/data")).json();
const shots = [];
async function shot(id, description) {
  await p.screenshot({ path: `${out}/${id}.png` });
  shots.push({ id, description });
  await writeFile(
    `${out}/SURFACE_CAPTURES.json`,
    JSON.stringify(shots, null, 2),
  );
}
const btn = (name) => p.getByRole("button", { name, exact: true });
async function tour() {
  await p
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Messages", exact: true })
    .click();
  await p.locator('[data-channel-id="surfaces"]').click();
  await btn("Mention a member").click();
  await expect(
    p.getByRole("region", { name: "Mention a member or agent" }),
  ).toContainText("Wes’s Honey");
  await p.keyboard.press("Escape");
  await expect(btn("View Wes’s Honey profile").first()).toBeVisible();
}
await p
  .getByRole("navigation", { name: "Pages", exact: true })
  .getByRole("button", { name: "Messages", exact: true })
  .click();
await p.locator('[data-channel-id="conflict-lab"]').click();
await btn("Mention a member").click();
await expect
  .poll(() =>
    p.evaluate(
      (keys) =>
        keys.every((k) =>
          window.namingDemoServices.relay
            .snapshot()
            .session.profiles.snapshot()
            .has(k),
        ),
      data.channels
        .find((c) => c.id === "conflict-lab")
        .ids.map((i) => data.identities[i].pubkey),
    ),
  )
  .toBe(true);
await p.keyboard.press("Escape");
await tour();
const sent = p
  .locator('[data-mention-kind="agent"]')
  .filter({ hasText: "Honey (agent)" })
  .first();
await sent.scrollIntoViewIfNeeded();
await expect(sent).toBeVisible();
await expect(p.locator("[data-membership-row]")).toContainText(
  "Wes’s Honey added by you",
);
await shot(
  "surface-sent-membership",
  "Sent mention Honey (agent), join row Wes’s Honey, and thread participant avatars",
);

await btn("View Wes’s Honey profile").first().click();
await expect(
  p.getByRole("complementary", { name: "Profile", exact: true }),
).toContainText("Wes’s Honey");
await shot("surface-profile", "Channel-scoped profile heading");
await btn("Close channel panel").click();
await p
  .locator(`[data-message-id="${data.root}"]`)
  .getByRole("button", { name: /^View thread:/ })
  .click();
await expect(
  p.getByRole("complementary", { name: "Thread", exact: true }),
).toContainText("Honey (agent)");
await shot(
  "surface-thread",
  "Thread root and reply use their channel comparison set",
);
await p.getByRole("button", { name: /Close thread/i }).click();
const participant = p.locator(
  `[data-message-id="${data.root}"] [title="Honey (agent)"]`,
);
await participant.hover();
await shot(
  "surface-thread-participant",
  "Thread participant avatar tooltip carries resolved label",
);
await p.mouse.move(0, 0);
const link = p.getByRole("link", { name: "19 Surface tour", exact: true });
await link.hover();
await expect(p.getByText("Wes’s Honey", { exact: true }).last()).toBeVisible();
await expect(
  p.getByRole("link", { name: "Message preview", exact: true }),
).toContainText("Wes’s Honey");
await shot(
  "surface-link-preview",
  "Message-link hover preview author uses linked message channel",
);
await p.keyboard.press("Escape");
await p.mouse.move(0, 0);
await btn("Mention a member").click();
await expect(
  p.getByRole("region", { name: "Mention a member or agent" }),
).toBeVisible();
await shot(
  "surface-picker",
  "Complete eligible choice set; no arbitrary winner for duplicate agents",
);
await p
  .getByRole("region", { name: "Mention a member or agent" })
  .getByRole("button", { name: new RegExp(data.identities.theirs.pubkey) })
  .click();
const input = p.getByRole("textbox", {
  name: "Message #19 Surface tour",
  exact: true,
});
await expect(input.locator(".inline-chip")).toContainText("Wes’s Honey");
await shot(
  "surface-draft",
  "Selected recipient chip resolves against picker choices plus selected keys",
);
await input.press("ControlOrMeta+a");
await input.press("Backspace");
await input.pressSequentially("@Honey");
await expect(p.getByRole("listbox")).toBeVisible();
await shot(
  "surface-completion",
  "Inline @ completion resolves before query filtering",
);
await p.keyboard.press("Escape");
await input.press("ControlOrMeta+a");
await input.press("Backspace");
await fetch("http://127.0.0.1:1435/demo/typing", {
  method: "POST",
  body: JSON.stringify({ identity: "human2" }),
});
await expect(p.getByText(/Honey.*typing/)).toBeVisible();
await shot(
  "surface-typing",
  "Typing name compares with channel members, even if writer is a historical/outside identity",
);
await fetch("http://127.0.0.1:1435/demo/activity", { method: "POST" });
await expect(
  p.getByRole("region", {
    name: "Agent activity in this channel",
    exact: true,
  }),
).toBeVisible();
await shot(
  "surface-activity-accessory",
  "Channel agent-activity accessory readable conflict labels",
);
await p
  .getByRole("region", { name: "Agent activity in this channel", exact: true })
  .getByRole("button")
  .last()
  .click();
await expect(
  p.getByRole("region", { name: "Agent activity", exact: true }),
).toBeVisible();
await p.getByRole("combobox", { name: "Agent", exact: true }).click();
await shot(
  "surface-activity-selector",
  "Observed-agent choices compare snapshot identities, not channel members",
);
await p.keyboard.press("Escape");
await btn("Close channel panel").click();
await p.locator('[data-channel-id="dm-conflicts"]').click();
await expect(p.locator("[data-channel-timeline]")).toContainText("Wes’s Honey");
await shot(
  "surface-dm",
  "DM sidebar and header label compare the participant set",
);
await btn("Search Buzz").click();
const search = p
  .getByRole("dialog", { name: "Search Buzz" })
  .getByRole("combobox");
await search.fill("Honey");
await expect(p.getByRole("dialog", { name: "Search Buzz" })).toContainText(
  "Wes’s Honey",
);
await shot(
  "surface-search-dm",
  "Search conversation label compares DM participants",
);
await search.fill("Readable conflicts");
await expect(p.getByRole("dialog", { name: "Search Buzz" })).toContainText(
  "Wes’s Honey",
);
await shot(
  "surface-search-message",
  "Search message authors compare the source channel",
);
await p.keyboard.press("Escape");
await tour();
await p
  .locator("[data-channel-timeline]")
  .evaluate((el) => (el.scrollTop = el.scrollHeight));
await p
  .getByRole("link", { name: "Open image attachment", exact: true })
  .click();
await expect(p.getByRole("region", { name: "Media comments" })).toContainText(
  "Wes’s Honey",
);
await shot(
  "surface-media-review",
  "Image viewer and real media-comment MessageRow with owner qualifier",
);
await p.keyboard.press("Escape");
const dmLink = p.getByRole("link", { name: "20 Conflict DM", exact: true });
await dmLink.hover();
await expect(
  p.getByRole("link", { name: "Message preview", exact: true }),
).toContainText("Wes’s Honey");
await shot(
  "surface-dm-preview",
  "Linked DM preview author and participant-scoped conversation label",
);
await p.mouse.move(0, 0);
await p.keyboard.press("Escape");
await p.locator('[data-channel-id="unique"]').click();
await p.evaluate(() =>
  window.namingDemoServices.notifications.updatePreferences({
    enabled: true,
    notifyWhileViewing: true,
  }),
);
await fetch("http://127.0.0.1:1435/demo/message", {
  method: "POST",
  body: JSON.stringify({
    thread: data.root,
    mention: true,
    text: "A qualifying unread reply from another owner’s Honey.",
  }),
});
await expect
  .poll(() =>
    p.evaluate(
      () =>
        window.namingDemoServices.relay
          .snapshot()
          .session.unread.activity("surfaces").items?.length,
    ),
  )
  .toBeGreaterThan(0);
await expect
  .poll(() => p.evaluate(() => window.demoNotifications.length))
  .toBeGreaterThan(0);
const notifications = await p.evaluate(() => window.demoNotifications);
expect(notifications.at(-1).title).toBe(
  "Wes’s Honey mentioned you in #19 Surface tour",
);
await writeFile(
  `${out}/NOTIFICATION_PAYLOAD.json`,
  JSON.stringify(notifications, null, 2),
);
await p.locator('[data-channel-id="surfaces"]').hover();
await expect(
  p.getByRole("button", { name: /Open unread thread from Wes’s Honey:/ }),
).toBeVisible();
await shot(
  "surface-sidebar-activity",
  "Unread thread hover popover with qualified author",
);
await p.mouse.move(0, 0);
await p.keyboard.press("Escape");
await p
  .getByRole("navigation", { name: "Pages", exact: true })
  .getByRole("button", { name: "Sessions", exact: true })
  .click();
await btn("Choose an agent").click();
await expect(p.getByRole("menu")).toContainText("Honey · jus6");
await shot(
  "surface-new-session-selector",
  "New-session agent menu uses all library choices",
);
await p.keyboard.press("Escape");
await p.getByRole("button", { name: /21 Conflict session/ }).click();
await btn("Choose an agent").click();
await expect(p.getByRole("menu")).toContainText("Wes’s Honey");
await shot("surface-existing-session-selector", "Existing-session agent menu");
await p.keyboard.press("Escape");
const navigationResult = await p.evaluate(async (messageId) => {
  const svc = window.namingDemoServices;
  const state = svc.relay.snapshot();
  return svc.navigation.open({
    version: 1,
    kind: "conversation",
    scope: {
      communityOrigin: "https://names.demo.invalid",
      viewer: state.viewer,
    },
    channelId: "session-demo",
    messageId,
  });
}, data.oldSessionMessage);
expect(navigationResult).toEqual({ status: "opened" });
await expect(
  p.getByRole("region", { name: "Selected session message" }),
).toContainText("Wes’s Honey");
await shot(
  "surface-session-target",
  "Exact older session message uses channel-scoped MessageRow",
);
await p
  .getByRole("navigation", { name: "Pages", exact: true })
  .getByRole("button", { name: "Agents", exact: true })
  .click();
await expect(
  p.getByRole("heading", { name: "Honey · jus6", exact: true }),
).toBeVisible();
await shot(
  "surface-managed-agents",
  "Production managed-agent page with modeled native snapshot; not a native process screenshot",
);
await p
  .getByRole("button", { name: "Actions for Honey · jus6", exact: true })
  .click();
await p.getByRole("menuitem", { name: "Edit", exact: true }).click();
await expect(p.getByRole("dialog")).toContainText("Honey · jus6");
await shot(
  "surface-agent-editor",
  "Production native-agent editor with modeled read-only host",
);
await p
  .getByRole("dialog")
  .getByRole("button", { name: "Cancel", exact: true })
  .click();
await p.goto("http://127.0.0.1:1435/?library");
await p
  .getByRole("navigation", { name: "Pages", exact: true })
  .getByRole("button", { name: "Agents", exact: true })
  .click();
await btn("Refresh agents").click();
await expect(
  p.getByRole("button", { name: "Honey template: 2 identities", exact: true }),
).toBeVisible();
await p
  .getByRole("button", { name: "Honey template: 2 identities", exact: true })
  .click();
await expect(p.getByText("Honey · hysa", { exact: true })).toBeVisible();
await shot(
  "surface-agent-library",
  "Browser read-only library; custom cards and template identities qualify against the complete library",
);
await p
  .getByRole("heading", { name: "Honey · jus6", exact: true })
  .scrollIntoViewIfNeeded();
await expect(
  p.getByRole("heading", { name: "Honey · jus6", exact: true }),
).toBeVisible();
await shot(
  "surface-library-custom",
  "Custom library identity cards with key qualifiers; template names are not identity names",
);
expect(pageErrors.unexplained()).toEqual([]);
await writeFile(
  `${out}/SURFACE_CAPTURES.json`,
  JSON.stringify(
    {
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      dirty: execFileSync("git", ["status", "--short"], { encoding: "utf8" }),
      browser: b.version(),
      shots,
      errors: pageErrors.errors,
    },
    null,
    2,
  ),
);
console.log(shots);
await b.close();
