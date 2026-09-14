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
    const notifications = [];
    await page.route(/\/api\/relay\/.*sign$/, (route) =>
      route.fulfill({ json: app.signTemplate(route.request().postDataJSON()) }),
    );
    await page.route(/\/api\/relay\/.*publish$/, (route) => {
      const event = route.request().postDataJSON();
      notifications.push(event);
      return route.fulfill({ json: { event_id: event.id, accepted: true } });
    });
    await page.route(/\/api\/relay\/.*session$/, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        json: { ...(await response.json()), agentLibrary: true },
      });
    });
    await page.route(/\/api\/relay\/.*agent-library$/, (route) =>
      route.fulfill({
        json: {
          definitions: [],
          identities: [{ pubkey: app.viewer, name: "Another agent" }],
        },
      }),
    );
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
        notifications,
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
  await page.addInitScript(
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
  await open(page, app);
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
  await page.locator("summary").filter({ hasText: "Add project" }).click();
  await page
    .getByRole("combobox", { name: "Channel", exact: true })
    .selectOption("alpha");
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const task = page.getByRole("button", { name: "Silent hangup", exact: true });
  await expect(task).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Find projects or tasks" })
    .fill("no match");
  await expect(page.getByRole("status")).toHaveText(
    "No matching projects or tasks.",
  );
  await page
    .getByRole("searchbox", { name: "Find projects or tasks" })
    .fill("");
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
  await expect(task).toContainText("Another agent");
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
    page.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(`[data-message-id="${app.exact.root.id}"]`).first(),
  ).toBeVisible();
  const workspace = page.getByRole("region", { name: "Task workspace" });
  await expect(workspace.locator("header").first()).toContainText(
    "Silent hangup",
  );
  await expect(
    workspace.getByRole("region", { name: "Attached task" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(workspace.locator("header").first()).toContainText(
    "Silent hangup",
  );
  await expect(
    workspace.getByRole("textbox", { name: "Reply to thread", exact: true }),
  ).toBeVisible();
  await workspace
    .getByRole("textbox", { name: "Reply to thread", exact: true })
    .fill("Reply from the task workspace");
  await workspace
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect
    .poll(() =>
      fileStore.notifications.find(
        (event) => event.content === "Reply from the task workspace",
      ),
    )
    .toMatchObject({
      tags: expect.arrayContaining([
        ["h", "alpha"],
        expect.arrayContaining(["e", app.exact.root.id]),
      ]),
    });
  await workspace.getByRole("button", { name: "View in channel" }).click();
  await expect(
    page.getByRole("region", { name: "Channel message history", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Thread messages", exact: true }),
  ).toContainText("Silent hangup");
  await page.goBack();
  await expect(workspace.locator("header").first()).toContainText(
    "Silent hangup",
  );
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
  await expect(launcher).toHaveCount(0);
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
  const insideViewport = async (locator) =>
    locator.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return (
        r.top >= 0 &&
        r.left >= 0 &&
        r.bottom <= innerHeight &&
        r.right <= innerWidth
      );
    });
  await expect
    .poll(() =>
      insideViewport(
        page.getByRole("dialog", { name: "Task details", exact: true }),
      ),
    )
    .toBe(true);
  const publications = app.report.publications.length;
  await form
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Status sounds");
  await form
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Move playback into the runtime");
  await form
    .getByRole("button", { name: "Link existing branch", exact: true })
    .click();
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
  await page
    .getByRole("button", { name: "Close task details", exact: true })
    .click();
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
  await form.getByText("More options", { exact: true }).click();
  await form.getByRole("button", { name: "Reload saved task" }).click();
  await expect(
    form.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue("Changed elsewhere");
  await form
    .getByRole("button", { name: "Assign an agent", exact: true })
    .click();
  await page
    .getByRole("searchbox", { name: "Search your agents" })
    .fill("Another");
  await expect
    .poll(() =>
      insideViewport(
        page.getByRole("dialog", { name: "Choose an assignee", exact: true }),
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: `Another agent ${app.viewer}`, exact: true })
    .click();
  await form.getByRole("button", { name: "Save locally" }).click();
  await expect(form.getByRole("status")).toHaveText("Saved on this device.");
  expect(JSON.parse((await fileStore.read())[key].value).assignee).toBe(
    app.viewer,
  );
  expect(app.report.publications).toHaveLength(publications);
  await form.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(form.getByRole("status")).toContainText("notification queued");
  await expect.poll(() => fileStore.notifications.length).toBe(1);
  const notification = fileStore.notifications[0];
  expect(notification.pubkey).toBe(app.viewer);
  expect(notification.content).toContain(
    "Assigned @Another agent to [Changed elsewhere](buzz://message?",
  );
  expect(notification.content).toContain(
    `&id=${app.exact.root.id}). Please start work now.`,
  );
  expect(notification.tags).toContainEqual(["p", app.viewer]);
  expect(notification.tags).toContainEqual([
    "e",
    app.exact.root.id,
    "",
    "reply",
  ]);
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

test("task references render as an inline link or a whole-message card and open the real thread", async ({
  page,
  app,
  fileStore,
}) => {
  const key = `buzz.local-task.v1:${JSON.stringify([`https://primary.example:${app.viewer}`, "alpha", app.exact.root.id])}`;
  await fileStore.put(key, {
    title: "Quiet ending",
    description: "Keep the microphone quiet",
    assignee: "",
    branches: [],
  });
  await open(page, app);
  const link = `buzz://message?channel=alpha&id=${app.exact.root.id}`;
  const unknown = app.append(
    "primary",
    "alpha",
    `See [Original title](buzz://message?channel=alpha&id=${"f".repeat(64)}).`,
  );
  const unknownRow = page.locator(`[data-message-id="${unknown.id}"]`);
  await expect(unknownRow).toContainText("Original title");
  await expect(unknownRow).not.toContainText("Task thread");
  const card = app.append("primary", "alpha", link);
  const cardRow = page.locator(`[data-message-id="${card.id}"]`);
  await expect(
    cardRow.getByText("Quiet ending", { exact: true }),
  ).toBeVisible();
  await expect(
    cardRow.getByRole("button", { name: "Open task", exact: true }),
  ).toBeVisible();
  const inline = app.append("primary", "alpha", `See ${link}.`);
  const inlineRow = page.locator(`[data-message-id="${inline.id}"]`);
  await expect(
    inlineRow.getByRole("button", { name: "Quiet ending", exact: true }),
  ).toBeVisible();
  await expect(
    inlineRow.getByRole("button", { name: "Open task", exact: true }),
  ).toHaveCount(0);
  const assignment = app.append(
    "primary",
    "alpha",
    `Assigned @GLM to [Quiet ending](${link}). Please start work now.`,
  );
  const assignmentRow = page.locator(`[data-message-id="${assignment.id}"]`);
  await expect(
    assignmentRow.getByRole("button", { name: "Quiet ending", exact: true }),
  ).toBeVisible();
  await expect(assignmentRow).toContainText("Assigned @GLM to");
  await fileStore.put(key, {
    title: "Updated task",
    description: "",
    assignee: "",
    branches: [],
  });
  await expect(
    inlineRow.getByRole("button", { name: "Updated task", exact: true }),
  ).toBeVisible();
  await assignmentRow
    .getByRole("button", { name: "Updated task", exact: true })
    .click();
  const thread = page.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  await expect(
    thread.locator(`[data-message-id="${app.exact.root.id}"]`),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Task workspace" })
      .locator("header")
      .first(),
  ).toContainText("Updated task");
  expect(fileStore.notifications).toHaveLength(0);
});
