// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { AgentEnvironmentEditor } from "./AgentEnvironmentEditor";

afterEach(cleanup);
test("worker counts are readable while credentials and unknown values stay masked", async () => {
  const user = userEvent.setup();
  function Example() {
    const [patch, setPatch] = useState<Record<string, string | null>>({
      BUZZ_ACP_AGENTS: "10",
      OPENAI_API_KEY: "test-api-key",
      TOKEN: "test-token",
      CUSTOM_VALUE: "test-value",
    });
    return (
      <AgentEnvironmentEditor
        keys={[]}
        patch={patch}
        disabled={false}
        onChange={setPatch}
      />
    );
  }
  render(<Example />);
  const workers = screen.getByLabelText("Replacement for BUZZ_ACP_AGENTS");
  expect(workers).toHaveAttribute("type", "text");
  expect(workers).toHaveValue("10");
  await user.clear(workers);
  await user.type(workers, "12");
  expect(workers).toHaveValue("12");
  for (const key of ["OPENAI_API_KEY", "TOKEN", "CUSTOM_VALUE"]) {
    expect(screen.getByLabelText(`Replacement for ${key}`)).toHaveAttribute(
      "type",
      "password",
    );
  }
});
test("variable errors belong to the name field and recover without exposing saved values", async () => {
  const user = userEvent.setup();
  function Example() {
    const [patch, setPatch] = useState<Record<string, string | null>>({});
    return (
      <AgentEnvironmentEditor
        keys={["TOKEN"]}
        patch={patch}
        disabled={false}
        onChange={setPatch}
      />
    );
  }
  render(<Example />);
  const name = screen.getByRole("textbox", { name: "Variable name" });
  const add = screen.getByRole("button", { name: "Add variable" });
  await user.type(name, "1invalid");
  await user.click(add);
  expect(name).toHaveAttribute("aria-invalid", "true");
  expect(name).toHaveAccessibleDescription(/start with a letter or underscore/);
  expect(name).toHaveValue("1invalid");
  await user.clear(name);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await user.type(name, "TOKEN");
  await user.click(add);
  expect(name).toHaveAccessibleDescription("That variable is already listed.");
  await user.clear(name);
  await user.type(name, "NEW_TOKEN");
  await user.click(add);
  expect(name).not.toHaveAttribute("aria-invalid", "true");
  expect(name).toHaveValue("");
  expect(screen.getByLabelText("Replacement for TOKEN")).toHaveValue("");
  expect(screen.getByLabelText("Replacement for NEW_TOKEN")).toHaveValue("");
});
