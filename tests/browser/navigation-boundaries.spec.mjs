import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
test.use({ pluginFixtures: true });

// Regressions from the independent review, exercised through production composition.
test("cold destination waits for its enabled provider to activate", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    window.delayFixture = { started: false };
  });
  const target = {
    version: 1,
    kind: "page",
    pluginId: "fixture.delayed",
    pageId: "slow",
  };
  try {
    await page.goto(
      `${app.origin}/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
    );
    await expect
      .poll(() => page.evaluate(() => window.delayFixture.started))
      .toBe(true);
    await expect(page.getByRole("status")).toHaveText("Opening destination…");
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation?.snapshot().status),
      )
      .toBe("opening");
    const launcher = page.getByRole("button", {
      name: "Delayed fixture",
      exact: true,
    });
    const destination = page.getByText("Delayed destination presented", {
      exact: true,
    });
    await expect(launcher).toHaveCount(0);
    await expect(destination).toHaveCount(0);
    await page.evaluate(() => window.delayFixture.release());
    await expect(launcher.first()).toBeVisible();
    await expect(destination).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
  } finally {
    await page.evaluate(() => window.delayFixture?.release?.());
  }
});

test("Messages default resolution returns opened to cold and warm callers without an extra visit", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await expect(
    page.getByRole("button", { name: "Messages", exact: true }).first(),
  ).toBeVisible();
  for (const mode of ["cold", "warm"]) {
    const result = await page.evaluate(async () => {
      const nav = window.fixtureNavigation;
      const pending = nav.open({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
      });
      const visit = nav.snapshot().entry.id;
      return { result: await pending, visit, resolved: nav.snapshot().entry };
    });
    expect(result.result, mode).toEqual({ status: "opened" });
    expect(result.resolved.id, mode).toBe(result.visit);
    expect(result.resolved.target.channelId, mode).toBe("alpha");
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: "Make yourself at home.",
        exact: true,
      }),
    ).toBeVisible();
  }
});

test("Alt arrows preserve composer editing while deliberate history shortcuts still navigate", async ({
  page,
  app,
}) => {
  await open(page, app);
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("one two three");
  const visit = await page.evaluate(
    () => window.fixtureNavigation.snapshot().entry.id,
  );
  for (const arrow of ["ArrowLeft", "ArrowRight"]) {
    await page.keyboard.press(`Alt+${arrow}`);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveJSProperty("value", "one two three");
    expect(
      await page.evaluate(() => window.fixtureNavigation.snapshot().entry.id),
    ).toBe(visit);
  }
  const apple = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform),
  );
  await page.keyboard.press(`${apple ? "Meta" : "Control"}+[`);
  await expect(composer).toHaveCount(0);
  await page.keyboard.press(`${apple ? "Meta" : "Control"}+]`);
  await expect(composer).toHaveJSProperty("value", "one two three");
});
