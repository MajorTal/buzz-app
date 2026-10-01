// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { AgentHarnessEditor } from "./AgentHarnessEditor";
import { agentDraft } from "./agent-edit";
import { controlFixture } from "../../features/agents/control-testing";

afterEach(cleanup);
it("keeps custom mode separate from saved values and supports an unset provider", async () => {
  const f = controlFixture();
  const user = userEvent.setup();
  function Example() {
    const [draft, setDraft] = useState({
      ...agentDraft(f.agent),
      command: "buzz-agent",
      provider: "provider",
    });
    return (
      <>
        <AgentHarnessEditor
          draft={draft}
          options={[
            {
              command: "buzz-agent",
              label: "Buzz Agent",
              providers: [{ value: "provider", label: "Provider" }],
            },
          ]}
          onChange={(patch) =>
            setDraft((current) => ({ ...current, ...patch }))
          }
        />
        <output>
          {JSON.stringify({ command: draft.command, provider: draft.provider })}
        </output>
      </>
    );
  }
  render(<Example />);
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  await user.click(
    await screen.findByRole("option", {
      name: "Custom executable / current value",
    }),
  );
  expect(screen.getByRole("textbox", { name: "Executable" })).toHaveValue(
    "buzz-agent",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    '{"command":"buzz-agent","provider":"provider"}',
  );
  await user.clear(screen.getByRole("textbox", { name: "Executable" }));
  await user.type(
    screen.getByRole("textbox", { name: "Executable" }),
    "/custom/buzz-agent",
  );
  expect(screen.getByRole("textbox", { name: "Custom provider" })).toHaveValue(
    "provider",
  );
  await user.click(screen.getByRole("combobox", { name: "Provider" }));
  await user.click(await screen.findByRole("option", { name: "Not set" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    '{"command":"/custom/buzz-agent","provider":""}',
  );
});

it.each([
  "/opt/homebrew/bin/goose",
  "C:\\tools\\goose",
  "/opt/buzz/goose-acp",
  "C:\\tools\\goose-acp.exe",
])(
  "preserves Goose settings while editing custom executable %s",
  async (path) => {
    const f = controlFixture();
    const user = userEvent.setup();
    function Example() {
      const [draft, setDraft] = useState({
        ...agentDraft(f.agent),
        command: "/usr/local/bin/goose",
        args: '["acp"]',
        provider: "openrouter",
        model: "m",
      });
      return (
        <>
          <AgentHarnessEditor
            draft={draft}
            options={[
              {
                command: "buzz-agent",
                label: "Buzz Agent",
                defaultArgs: [],
                providers: [{ value: "databricks_v2", label: "Databricks v2" }],
              },
              {
                command: "goose",
                label: "Goose",
                defaultArgs: [],
                providers: [{ value: "openrouter", label: "OpenRouter" }],
              },
            ]}
            onChange={(patch) =>
              setDraft((current) => ({ ...current, ...patch }))
            }
          />
          <output>{JSON.stringify(draft)}</output>
        </>
      );
    }
    render(<Example />);
    await user.click(screen.getByRole("combobox", { name: "Harness" }));
    await user.click(
      await screen.findByRole("option", {
        name: "Custom executable / current value",
      }),
    );
    const executable = screen.getByRole("textbox", { name: "Executable" });
    await user.clear(executable);
    await user.type(executable, path);
    expect(
      JSON.parse(screen.getByRole("status").textContent ?? ""),
    ).toMatchObject({
      command: path,
      args: '["acp"]',
      provider: "openrouter",
      model: "m",
    });
    await user.click(screen.getByRole("combobox", { name: "LLM Provider" }));
    await user.click(await screen.findByRole("option", { name: "Not set" }));
    expect(
      JSON.parse(screen.getByRole("status").textContent ?? ""),
    ).toMatchObject({
      provider: "",
      model: "",
    });
  },
);

it("switching Pi, Goose and Buzz resets incompatible selections and uses each harness arguments", async () => {
  let current = {
    ...agentDraft(controlFixture().agent),
    command: "buzz-agent",
    provider: "databricks_v2",
    model: "old",
    args: "[]",
  };
  function Editor() {
    const [draft, setDraft] = useState(current);
    current = draft;
    return (
      <AgentHarnessEditor
        draft={draft}
        options={[
          {
            command: "buzz-agent",
            label: "Buzz Agent",
            providers: [{ value: "databricks_v2", label: "Databricks v2" }],
            defaultArgs: [],
          },
          {
            command: "goose",
            label: "Goose",
            providers: [],
            defaultArgs: [],
          },
          {
            command: "/local/buzz-pi-acp",
            label: "Pi",
            providers: [{ value: "anthropic", label: "Anthropic" }],
            defaultArgs: [],
          },
        ]}
        piProviders={["extension", "openai"]}
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      />
    );
  }
  const user = userEvent.setup();
  render(<Editor />);
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Pi" }));
  expect(current).toMatchObject({
    command: "/local/buzz-pi-acp",
    args: "[]",
    provider: "",
    model: "",
  });
  await user.click(screen.getByRole("combobox", { name: "LLM Provider" }));
  const extension = await screen.findByRole("option", { name: "extension" });
  // Signed-in providers come from the catalog; the static harness list is
  // ignored, and key providers that are not signed in say so.
  expect(screen.getByRole("option", { name: "OpenAI" })).toBeVisible();
  expect(
    screen.getByRole("option", { name: "Anthropic (API key needed)" }),
  ).toBeVisible();
  expect(
    screen.getByRole("option", { name: "Google Gemini (API key needed)" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("option", { name: "OpenAI (API key needed)" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Anthropic" }),
  ).not.toBeInTheDocument();
  await user.click(extension);
  expect(current.provider).toBe("extension");
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Goose" }));
  expect(current).toMatchObject({
    command: "goose",
    args: "[]",
    provider: "",
    model: "",
  });
  await user.click(screen.getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Buzz Agent" }));
  expect(current).toMatchObject({
    command: "buzz-agent",
    args: "[]",
    provider: "databricks_v2",
    model: "",
  });
});

it("disables Pi's provider list while signed-in providers load and keeps the current choice", () => {
  const f = controlFixture();
  render(
    <AgentHarnessEditor
      draft={{
        ...agentDraft(f.agent),
        command: "/local/buzz-pi-acp",
        provider: "databricks",
      }}
      options={[
        {
          command: "/local/buzz-pi-acp",
          label: "Pi",
          providers: [],
          defaultArgs: [],
        },
      ]}
      piProviders={null}
      onChange={() => {}}
    />,
  );
  const provider = screen.getByRole("combobox", { name: "LLM Provider" });
  expect(provider).toHaveTextContent("databricks");
  expect(provider).toHaveAttribute("data-disabled");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading signed-in providers…",
  );
  expect(screen.queryByLabelText("Custom provider")).toBeNull();
});
