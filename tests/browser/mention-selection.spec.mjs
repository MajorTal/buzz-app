import { test, expect } from "./source-fixture.mjs";

// The browser moves the caret through prose, words and lines; the editor takes
// over only at a mention's edge. That handoff is a native selection contract,
// and the paint of the resulting range is the browser's too: WebKit fills the
// gap on a line from the block edge to the first selected box when a range
// starts exactly where prose meets a token, so the paint is sampled as well.
//
// The second mention is the one every gesture crosses. Its display name is
// one word in the first variant and contains a space in the second: a token
// is one atom either way, and the contract must not depend on the label.
const variants = [
  {
    title: "one-word labels",
    query: "",
    first: (keys) => `Honey ${keys.first}`,
    second: (keys) => `Honey (agent) ${keys.second}`,
    value: "@Honey say hello to @Honey ",
  },
  {
    title: "a label with a space",
    query: "?delayed-profiles",
    first: (keys) => `Honey ${keys.second}`,
    second: (keys) => `Mary Jane ${keys.first}`,
    value: "@Honey say hello to @Mary Jane ",
  },
];

async function compose(page, variant) {
  await page.goto(`/tests/fixtures/mentions.html${variant.query}`);
  await page.evaluate(() => window.mentionFixture.releaseProfiles());
  const keys = await page.evaluate(() => ({
    first: window.mentionFixture.first,
    second: window.mentionFixture.second,
  }));
  const input = page.getByRole("textbox", { name: "Message #General" });
  const mention = async (name) => {
    await page
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    await page.getByRole("button", { name, exact: true }).click();
    // The picker restores focus and the caret on the next animation frame.
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(input).toBeFocused();
  };
  await input.click();
  await mention(variant.first(keys));
  await page.keyboard.type("say hello to ");
  await mention(variant.second(keys));
  const { value } = variant;
  await expect(input).toHaveJSProperty("value", value);
  const selection = () =>
    input.evaluate((el) => [
      el.selectionStart,
      el.selectionEnd,
      el.selectionDirection,
    ]);
  const caret = (offset) =>
    input.evaluate(
      (el, offset) => el.setSelectionRange(offset, offset),
      offset,
    );
  return {
    input,
    selection,
    caret,
    end: value.length,
    // Offsets of the first mention's end, the prose, and the second mention.
    firstEnd: value.indexOf(" "),
    mention: value.lastIndexOf("@"),
    lastWord: value.lastIndexOf("to "),
  };
}

for (const variant of variants) {
  test(`keyboard and pointer selection cross a mention as one unit in both directions (${variant.title})`, async ({
    page,
  }) => {
    const { input, selection, caret, end, firstEnd, mention, lastWord } =
      await compose(page, variant);

    // The browser selects the trailing space; the editor extends over the mention.
    await expect.poll(selection).toEqual([end, end, "forward"]);
    await input.press("Shift+ArrowLeft");
    await expect.poll(selection).toEqual([end - 1, end, "backward"]);
    await input.press("Shift+ArrowLeft");
    await expect.poll(selection).toEqual([mention, end, "backward"]);
    await input.press("Shift+ArrowLeft");
    await expect.poll(selection).toEqual([mention - 1, end, "backward"]);
    await input.press("Shift+ArrowRight");
    await expect.poll(selection).toEqual([mention, end, "backward"]);
    await input.press("Shift+ArrowRight");
    await expect.poll(selection).toEqual([end - 1, end, "backward"]);

    await caret(mention);
    await input.press("Shift+ArrowRight");
    await expect.poll(selection).toEqual([mention, end - 1, "forward"]);
    await input.press("Shift+ArrowRight");
    await expect.poll(selection).toEqual([mention, end, "forward"]);
    await input.press("Shift+ArrowLeft");
    await expect.poll(selection).toEqual([mention, end - 1, "forward"]);
    await input.press("Shift+ArrowLeft");
    await expect.poll(selection).toEqual([mention, mention, "forward"]);

    await caret(end - 1);
    await input.press("Shift+ArrowLeft");
    await expect.poll(selection).toEqual([mention, end - 1, "backward"]);
    await caret(firstEnd);
    await input.press("Shift+ArrowLeft");
    await expect.poll(selection).toEqual([0, firstEnd, "backward"]);
    await input.press("Shift+ArrowRight");
    await expect.poll(selection).toEqual([firstEnd, firstEnd, "forward"]);

    // Word and line jumps stay native and never split a mention.
    const word = process.platform === "darwin" ? "Alt" : "Control";
    await caret(end);
    await input.press(`${word}+Shift+ArrowLeft`);
    await expect.poll(selection).toEqual([mention, end, "backward"]);
    await input.press(`${word}+Shift+ArrowLeft`);
    await expect.poll(selection).toEqual([lastWord, end, "backward"]);
    await input.press("Shift+Home");
    await expect.poll(selection).toEqual([0, end, "backward"]);
    await caret(4);
    await input.press("Shift+End");
    await expect.poll(selection).toEqual([4, end, "forward"]);

    // Dragging from the end back into the prose selects the mention in between.
    // Collapse first: a press inside the Shift+End range would start a drag of
    // the selected text instead of a new selection, and Linux hit-tests the
    // point past the line's end as inside that range.
    await caret(end);
    const points = await input.evaluate((el) => {
      const paragraph = el.querySelector("p");
      const prose = [...paragraph.childNodes].find(
        (node) =>
          node.nodeType === Node.TEXT_NODE && node.data.includes("hello"),
      );
      const line = document.createRange();
      line.selectNodeContents(paragraph);
      const edge = line.getBoundingClientRect();
      const boundary = document.createRange();
      boundary.setStart(prose, 12);
      boundary.setEnd(prose, 12);
      const at = boundary.getBoundingClientRect();
      return {
        y: edge.top + edge.height / 2,
        end: edge.right + 2,
        inProse: at.left,
      };
    });
    await page.mouse.move(points.end, points.y);
    await page.mouse.down();
    await page.mouse.move(points.inProse, points.y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(selection).toEqual([firstEnd + 12, end, "backward"]);
  });

  test(`a selection that starts at a mention paints only its own range (${variant.title})`, async ({
    page,
  }) => {
    const { input, selection, caret, end, mention } = await compose(
      page,
      variant,
    );
    const idle = await paint(page, input);
    expect(idle.firstMention).not.toEqual(idle.prose);

    // Backward: the trailing space, then the mention. Nothing before it moves.
    await input.press("Shift+ArrowLeft");
    await input.press("Shift+ArrowLeft");
    await expect.poll(selection).toEqual([mention, end, "backward"]);
    const backward = await paint(page, input);
    expect(backward.mention).not.toEqual(idle.mention);
    expect(backward.space).not.toEqual(idle.space);
    expect(backward.prose).toEqual(idle.prose);
    expect(backward.firstMention).toEqual(idle.firstMention);

    // Forward from directly before the mention: only the mention is painted.
    await caret(mention);
    await input.press("Shift+ArrowRight");
    await expect.poll(selection).toEqual([mention, end - 1, "forward"]);
    const forward = await paint(page, input);
    expect(forward.mention).not.toEqual(idle.mention);
    expect(forward.space).toEqual(idle.space);
    expect(forward.prose).toEqual(idle.prose);
    expect(forward.firstMention).toEqual(idle.firstMention);
  });
}

/** Painted colours inside the first mention, between two prose words, inside
 * the second mention, and in the trailing space. Sampled in CSS pixels at the
 * line's vertical centre, away from any glyph, so only highlight paint differs. */
async function paint(page, input) {
  // The chip fades its background away to reveal the token's selection paint.
  // Sample the settled state, not whichever frame the screenshot happens to win.
  await input.evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
  );
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const points = await input.evaluate((el) => {
    const paragraph = el.querySelector("p");
    const [first, second] = paragraph.querySelectorAll("[data-source]");
    const prose = [...paragraph.childNodes].find(
      (node) => node.nodeType === Node.TEXT_NODE && node.data.includes("hello"),
    );
    const inset = (element) => {
      const box = element.getBoundingClientRect();
      return { x: Math.floor(box.left) + 1, y: box.top + box.height / 2 };
    };
    const centre = (node, from, to) => {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const box = range.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    };
    const line = paragraph.getBoundingClientRect();
    return {
      clip: {
        x: Math.floor(line.left),
        y: Math.floor(line.top),
        width: Math.ceil(line.right) - Math.floor(line.left),
        height: Math.ceil(line.bottom) - Math.floor(line.top),
      },
      firstMention: inset(first),
      // The space between "say" and "hello".
      prose: centre(prose, 4, 5),
      mention: inset(second),
      space: centre(paragraph.lastChild, 0, 1),
    };
  });
  const png = await page.screenshot({ clip: points.clip, scale: "css" });
  return page.evaluate(
    async ({ base64, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const { clip, ...samples } = points;
      return Object.fromEntries(
        Object.entries(samples).map(([name, { x, y }]) => [
          name,
          [
            ...context.getImageData(
              Math.round(x - clip.x),
              Math.round(y - clip.y),
              1,
              1,
            ).data,
          ].slice(0, 3),
        ]),
      );
    },
    { base64: png.toString("base64"), points },
  );
}
