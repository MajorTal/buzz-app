import { chromium, expect } from "@playwright/test";
import { watchPageErrors } from "../../browser/page-errors.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const out = process.env.DEMO_OUTPUT ?? "test-results/identity-names-demo";
await mkdir(out, { recursive: true });
const b = await chromium.launch();
const page = await b.newPage();
const data = await (await fetch("http://127.0.0.1:1435/demo/data")).json();
await page.setViewportSize({ width: 1440, height: 1000 });
const pageErrors = watchPageErrors(page);
await page.goto("http://127.0.0.1:1435");
await page
  .getByRole("navigation", { name: "Pages", exact: true })
  .getByRole("button", { name: "Messages", exact: true })
  .click();
const expected = {
  unique: ["Juniper"],
  "viewer-human": ["Alex", "Alex · v64k"],
  "human-tie": ["Honey · zcrp", "Honey · pfhd"],
  "human-agents": ["Honey", "Honey (agent)", "Wes’s Honey"],
  "mine-first": ["Honey", "Wes’s Honey"],
  "mine-tie": ["Honey · jus6", "Honey · jp7g"],
  "other-tie": ["Wes’s Honey · hysa", "Wes’s Honey · guf4"],
  "human-mine-tie": ["Honey", "Honey (agent) · jus6", "Honey (agent) · jp7g"],
  "owner-tie": ["Wes’s Honey · hysa", "Wes’s Honey · c9ss"],
  "owner-missing": ["Honey · hqmz", "Honey · cs64"],
  "readable-first": ["Honey", "Wes’s Honey"],
  "literal-owner": ["Honey", "Wes’s Honey · hysa", "Wes’s Honey"],
  "literal-agent": ["Honey", "Honey (agent) · jus6", "Honey (agent)"],
  "tail-extension": ["Echo · 6z0h9", "Echo · 2z0h9"],
  "literal-suffix": ["Honey · wjus6", "Honey · jp7g", "Honey · jus6"],
  "case-sensitive": ["Honey", "honey"],
  trim: ["Honey · zcrp", "Honey · qqwq"],
};
const shots = [];
async function capture(id, description) {
  await page.screenshot({ path: `${out}/${id}.png` });
  shots.push({ id, description });
}
for (const [id, , , description] of data.cases.slice(0, 18)) {
  await page.locator(`[data-channel-id="${id}"]`).click();
  await expect(
    page.locator("[data-channel-timeline] [data-message-id]"),
  ).not.toHaveCount(0);
  // The ordinary picker requests the full member profile set, including owner profiles.
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Mention a member or agent" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (keys) =>
          keys.every((k) =>
            window.namingDemoServices.relay
              .snapshot()
              .session.profiles.snapshot()
              .has(k),
          ),
        data.channels
          .find((c) => c.id === id)
          .ids.map((i) => data.identities[i].pubkey),
      ),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  if (expected[id])
    await expect(
      page.locator("[data-channel-timeline] [data-message-id] strong"),
    ).toHaveText(expected[id]);
  const labels = await page
    .locator("[data-channel-timeline] [data-message-id] strong")
    .allTextContents();
  await page
    .locator("[data-channel-timeline]")
    .evaluate((el) => (el.scrollTop = 0));
  await capture(
    id,
    `${description}; visible message headers: ${labels.join(" | ")}`,
  );
  if (id === "conflict-lab") {
    await page
      .locator("[data-channel-timeline]")
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    await capture(
      "conflict-lab-bottom",
      "Mixed conflict scene, lower portion: literal labels and key-extension collisions",
    );
  }
}
await page.locator('[data-channel-id="surfaces"]').click();
await expect(
  page.getByText(
    "Naming demo: thread, mentions, preview and profile. Select an avatar or open this thread.",
    { exact: true },
  ),
).toBeVisible();
await capture(
  "surface-timeline",
  "Message headers, thread participants, membership row, sent mention, message-link preview",
);
await writeFile(
  `${out}/POLICY_CAPTURES.json`,
  JSON.stringify(
    {
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      dirty: execFileSync("git", ["status", "--short"], { encoding: "utf8" }),
      browser: b.version(),
      data,
      shots,
      errors: pageErrors.errors,
    },
    null,
    2,
  ),
);
expect(pageErrors.unexplained()).toEqual([]);
console.log(JSON.stringify({ shots, errors: pageErrors.errors }, null, 2));
await b.close();
