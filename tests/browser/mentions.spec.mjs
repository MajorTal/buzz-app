import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("actual composer selects namesakes by exact key, publishes channel/reply tags, and blocks removed members", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html`,
    );
    const keys = await page.evaluate(() => ({
      first: window.mentionFixture.first,
      second: window.mentionFixture.second,
    }));
    const choose = async (key) => {
      await page
        .getByRole("button", { name: "Mention a member", exact: true })
        .click();
      const picker = page.getByRole("region", {
        name: "Mention a channel member",
      });
      await expect(
        picker.getByRole("button", { name: `Honey ${key}`, exact: true }),
      ).toBeVisible();
      await picker
        .getByRole("button", { name: `Honey ${key}`, exact: true })
        .click();
    };
    const order = () =>
      page
        .getByRole("button", { name: /^(Mention a member|Insert emoji)$/ })
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute("aria-label")),
        );
    await expect.poll(order).toEqual(["Mention a member", "Insert emoji"]);
    await choose(keys.first);
    await choose(keys.second);
    // The merged toolbar must preserve exact recipients while the new picker
    // inserts Unicode and follows the host mode without recreating the draft.
    const input = page.getByRole("textbox", { name: "Message #General" });
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    await page
      .getByRole("button", { name: "Insert emoji", exact: true })
      .click();
    const search = page.getByRole("searchbox", { name: "Search" });
    await expect(page.locator("em-emoji-picker #root")).toHaveAttribute(
      "data-theme",
      "dark",
    );
    await search.fill("grinning");
    await page.getByRole("button", { name: "😀", exact: true }).click();
    await expect(input).toHaveJSProperty("value", "@Honey @Honey 😀");
    await expect(
      page
        .getByRole("region", { name: "Notification recipients" })
        .getByRole("button"),
    ).toHaveCount(2);
    const chip = page
      .getByRole("region", { name: "Notification recipients" })
      .getByRole("button")
      .first();
    await expect(chip).toHaveCSS("background-color", "rgb(51, 51, 51)");
    await expect(chip).toHaveCSS("color", "rgb(255, 255, 255)");
    await page.screenshot({
      path: test.info().outputPath("mention-recipients.png"),
    });
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.mentionFixture.publications.length ||
            window.mentionFixture
              .outbox()
              .map((item) => ({ state: item.delivery, error: item.error })),
        ),
      )
      .toBe(1);
    const first = await page.evaluate(
      () => window.mentionFixture.publications[0],
    );
    expect(first.content).toBe("@Honey @Honey 😀");
    expect(first.tags.filter(([tag]) => tag === "p")).toEqual([
      ["p", keys.first],
      ["p", keys.second],
    ]);
    expect(first.tags.filter(([tag]) => tag === "h")).toEqual([["h", "c"]]);
    await page.getByRole("button", { name: "Toggle thread" }).click();
    await choose(keys.second);
    await page.evaluate(() =>
      window.mentionFixture.change("disable", "buzz.mentions"),
    );
    await expect(
      page.getByRole("button", { name: "Mention a member", exact: true }),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Notification recipients" })
        .getByRole("button"),
    ).toHaveCount(1);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(2);
    const reply = await page.evaluate(
      () => window.mentionFixture.publications[1],
    );
    expect(reply.tags).toContainEqual(["e", "a".repeat(64), "", "reply"]);
    expect(reply.tags.filter(([tag]) => tag === "p")).toEqual([
      ["p", keys.second],
    ]);
    await page.evaluate(() =>
      window.mentionFixture.change("enable", "buzz.mentions"),
    );
    await expect.poll(order).toEqual(["Mention a member", "Insert emoji"]);
    await choose(keys.first);
    await page
      .getByRole("button", { name: "Remove first Honey", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "no longer a channel member",
    );
    await expect(
      page.getByRole("textbox", { name: "Reply to thread" }),
    ).toHaveJSProperty("value", "@Honey ");
    expect(
      await page.evaluate(() => window.mentionFixture.publications.length),
    ).toBe(2);
    // A child layout effect sees disabled DOM before parent command props refresh.
    // Both commands must fail, even with the previous render's enabled closures.
    await page
      .getByRole("button", { name: "Toggle disabled", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Reply to thread" }),
    ).toBeDisabled();
    expect(
      await page.evaluate(() => window.mentionFixture.disabledCalls),
    ).toEqual([{ inputDisabled: true, text: false, mention: false }]);
    await expect(
      page.getByRole("textbox", { name: "Reply to thread" }),
    ).toHaveJSProperty("value", "@Honey ");
    await expect(
      page
        .getByRole("region", { name: "Notification recipients" })
        .getByRole("button"),
    ).toHaveCount(1);
    await page
      .getByRole("button", { name: "Toggle disabled", exact: true })
      .click();
    await choose(keys.second);
    await expect(
      page.getByRole("textbox", { name: "Reply to thread" }),
    ).toHaveJSProperty("value", "@Honey @Honey ");
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
