import { test as base, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { taskStoreHandler } from "../../dev/task-store-api.mjs";
import { changeStore, putRecord, readStore } from "../../dev/task-store.mjs";

const test = base.extend({
  fileStore: async ({ app, page }, use) => {
    const dir = await mkdtemp(join(tmpdir(), "buzz-task-browser-"));
    const file = join(dir, "tasks.json");
    const handler = taskStoreHandler({ viewer: app.viewer, file });
    const server = createServer((req, res) =>
      handler(req, res, () => {
        res.writeHead(404);
        res.end();
      }),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const route = async (page) =>
      page.route("**/api/experiment/tasks?*", async (r) => {
        const req = r.request();
        const response = await fetch(
          `${origin}${new URL(req.url()).pathname}${new URL(req.url()).search}`,
          {
            method: req.method(),
            headers: { Origin: origin, "Content-Type": "application/json" },
            ...(req.method() === "POST" ? { body: req.postData() } : {}),
          },
        );
        await r.fulfill({
          status: response.status,
          contentType: "application/json",
          body: await response.text(),
        });
      });
    await route(page);
    try {
      await use({
        read: async () => (await readStore(file)).records,
        put: (key, value) =>
          changeStore(
            (records) =>
              putRecord(
                records,
                key,
                JSON.stringify(value),
                records[key]?.revision ?? null,
              ),
            file,
          ),
        route,
      });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  },
});

test.use({
  pluginFixtures: true,
  exactMessages: true,
  screenshot: "off",
  trace: "off",
});

test("Projects marks an existing channel locally, restores it, and links saved task threads", async ({
  page,
  app,
  fileStore,
}) => {
  await open(page, app);
  await page.evaluate(
    ({ viewer, root }) => {
      const task = {
        title: "Silent hangup",
        description: "Do not unmute on shutdown",
        assignee: "Sol",
        branches: [],
      };
      localStorage.setItem(
        `buzz.local-task.v1:${JSON.stringify([`https://primary.example:${viewer}`, "alpha", root])}`,
        JSON.stringify(task),
      );
    },
    { viewer: app.viewer, root: app.exact.root.id },
  );
  const projects = () =>
    page.evaluate(
      (viewer) =>
        window.fixtureNavigation.open({
          version: 1,
          kind: "page",
          pluginId: "buzz.projects",
          pageId: "projects",
          scope: { viewer, communityOrigin: "https://primary.example" },
        }),
      app.viewer,
    );
  expect(await projects()).toEqual({ status: "opened" });
  await page
    .getByRole("combobox", { name: "Channel", exact: true })
    .selectOption("alpha");
  await page.getByRole("button", { name: "Mark as project locally" }).click();
  const task = page.getByRole("button", { name: "Silent hangup", exact: true });
  await expect(task).toBeVisible();
  await page.reload();
  await expect(task).toBeVisible();
  const key = Object.keys(await fileStore.read()).find((k) =>
    k.startsWith("buzz.local-task.v1:"),
  );
  await fileStore.put(key, {
    title: "Silent hangup",
    description: "Updated by the agent",
    assignee: "Another agent",
    branches: [],
  });
  await expect(
    page.getByText("Assigned to Another agent", { exact: true }),
  ).toBeVisible();
  // Clearing browser storage leaves the file intact and the Projects view recoverable.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage))
      if (
        key.startsWith("buzz.local-task.v1:") ||
        key.startsWith("buzz.local-project.v1:")
      )
        localStorage.removeItem(key);
  });
  await page.reload();
  await expect(task).toBeVisible();
  await task.click();
  await expect(
    page.locator(`[data-message-id="${app.exact.root.id}"]`).first(),
  ).toBeVisible();
});

test("local task panel saves against a canonical thread and never publishes metadata", async ({
  page,
  app,
  fileStore,
}) => {
  await open(page, app);
  const launcher = page.getByRole("button", {
    name: "Task details",
    exact: true,
  });
  await expect(launcher).toBeDisabled();
  const navigate = async (id) => {
    expect(
      await page.evaluate((target) => window.fixtureNavigation.open(target), {
        version: 1,
        kind: "conversation",
        channelId: "alpha",
        messageId: id,
        scope: {
          viewer: app.viewer,
          communityOrigin: "https://primary.example",
        },
      }),
    ).toEqual({ status: "opened" });
  };
  await navigate(app.exact.target.id);
  await launcher.click();
  const form = page.getByRole("form", { name: "Local task details" });
  await expect(form).toBeVisible();
  const publications = app.report.publications.length;
  await form
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Status sounds");
  await form
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Move playback into the runtime");
  await form.getByRole("button", { name: "Add branch", exact: true }).click();
  await form
    .getByRole("textbox", { name: "Repository URL" })
    .fill("https://github.com/block/berd");
  await form
    .getByRole("textbox", { name: "Branch name" })
    .fill("jtennant/status-sounds");
  await form.getByRole("button", { name: "Save locally" }).click();
  await expect(form.getByRole("status")).toHaveText("Saved on this device.");
  const records = Object.entries(await fileStore.read()).filter(([key]) =>
    key.startsWith("buzz.local-task.v1:"),
  );
  expect(records).toHaveLength(1);
  expect(records[0][0]).toContain(app.exact.root.id);
  const anotherReply = await page
    .getByRole("region", { name: "Thread messages", exact: true })
    .locator(
      `[data-message-id]:not([data-message-id="${app.exact.root.id}"]):not([data-message-id="${app.exact.target.id}"])`,
    )
    .first()
    .getAttribute("data-message-id");
  await launcher.click();
  await navigate(anotherReply);
  await launcher.click();
  await expect(
    form.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue("Status sounds");
  await expect(form.getByRole("textbox", { name: "Branch name" })).toHaveValue(
    "jtennant/status-sounds",
  );
  const key = records[0][0];
  await fileStore.put(key, {
    ...JSON.parse(records[0][1].value),
    title: "Changed elsewhere",
  });
  const conflict = page.waitForResponse(
    (response) =>
      response.url().includes("/api/experiment/tasks?") &&
      response.status() === 409,
  );
  await form.getByRole("button", { name: "Save locally" }).click();
  await conflict;
  await expect(form.getByRole("alert")).toContainText("changed elsewhere");
  await form.getByRole("button", { name: "Reload saved task" }).click();
  await expect(
    form.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue("Changed elsewhere");
  await form.getByRole("textbox", { name: "Assignee" }).fill("Another agent");
  await form.getByRole("button", { name: "Save locally" }).click();
  await expect(form.getByRole("status")).toHaveText("Saved on this device.");
  expect(JSON.parse((await fileStore.read())[key].value).assignee).toBe(
    "Another agent",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await form.getByRole("button", { name: "Delete task", exact: true }).click();
  await expect(form.getByRole("status")).toContainText("metadata deleted");
  expect((await fileStore.read())[key].value).toBeNull();
  // This deliberately rejected save is the single expected network-console error.
  const conflicts = app.report.consoleErrors.filter(
    (message) =>
      message ===
      "Failed to load resource: the server responded with a status of 409 (Conflict)",
  );
  expect(conflicts).toHaveLength(1);
  app.report.consoleErrors.splice(
    app.report.consoleErrors.indexOf(conflicts[0]),
    1,
  );
  expect(app.report.publications).toHaveLength(publications);
});
