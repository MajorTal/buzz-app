// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { createAgentControl } from "../features/agents/control";
import { controlFixture } from "../features/agents/control-testing";
import type { ModelRequest } from "../features/agents/models";
import { AgentDefaultsCard } from "./AgentDefaultsCard";
import { useSyncExternalStore } from "react";

const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
});

function setup(
  restarted = 0,
  restartFailures = 0,
  configure?: (fixture: ReturnType<typeof controlFixture>) => void,
) {
  const fixture = controlFixture();
  fixture.data.defaultSettings = {
    harness: "buzz-agent",
    provider: "databricks_v2",
    model: "old-model",
    effort: "high",
    sessionPolicy: "channel",
    environmentKeys: ["SAVED_TOKEN"],
  };
  configure?.(fixture);
  const saveDefaults = fixture.host.saveDefaults;
  if (!saveDefaults) throw Error("Missing fixture");
  fixture.host.saveDefaults = async (edit) => ({
    ...(await saveDefaults(edit)),
    restarted,
    restartFailures,
  });
  const control = createAgentControl(fixture.host);
  disposals.push(() => control.dispose());
  function Card() {
    const state = useSyncExternalStore(control.subscribe, control.snapshot);
    return <AgentDefaultsCard control={control} state={state} />;
  }
  render(<Card />);
  return { fixture, control };
}

it("uses harness provider choices, preserves custom IDs, and clears incompatible models", async () => {
  const user = userEvent.setup();
  const { fixture, control } = setup(0, 0, (f) => {
    f.data.harnessOptions?.push({
      command: "/usr/local/bin/goose",
      label: "Goose",
      available: true,
      providers: [{ value: "anthropic", label: "Anthropic" }],
    });
  });
  await control.refresh();
  const card = await screen.findByRole("region", { name: "Agent defaults" });
  await user.click(
    within(card).getByRole("combobox", { name: "Default provider" }),
  );
  expect(
    await screen.findByRole("option", { name: "Databricks v2" }),
  ).toBeVisible();
  await user.click(screen.getByRole("option", { name: "Custom ID" }));
  const custom = within(card).getByRole("textbox", {
    name: "Custom default provider ID",
  });
  expect(custom).toHaveValue("databricks_v2");
  await user.clear(custom);
  await user.type(custom, "private-provider");
  expect(
    within(card).getByRole("combobox", { name: "Default model" }),
  ).toHaveTextContent("Not set");
  await user.click(within(card).getByRole("button", { name: "Discard" }));
  expect(
    within(card).getByRole("combobox", { name: "Default provider" }),
  ).toHaveTextContent("Databricks v2");
  await user.click(
    within(card).getByRole("combobox", { name: "Default harness" }),
  );
  await user.click(await screen.findByRole("option", { name: "Goose" }));
  expect(
    within(card).getByRole("combobox", { name: "Default harness" }),
  ).toHaveTextContent("Goose");
  expect(
    within(card).getByRole("combobox", { name: "Default model" }),
  ).toHaveTextContent("Not set");
  await user.click(
    within(card).getByRole("combobox", { name: "Default provider" }),
  );
  expect(
    await screen.findByRole("option", { name: "Anthropic" }),
  ).toBeVisible();
  await user.click(screen.getByRole("option", { name: "Anthropic" }));
  await user.click(
    within(card).getByRole("combobox", { name: "Default model" }),
  );
  await user.click(await screen.findByRole("option", { name: "Custom ID" }));
  await user.type(
    within(card).getByRole("textbox", { name: "Custom default model ID" }),
    "custom-goose-model",
  );
  await user.keyboard("{Enter}");
  await user.click(within(card).getByRole("button", { name: "Save defaults" }));
  expect(await within(card).findByText("Saved.")).toBeVisible();
  expect(fixture.data.defaultSettings).toMatchObject({
    harness: "goose",
    provider: "anthropic",
    model: "custom-goose-model",
  });
  expect(
    within(card).getByRole("combobox", { name: "Default provider" }),
  ).toHaveTextContent("Anthropic");
  expect(
    within(card).getByRole("textbox", { name: "Custom default model ID" }),
  ).toHaveValue("custom-goose-model");
});

it("looks up Pi models only on Browse, then recovers from failure using the draft", async () => {
  const user = userEvent.setup();
  const requests: ModelRequest[] = [];
  let attempts = 0;
  const { fixture, control } = setup(0, 0, (f) => {
    f.data.defaultWorkspace = "/fixture/workspace";
    f.data.harnessOptions?.push({
      command: "/usr/local/bin/buzz-pi-acp",
      label: "Pi",
      available: true,
      providers: [],
    });
    f.host.models = {
      begin: async () => ++attempts,
      cancel: async () => {},
      run: async (_ticket, request) => {
        requests.push(request);
        if (requests.length === 1) throw "Pi catalog unavailable";
        return {
          host: "",
          models: [{ id: "anthropic/claude-sonnet", name: "Claude Sonnet" }],
          modelOverridden: false,
          disconnected: false,
        };
      },
    };
  });
  await control.refresh();
  const card = await screen.findByRole("region", { name: "Agent defaults" });
  await user.click(
    within(card).getByRole("combobox", { name: "Default harness" }),
  );
  await user.click(await screen.findByRole("option", { name: "Pi" }));
  await user.click(
    within(card).getByRole("combobox", { name: "Default provider" }),
  );
  expect(
    await screen.findByRole("option", {
      name: "OpenAI (API key may be needed)",
    }),
  ).toBeVisible();
  await user.click(
    screen.getByRole("option", { name: "Not set (use harness default)" }),
  );
  await user.click(
    within(card).getByRole("combobox", { name: "Default model" }),
  );
  await user.click(
    await screen.findByRole("option", {
      name: "Not set (use harness default)",
    }),
  );
  expect(requests).toHaveLength(0);
  await user.click(within(card).getByRole("button", { name: "Browse models" }));
  expect(await within(card).findByText("Pi catalog unavailable")).toBeVisible();
  expect(
    fixture.calls.filter((call) => call.action === "saveDefaults"),
  ).toHaveLength(0);
  await user.click(
    within(card).getByRole("combobox", { name: "Default model" }),
  );
  await user.click(await screen.findByRole("option", { name: "Custom ID" }));
  await user.type(
    within(card).getByRole("textbox", { name: "Custom default model ID" }),
    "local/custom-model",
  );
  await user.keyboard("{Enter}");
  expect(
    within(card).getByRole("textbox", { name: "Custom default model ID" }),
  ).toHaveValue("local/custom-model");
  await user.click(within(card).getByRole("button", { name: "Retry models" }));
  expect(await within(card).findByText(/Model choices loaded/)).toBeVisible();
  expect(
    within(card).getByRole("textbox", { name: "Custom default model ID" }),
  ).toHaveValue("local/custom-model");
  expect(requests[1]?.edit?.harness).toMatchObject({
    command: "/usr/local/bin/buzz-pi-acp",
    provider: "",
  });
  await user.click(
    within(card).getByRole("combobox", { name: "Default model" }),
  );
  await user.click(
    await screen.findByRole("option", { name: /Claude Sonnet/ }),
  );
  expect(
    within(card).getByRole("combobox", { name: "Default provider" }),
  ).toHaveTextContent("Anthropic");
  await user.click(within(card).getByRole("button", { name: "Save defaults" }));
  expect(fixture.data.defaultSettings).toMatchObject({
    harness: "pi",
    provider: "anthropic",
    model: "claude-sonnet",
  });
  expect(await within(card).findByText("Saved.")).toBeVisible();
  expect(
    within(card).getByRole("combobox", { name: "Default provider" }),
  ).toHaveTextContent("Anthropic");
  expect(
    within(card).getByRole("combobox", { name: "Default model" }),
  ).toHaveTextContent("Claude Sonnet");
  expect(
    within(card).getByRole("button", { name: "Save defaults" }),
  ).toBeDisabled();
});

it.each([
  {
    harness: "pi" as const,
    command: "/usr/local/bin/buzz-pi-acp",
    label: "Pi",
    provider: "google",
    env: "GEMINI_API_KEY",
    id: "google/gemini-2.5-pro",
  },
  {
    harness: "goose" as const,
    command: "/usr/local/bin/goose",
    label: "Goose",
    provider: "google",
    env: "GOOGLE_API_KEY",
    id: "gemini-2.5-pro",
  },
])(
  "offers a masked $harness default key for lookup and saves it write-only",
  async ({ harness, command, label, provider, env, id }) => {
    const user = userEvent.setup();
    const requests: ModelRequest[] = [];
    const { fixture, control } = setup(0, 0, (f) => {
      f.data.defaultSettings = {
        harness,
        provider,
        model: "gemini-2.5-pro",
        effort: "",
        sessionPolicy: "channel",
        environmentKeys: [env],
      };
      f.data.harnessOptions?.push({
        command,
        label,
        available: true,
        providers: [{ value: provider, label: "Google Gemini" }],
      });
      f.host.models = {
        begin: async () => 1,
        cancel: async () => {},
        run: async (_ticket, request) => {
          requests.push(request);
          return {
            host: "",
            models: [{ id, name: "Gemini 2.5 Pro" }],
            modelOverridden: false,
            disconnected: false,
          };
        },
      };
    });
    await control.refresh();
    const card = await screen.findByRole("region", { name: "Agent defaults" });
    const key = within(card).getByLabelText("Google Gemini API key");
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveValue("");
    expect(key).toHaveAttribute("placeholder", "Saved key unchanged");
    await user.type(key, "replacement-key");
    expect(key).toHaveAttribute("type", "password");
    await user.click(
      within(card).getByRole("button", { name: "Show API key" }),
    );
    expect(key).toHaveAttribute("type", "text");
    await user.click(
      within(card).getByRole("button", { name: "Browse models" }),
    );
    expect(await within(card).findByText(/Model choices loaded/)).toBeVisible();
    expect(requests[0]?.edit?.environment).toEqual({
      [env]: "replacement-key",
    });
    await user.click(
      within(card).getByRole("button", { name: "Save defaults" }),
    );
    expect(await within(card).findByText("Saved.")).toBeVisible();
    expect(
      fixture.calls.find((call) => call.action === "saveDefaults"),
    ).toMatchObject({
      payload: { edit: { environment: { [env]: "replacement-key" } } },
    });
    expect(within(card).getByLabelText("Google Gemini API key")).toHaveValue(
      "",
    );
    expect(
      within(card).getByLabelText("Google Gemini API key"),
    ).toHaveAttribute("placeholder", "Saved key unchanged");
    expect(card).not.toHaveTextContent("replacement-key");
    await user.type(
      within(card).getByLabelText("Google Gemini API key"),
      "next-key",
    );
    expect(
      within(card).getByLabelText("Google Gemini API key"),
    ).toHaveAttribute("type", "password");
  },
);

it("searches the full catalog by ID while bounding choices and distinguishing duplicate names", async () => {
  const user = userEvent.setup();
  const requests: ModelRequest[] = [];
  const { fixture, control } = setup(0, 0, (f) => {
    f.data.defaultSettings = {
      harness: "goose",
      provider: "openai",
      model: "",
      effort: "",
      sessionPolicy: "channel",
      environmentKeys: [],
    };
    f.data.harnessOptions?.push({
      command: "/usr/local/bin/goose",
      label: "Goose",
      available: true,
      providers: [{ value: "openai", label: "OpenAI" }],
    });
    f.host.models = {
      begin: async () => 1,
      cancel: async () => {},
      run: async (_ticket, request) => {
        requests.push(request);
        return {
          host: "",
          models: Array.from({ length: 12 }, (_, index) => ({
            id: `model-${index}`,
            name: "Same name",
          })),
          modelOverridden: false,
          disconnected: false,
        };
      },
    };
  });
  await control.refresh();
  const card = await screen.findByRole("region", { name: "Agent defaults" });
  await user.click(within(card).getByRole("button", { name: "Browse models" }));
  expect(await within(card).findByText(/Model choices loaded/)).toBeVisible();
  await user.click(
    within(card).getByRole("combobox", { name: "Default model" }),
  );
  expect(
    await screen.findByRole("option", { name: "Same name · model-0" }),
  ).toBeVisible();
  expect(screen.getAllByRole("option")).toHaveLength(12); // Ten models, default, custom.
  await user.keyboard("{Escape}");
  await user.type(
    within(card).getByRole("textbox", { name: "Search models" }),
    "model-11",
  );
  await user.click(
    within(card).getByRole("combobox", { name: "Default model" }),
  );
  await user.click(
    await screen.findByRole("option", { name: "Same name · model-11" }),
  );
  await user.clear(
    within(card).getByRole("textbox", { name: "Search models" }),
  );
  await user.type(
    within(card).getByRole("textbox", { name: "Search models" }),
    "no-match",
  );
  expect(
    within(card).getByRole("combobox", { name: "Default model" }),
  ).toHaveTextContent("model-11");
  expect(requests).toHaveLength(1);
  await user.type(within(card).getByLabelText("OpenAI API key"), "draft-key");
  expect(within(card).getByLabelText("OpenAI API key")).toHaveFocus();
  expect(
    within(card).getByRole("textbox", { name: "Custom default model ID" }),
  ).toHaveValue("model-11");
  await user.click(within(card).getByRole("button", { name: "Save defaults" }));
  expect(await within(card).findByText("Saved.")).toBeVisible();
  expect(fixture.data.defaultSettings?.model).toBe("model-11");
  expect(
    within(card).getByRole("textbox", { name: "Custom default model ID" }),
  ).toHaveValue("model-11");
});

it.each([
  {
    environment: { DATABRICKS_HOST: "https://draft.example.test" },
    host: "",
    filter: "build-filter",
  },
  {
    environment: { DATABRICKS_MODEL_FILTER: "" },
    host: "https://build.example.test",
    filter: "",
  },
  {
    environment: {
      DATABRICKS_HOST: "https://draft.example.test",
      DATABRICKS_MODEL_FILTER: "draft-filter",
    },
    host: "",
    filter: "",
  },
])(
  "browses with draft Databricks environment $environment without saving",
  async ({ environment, host, filter }) => {
    const user = userEvent.setup();
    const requests: ModelRequest[] = [];
    const { fixture, control } = setup(0, 0, (f) => {
      f.data.databricksDefaults = {
        host: "https://build.example.test",
        filter: "build-filter",
      };
      f.host.models = {
        begin: async () => 1,
        cancel: async () => {},
        run: async (_ticket, request) => {
          requests.push(request);
          return {
            host: "",
            models: [{ id: "draft-model", name: "Draft model" }],
            modelOverridden: false,
            disconnected: false,
          };
        },
      };
    });
    await control.refresh();
    const card = await screen.findByRole("region", { name: "Agent defaults" });
    for (const [key, value] of Object.entries(environment)) {
      await user.type(within(card).getByLabelText("Name"), key);
      if (value) await user.type(within(card).getByLabelText("Value"), value);
      await user.click(
        within(card).getByRole("button", { name: "Add variable" }),
      );
    }
    await user.click(
      within(card).getByRole("button", { name: "Browse models" }),
    );
    expect(await within(card).findByText(/Model choices loaded/)).toBeVisible();
    expect(requests[0]).toMatchObject({
      host,
      filter,
      inheritWorkspace: true,
      edit: { environment },
    });
    expect(
      fixture.calls.filter((call) => call.action === "saveDefaults"),
    ).toHaveLength(0);
  },
);

it.each([
  {
    provider: "databricks_v2",
    savedKeys: [],
    draft: undefined,
    buildVisible: true,
  },
  { provider: "openai", savedKeys: [], draft: undefined, buildVisible: false },
  {
    provider: "",
    savedKeys: ["BUZZ_AGENT_PROVIDER"],
    draft: undefined,
    buildVisible: false,
  },
  {
    provider: "databricks_v2",
    savedKeys: ["DATABRICKS_MODEL"],
    draft: undefined,
    buildVisible: false,
  },
  {
    provider: "databricks_v2",
    savedKeys: ["BUZZ_AGENT_MODEL"],
    draft: undefined,
    buildVisible: false,
  },
  {
    provider: "databricks_v2",
    savedKeys: [],
    draft: { key: "BUZZ_AGENT_PROVIDER", value: "openai" },
    buildVisible: false,
  },
  {
    provider: "openai",
    savedKeys: [],
    draft: { key: "BUZZ_AGENT_PROVIDER", value: "databricks-v2" },
    buildVisible: true,
  },
  {
    provider: "databricks_v2",
    savedKeys: [],
    draft: { key: "DATABRICKS_MODEL", value: "" },
    buildVisible: false,
  },
])(
  "names the build model only when its fallback applies: $provider $savedKeys $draft",
  async ({ provider, savedKeys, draft, buildVisible }) => {
    const user = userEvent.setup();
    const { control } = setup(0, 0, (f) => {
      if (!f.data.defaultSettings) throw Error("Missing defaults fixture");
      Object.assign(f.data.defaultSettings, {
        provider,
        model: "",
        environmentKeys: savedKeys,
      });
      f.data.agentDefaults = {
        provider: "databricks_v2",
        model: "build-model",
        ownerOnly: true,
      };
    });
    await control.refresh();
    const card = await screen.findByRole("region", { name: "Agent defaults" });
    if (draft) {
      await user.type(within(card).getByLabelText("Name"), draft.key);
      if (draft.value)
        await user.type(within(card).getByLabelText("Value"), draft.value);
      await user.click(
        within(card).getByRole("button", { name: "Add variable" }),
      );
    }
    expect(
      within(card).getByRole("combobox", { name: "Default model" }),
    ).toHaveTextContent(
      buildVisible
        ? "Use build default (build-model)"
        : "Not set (use harness default)",
    );
  },
);

it("hands keyboard focus between a listed choice and its custom input", async () => {
  const user = userEvent.setup();
  const { control } = setup();
  await control.refresh();
  const card = await screen.findByRole("region", { name: "Agent defaults" });
  within(card).getByRole("combobox", { name: "Default effort" }).focus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("option", { name: "Custom ID" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "High" })).toHaveFocus(),
  );
  await user.keyboard("{End}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Custom ID" })).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  expect(
    within(card).getByRole("textbox", { name: "Custom default effort ID" }),
  ).toHaveFocus();
  await user.keyboard("{Shift>}{Tab}{/Shift}{Enter}");
  expect(await screen.findByRole("option", { name: "None" })).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "Custom ID" })).toHaveFocus(),
  );
  await user.keyboard("{Home}{ArrowDown}");
  await waitFor(() =>
    expect(screen.getByRole("option", { name: "None" })).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  expect(
    within(card).queryByRole("textbox", { name: "Custom default effort ID" }),
  ).not.toBeInTheDocument();
  expect(
    within(card).getByRole("combobox", { name: "Default effort" }),
  ).toHaveFocus();
  expect(
    within(card).getByRole("combobox", { name: "Default effort" }),
  ).toHaveTextContent("None");
});

it.each([false, true])(
  "discards a typed Pi key when clearing Model while retaining saved keys (%s)",
  async (savedKey) => {
    const user = userEvent.setup();
    const { fixture, control } = setup(0, 0, (f) => {
      if (!f.data.defaultSettings) throw Error("Missing defaults fixture");
      Object.assign(f.data.defaultSettings, {
        harness: "pi",
        provider: "openai",
        model: "gpt-test",
        environmentKeys: savedKey ? ["OPENAI_API_KEY"] : [],
      });
    });
    await control.refresh();
    const card = await screen.findByRole("region", { name: "Agent defaults" });
    await user.type(
      within(card).getByLabelText("OpenAI API key"),
      "unsaved-key",
    );
    await user.click(
      within(card).getByRole("combobox", { name: "Default model" }),
    );
    await user.click(
      await screen.findByRole("option", {
        name: "Not set (use harness default)",
      }),
    );
    await user.click(
      within(card).getByRole("button", { name: "Save defaults" }),
    );
    expect(await within(card).findByText("Saved.")).toBeVisible();
    expect(
      fixture.calls.find((call) => call.action === "saveDefaults")?.payload,
    ).toEqual({
      edit: expect.objectContaining({
        provider: "",
        model: "",
        environment: {},
      }),
    });
    expect(fixture.data.defaultSettings?.environmentKeys).toEqual(
      savedKey ? ["OPENAI_API_KEY"] : [],
    );
  },
);

it.each([
  { harness: "buzz-agent" as const, override: "BUZZ_AGENT_MODEL" },
  { harness: "goose" as const, override: "GOOSE_MODEL" },
])(
  "warns about $override before browsing and respects its draft removal",
  async ({ harness, override }) => {
    const user = userEvent.setup();
    const { control } = setup(0, 0, (f) => {
      if (!f.data.defaultSettings) throw Error("Missing defaults");
      f.data.defaultSettings.harness = harness;
      f.data.defaultSettings.environmentKeys = [override];
    });
    await control.refresh();
    const card = await screen.findByRole("region", { name: "Agent defaults" });
    expect(
      within(card).getByText(
        `${override} overrides this model selection. Replace or remove it under Environment variables.`,
      ),
    ).toBeVisible();
    await user.click(
      within(card).getByRole("button", { name: `Remove ${override}` }),
    );
    expect(
      within(card).queryByText(/overrides this model selection/),
    ).toBeNull();
  },
);

it("waits for a hidden Goose provider override to be removed before offering its key", async () => {
  const user = userEvent.setup();
  const { control } = setup(0, 0, (f) => {
    f.data.defaultSettings = {
      harness: "goose",
      provider: "openai",
      model: "",
      effort: "",
      sessionPolicy: "channel",
      environmentKeys: ["GOOSE_PROVIDER"],
    };
    f.data.harnessOptions?.push({
      command: "/usr/local/bin/goose",
      label: "Goose",
      available: true,
      providers: [],
    });
    f.host.models = {
      begin: async () => 1,
      cancel: async () => {},
      run: async () => {
        throw "Unexpected lookup";
      },
    };
  });
  await control.refresh();
  const card = await screen.findByRole("region", { name: "Agent defaults" });
  expect(within(card).queryByLabelText("OpenAI API key")).toBeNull();
  expect(
    within(card).getByText(/saved GOOSE_PROVIDER override has a hidden value/),
  ).toBeVisible();
  await user.click(
    within(card).getByRole("button", { name: "Remove GOOSE_PROVIDER" }),
  );
  expect(within(card).getByLabelText("OpenAI API key")).toHaveAttribute(
    "type",
    "password",
  );
  expect(
    within(card).getByRole("button", { name: "Browse models" }),
  ).toBeDisabled();
  expect(
    within(card).getByText(
      "Save environment removals before browsing models so lookup uses the updated settings.",
    ),
  ).toBeVisible();
});

it("drops an unsaved Pi key when its provider changes", async () => {
  const user = userEvent.setup();
  const { fixture, control } = setup(0, 0, (f) => {
    f.data.defaultSettings = {
      harness: "pi",
      provider: "openai",
      model: "gpt-5",
      effort: "",
      sessionPolicy: "channel",
      environmentKeys: [],
    };
  });
  await control.refresh();
  const card = await screen.findByRole("region", { name: "Agent defaults" });
  await user.type(within(card).getByLabelText("OpenAI API key"), "draft-key");
  await user.click(
    within(card).getByRole("combobox", { name: "Default provider" }),
  );
  await user.click(
    await screen.findByRole("option", {
      name: /Anthropic \(API key may be needed\)/,
    }),
  );
  expect(within(card).queryByLabelText("OpenAI API key")).toBeNull();
  expect(within(card).getByLabelText("Anthropic API key")).toHaveValue("");
  expect(within(card).queryByText("OPENAI_API_KEY")).toBeNull();
  await user.type(
    within(card).getByLabelText("Anthropic API key"),
    "another-key",
  );
  await user.click(
    within(card).getByRole("combobox", { name: "Default harness" }),
  );
  await user.click(await screen.findByRole("option", { name: "Goose" }));
  expect(within(card).queryByText("ANTHROPIC_API_KEY")).toBeNull();
  await user.click(within(card).getByRole("button", { name: "Save defaults" }));
  expect(
    fixture.calls.find((call) => call.action === "saveDefaults"),
  ).toMatchObject({
    payload: {
      edit: { harness: "goose", provider: "anthropic", environment: {} },
    },
  });
});

it("saves a selected effort level", async () => {
  const user = userEvent.setup();
  const { fixture, control } = setup();
  await control.refresh();
  const card = await screen.findByRole("region", { name: "Agent defaults" });
  await user.click(
    within(card).getByRole("combobox", { name: "Default effort" }),
  );
  expect(await screen.findByRole("option", { name: "Medium" })).toBeVisible();
  await user.click(screen.getByRole("option", { name: "Medium" }));
  await user.click(within(card).getByRole("button", { name: "Save defaults" }));
  expect(await within(card).findByText("Saved.")).toBeVisible();
  expect(fixture.data.defaultSettings?.effort).toBe("medium");
});

it("keeps a custom effort editable and clears it on harness changes", async () => {
  const user = userEvent.setup();
  const { control } = setup(0, 0, (fixture) => {
    if (!fixture.data.defaultSettings) throw Error("Missing defaults");
    fixture.data.defaultSettings.effort = "special-level";
  });
  await control.refresh();
  const card = await screen.findByRole("region", { name: "Agent defaults" });
  expect(
    within(card).getByRole("textbox", { name: "Custom default effort ID" }),
  ).toHaveValue("special-level");
  await user.click(
    within(card).getByRole("combobox", { name: "Default harness" }),
  );
  await user.click(await screen.findByRole("option", { name: "Goose" }));
  await user.click(
    within(card).getByRole("combobox", { name: "Default effort" }),
  );
  expect(await screen.findByRole("option", { name: "Off" })).toBeVisible();
  expect(screen.getByRole("option", { name: "Max" })).toBeVisible();
  await user.click(screen.getByRole("option", { name: "Max" }));
  expect(
    within(card).getByRole("combobox", { name: "Default effort" }),
  ).toHaveTextContent("Max");
  await user.click(
    within(card).getByRole("combobox", { name: "Default harness" }),
  );
  await user.click(await screen.findByRole("option", { name: "Pi" }));
  expect(
    within(card).getByRole("combobox", { name: "Default harness" }),
  ).toHaveTextContent("Pi");
  expect(
    within(card).getByRole("combobox", { name: "Default effort" }),
  ).toHaveTextContent("Not set");
  await user.click(
    within(card).getByRole("combobox", { name: "Default effort" }),
  );
  expect(await screen.findByRole("option", { name: "Off" })).toBeVisible();
});

it("cancels an in-flight lookup without losing the editable defaults draft", async () => {
  const user = userEvent.setup();
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finished!: () => void;
  const finish = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { fixture, control } = setup(0, 0, (f) => {
    f.host.models = {
      begin: async () => 1,
      cancel: async () => {},
      run: async () => {
        started();
        await gate;
        finished();
        return {
          host: "",
          models: [{ id: "late-model", name: "Late model" }],
          modelOverridden: false,
          disconnected: false,
        };
      },
    };
  });
  try {
    await control.refresh();
    const card = await screen.findByRole("region", { name: "Agent defaults" });
    await user.click(
      within(card).getByRole("button", { name: "Browse models" }),
    );
    await start;
    expect(
      await within(card).findByRole("button", { name: "Cancel model lookup" }),
    ).toBeVisible();
    await user.click(
      within(card).getByRole("button", { name: "Cancel model lookup" }),
    );
    expect(
      await within(card).findByText("Cancelled. Retry when ready."),
    ).toBeVisible();
    await user.clear(
      within(card).getByRole("textbox", { name: "Custom default model ID" }),
    );
    await user.type(
      within(card).getByRole("textbox", { name: "Custom default model ID" }),
      "manual-model",
    );
    await user.keyboard("{Enter}");
    expect(
      within(card).getByRole("textbox", { name: "Custom default model ID" }),
    ).toHaveValue("manual-model");
    expect(fixture.data.defaultSettings?.model).toBe("old-model");
    await act(async () => {
      release();
      await finish;
    });
    expect(
      within(card).getByRole("button", { name: "Retry models" }),
    ).toBeEnabled();
    await user.click(
      within(card).getByRole("combobox", { name: "Default model" }),
    );
    expect(
      await screen.findByRole("option", { name: "Custom ID" }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: /Late model/ })).toBeNull();
    await user.keyboard("{Escape}");
    expect(
      within(card).getByRole("textbox", { name: "Custom default model ID" }),
    ).toHaveValue("manual-model");
  } finally {
    release();
  }
});

it("discard clears unfinished environment inputs as well as the saved draft", async () => {
  const user = userEvent.setup();
  const { control } = setup();
  await control.refresh();
  const card = await screen.findByRole("region", { name: "Agent defaults" });
  await user.type(within(card).getByLabelText("Name"), "UNSAVED_TOKEN");
  await user.type(within(card).getByLabelText("Value"), "unfinished-secret");
  expect(within(card).getByRole("button", { name: "Discard" })).toBeVisible();
  await user.type(
    within(card).getByRole("textbox", { name: "Custom default model ID" }),
    "-draft",
  );
  await user.keyboard("{Enter}");
  await user.click(within(card).getByRole("button", { name: "Discard" }));
  expect(
    within(card).getByRole("textbox", { name: "Custom default model ID" }),
  ).toHaveValue("old-model");
  expect(within(card).getByLabelText("Name")).toHaveValue("");
  expect(within(card).getByLabelText("Value")).toHaveValue("");
});

it("changing the default harness keeps provider, clears model and effort, and saves write-only env", async () => {
  const user = userEvent.setup();
  const { fixture, control } = setup(2, 1);
  await control.refresh();
  const card = await screen.findByRole("region", { name: "Agent defaults" });
  expect(
    within(card).getByRole("textbox", { name: "Custom default model ID" }),
  ).toHaveValue("old-model");
  // Saved environment values are never shown; only the key and its state.
  expect(within(card).getByText("SAVED_TOKEN")).toBeVisible();
  expect(card).not.toHaveTextContent("secret");
  await user.click(
    within(card).getByRole("combobox", { name: "Default harness" }),
  );
  await user.click(await screen.findByRole("option", { name: "Goose" }));
  await user.click(
    within(card).getByRole("combobox", { name: "Conversation context" }),
  );
  await user.click(await screen.findByRole("option", { name: "Each thread" }));
  expect(
    within(card).getByRole("combobox", { name: "Default provider" }),
  ).toHaveTextContent("Custom ID");
  expect(
    within(card).getByRole("textbox", { name: "Custom default provider ID" }),
  ).toHaveValue("databricks_v2");
  expect(
    within(card).getByRole("combobox", { name: "Default model" }),
  ).toHaveTextContent("Not set");
  expect(within(card).getByLabelText("Default effort")).toHaveValue("");
  await user.type(within(card).getByLabelText("Name"), "NEW_KEY");
  await user.type(within(card).getByLabelText("Value"), "secret-value");
  await user.click(within(card).getByRole("button", { name: "Add variable" }));
  await user.click(
    within(card).getByRole("button", { name: "Remove SAVED_TOKEN" }),
  );
  await user.click(within(card).getByRole("button", { name: "Save defaults" }));
  expect(
    await within(card).findByText(
      "Saved. Restarted 2 agents. 1 agent couldn’t restart with the new settings; check Agents.",
    ),
  ).toBeVisible();
  expect(fixture.calls.find((c) => c.action === "saveDefaults")).toEqual({
    action: "saveDefaults",
    payload: {
      edit: {
        harness: "goose",
        provider: "databricks_v2",
        model: "",
        effort: "",
        sessionPolicy: "thread",
        environment: { NEW_KEY: "secret-value", SAVED_TOKEN: null },
      },
    },
  });
  expect(within(card).getByText("NEW_KEY")).toBeVisible();
  expect(within(card).queryByText("SAVED_TOKEN")).toBeNull();
  expect(card).not.toHaveTextContent("secret-value");
});

it("keeps the uncertain-write explanation when Stop overtakes a committed save", async () => {
  const user = userEvent.setup();
  const { fixture, control } = setup();
  await control.refresh();
  const commit = fixture.host.saveDefaults;
  if (!commit) throw Error("Missing fixture");
  let committed!: () => void;
  const written = new Promise<void>((resolve) => {
    committed = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Native commits the defaults, then waits on a restart credential prompt.
  fixture.host.saveDefaults = async (edit) => {
    const saved = await commit(edit);
    committed();
    await gate;
    return saved;
  };
  const card = await screen.findByRole("region", { name: "Agent defaults" });
  await user.clear(
    within(card).getByRole("textbox", { name: "Custom default model ID" }),
  );
  await user.type(
    within(card).getByRole("textbox", { name: "Custom default model ID" }),
    "committed",
  );
  await user.keyboard("{Enter}");
  try {
    await user.click(
      within(card).getByRole("button", { name: "Save defaults" }),
    );
    await written;
    await control.action(fixture.agent.id, "stop");
  } finally {
    release();
  }
  const alert = await within(card).findByRole("alert");
  expect(alert).toHaveTextContent("Could not confirm the operation");
  expect(alert).toHaveTextContent("Check current status and saved settings");
  expect(alert).not.toHaveTextContent("weren’t saved");
  expect(fixture.data.defaultSettings?.model).toBe("committed");
});
