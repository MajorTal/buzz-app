// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  PlusIcon,
  PlayFilledIcon,
  OneDriveLogoIcon,
} from "../../../../src/shared/design-system/icons/index";

afterEach(cleanup);

it("preserves SVG refs, explicit accessibility, and styling across rerenders", () => {
  const ref = createRef<SVGSVGElement>();
  const { rerender } = render(
    <PlusIcon ref={ref} size={15} strokeWidth={2.5} color="red" />,
  );
  expect(ref.current).toHaveAttribute("aria-hidden", "true");
  expect(ref.current).toHaveAttribute("width", "0.9375rem");
  expect(ref.current).toHaveAttribute("height", "0.9375rem");
  expect(ref.current).toHaveAttribute("stroke-width", "2.5");
  expect(ref.current).toHaveAttribute("stroke", "red");

  rerender(
    <PlusIcon
      ref={ref}
      aria-hidden={false}
      role="img"
      aria-label="Add item"
      title="Add item"
      className="custom-icon"
      size={20}
    />,
  );
  expect(screen.getByRole("img", { name: "Add item" })).toBe(ref.current);
  expect(ref.current).toHaveAttribute("aria-hidden", "false");
  expect(ref.current).toHaveAttribute("width", "1.25rem");
  expect(ref.current).toHaveAttribute("stroke-width", "2");
  expect(ref.current).toHaveClass("custom-icon");
  expect(ref.current?.querySelector("title")).toHaveTextContent("Add item");
});

it("keeps filled artwork and the existing custom mark decorative", () => {
  const filled = createRef<SVGSVGElement>();
  const custom = createRef<SVGSVGElement>();
  render(
    <>
      <PlayFilledIcon ref={filled} size={18} color="red" />
      <OneDriveLogoIcon ref={custom} size={14} />
    </>,
  );
  expect(filled.current).toHaveAttribute("aria-hidden", "true");
  expect(filled.current).toHaveAttribute("fill", "red");
  expect(filled.current).toHaveAttribute("width", "1.125rem");
  expect(custom.current).toHaveAttribute("aria-hidden", "true");
  expect(custom.current).toHaveAttribute("viewBox", "0 0 256 256");
  expect(custom.current).toHaveAttribute("width", "0.875rem");
});
