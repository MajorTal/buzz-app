import { test, expect } from "./fixture.mjs";

test("relay-backed GIF tab searches KLIPY and inserts URL-only media", async ({
  page,
  app,
}, testInfo) => {
  const result = (id, title, height) => ({
    id,
    type: "gif",
    slug: title.toLowerCase(),
    title,
    file: {
      md: {
        gif: {
          url: `https://gif.fixture.invalid/${id}.gif`,
          width: 320,
          height,
          size: 1200,
        },
      },
      sm: {
        webp: {
          url: `https://gif.fixture.invalid/${id}.webp`,
          width: 160,
          height: height / 2,
          size: 600,
        },
      },
    },
  });
  const requests = [];
  let signRequests = 0;
  await page.route("**/api/relay/*/sign", (route) => {
    signRequests += 1;
    return route.abort();
  });
  let releaseInfo = () => {};
  const infoReady = new Promise((resolve) => {
    releaseInfo = resolve;
  });
  let infoRequests = 0;
  await page.route("**/api/relay/*/gif-info", async (route) => {
    infoRequests += 1;
    await infoReady;
    await route.fulfill({
      json: {
        policy: null,
        supported_extensions: ["buzz-gif"],
        gif: { provider: "klipy", search: "/gifs/search" },
      },
    });
  });
  await page.route("**/api/relay/*/gifs", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        result: true,
        data: {
          data: [result(1, "Hello", 240), result(2, "Celebrate", 320)],
        },
      },
    });
  });
  await page.route("https://gif.fixture.invalid/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#8aa6b4"/></svg>',
    }),
  );

  await page.goto(app.origin);
  await page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Messages", exact: true })
    .click();
  const draft = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const emojiTrigger = page.getByRole("button", {
    name: "Insert emoji",
    exact: true,
  });
  await emojiTrigger.click();
  await expect.poll(() => infoRequests).toBeGreaterThan(0);
  const picker = page.getByRole("region", { name: "Emoji picker" });
  await expect(emojiTrigger).toHaveAttribute("aria-busy", "true");
  await expect(picker).toBeVisible();
  await expect(page.getByRole("tab", { name: "GIF", exact: true })).toHaveCount(
    0,
  );
  releaseInfo();
  await expect(emojiTrigger).not.toHaveAttribute("aria-busy", "true");
  await expect(
    page.getByRole("tab", { name: "GIF", exact: true }),
  ).toBeVisible();
  await expect(picker).toBeVisible();
  await expect(picker).toHaveCSS("border-radius", "24px");
  await expect(picker).toHaveCSS("border-top-width", "1px");
  await expect(picker).not.toHaveCSS("box-shadow", "none");
  const emojiTab = page.getByRole("tab", { name: "Emoji", exact: true });
  const gifTab = page.getByRole("tab", { name: "GIF", exact: true });
  const emojiSearch = page.getByRole("searchbox", {
    name: "Search emoji",
    exact: true,
  });
  const emojiSearchPosition = await emojiSearch.boundingBox();
  await expect(emojiSearch).toBeFocused();
  await expect(emojiTab).toHaveAttribute("aria-selected", "true");
  await expect(emojiTab).toHaveAttribute("aria-controls", /.+/);
  await expect(
    picker.getByRole("tabpanel", { name: "Emoji", exact: true }),
  ).toBeVisible();
  await emojiSearch.fill("hello");
  // Base UI owns the tab keyboard model; the selected panel focuses its search.
  await emojiTab.focus();
  await emojiTab.press("ArrowRight");
  await expect(gifTab).toBeFocused();
  await gifTab.press("Enter");
  await expect(gifTab).toHaveAttribute("aria-selected", "true");
  await expect(
    picker.getByRole("tabpanel", { name: "GIF", exact: true }),
  ).toBeVisible();
  await expect(
    picker.getByRole("tabpanel", { name: "Emoji", exact: true }),
  ).toHaveCount(0);
  const tabIndicator = picker.locator(".buzz-tabs-indicator");
  await expect(tabIndicator).toHaveCSS("height", "2px");
  await expect(tabIndicator).toHaveCSS("background-color", "rgb(0, 0, 0)");
  const search = page.getByRole("searchbox", { name: "Search GIFs" });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("hello");
  await draft.fill("unfinished draft");
  // Observe the real key's browser-default boundary, not a guessed network delay.
  await search.evaluate((input) => {
    window.gifEnter = { prevented: false, submits: 0 };
    input.form.addEventListener("submit", () => window.gifEnter.submits++);
    window.addEventListener("keydown", (event) => {
      if (event.target === input && event.key === "Enter")
        window.gifEnter.prevented = event.defaultPrevented;
    });
  });
  await search.press("Enter");
  expect(await page.evaluate(() => window.gifEnter)).toEqual({
    prevented: true,
    submits: 0,
  });
  await expect(draft).toHaveJSProperty("value", "unfinished draft");
  expect(signRequests).toBe(0);
  await draft.evaluate((element) => {
    element.value = "";
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
  });
  await expect(draft).toHaveJSProperty("value", "");
  const composer = draft.locator("xpath=ancestor::form");
  await expect(composer).toHaveCSS("border-top-color", "rgb(128, 128, 128)");
  await expect(composer).toHaveCSS("box-shadow", "none");
  await expect(search).toHaveAttribute("spellcheck", "false");
  await expect(search).toHaveAttribute("autocorrect", "off");
  await expect(search).toHaveAttribute("autocapitalize", "off");
  const searchFrame = search.locator("..");
  await expect(searchFrame).toHaveClass(/search-field/);
  await expect(searchFrame).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(searchFrame).toHaveCSS("border-top-color", "rgb(128, 128, 128)");
  await expect(search).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(search).toHaveCSS("font-family", /Inter Variable/);
  const gifSearchPosition = await searchFrame.boundingBox();
  expect(gifSearchPosition.width).toBeGreaterThan(0);
  expect(gifSearchPosition.x).toBeGreaterThanOrEqual(
    (await picker.boundingBox()).x,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(tabIndicator).toHaveCSS("transition-duration", "0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(
    page.getByTestId("klipy-gif-grid").getByRole("button"),
  ).toHaveCount(2);
  const gifGridBox = await page.getByTestId("klipy-gif-grid").boundingBox();
  const gifResultGutters = await page
    .getByTestId("klipy-gif-grid")
    .evaluate((grid) => {
      const results = grid.parentElement;
      const resultsBounds = results.getBoundingClientRect();
      const gridBounds = grid.getBoundingClientRect();
      return {
        left: gridBounds.left - resultsBounds.left,
        right: resultsBounds.left + results.clientWidth - gridBounds.right,
      };
    });
  expect(gifResultGutters.left).toBeCloseTo(gifResultGutters.right, 1);
  expect(gifResultGutters.left).toBeCloseTo(12, 1);
  const gifScrollbar = page.getByTestId("gif-scrollbar-track");
  await expect(gifScrollbar).toHaveCSS("right", "4px");
  await expect(gifScrollbar).toHaveCSS("opacity", "0.6");
  expect(gifGridBox.y).toBeGreaterThanOrEqual(
    gifSearchPosition.y + gifSearchPosition.height,
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    locale: expect.any(String),
    query: "hello",
  });
  await search.fill("celebrate");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({ query: "celebrate" });
  await emojiTab.click();
  await expect(emojiTab).toHaveAttribute("aria-selected", "true");
  const returningEmojiSearch = page.getByRole("searchbox", {
    name: "Search emoji",
    exact: true,
  });
  await expect(returningEmojiSearch).toHaveValue("celebrate");
  await expect(returningEmojiSearch).toHaveCSS("animation-name", "none");
  const returningEmojiSearchPosition = await returningEmojiSearch.boundingBox();
  expect(returningEmojiSearchPosition.x).toBeCloseTo(emojiSearchPosition.x, 1);
  expect(returningEmojiSearchPosition.y).toBeCloseTo(emojiSearchPosition.y, 1);
  expect(returningEmojiSearchPosition.width).toBeCloseTo(
    emojiSearchPosition.width,
    1,
  );
  await gifTab.click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("celebrate");
  await page.locator("main").click({ position: { x: 4, y: 4 } });
  await expect(picker).toHaveCount(0);
  await emojiTrigger.click();
  await gifTab.click();
  await expect(search).toHaveValue("celebrate");
  await expect(
    page.getByTestId("klipy-gif-grid").getByRole("button"),
  ).toHaveCount(2);
  const reopenRequests = requests.length;
  expect(requests.at(-1)).toMatchObject({
    locale: expect.any(String),
    query: "celebrate",
  });
  await search.fill("hello");
  await expect.poll(() => requests.length).toBe(reopenRequests + 1);
  expect(requests.at(-1)).toMatchObject({ query: "hello" });
  const clear = picker.getByRole("button", {
    name: "Clear search gifs",
    exact: true,
  });
  await expect(clear).toHaveCSS("width", "32px");
  await expect(clear).toHaveCSS("height", "32px");
  await clear.click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(
    page.getByTestId("klipy-gif-grid").getByRole("button"),
  ).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("gif-picker.png") });

  await page.getByRole("button", { name: "Choose Hello", exact: true }).click();
  await expect(draft).toHaveJSProperty(
    "value",
    "![Hello](https://gif.fixture.invalid/1.gif)",
  );
  await expect(
    page.getByRole("searchbox", { name: "Search GIFs" }),
  ).toHaveCount(0);
  expect(app.report.unexpected).toEqual([]);
});

for (const initial of ["invalid response", "unsupported relay"]) {
  test(`GIF discovery retries after ${initial}`, async ({ page, app }) => {
    let attempts = 0;
    await page.route("**/api/relay/*/gif-info", async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: initial === "invalid response" ? "{" : "{}",
        });
        return;
      }
      await route.fulfill({
        json: {
          policy: null,
          supported_extensions: ["buzz-gif"],
          gif: { provider: "klipy", search: "/gifs/search" },
        },
      });
    });

    await page.goto(app.origin);
    await page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: "Messages", exact: true })
      .click();
    const trigger = page.getByRole("button", {
      name: "Insert emoji",
      exact: true,
    });
    const gifTab = page.getByRole("tab", { name: "GIF", exact: true });

    await trigger.click();
    await expect.poll(() => attempts).toBe(1);
    await expect(trigger).not.toHaveAttribute("aria-busy", "true");
    await expect(gifTab).toHaveCount(0);
    await trigger.click();
    await trigger.click();
    await expect.poll(() => attempts).toBe(2);
    await expect(trigger).not.toHaveAttribute("aria-busy", "true");
    await expect(gifTab).toBeVisible();
  });
}
