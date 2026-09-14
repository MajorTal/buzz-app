import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  pluginFixtures: true,
  exactMessages: true,
  screenshot: "off",
  trace: "off",
});

test("Projects marks an existing channel locally, restores it, and links saved task threads", async ({
  page,
  app,
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
  await task.click();
  await expect(
    page.locator(`[data-message-id="${app.exact.root.id}"]`).first(),
  ).toBeVisible();
});

test("local task panel saves against a canonical thread and never publishes metadata", async ({
  page,
  app,
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
  const records = await page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) =>
      key.startsWith("buzz.local-task.v1:"),
    ),
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
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith("buzz.local-task.v1:"),
    );
    const record = JSON.parse(localStorage.getItem(key));
    localStorage.setItem(
      key,
      JSON.stringify({ ...record, title: "Changed elsewhere" }),
    );
  });
  await form.getByRole("button", { name: "Save locally" }).click();
  await expect(form.getByRole("alert")).toContainText("another window");
  await launcher.click();
  await launcher.click();
  await expect(
    form.getByRole("textbox", { name: "Title", exact: true }),
  ).toHaveValue("Changed elsewhere");
  expect(app.report.publications).toHaveLength(publications);
});
