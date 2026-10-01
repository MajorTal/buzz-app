import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { connect } from "node:net";
import { once } from "node:events";

test.use({ pluginFixtures: true, historyCounts: { alpha: 0, beta: 0 } });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const companionLauncher = (page, name) =>
  button(page, name).and(page.locator("button[aria-expanded]"));
const card = (page, name) =>
  page.getByRole("complementary", { name, exact: true });

test("a second plugin uses the same launcher slot without remounting a legacy page or accepting stale handlers", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Legacy");
  const draft = page.getByRole("textbox", { name: "Legacy page draft" });
  await draft.fill("Keep the page instance");
  await button(page, "Notes").click();
  await expect(card(page, "Notes")).toHaveCount(1);
  await expect(card(page, "Wrong panel")).toHaveCount(0);
  await expect(card(page, "Notes")).toContainText("not-an-agent-api");
  await expect(draft).toHaveValue("Keep the page instance");
  const note = page.getByRole("textbox", { name: "Panel note" });
  await note.fill("Close this opening");
  await button(page, "Notes").click();
  await expect(card(page, "Notes")).toHaveCount(0);
  await expect(button(page, "Notes")).toBeFocused();
  await expect(draft).toHaveValue("Keep the page instance");
  await button(page, "Notes").click();
  await expect(note).toHaveValue("");
  await companionLauncher(page, "Companion fixture").click();
  await expect(card(page, "Notes")).toHaveCount(0);
  await expect(card(page, "Companion fixture")).toHaveCount(1);
  await page.evaluate(() => window.stalePanelClose());
  await expect(card(page, "Companion fixture")).toHaveCount(1);
  await button(page, "Close Companion fixture panel").click();
  await expect(draft).toHaveValue("Keep the page instance");
  await button(page, "Notes").click();
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await button(page, "Plugins").click();
  await page.getByRole("switch", { name: "Enable Notes fixture" }).click();
  await expect(button(page, "Notes")).toHaveCount(0);
  await expect(card(page, "Notes")).toHaveCount(0);
  await page.getByRole("switch", { name: "Enable Notes fixture" }).click();
  await expect(button(page, "Notes")).toBeVisible();
  await expect(card(page, "Notes")).toHaveCount(0);
  await companionLauncher(page, "Companion fixture").click();
  await page.evaluate(() => window.stalePanelClose());
  await expect(card(page, "Companion fixture")).toHaveCount(1);
});

test("the launched card works with an empty Channels roster", async ({
  page,
  app,
}) => {
  // Exercise the actual fixture middleware, not just its body-reader helper.
  // 100 Continue proves Node accepted the headers before the client disconnects.
  const socket = connect(Number(new URL(app.origin).port), "127.0.0.1");
  try {
    await once(socket, "connect");
    const accepted = once(socket, "data");
    socket.write(
      'POST /api/relay/primary/query HTTP/1.1\r\nHost: localhost\r\nExpect: 100-continue\r\nContent-Length: 100\r\n\r\n[{"kinds":',
    );
    expect(String((await accepted)[0])).toContain("100 Continue");
  } finally {
    socket.destroy();
  }
  await expect
    .poll(() => app.report.cancelledRequests)
    .toEqual([{ method: "POST", url: "/api/relay/primary/query" }]);
  expect(app.report.unexpected).toEqual([]);
  expect(app.report.queries).toEqual([]);
  // Model the empty roster before startup; leave query routing to the fixture.
  app.omitChannel("alpha");
  app.omitChannel("beta");
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect(
    page.getByText("No channels yet.", { exact: true }),
  ).toBeVisible();
  await companionLauncher(page, "Companion fixture").click();
  await expect(card(page, "Companion fixture")).toHaveCount(1);
  await button(page, "Notes").click();
  await expect(card(page, "Notes")).toHaveCount(1);
  await expect(card(page, "Companion fixture")).toHaveCount(0);
  await button(page, "Close Notes panel").click();
  await expect(card(page, "Notes")).toHaveCount(0);
  await expect(button(page, "Notes")).toBeFocused();
});

// Independent reviewer controls: Brain.
test("old close cannot dismiss a later opening of the same contribution", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await button(page, "Notes").click();
  await expect(card(page, "Notes")).toHaveCount(1);
  await page.evaluate(() => {
    window.firstNotesClose = window.stalePanelClose;
  });
  await companionLauncher(page, "Companion fixture").click();
  await expect(card(page, "Notes")).toHaveCount(0);
  await button(page, "Notes").click();
  await page.getByRole("textbox", { name: "Panel note" }).fill("A new opening");
  await page.evaluate(() => window.firstNotesClose());
  await expect(card(page, "Notes")).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Panel note" })).toHaveValue(
    "A new opening",
  );
});

test("companion remains usable while Channels connection is pending", async ({
  page,
  app,
}) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/relay/primary/session", async (route) => {
    await held;
    await route.continue();
  });
  try {
    await page.goto(app.origin);
    await openPage(page, "Messages", { connected: false });
    await expect(
      page.getByText("Connecting to your relay…", { exact: true }),
    ).toBeVisible();
    await button(page, "Notes").click();
    await expect(card(page, "Notes")).toHaveCount(1);
    await button(page, "Close Notes panel").click();
    await expect(button(page, "Notes")).toBeFocused();
    await companionLauncher(page, "Companion fixture").click();
    release();
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
    await expect(card(page, "Companion fixture")).toHaveCount(1);
  } finally {
    release();
  }
});
