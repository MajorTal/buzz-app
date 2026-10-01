import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });

// A real browser is required: jsdom cannot prove stylesheet layers, inherited
// custom properties or the production Tailwind/module CSS cascade.
test("shared tokens reach app controls without history or chip overrides", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page
    .getByRole("button", { name: "Increase interface size", exact: true })
    .click();
  const reset = page.getByRole("button", {
    name: "Reset interface size",
    exact: true,
  });
  await expect(reset).toBeVisible();

  // Clone the actual shared control into diagnostic feature containers. This
  // isolates their CSS contract without fabricating network/history failures.
  await reset.evaluate((button) => {
    const selectors = [];
    const collect = (rules) => {
      for (const rule of rules) {
        if (rule.selectorText) selectors.push(rule.selectorText);
        if (rule.cssRules) collect(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) collect(sheet.cssRules);
    const probes = document.createElement("div");
    probes.id = "design-contract";
    for (const name of [
      "edge",
      "threadHistoryControls",
      "mediaReviewUnavailable",
    ]) {
      const selector = selectors.find((s) =>
        new RegExp(`\\._${name}_`).test(s),
      );
      if (!selector) throw new Error(`Missing feature style: ${name}`);
      const wrapper = document.createElement("div");
      wrapper.className = selector.match(new RegExp(`\\.(_${name}_[\\w]+)`))[1];
      const clone = button.cloneNode(true);
      clone.id = `probe-${name}`;
      clone.setAttribute("aria-label", `Probe ${name}`);
      wrapper.append(clone);
      probes.append(wrapper);
    }
    const chip = document.createElement("span");
    chip.id = "probe-chip";
    chip.className = "inline-chip";
    chip.dataset.buzzUi = "";
    chip.dataset.state = "resolved";
    chip.textContent = "Reference";
    probes.append(chip);
    for (const name of ["buzz-popover-popup", "popup"]) {
      const surface = document.createElement("div");
      surface.id = `probe-${name}`;
      if (name === "buzz-popover-popup") {
        surface.className = name;
        const positioner = document.createElement("div");
        positioner.id = "probe-positioner";
        positioner.className = "buzz-popover-positioner";
        positioner.append(surface);
        probes.append(positioner);
      } else {
        const selector = selectors.find((s) =>
          new RegExp(`\\._${name}_`).test(s),
        );
        if (!selector) throw new Error(`Missing popup style: ${name}`);
        surface.className = selector.match(
          new RegExp(`\\.(_${name}_[\\w]+)`),
        )[1];
        probes.append(surface);
      }
    }
    document.body.append(probes);
  });

  for (const mode of ["Light", "Dark"]) {
    await page.getByRole("radio", { name: mode, exact: true }).check();
    await expect(page.locator("body")).toHaveCSS("scrollbar-width", "thin");
    await expect(page.locator("body")).toHaveCSS(
      "scrollbar-color",
      "rgb(128, 128, 128) rgba(0, 0, 0, 0)",
    );
    const override = await page.addStyleTag({
      content: `:root, :root[data-color-mode] {
        --affordance-subtle: rgb(12, 34, 56);
        --text-standard: rgb(10, 20, 30);
        --text-label-sm: 19px;
        --space-4: 29px;
        --surface-popover: rgb(23, 45, 67);
        --border-standard: rgb(45, 67, 89);
        --radius-control: 13px;
        --radius-panel: 19px;
        --layer-popover: 1234;
      }`,
    });
    try {
      for (const control of [
        reset,
        page.locator("#probe-edge"),
        page.locator("#probe-threadHistoryControls"),
        page.locator("#probe-mediaReviewUnavailable"),
      ]) {
        await expect(control).toHaveCSS("background-color", "rgb(12, 34, 56)");
        await expect(control).toHaveCSS("color", "rgb(10, 20, 30)");
        await expect(control).toHaveCSS("padding-left", "29px");
        await expect(control).toHaveCSS("font-size", "19px");
      }
      await expect(page.locator("#probe-chip")).toHaveCSS(
        "background-color",
        "rgb(12, 34, 56)",
      );
      for (const name of ["buzz-popover-popup", "popup"]) {
        const surface = page.locator(`#probe-${name}`);
        await expect(surface).toHaveCSS("background-color", "rgb(23, 45, 67)");
        await expect(surface).toHaveCSS("border-top-color", "rgb(45, 67, 89)");
        await expect(surface).toHaveCSS(
          "border-radius",
          name === "buzz-popover-popup" ? "19px" : "13px",
        );
        await expect(
          name === "buzz-popover-popup"
            ? page.locator("#probe-positioner")
            : surface,
        ).toHaveCSS("z-index", "1234");
      }
    } finally {
      await override.evaluate((node) => node.remove());
    }
  }
});
