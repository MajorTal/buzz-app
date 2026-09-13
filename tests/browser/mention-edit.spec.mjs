import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
test("editing selected name plus pasting same name cannot transfer notification to pasted prose", async ({
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
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html`,
    );
    const first = await page.evaluate(() => window.mentionFixture.first);
    const input = page.getByRole("textbox", { name: "Message #General" });
    const cases = [
      {
        start: 6,
        end: 6,
        inserted: "bee @Honey",
        expected: "@Honeybee @Honey",
        notify: false,
      },
      {
        start: 0,
        end: 6,
        inserted: "@Honey",
        expected: "@Honey",
        notify: false,
      },
      {
        start: 0,
        end: 6,
        inserted: "bee @Honey",
        expected: "bee @Honey",
        notify: false,
      },
      {
        start: 0,
        end: 0,
        inserted: "Hi ",
        expected: "Hi @Honey",
        notify: true,
      },
      {
        start: 7,
        end: 7,
        inserted: "help",
        expected: "@Honey help",
        notify: true,
      },
    ];
    for (const [index, scenario] of cases.entries()) {
      await page
        .getByRole("button", { name: "Mention a member", exact: true })
        .click();
      await page
        .getByRole("button", { name: `Honey ${first}`, exact: true })
        .click();
      await expect(input).toHaveValue("@Honey ");
      // The picker restores focus/caret on the next animation frame. Let that
      // finish before establishing the selection this edit is meant to replace.
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await expect(input).toBeFocused();
      await input.evaluate(
        (e, { start, end }) => e.setSelectionRange(start, end),
        scenario,
      );
      await page.keyboard.insertText(scenario.inserted);
      await expect(input).toHaveValue(
        scenario.expected + (scenario.expected.endsWith("help") ? "" : " "),
      );
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await expect
        .poll(() =>
          page.evaluate(() => window.mentionFixture.publications.length),
        )
        .toBe(index + 1);
      const event = await page.evaluate(
        (index) => window.mentionFixture.publications[index],
        index,
      );
      expect(event.content).toBe(scenario.expected);
      expect(event.tags.filter(([tag]) => tag === "p")).toEqual(
        scenario.notify ? [["p", first]] : [],
      );
    }
  } finally {
    await server.close();
  }
});
