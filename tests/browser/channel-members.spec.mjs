import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

// Browser-only contract: real header composition, modal focus and responsive geometry.
// Write/search failure matrices live in the mounted component and session tests.
test("channel members opens from the header, fits each viewport, and returns keyboard focus", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const conversation = page.getByRole("article", { name: "Conversation" });
  await expect(
    conversation.getByRole("tab", { name: "Alpha", exact: true }),
  ).toBeVisible();
  const trigger = conversation.getByRole("button", {
    name: "Channel members",
    exact: true,
  });
  for (const [width, height, mode] of [
    [1440, 850, "light"],
    [800, 850, "dark"],
    [390, 850, "light"],
    [800, 360, "dark"],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(
      (value) =>
        document.documentElement.setAttribute("data-color-mode", value),
      mode,
    );
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: "Channel members",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("searchbox")).toBeFocused();
    await expect(dialog.getByText(/Members ·/)).toBeVisible();
    await expect(dialog.getByText("Loading members…")).toHaveCount(0);
    // Finish the entrance before measuring; content changes must not recenter it.
    await dialog.evaluate(async (node) => {
      await Promise.all(
        node.getAnimations().map((animation) => animation.finished),
      );
    });
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    const search = dialog.getByRole("searchbox");
    await search.fill("no-matching-member");
    await expect(
      dialog.getByText("No members match your search."),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const next = await dialog.boundingBox();
        return { height: next.height, y: next.y };
      })
      .toEqual({ height: box.height, y: box.y });
    await search.fill("");
    await expect(dialog.getByText("No members match your search.")).toHaveCount(
      0,
    );
    await expect
      .poll(async () => (await dialog.boundingBox()).height)
      .toBe(box.height);
    const body = dialog.locator(".buzz-dialog-body");
    await expect(body).toHaveCSS("overflow-y", "auto");
    await expect(
      dialog.getByRole("button", { name: "Close channel members" }),
    ).toBeInViewport();
    if (height === 360) {
      expect(
        await body.evaluate((node) => node.scrollHeight > node.clientHeight),
      ).toBe(true);
      await body.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await expect
        .poll(() => body.evaluate((node) => node.scrollTop))
        .toBeGreaterThan(0);
      await expect(
        dialog.getByRole("button", { name: "Close channel members" }),
      ).toBeInViewport();
    }
    await page.screenshot({
      path: testInfo.outputPath(
        `channel-members-${width}-${height}-${mode}.png`,
      ),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});
