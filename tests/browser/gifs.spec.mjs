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
  await expect(page.getByRole("tab", { name: "GIF", exact: true })).toHaveCount(
    0,
  );
  await emojiTrigger.click();
  await emojiTrigger.click();
  await expect(picker).toBeVisible();
  await expect(picker).toHaveCSS("border-radius", "24px");
  await expect(picker).toHaveCSS("border-top-width", "1px");
  await expect(picker).not.toHaveCSS("box-shadow", "none");
  const emojiTab = page.getByRole("tab", { name: "Emoji", exact: true });
  const gifTab = page.getByRole("tab", { name: "GIF", exact: true });
  await expect(emojiTab).toHaveCSS("border-top-left-radius", "16px");
  await expect(gifTab).toHaveCSS("border-top-right-radius", "16px");
  const emojiSearch = page.getByRole("searchbox", {
    name: "Search emoji",
    exact: true,
  });
  await expect(emojiSearch).toHaveCSS(
    "box-shadow",
    "rgb(206, 206, 206) 0px 0px 0px 2px",
  );
  const emojiSearchPosition = await emojiSearch.boundingBox();
  const emojiTabPosition = await emojiTab.boundingBox();
  expect(emojiTabPosition.x).toBeCloseTo(emojiSearchPosition.x - 2, 1);
  const searchStyle = (input) => {
    const style = getComputedStyle(input);
    return {
      height: style.height,
      padding: style.padding,
      borderRadius: style.borderRadius,
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
    };
  };
  const emojiSearchStyle = await emojiSearch.evaluate(searchStyle);
  expect(emojiSearchStyle.fontFamily).toMatch(/^Inter, /);
  expect(emojiSearchStyle.fontFamily).not.toContain("Inter Variable");
  const emojiContentHeight = (
    await page.locator("em-emoji-picker").boundingBox()
  ).height;
  const sharedSearchIcon = picker.locator(":scope > svg.lucide-search");
  const sharedSearchIconNode = await sharedSearchIcon.elementHandle();
  const emojiSearchIconPosition = await sharedSearchIcon.boundingBox();
  expect(emojiSearchIconPosition.x - emojiSearchPosition.x).toBeCloseTo(8, 1);
  expect(emojiSearchIconPosition.y - emojiSearchPosition.y).toBeCloseTo(6, 1);
  const emojiSearchSpacing = await emojiSearch.evaluate((input) => {
    const root = input.getRootNode();
    const picker = root.querySelector("#root").getBoundingClientRect();
    const scroll = root.querySelector(".scroll").getBoundingClientRect();
    const search = input.getBoundingClientRect();
    return {
      top: search.top - picker.top,
      bottom: scroll.top - search.bottom,
    };
  });
  expect(emojiSearchSpacing.top).toBeCloseTo(14, 1);
  expect(emojiSearchSpacing.bottom).toBeCloseTo(14, 1);
  expect(emojiSearchSpacing.bottom).toBeCloseTo(emojiSearchSpacing.top, 1);
  const tabsBox = await page.getByRole("tablist").boundingBox();
  await expect(page.getByRole("tablist")).toHaveCSS("padding", "8px");
  const tabIndicator = page.getByTestId("picker-tab-indicator");
  const initialIndicatorTransform = await tabIndicator.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  await page.mouse.move(0, 0);
  await expect(gifTab).toHaveCSS("color", "rgb(141, 141, 141)");
  await gifTab.hover();
  await expect(gifTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(gifTab).toHaveCSS("color", "rgb(10, 10, 10)");
  const initialIndicatorBox = await tabIndicator.boundingBox();
  await gifTab.dispatchEvent("pointerdown", {
    button: 0,
    pointerType: "mouse",
  });
  await expect
    .poll(async () => (await tabIndicator.boundingBox()).width)
    .toBeGreaterThan(initialIndicatorBox.width * 1.04);
  await gifTab.dispatchEvent("pointercancel", { pointerType: "mouse" });
  await expect
    .poll(async () => (await tabIndicator.boundingBox()).width)
    .toBeCloseTo(initialIndicatorBox.width, 1);
  await gifTab.evaluate((button) => {
    button.addEventListener(
      "focus",
      () => {
        button.dataset.focusedDuringPointerSwitch = "true";
      },
      { once: true },
    );
  });
  await emojiSearch.fill("hello");
  await gifTab.click();
  await expect(gifTab).not.toHaveAttribute(
    "data-focused-during-pointer-switch",
    "true",
  );
  const activeTab = gifTab;
  await expect(activeTab).toHaveCSS("align-items", "center");
  await expect(activeTab).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(activeTab).toHaveCSS("color", "rgb(10, 10, 10)");
  await expect(activeTab).toHaveCSS("display", "flex");
  await expect(activeTab).toHaveCSS("height", "30px");
  await expect(tabIndicator).toHaveCSS(
    "background-color",
    "rgb(240, 240, 240)",
  );
  await expect(tabIndicator).toHaveCSS("transition-duration", "0.16s");
  await expect
    .poll(() =>
      tabIndicator.evaluate((element) => getComputedStyle(element).transform),
    )
    .not.toBe(initialIndicatorTransform);
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
  await expect(draft).toHaveValue("unfinished draft");
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
  await expect(draft).toHaveValue("");
  const composer = draft.locator("xpath=ancestor::form");
  await expect(composer).toHaveCSS("border-top-color", "rgb(138, 148, 152)");
  await expect(composer).toHaveCSS("box-shadow", "none");
  await expect(search).toHaveAttribute("spellcheck", "false");
  await expect(search).toHaveAttribute("autocorrect", "off");
  await expect(search).toHaveAttribute("autocapitalize", "off");
  await expect(sharedSearchIcon).toHaveAttribute("viewBox", "0 0 24 24");
  await expect(sharedSearchIcon).toHaveAttribute("stroke-width", "2");
  await expect(sharedSearchIcon.locator("path")).toHaveAttribute(
    "d",
    "m21 21-4.34-4.34",
  );
  await expect(sharedSearchIcon.locator("circle")).toHaveAttribute("r", "8");
  expect(await sharedSearchIconNode.evaluate((node) => node.isConnected)).toBe(
    true,
  );
  const gifSearchIconPosition = await sharedSearchIcon.boundingBox();
  expect(gifSearchIconPosition).toEqual(emojiSearchIconPosition);
  const gifSearchPosition = await search.boundingBox();
  const gifContentHeight = (await search.locator("xpath=../..").boundingBox())
    .height;
  expect(gifContentHeight).toBeCloseTo(emojiContentHeight, 1);
  expect(gifSearchPosition.x).toBeCloseTo(emojiSearchPosition.x, 1);
  expect(gifSearchPosition.y).toBeCloseTo(emojiSearchPosition.y, 1);
  expect(gifSearchPosition.width).toBeCloseTo(emojiSearchPosition.width, 1);
  await expect(search).toHaveCSS(
    "box-shadow",
    "rgb(206, 206, 206) 0px 0px 0px 2px",
  );
  expect(gifSearchIconPosition.x - gifSearchPosition.x).toBeCloseTo(8, 1);
  expect(gifSearchIconPosition.y - gifSearchPosition.y).toBeCloseTo(6, 1);
  expect(await search.evaluate(searchStyle)).toEqual(emojiSearchStyle);
  await expect(search).toHaveCSS("height", "28px");
  await expect(search).toHaveCSS("margin-left", "2px");
  await expect(search).toHaveCSS("margin-right", "2px");
  await expect(search).toHaveCSS("border-top-width", "0px");
  await expect(search).toHaveCSS("border-radius", "8px");
  await expect(search).toHaveCSS("background-color", "rgb(245, 245, 246)");
  await expect(search).toHaveCSS("color", "rgb(10, 10, 10)");
  await expect(search).toHaveCSS("animation-name", "none");
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
  expect(
    gifGridBox.y - (gifSearchPosition.y + gifSearchPosition.height),
  ).toBeCloseTo(gifSearchPosition.y - (tabsBox.y + tabsBox.height), 1);
  expect(gifSearchPosition.y - (tabsBox.y + tabsBox.height)).toBeCloseTo(14, 1);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    locale: expect.any(String),
    query: "hello",
  });
  await search.fill("celebrate");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({ query: "celebrate" });
  await emojiTab.evaluate((button) => {
    button.addEventListener(
      "focus",
      () => {
        button.dataset.focusedDuringPointerSwitch = "true";
      },
      { once: true },
    );
  });
  await emojiTab.click();
  await expect(emojiTab).not.toHaveAttribute(
    "data-focused-during-pointer-switch",
    "true",
  );
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
  const clear = picker.getByRole("button", { name: "Clear", exact: true });
  const clearIcon = clear.locator("svg");
  await expect(clear).toHaveCSS("right", "10px");
  await expect(clear).toHaveCSS("width", "16px");
  await expect(clear).toHaveCSS("height", "16px");
  await expect(clear).toHaveCSS("color", "rgb(141, 141, 141)");
  await expect(clearIcon).toHaveAttribute("viewBox", "0 0 24 24");
  await expect(clearIcon).toHaveClass(/lucide-circle-x/);
  await expect(clearIcon.locator("circle")).toHaveCSS(
    "fill",
    "rgb(141, 141, 141)",
  );
  await expect(clearIcon.locator("circle")).toHaveCSS("stroke", "none");
  await expect(clearIcon.locator("path").first()).toHaveCSS(
    "stroke",
    "rgb(245, 245, 246)",
  );
  const filledSearchPosition = await search.boundingBox();
  const clearIconPosition = await clearIcon.boundingBox();
  expect(
    filledSearchPosition.x +
      filledSearchPosition.width -
      clearIconPosition.x -
      clearIconPosition.width,
  ).toBeCloseTo(emojiSearchIconPosition.x - emojiSearchPosition.x, 1);
  await page.screenshot({ path: testInfo.outputPath("gif-picker.png") });

  await page.getByRole("button", { name: "Choose Hello", exact: true }).click();
  await expect(draft).toHaveValue(
    "![Hello](https://gif.fixture.invalid/1.gif)",
  );
  await expect(
    page.getByRole("searchbox", { name: "Search GIFs" }),
  ).toHaveCount(0);
  expect(app.report.unexpected).toEqual([]);
});

test("GIF discovery retries after a transient relay failure", async ({
  page,
  app,
}) => {
  let attempts = 0;
  await page.route("**/api/relay/*/gif-info", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{",
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
  if ((await gifTab.count()) === 0) {
    await trigger.click();
    await trigger.click();
  }
  await expect(gifTab).toBeVisible();
});
