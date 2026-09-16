import { test, expect } from "@playwright/test";
import { createServer } from "../../../tests/browser/vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

let server;
let url;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    configFile: false,
    envDir: false,
    plugins: [react()],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/src/bundled/workflows/fixture.html`;
});
test.afterAll(async () => {
  await server?.close();
});

test("workflow editor preserves YAML, resolves exact saves, retains conflicts and purges access", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowFixture.definitions.active()),
    )
    .toBe(1);
  await button("Refresh configurations").click();
  await button("Message helper").click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  const yaml = page.getByLabel("Workflow YAML", { exact: true });
  await expect
    .poll(() => yaml.inputValue())
    .toContain("# Keep this comment on opening");
  await page.getByRole("tab", { name: "Form", exact: true }).click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await expect
    .poll(() => yaml.inputValue())
    .toContain("# Keep this comment on opening");
  await yaml.fill(
    (await yaml.inputValue()).replace("Hello from a fixture", "Edited text"),
  );
  await button("Save workflow").click();
  await expect
    .poll(() => page.evaluate(() => window.workflowFixture.calls.save))
    .toBe(1);
  await button("Complete concurrent head").click();
  await expect
    .poll(() => page.getByText(/waiting for a readback/).count())
    .toBe(1);
  expect(await button("Save workflow").isDisabled()).toBe(true);
  expect(await yaml.inputValue()).toContain("Edited text");
  await button("Complete exact save").click();
  await expect.poll(() => button("Save workflow").isEnabled()).toBe(true);
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  await yaml.fill(
    (await yaml.inputValue()).replace("Edited text", "Rejected draft"),
  );
  await button("Save workflow").click();
  await button("Reject operation").click();
  await expect
    .poll(() => page.getByText("Fixture conflict", { exact: true }).count())
    .toBe(1);
  expect(await yaml.inputValue()).toContain("Rejected draft");
  await button("Continue editing retained draft").click();
  expect(await button("Save workflow").isEnabled()).toBe(true);
  await button("Close editor").click();
  await expect(
    page.getByRole("alertdialog", { name: "Leave this draft?" }),
  ).toBeVisible();
  await expect(button("Keep editing")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(button("Close editor")).toBeFocused();
  expect(await yaml.inputValue()).toContain("Rejected draft");
  await button("Revoke access").click();
  await expect
    .poll(() => page.getByRole("region", { name: "Workflow editor" }).count())
    .toBe(0);
  expect(await page.getByText("Rejected draft", { exact: false }).count()).toBe(
    0,
  );
  await page.reload();
  await page.evaluate(() =>
    window.workflowFixture.definitions.update({
      status: "ready",
      data: { items: [], partial: false },
    }),
  );
  await expect(
    page.getByText(/Create a disabled draft to start/),
  ).toBeVisible();
  await expect(
    page.getByText(/Creating and saving workflows is unavailable/),
  ).toHaveCount(0);
  await button("New workflow").click();
  expect(
    await page
      .getByRole("switch", { name: "Enabled in configuration" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  await button("Add Send Message").click();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Incomplete editor");
  await page
    .getByLabel("Message text", { exact: true })
    .fill("Keyboard-created text");
  await expect.poll(() => button("Save workflow").isEnabled()).toBe(true);
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  expect(await yaml.inputValue()).toContain("enabled: false");
  await yaml.fill(
    (await yaml.inputValue()).replace("on: message_posted", "on: webhook"),
  );
  expect(await button("Save workflow").isDisabled()).toBe(true);
  await expect
    .poll(() => page.getByText(/Webhook-trigger saves are unavailable/).count())
    .toBe(1);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await button("Toggle appearance").click();
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  // Wait for the shared control transition before checking its final paint.
  await expect(button("Close editor")).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(button("Close editor")).toHaveCSS(
    "background-color",
    "rgb(16, 16, 16)",
  );
  await yaml.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(yaml).toHaveCSS("outline-style", "solid");
  await expect(yaml).toHaveCSS("outline-width", "2px");
  await button("Unmount plugin").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowFixture.definitions.disposed()),
    )
    .toBe(true);
  expect(errors).toEqual([]);
});

test("keyboard switches feed enabled-save confirmation and disabled readback", async ({
  page,
  browserName,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(url);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const enabled = page.getByRole("switch", {
    name: "Enabled in configuration",
  });
  const reply = page.getByRole("switch", {
    name: "Reply in the triggering thread",
  });
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  const focusByTab = async (control) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await control.evaluate((node) => node === document.activeElement))
        return;
      await page.keyboard.press(tab);
    }
    await expect(control).toBeFocused();
  };
  const saves = () => page.evaluate(() => window.workflowFixture.calls.save);
  const savedYaml = async () =>
    parseYaml(await page.evaluate(() => window.workflowFixture.input().yaml));

  await button("New workflow").click();
  const name = page.getByLabel("Workflow name", { exact: true });
  await name.fill("Keyboard workflow");
  await button("Add Send Message").click();
  await page.getByLabel("Message text", { exact: true }).fill("Offline only");
  await name.focus();
  await page.keyboard.press(tab);
  await expect(enabled).toBeFocused();
  await expect(enabled).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(enabled).toBeChecked();
  await page.keyboard.press("Enter");
  await expect(enabled).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(enabled).toBeChecked();

  await focusByTab(reply);
  await page.keyboard.press("Enter");
  await expect(reply).toBeChecked();
  await page.keyboard.press("Space");
  await expect(reply).not.toBeChecked();
  await page.keyboard.press("Enter");
  await expect(reply).toBeChecked();
  await focusByTab(button("Save workflow"));
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("It will run for every new message");
  await expect(button("Keep editing")).toBeFocused();
  expect(await saves()).toBe(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(button("Save workflow")).toBeFocused();
  expect(await saves()).toBe(0);
  await page.keyboard.press("Space");
  await expect(button("Keep editing")).toBeFocused();
  await page.keyboard.press(tab);
  await expect(button("Save enabled workflow")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(saves).toBe(1);
  expect((await savedYaml()).enabled).not.toBe(false);
  expect((await savedYaml()).steps[0].reply_in_thread).toBe(true);
  await expect(enabled).toBeDisabled();
  await expect(reply).toBeDisabled();
  await enabled.click({ force: true });
  await enabled.press("Space");
  await reply.press("Enter");
  await expect(enabled).toBeChecked();
  await expect(reply).toBeChecked();
  expect(await saves()).toBe(1);

  // The offline capability supplies the exact asynchronous receipt/readback.
  await page.evaluate(() => window.workflowFixture.finish("succeeded"));
  await expect(button("Save workflow")).toBeEnabled();
  await expect(enabled).toBeChecked();
  await expect(reply).toBeChecked();
  await page
    .getByLabel("Message text", { exact: true })
    .fill("Ordinary enabled edit");
  await button("Save workflow").click();
  await expect.poll(saves).toBe(2);
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.workflowFixture.finish("succeeded"));
  await expect(button("Save workflow")).toBeEnabled();
  await name.focus();
  await page.keyboard.press(tab);
  await expect(enabled).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(enabled).not.toBeChecked();
  await focusByTab(reply);
  await page.keyboard.press("Space");
  await expect(reply).not.toBeChecked();
  await focusByTab(button("Save workflow"));
  await page.keyboard.press("Enter");
  await expect.poll(saves).toBe(3);
  await expect(dialog).toHaveCount(0);
  expect((await savedYaml()).enabled).toBe(false);
  expect((await savedYaml()).steps[0].reply_in_thread).not.toBe(true);
  await page.evaluate(() => window.workflowFixture.finish("succeeded"));
  await expect(enabled).toBeEnabled();
  await expect(enabled).not.toBeChecked();
  await expect(reply).not.toBeChecked();
  await enabled.click();
  await button("Save workflow").click();
  await expect(dialog).toContainText("It will run for every new message");
  expect(await saves()).toBe(3);
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("real session page under StrictMode fences community changes, warns for dirty channel navigation and purges access", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url.replace("/fixture.html", "/session-fixture.html"));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const choose = async (name) => {
    await page.getByRole("combobox", { name: "Channel", exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  await choose("First channel");
  await expect(button("New workflow")).toBeDisabled();
  await expect(
    page.getByText(/Creating and saving workflows is unavailable/),
  ).toBeVisible();
  await button("Fixture A helper").click();
  await expect(button("Save workflow")).toBeDisabled();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Unsaved private text");
  await choose("Second channel");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await button("Keep editing").click();
  await expect(page.getByLabel("Workflow name", { exact: true })).toHaveValue(
    "Unsaved private text",
  );
  await choose("Second channel");
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Change channel", exact: true })
    .click();
  await expect(
    page.getByText("No saved configurations returned for this channel.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(button("New workflow")).toBeDisabled();
  await expect(
    page.getByText(/Creating and saving workflows is unavailable/),
  ).toBeVisible();
  await expect(page.getByText(/Create a disabled draft to start/)).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("region", { name: "Workflow editor" }),
  ).toHaveCount(0);
  await choose("First channel");
  await button("Fixture A helper").click();
  await button("Switch community").click();
  await expect(
    page.getByRole("region", { name: "Workflow editor" }),
  ).toHaveCount(0);
  await choose("First channel");
  await button("Fixture B helper").click();
  await button("Switch community").click();
  await choose("First channel");
  await button("Fixture A helper").click();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Revoked private text");
  await button("Revoke selected channel").click();
  await expect(
    page.getByRole("region", { name: "Workflow editor" }),
  ).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain(
    "Revoked private text",
  );
  expect(errors).toEqual([]);
});

test("real session reconnect retains unsaved YAML and an in-flight returned run ID", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.getByRole("combobox", { name: "Channel", exact: true }).click();
  await page
    .getByRole("option", { name: "First channel", exact: true })
    .click();
  await button("Fixture A helper").click();
  await page.getByRole("tab", { name: "YAML", exact: true }).click();
  const yaml = page.getByLabel("Workflow YAML", { exact: true });
  const original = await yaml.inputValue();
  const edited = original.replace(
    "Hello from a fixture",
    "Unsaved reconnect draft",
  );
  expect(edited).not.toBe(original);
  await yaml.fill(edited);
  await page.evaluate(() => window.workflowSessionFixture.state("retrying"));
  await expect(page.getByText(/Connection interrupted/)).toBeVisible();
  await expect(yaml).toHaveValue(edited);
  await page.evaluate(() => window.workflowSessionFixture.state("connected"));
  await button("Refresh configurations").click();
  await expect(page.getByText(/Connection interrupted/)).toHaveCount(0);
  await expect(yaml).toHaveValue(edited);
  await yaml.fill(original);
  await button("Run now").click();
  try {
    await expect
      .poll(() =>
        page.evaluate(() => window.workflowSessionFixture.publications()),
      )
      .toBe(1);
    await page.evaluate(() => window.workflowSessionFixture.state("retrying"));
    await expect(
      page.getByText("Requesting a run…", { exact: true }),
    ).toBeVisible();
  } finally {
    await page.evaluate(() => window.workflowSessionFixture.settle());
  }
  await expect(
    page.getByText("Run requested. Inspect run history for its result.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText("Delivery details", { exact: true }).click();
  await expect(
    page.getByText("Returned run ID: 33333333-3333-4333-8333-333333333333", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(yaml).toHaveValue(original);
  await button("Revoke selected channel").click();
  await expect(yaml).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Workflow operations" }),
  ).toHaveCount(0);
});

test("generic Outbox offers message retry but no workflow replay", async ({
  page,
}) => {
  await page.goto(url.replace("/fixture.html", "/session-fixture.html?writes"));
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.getByRole("combobox", { name: "Channel", exact: true }).click();
  await page
    .getByRole("option", { name: "First channel", exact: true })
    .click();
  await button("Fixture A helper").click();
  await button("Run now").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.publications()),
    )
    .toBe(1);
  await page.evaluate(() => window.workflowSessionFixture.reject());
  await expect(
    page.getByText("Run request was rejected.", { exact: true }),
  ).toBeVisible();
  await page.getByText("Outbox · 1 items", { exact: true }).click();
  const outbox = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Outbox ·/ }) });
  await expect(outbox.getByText(/Not sent/)).toBeVisible();
  await expect(
    outbox.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => window.workflowSessionFixture.sendMessage());
  await expect
    .poll(() =>
      page.evaluate(() => window.workflowSessionFixture.publications()),
    )
    .toBe(2);
  await page.evaluate(() => window.workflowSessionFixture.reject());
  const message = outbox
    .getByRole("listitem")
    .filter({ hasText: "Retryable message" });
  await expect(message).toContainText("Not sent");
  await message.getByRole("button", { name: "Retry", exact: true }).click();
  try {
    await expect
      .poll(() =>
        page.evaluate(() => window.workflowSessionFixture.publications()),
      )
      .toBe(3);
  } finally {
    await page.evaluate(() => window.workflowSessionFixture.settle());
  }
  await expect(message).toContainText("Sent");
  await expect(
    outbox.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
});
