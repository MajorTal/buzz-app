import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect } from "@playwright/test";

const require = createRequire(import.meta.url);

// Compare with the pinned upstream artwork, not the app's gateway mapping.
// React omits the raw asset's invisible canvas path, so compare visible primitives.
export async function expectTabler(locator, name) {
  const svg = readFileSync(
    require.resolve(`@tabler/icons/outline/${name}.svg`),
    "utf8",
  );
  await expect(locator).toHaveCount(1);
  await expect(locator).toHaveAttribute("viewBox", "0 0 24 24");
  await expect(locator).toHaveAttribute("fill", "none");
  await expect(locator).toHaveAttribute("stroke", "currentColor");
  await expect(locator).toHaveAttribute("stroke-width", "2");
  const { actual, expected } = await locator.evaluate((element, upstream) => {
    const artwork = (root) =>
      [
        ...root.querySelectorAll(
          "path,circle,rect,line,polyline,polygon,ellipse",
        ),
      ]
        .filter((node) => node.getAttribute("stroke") !== "none")
        .map((node) => ({
          tag: node.tagName,
          attributes: Object.fromEntries(
            [...node.attributes].map(({ name, value }) => [name, value]),
          ),
        }));
    return {
      actual: artwork(element),
      expected: artwork(
        new DOMParser().parseFromString(upstream, "image/svg+xml"),
      ),
    };
  }, svg);
  expect(expected.length).toBeGreaterThan(0);
  expect(actual).toEqual(expected);
}
