import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";

test.use({ productionBroker: true, readState: true });
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const alpha = (page) => page.getByRole("button", { name: /^Alpha/ });
const composer = (page) =>
  page.getByRole("textbox", { name: "Message #Alpha", exact: true });
// Observe the real durable result, never seed state or call an engine test hook.
async function journal(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("buzz-read-state-v1", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("partitions", "readonly");
          const read = tx.objectStore("partitions").getAll();
          read.onsuccess = () => resolve(read.result[0]);
          read.onerror = () => reject(read.error);
          tx.oncomplete = () => db.close();
        };
      }),
  );
}
async function visible(page) {
  return history(page).evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    return [...element.querySelectorAll("[data-message-id]")]
      .filter((row) => {
        const b = row.getBoundingClientRect();
        return (
          b.width > 0 &&
          b.height > 0 &&
          b.top >= viewport.top &&
          b.bottom <= viewport.bottom &&
          b.left >= viewport.left &&
          b.right <= viewport.right
        );
      })
      .map((row) => row.dataset.messageId);
  });
}
async function options(page) {
  await page.getByLabel("Conversation options", { exact: true }).click();
}

test("built sidebar → visible dwell → durable journal → encrypted broker publication; reload preserves intent", async ({
  page,
  app,
}) => {
  await open(page, app);
  await expect
    .poll(() =>
      app.report.queries.some(({ filter }) => filter.read_state_snapshot === 1),
    )
    .toBe(true);
  // Wait for the bounded roster-wide repair, not merely the first 20-row head.
  await expect(alpha(page).getByRole("img")).toHaveAttribute(
    "aria-label",
    /^500 observed unread messages/,
  );
  await composer(page).focus();
  await page.waitForTimeout(900); // Negative dwell control: opening and composer focus are not reading.
  expect((await journal(page)).state.frontiers).toEqual({});
  expect(app.report.readPublications).toEqual([]);
  const ids = await visible(page);
  expect(ids.length).toBeGreaterThan(0);
  const before = Number(
    (await alpha(page).getByRole("img").getAttribute("aria-label")).split(
      " ",
    )[0],
  );
  await history(page).focus();
  await page.waitForTimeout(300);
  expect((await journal(page)).state.frontiers).toEqual({});
  await expect
    .poll(async () => Object.keys((await journal(page)).state.frontiers).sort())
    .toEqual(ids.map((id) => `msg:${id}`).sort());
  await expect(alpha(page).getByRole("img")).toHaveAttribute(
    "aria-label",
    new RegExp(`^${before - ids.length} observed unread messages`),
  );
  const stored = await journal(page);
  expect(stored.state.frontiers.alpha).toBeUndefined();
  // The normal debounce, signing, NIP-44, NIP-98 and publication/readback all run.
  await expect
    .poll(() => app.report.readPublications.length, { timeout: 12000 })
    .toBe(1);
  await expect
    .poll(async () => (await journal(page)).acceptedRevision)
    .toBe(stored.revision);
  const { event, blob } = app.report.readPublications[0];
  expect(blob.contexts).toEqual(stored.state.frontiers);
  expect(event.content).not.toContain(ids[0]);
  expect(blob.contexts.alpha).toBeUndefined();
  await page.reload();
  await page
    .getByRole("button", { name: "Messages", exact: true })
    .first()
    .click();
  await composer(page).waitFor();
  await settle(page);
  expect((await journal(page)).slot).toBe(stored.slot);
  expect((await journal(page)).state.frontiers).toEqual(stored.state.frontiers);
  await expect(alpha(page).getByRole("img")).toHaveAttribute(
    "aria-label",
    new RegExp(`^${before - ids.length} observed unread messages`),
  );
});

test("focus cancellation and local manual-unread survive dwell/reload until explicit mark-through", async ({
  page,
  app,
}) => {
  await open(page, app);
  await history(page).focus();
  await page.waitForTimeout(300);
  await composer(page).focus();
  await page.waitForTimeout(900);
  expect((await journal(page)).state.frontiers).toEqual({});
  await options(page);
  await page
    .getByRole("button", { name: "Mark unread on this device", exact: true })
    .click();
  await options(page);
  await expect(
    alpha(page).getByRole("img", {
      name: "Marked unread on this device only",
      exact: true,
    }),
  ).toBeVisible();
  await history(page).focus();
  await page.waitForTimeout(1000);
  expect((await journal(page)).localUnread.alpha).toBeGreaterThan(0);
  await expect(
    alpha(page).getByRole("img", {
      name: "Marked unread on this device only",
      exact: true,
    }),
  ).toBeVisible();
  app.relay.holdContent(); // Reload must use verified disk evidence, not wait for network repair.
  await page.reload();
  await page
    .getByRole("button", { name: "Messages", exact: true })
    .first()
    .click();
  await composer(page).waitFor();
  await expect(
    alpha(page).getByRole("img", {
      name: "Marked unread on this device only",
      exact: true,
    }),
  ).toBeVisible();
  await options(page);
  await page
    .getByRole("button", {
      name: "Mark read through loaded messages",
      exact: true,
    })
    .click();
  await expect
    .poll(async () => (await journal(page)).localUnread.alpha)
    .toBeUndefined();
  await expect
    .poll(async () => (await journal(page)).state.frontiers.alpha)
    .toBe(app.histories.get("primary/alpha").at(-1).created_at);
  await expect(alpha(page).getByRole("img")).toHaveCount(0);
});

test("a surviving window publishes a closed window's durable read intent", async ({
  page,
  context,
  app,
}) => {
  await open(page, app);
  await composer(page).focus();
  const survivor = await context.newPage();
  survivor.on("pageerror", (error) => app.report.errors.push(error.message));
  survivor.on("console", (message) => {
    if (message.type() === "error")
      app.report.consoleErrors.push(message.text());
  });
  try {
    await open(survivor, app);
    await composer(survivor).focus();
    await options(survivor);
    await survivor.getByText("Unread status", { exact: true }).click();
    await expect(
      survivor.getByText(/Read sync: frontier-sync · reconciled/),
    ).toBeVisible();
    await page.bringToFront();
    await history(page).focus();
    await expect
      .poll(async () => (await journal(page)).revision)
      .toBeGreaterThan(0);
    const stored = await journal(page);
    await expect(
      survivor.getByText(/Read sync: frontier-sync · pending/),
    ).toBeVisible();
    expect(app.report.readPublications).toEqual([]);
    await page.close(); // Cancel the origin publisher before its normal five-second debounce.
    await expect
      .poll(() => app.report.readPublications.length, { timeout: 12000 })
      .toBe(1);
    await expect
      .poll(async () => (await journal(survivor)).acceptedRevision)
      .toBe(stored.revision);
    expect(app.report.readPublications[0].blob.contexts).toEqual(
      stored.state.frontiers,
    );
    await expect(
      survivor.getByText(/Read sync: frontier-sync · reconciled/),
    ).toBeVisible();
  } finally {
    await survivor.close();
  }
});
