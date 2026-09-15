import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Avatar } from "./Avatar";

it("keeps decorative avatars out of the accessible name of their parent control", () => {
  const html = renderToStaticMarkup(<Avatar alt="" fallback="Alex Lee" />);
  expect(html).toContain('aria-hidden="true"');
  expect(html).not.toContain('role="img"');
  expect(html).not.toContain("aria-label=");
});

it("uses a complete first character and a fallback for empty names", () => {
  expect(
    renderToStaticMarkup(<Avatar alt="Person" fallback=" 🧑‍💻 Alex" />),
  ).toContain("🧑");
  expect(renderToStaticMarkup(<Avatar alt="Person" fallback="  " />)).toContain(
    ">?</span>",
  );
  expect(
    renderToStaticMarkup(<Avatar alt="Alex Lee" fallback="Alex Lee" />),
  ).toContain('aria-label="Alex Lee"');
});
