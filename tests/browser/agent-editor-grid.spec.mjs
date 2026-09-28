import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import config from "../fixtures/agent-control.vite.mjs";
import { watchPageErrors } from "./page-errors.mjs";

test("existing grid opens the focused editor, selects a model and saves/reopens", async ({
  page,
}) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const errors = watchPageErrors(page);
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    await page.evaluate(async () => {
      const f = window.agentControlFixture;
      Object.assign(f.agent.harness, {
        command: "buzz-agent",
        provider: "databricks_v2",
        args: [],
        databricks: { host: "https://workspace.example.com", filter: "" },
      });
      await f.control.refresh();
    });
    const card = page.getByRole("article", {
      name: "Agent Fixture agent",
      exact: true,
    });
    await expect(
      card.getByRole("button", {
        name: "Actions for Fixture agent",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText("Add agent", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Old Buzz library", { exact: true }),
    ).toHaveCount(0);
    const actions = card.getByRole("button", {
      name: "Actions for Fixture agent",
      exact: true,
    });
    const bounds = await card.boundingBox();
    const button = await actions.boundingBox();
    expect(button.y - bounds.y).toBeLessThan(16);
    expect(bounds.x + bounds.width - button.x - button.width).toBeLessThan(16);
    // Managed cards group identity in one row, not a tall gallery pedestal.
    const avatar = await card
      .getByRole("img", { name: "Fixture agent", exact: true })
      .boundingBox();
    const name = await card
      .getByRole("heading", { name: "Fixture agent", exact: true })
      .boundingBox();
    expect(name.x).toBeGreaterThan(avatar.x + avatar.width);
    expect(name.y).toBeGreaterThanOrEqual(avatar.y);
    expect(name.y + name.height).toBeLessThanOrEqual(avatar.y + avatar.height);
    const add = page.getByRole("button", { name: "Add agent", exact: true });
    await expect(add).toHaveAttribute("aria-haspopup", "dialog");
    await add.focus();
    await add.press("Enter");
    const create = page.getByRole("dialog", {
      name: "Create agent",
      exact: true,
    });
    await expect(create.getByLabel("Name", { exact: true })).toBeVisible();
    await create.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(create).toBeHidden();
    await expect(add).toBeFocused();
    await expect(
      card.getByRole("button", { name: "Edit", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("agents-grid-light.png"),
    });
    await actions.focus();
    await actions.press("ArrowDown");
    await expect(
      page.getByRole("menuitem", { name: "Edit", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("menuitem", { name: "Edit", exact: true })
      .press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Edit agent",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    // Browser geometry: the editor is a single column aligned with its title.
    const titleBounds = await dialog
      .getByRole("heading", { name: "Edit agent", exact: true })
      .boundingBox();
    const nameBounds = await dialog
      .getByLabel("Name", { exact: true })
      .boundingBox();
    expect(Math.abs(nameBounds.x - titleBounds.x)).toBeLessThan(1);

    await expect(dialog.getByLabel("Workspace", { exact: true })).toBeHidden();
    await expect(
      dialog.getByRole("combobox", { name: "Harness", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("combobox", { name: "Provider", exact: true }),
    ).toBeVisible();
    const harness = await dialog
      .getByRole("combobox", { name: "Harness", exact: true })
      .boundingBox();
    const provider = await dialog
      .getByRole("combobox", { name: "Provider", exact: true })
      .boundingBox();
    const model = await dialog
      .getByRole("combobox", { name: "Model", exact: true })
      .boundingBox();
    expect(provider.y).toBeGreaterThan(harness.y + harness.height);
    expect(model.y).toBeGreaterThan(provider.y + provider.height);
    await dialog
      .getByRole("button", { name: "Browse models", exact: true })
      .click();
    await expect(
      page.getByRole("option", { name: /Friendly Model/ }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("agent-model-choices-light.png"),
    });
    await page.getByRole("option", { name: /Friendly Model/ }).click();
    await expect(
      dialog.getByRole("combobox", { name: "Model", exact: true }),
    ).toHaveValue("Friendly Model");
    await dialog
      .getByRole("textbox", { name: "Agent instructions", exact: true })
      .fill("Help with the project. Keep answers clear and concise.");
    await dialog
      .getByRole("textbox", { name: "Agent instructions", exact: true })
      .press("Escape");
    await expect(dialog).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(
      dialog.getByRole("textbox", { name: "Agent instructions", exact: true }),
    ).toHaveValue("Help with the project. Keep answers clear and concise.");
    await page.screenshot({
      path: test.info().outputPath("agent-editor-light.png"),
    });
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toContainText("Saved.");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      card.getByRole("button", {
        name: "Actions for Fixture agent",
        exact: true,
      }),
    ).toBeFocused();
    await card
      .getByRole("button", { name: "Actions for Fixture agent", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Browse models", exact: true })
      .click();
    await page.getByRole("option", { name: /Friendly Model/ }).click();
    await expect(
      dialog.getByRole("textbox", { name: "Agent instructions", exact: true }),
    ).toHaveValue("Help with the project. Keep answers clear and concise.");
    expect(
      await page.evaluate(() => window.agentControlFixture.agent.harness.model),
    ).toBe("catalog.schema.real-model");
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    await page.screenshot({
      path: test.info().outputPath("agent-editor-dark.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog
      .getByRole("button", { name: "Save changes" })
      .scrollIntoViewIfNeeded();
    await expect(
      dialog.getByRole("button", { name: "Save changes" }),
    ).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath("agent-editor-dark-narrow.png"),
    });
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    // Expanded diagnostics share the modal's scroll; long lines wrap at 200%.
    await page.evaluate(async () => {
      const fixture = window.agentControlFixture;
      fixture.agent.diagnostics = ["Synthetic diagnostic line ".repeat(80)];
      await fixture.control.refresh();
      document.documentElement.style.setProperty("--buzz-text-scale", "2");
    });
    const technical = dialog.getByRole("button", {
      name: "Technical details",
      exact: true,
    });
    await technical.focus();
    await technical.press("Enter");
    await expect(technical).toHaveAttribute("aria-expanded", "true");
    const diagnostics = dialog.locator("pre");
    await expect(diagnostics).toContainText("Synthetic diagnostic line");
    await expect
      .poll(() =>
        diagnostics.evaluate(
          (el) =>
            el.scrollHeight <= el.clientHeight &&
            el.scrollWidth <= el.clientWidth,
        ),
      )
      .toBe(true);
    await expect
      .poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth))
      .toBe(true);
    await dialog
      .getByRole("button", { name: "Save changes" })
      .scrollIntoViewIfNeeded();
    await expect(
      dialog.getByRole("button", { name: "Save changes" }),
    ).toBeInViewport();
    await technical.click();
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--buzz-text-scale", "1"),
    );
    await page.setViewportSize({ width: 1440, height: 950 });
    const search = dialog.getByRole("combobox", { name: "Model", exact: true });
    await dialog
      .getByRole("textbox", { name: "Agent instructions", exact: true })
      .fill("Custom model safety");
    const saves = await page.evaluate(
      () =>
        window.agentControlFixture.calls.filter((c) => c.action === "save")
          .length,
    );
    await search.fill("custom.enter");
    await expect(
      page.getByRole("option", { name: /custom.enter/ }),
    ).toBeVisible();
    await search.press("Enter");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          window.agentControlFixture.calls.filter((c) => c.action === "save")
            .length,
      ),
    ).toBe(saves);
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.agentControlFixture.agent.harness.model),
      )
      .toBe("custom.enter");
    await search.fill("custom.click-save");
    await expect(
      page.getByRole("option", { name: /custom.click-save/ }),
    ).toBeVisible();
    await dialog
      .getByRole("button", {
        name: "Save changes",
        exact: true,
        includeHidden: true,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.agentControlFixture.agent.harness.model),
      )
      .toBe("custom.click-save");
    await search.fill("");
    await dialog
      .getByRole("textbox", {
        name: "Agent instructions",
        exact: true,
        includeHidden: true,
      })
      .click();
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.agentControlFixture.agent.harness.model),
      )
      .toBe("");
    // Dirty write-only values receive the same incidental-dismissal protection.
    await dialog
      .getByRole("button", { name: "Environment", exact: true })
      .click();
    const environment = dialog.getByLabel("Replacement for EXAMPLE_TOKEN");
    await environment.fill("synthetic-draft-only");
    await environment.press("Escape");
    await page.mouse.click(5, 5);
    await expect(environment).toHaveValue("synthetic-draft-only");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await card
      .getByRole("button", { name: "Actions for Fixture agent", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Environment", exact: true })
      .click();
    await expect(environment).toHaveValue("");
    await dialog
      .getByRole("textbox", { name: "Name", exact: true })
      .press("Escape");
    await expect(dialog).toHaveCount(0); // clean Escape still closes
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

// Browser-only: compact card geometry after removing channel-selection controls.
test("managed cards omit the channel picker at narrow widths", async ({
  page,
}) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-control.html`,
    );
    const card = page.getByRole("article", {
      name: "Agent Fixture agent",
      exact: true,
    });
    await expect(
      card.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Use in channel", exact: true }),
    ).toHaveCount(0);
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
  } finally {
    await server.close();
  }
});
