import { useEffect, useRef, useState } from "react";
import {
  emptyLineup,
  resolveLineup,
  type Lineup,
} from "../../features/channel-templates/model";
import type {
  TemplateEditorProps,
  GroupDefaultProps,
} from "../../features/channel-templates/provider";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Select } from "../../shared/design-system/ui/Select";
import { useTemplateCatalog } from "./useTemplateCatalog";

export function TemplateEditor({
  session,
  value,
  initialDefault,
  group,
  onChange,
  active,
}: TemplateEditorProps) {
  const catalog = useTemplateCatalog(session);
  const automatic = useRef(initialDefault);
  const [replacement, setReplacement] = useState<string>();
  const cancelReplace = useRef<HTMLButtonElement>(null);
  const templateControl = useRef<HTMLDivElement>(null);
  const replacementTrigger = useRef<HTMLElement | null>(null);
  const templates = catalog.kit.entries.flatMap((e) =>
    !e.record.deleted && e.record.value.type === "template"
      ? [e.record.value]
      : [],
  );
  const publish = (templateId: string, lineup: Lineup) => {
    if (!active()) return;
    let agents: string[] = [],
      problem: string | undefined;
    try {
      if (catalog.kit.status !== "ready")
        throw new Error("Load the template catalog before accepting setup.");
      if (
        (lineup.teamIds.length || lineup.agents.length) &&
        !catalog.agentsReady
      )
        throw new Error(
          catalog.error ??
            "Load available agents before accepting this lineup.",
        );
      agents = resolveLineup(lineup, catalog.kit.entries, catalog.agents).map(
        (a) => a.pubkey,
      );
    } catch (error) {
      problem = String(error);
    }
    onChange({ templateId, lineup, agents, problem });
  };
  const apply = (id: string) => {
    if (!active()) return;
    automatic.current = "";
    if (!id) {
      onChange({ templateId: "", lineup: emptyLineup(), agents: [] });
      return;
    }
    const template = templates.find((t) => t.id === id);
    if (!template) {
      onChange({
        templateId: id,
        lineup: emptyLineup(),
        agents: [],
        problem: "Template unavailable. Choose another or None.",
      });
      return;
    }
    publish(id, {
      teamIds: [...template.teamIds],
      agents: [...template.agents],
      canvas: template.canvas,
    });
  };
  const choose = (id: string, automaticChoice = false) => {
    if (!active()) return;
    if (
      !automaticChoice &&
      value &&
      (value.lineup.canvas ||
        value.lineup.agents.length ||
        value.lineup.teamIds.length)
    ) {
      setReplacement(id);
    } else apply(id);
  };
  useEffect(() => {
    if (
      automatic.current &&
      value?.problem === "Group default is awaiting selection." &&
      catalog.kit.status === "ready" &&
      (catalog.agentsReady ||
        templates.some(
          (template) =>
            template.id === automatic.current &&
            !template.agents.length &&
            !template.teamIds.length,
        ))
    ) {
      const template = templates.find((t) => t.id === automatic.current);
      if (template && catalog.agentsPending) {
        try {
          resolveLineup(template, catalog.kit.entries, catalog.agents);
        } catch {
          // A pending source/roster is not evidence that a saved member is gone.
          return;
        }
      }
      choose(automatic.current, true);
    }
  });
  return (
    <>
      <div ref={templateControl}>
        <Select
          variant="field"
          label="Template"
          value={value?.templateId ?? ""}
          groups={[
            {
              label: "",
              options: [
                { value: "", label: "None — blank channel" },
                ...templates.map((t) => ({ value: t.id, label: t.name })),
                ...(value?.templateId &&
                !templates.some((t) => t.id === value.templateId)
                  ? [{ value: value.templateId, label: "Unavailable template" }]
                  : []),
              ],
            },
          ]}
          onValueChange={(id) => {
            replacementTrigger.current =
              templateControl.current?.querySelector<HTMLElement>(
                "[role=combobox]",
              ) ?? null;
            choose(id);
          }}
        />
      </div>
      {group?.defaultTemplateId &&
        group.defaultTemplateId === value?.templateId && (
          <p className="text-secondary">Default for {group.name}</p>
        )}
      {group?.defaultTemplateId &&
        group.defaultTemplateId !== value?.templateId && (
          <Button
            type="button"
            variant="ghost"
            onClick={(event) => {
              replacementTrigger.current = event.currentTarget;
              choose(group.defaultTemplateId);
            }}
          >
            Use this group’s default (replace setup)
          </Button>
        )}
      {catalog.kit.status !== "ready" ||
      !catalog.agentsReady ||
      catalog.error ? (
        <div role="status">
          <p>
            {catalog.kit.error ??
              catalog.error ??
              "Loading templates and available agents…"}
          </p>
          <Button type="button" onClick={catalog.refresh}>
            Reload templates and agents
          </Button>
        </div>
      ) : null}
      {value && (value.problem || value.lineup.teamIds.length > 0) && (
        <Button
          type="button"
          onClick={() => {
            if (
              value.problem === "Group default is awaiting selection." ||
              value.problem === "Template unavailable. Choose another or None."
            )
              choose(value.templateId, true);
            else publish(value.templateId, value.lineup);
          }}
        >
          {value.problem
            ? "Recheck selected setup"
            : "Refresh selected team membership"}
        </Button>
      )}
      <Dialog
        open={replacement !== undefined}
        onOpenChange={(open) => {
          if (!open) setReplacement(undefined);
        }}
        dismissOnOutsideClick
        initialFocus={cancelReplace}
        finalFocus={replacementTrigger}
        title="Replace channel setup?"
        actions={
          <>
            <Button
              ref={cancelReplace}
              onClick={() => setReplacement(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="prominent"
              onClick={() => {
                if (replacement === undefined) return;
                setReplacement(undefined);
                apply(replacement);
              }}
            >
              Replace setup
            </Button>
          </>
        }
      >
        Replace the current teams, agents and starting Canvas?
      </Dialog>
    </>
  );
}

export function GroupDefault({
  value,
  entries,
  onChange,
  active,
}: GroupDefaultProps) {
  const templates = entries.flatMap((e) =>
    !e.record.deleted && e.record.value.type === "template"
      ? [e.record.value]
      : [],
  );
  return (
    <Select
      label="Default for new channels"
      variant="field"
      value={value}
      groups={[
        {
          label: "",
          options: [
            { value: "", label: "No template" },
            ...templates.map((t) => ({ value: t.id, label: t.name })),
            ...(value && !templates.some((t) => t.id === value)
              ? [
                  {
                    value,
                    label: "Unavailable template — choose another or None",
                  },
                ]
              : []),
          ],
        },
      ]}
      onValueChange={(id) => {
        if (active()) onChange(id);
      }}
    />
  );
}
