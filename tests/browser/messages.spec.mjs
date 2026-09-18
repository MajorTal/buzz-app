import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Independent source consumer proves safe ordinary-prop reuse, with real React,
// thread reader and durable outbox. No developer env, broker, credentials or relay.
test("shared thread UI auto-loads, follows live replies, retries and isolates retargeted drafts", async ({
  page,
}, testInfo) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await server.listen();
    const address = server.httpServer.address();
    await page.goto(
      `http://127.0.0.1:${address.port}/tests/fixtures/messages.html`,
    );
    await page.evaluate(() => window.messagesFixture.activate());
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.extensionsActive()),
      )
      .toContain("custom");
    const feed = page.getByRole("region", { name: "Channel message history" });
    await expect(
      feed.getByRole("heading", { name: "Channel Markdown", level: 2 }),
    ).toBeVisible();
    await expect(
      feed.getByText("Virtualized channel row", { exact: true }),
    ).toHaveCSS("font-weight", /^(650|700)$/);
    const feedIndentation = await feed.evaluate(() => {
      const nested = [...document.querySelectorAll("li")].find(
        (item) => item.textContent?.trim() === "channel nested",
      );
      const outer = nested?.parentElement?.parentElement;
      if (!(outer instanceof HTMLLIElement) || !nested)
        throw new Error("Missing channel nested ordered list");
      return {
        outer: outer.getBoundingClientRect().left,
        nested: nested.getBoundingClientRect().left,
      };
    });
    expect(feedIndentation.nested).toBeGreaterThan(feedIndentation.outer + 8);
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const history = panel.getByRole("region", { name: "Thread messages" });
    const feedAuthorAvatar = feed.locator(
      '[data-message-id="ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"] [data-avatar-shape]',
    );
    await expect(feedAuthorAvatar).toHaveAttribute(
      "data-avatar-shape",
      "circle",
    );
    const draft = panel.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    const choose = (name) =>
      page.getByRole("button", { name, exact: true }).click();
    const gap = () =>
      history.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      );
    await expect(
      panel.getByText("61 replies shown", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("status")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Load more replies", exact: true }),
    ).toHaveCount(0);
    await expect.poll(gap).toBeLessThan(2);
    await expect(
      history.getByRole("heading", { name: "Markdown reply", level: 2 }),
    ).toBeVisible();
    await expect(history.getByText("Bold", { exact: true })).toHaveCSS(
      "font-weight",
      /^(650|700)$/,
    );
    await expect(history.getByText("italic", { exact: true })).toHaveCSS(
      "font-style",
      "italic",
    );
    await expect(history.locator("del")).toHaveText("done");
    await expect(
      history
        .getByText("unordered one", { exact: true })
        .locator("xpath=ancestor::ul[1]"),
    ).toHaveCSS("list-style-type", "disc");
    const indentation = await history.evaluate(() => {
      const nested = [...document.querySelectorAll("li")].find(
        (item) => item.textContent?.trim() === "nested",
      );
      const outer = nested?.parentElement?.parentElement;
      if (!(outer instanceof HTMLLIElement) || !nested)
        throw new Error("Missing nested ordered list");
      if (getComputedStyle(nested.parentElement).listStyleType !== "decimal")
        throw new Error("Nested ordered list lost its marker style");
      return {
        outer: outer.getBoundingClientRect().left,
        nested: nested.getBoundingClientRect().left,
      };
    });
    expect(indentation.nested).toBeGreaterThan(indentation.outer + 8);
    await expect(history.getByAltText(":_lead:")).toBeVisible();
    await expect(history.getByAltText(":trail_:")).toBeVisible();
    await expect(
      history.getByRole("heading", { name: "Agent Markdown", level: 3 }),
    ).toBeVisible();
    const threadAgentAvatar = history
      .getByRole("heading", { name: "Agent Markdown" })
      .locator("xpath=ancestor::*[@data-message-id][1]")
      .locator("[data-avatar-shape]")
      .first();
    await expect(threadAgentAvatar).toHaveAttribute(
      "data-avatar-shape",
      "squircle",
    );
    const threadHumanAvatar = history
      .getByText("First root", { exact: true })
      .locator("xpath=ancestor::*[@data-message-id][1]")
      .locator("[data-avatar-shape]")
      .first();
    await expect(threadHumanAvatar).toHaveAttribute(
      "data-avatar-shape",
      "circle",
    );
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    const evidence = testInfo.outputPath("human-agent-thread-avatars.png");
    const humanBox = await threadHumanAvatar.boundingBox();
    const agentBox = await threadAgentAvatar.boundingBox();
    const panelBox = await panel.boundingBox();
    if (!humanBox || !agentBox || !panelBox)
      throw new Error("Missing avatar evidence bounds");
    const top = Math.max(0, Math.min(humanBox.y, agentBox.y) - panelBox.y - 36);
    const bottom =
      Math.max(humanBox.y + humanBox.height, agentBox.y + agentBox.height) -
      panelBox.y +
      72;
    await panel.screenshot({
      path: evidence,
      clip: { x: 0, y: top, width: 440, height: bottom - top },
    });
    await testInfo.attach("human-agent-thread-avatars", {
      path: evidence,
      contentType: "image/png",
    });
    await expect(
      history.getByText("Rendered from an agent envelope", { exact: true }),
    ).toHaveCSS("font-weight", /^(650|700)$/);
    await expect(
      history.locator("code").filter({ hasText: "agent-code" }),
    ).toBeVisible();
    // A <br> count misses a second line box caused by inherited pre-wrap.
    // Measure the actual first/second text baselines in both shared surfaces.
    for (const surface of [feed, history]) {
      const paragraph = surface
        .locator("p")
        .filter({ hasText: /^first\s+second$/ });
      await expect(paragraph.locator("br")).toHaveCount(1);
      const geometry = await paragraph.evaluate((element) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const tops = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          for (const word of ["first", "second"]) {
            const start = node.textContent.indexOf(word);
            if (start < 0) continue;
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + word.length);
            tops.push(range.getBoundingClientRect().top);
          }
        }
        return {
          tops,
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        };
      });
      expect(geometry.tops).toHaveLength(2);
      expect(
        Math.abs(geometry.tops[1] - geometry.tops[0] - geometry.lineHeight),
      ).toBeLessThan(1);
      expect(Math.abs(geometry.height - 2 * geometry.lineHeight)).toBeLessThan(
        1,
      );
    }
    await expect(history.locator("pre code")).toHaveCSS("white-space", "pre");
    await expect(history.locator("table")).toContainText("wide-column-one-");
    await expect(history.locator("pre code")).toContainText("wide-content-");
    const safeLink = history.getByRole("link", { name: "Safe link" });
    await expect(safeLink).toHaveAttribute("href", "https://example.com/path");
    await expect(safeLink).toHaveAttribute("rel", "noopener noreferrer");
    const pagesBefore = page.context().pages().length;
    await safeLink.click();
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.links.at(-1)),
      )
      .toBe("https://example.com/path");
    expect(page.context().pages()).toHaveLength(pagesBefore);
    const unhandled = history.getByRole("link", { name: "Unhandled link" });
    const popup = page.waitForEvent("popup");
    await unhandled.click();
    const external = await popup;
    await external.waitForLoadState("domcontentloaded");
    expect(external.url()).toBe("https://example.com/unhandled");
    await external.close();
    await safeLink.click({ modifiers: ["ControlOrMeta"] });
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.links.length),
      )
      .toBe(2);
    const modified = page
      .context()
      .pages()
      .find((candidate) => candidate !== page);
    await modified?.close();
    await history.evaluate((element) => {
      for (const selector of ["pre", "table"]) {
        const item = element.querySelector(selector);
        if (!(item instanceof HTMLElement))
          throw new Error(`Missing ${selector}`);
        if (
          item.getBoundingClientRect().right >
          element.getBoundingClientRect().right + 1
        )
          throw new Error(`${selector} overflows the thread`);
        if (item.scrollWidth <= item.clientWidth)
          throw new Error(
            `${selector} does not provide local horizontal scrolling`,
          );
      }
    });
    await history.evaluate((el) => {
      el.scrollTop = 100;
      el.dispatchEvent(new Event("scroll"));
    });
    await page.evaluate(() => window.messagesFixture.live());
    await expect(
      panel.getByText("62 replies shown", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(100);
    await draft.fill("keep first draft");
    await choose("Second root");
    await expect(draft).toHaveJSProperty("value", "");
    await expect(
      panel.getByText("60 replies shown", { exact: true }),
    ).toBeVisible();
    await expect.poll(gap).toBeLessThan(2);
    await draft.fill("reject second reply");
    await draft.press("Enter");
    await expect(draft).toHaveJSProperty("value", "");
    await expect(
      panel.getByText("Couldn’t send this message.", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await panel.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "Retry", exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByText("reject second reply", { exact: true }),
    ).toHaveCount(1);
    // Retry removes its control while queued; wait for the actual second publish.
    await expect
      .poll(() =>
        page.evaluate(() => window.messagesFixture.report.publications.length),
      )
      .toBe(2);
    const delivery = await page.evaluate(() => window.messagesFixture.report);
    expect(delivery.signings).toHaveLength(1);
    expect(delivery.publications).toHaveLength(2);
    expect(delivery.publications[0]).toEqual(delivery.publications[1]);
    await choose("First root");
    await expect(draft).toHaveJSProperty("value", "keep first draft");
    await page
      .getByRole("textbox", { name: "Message #one", exact: true })
      .fill("keep channel draft");
    await choose("Other channel root");
    await expect(draft).toHaveJSProperty("value", "");
    await expect(
      page.getByRole("textbox", { name: "Message #two", exact: true }),
    ).toHaveJSProperty("value", "");
    await choose("First root");
    await expect(draft).toHaveJSProperty("value", "keep first draft");
    await expect(
      page.getByRole("textbox", { name: "Message #one", exact: true }),
    ).toHaveJSProperty("value", "keep channel draft");
    await choose("Switch scope");
    await expect(draft).toHaveJSProperty("value", "");
    await choose("Switch scope");
    await expect(draft).toHaveJSProperty("value", "keep first draft");
    for (const [index, kind] of [9, 40002].entries()) {
      await page.evaluate((value) => window.messagesFixture.deep(value), kind);
      await expect(
        panel.getByText(`${63 + index} replies shown`, { exact: true }),
      ).toBeVisible();
      const literal = history
        .getByText("literal deep message", { exact: false })
        .last();
      await expect(literal).toBeVisible();
      await expect(literal).toHaveCSS("white-space", "pre-wrap");
    }
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
