// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ExamplePreview } from "./ExamplePreview";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
afterEach(() => {
  cleanup();
  if (clipboardDescriptor)
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function example(code = '<Input defaultValue="Draft" />') {
  return createElement(ExamplePreview, {
    code,
    label: "Name field",
    // biome-ignore lint/correctness/noChildrenProp: createElement requires the component’s declared children prop.
    children: createElement("input", {
      "aria-label": "Name",
      defaultValue: "Draft",
    }),
  });
}

it("preserves an edited example and connects each tab to its panel", () => {
  render(example());
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "My draft" },
  });
  const codeTab = screen.getByRole("tab", { name: "Code" });
  fireEvent.click(codeTab);
  const panel = screen.getByRole("tabpanel", { name: "Code" });
  expect(codeTab).toHaveAttribute("aria-controls", panel.id);
  expect(panel).toHaveAttribute("aria-labelledby", codeTab.id);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
  expect(screen.getByRole("textbox")).toHaveValue("My draft");
});

it("copies the displayed code and clears stale feedback when it changes", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const view = render(example());
  fireEvent.click(screen.getByRole("button", { name: "Copy name field code" }));
  await screen.findByText("Code copied.");
  expect(writeText).toHaveBeenCalledWith('<Input defaultValue="Draft" />');
  view.rerender(example("<Input disabled />"));
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
});

it("reveals selectable code when clipboard access fails", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn().mockRejectedValue(new Error("Clipboard unavailable")),
    },
  });
  render(example());
  fireEvent.click(screen.getByRole("button", { name: "Copy name field code" }));
  await screen.findByText(
    "Couldn’t copy. Select the code and copy it manually.",
  );
  expect(screen.getByRole("tabpanel", { name: "Code" })).toHaveTextContent(
    '<Input defaultValue="Draft" />',
  );
  expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
