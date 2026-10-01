import { useId, useState, type ReactNode } from "react";
import { Tabs } from "../../../../src/shared/design-system/ui/Tabs";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { CopyIcon } from "../../../../src/shared/design-system/icons";

/** Keep examples mounted by default; render children can gate their portals. */
export function ExamplePreview({
  children,
  code,
  label = "Example",
  className = "",
  backdrop = false,
}: {
  children: ReactNode | ((visible: boolean) => ReactNode);
  code: string;
  label?: string;
  className?: string;
  backdrop?: boolean;
}) {
  const id = useId();
  const [view, setView] = useState<"preview" | "code">("preview");
  const [copy, setCopy] = useState<{
    code: string;
    result: "copied" | "failed";
  }>();
  const feedback = copy?.code === code ? copy.result : undefined;
  return (
    <div className="design-example">
      <div className="design-example-toolbar">
        <Tabs
          variant="panel"
          label={`${label} view`}
          value={view}
          onValueChange={setView}
          items={[
            { value: "preview", label: "Preview", panelId: `${id}-preview` },
            { value: "code", label: "Code", panelId: `${id}-code` },
          ]}
        />
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Copy ${label.toLowerCase()} code`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopy({ code, result: "copied" });
            } catch {
              setView("code");
              setCopy({ code, result: "failed" });
            }
          }}
        >
          <CopyIcon aria-hidden="true" />
          Copy
        </Button>
      </div>
      <div
        role="tabpanel"
        id={`${id}-preview`}
        aria-labelledby={`${id}-preview-tab`}
        hidden={view !== "preview"}
      >
        <div
          className={`component-specimen-frame ${className}`}
          data-backdrop={backdrop || undefined}
        >
          {typeof children === "function"
            ? children(view === "preview")
            : children}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${id}-code`}
        aria-labelledby={`${id}-code-tab`}
        hidden={view !== "code"}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The code panel scrolls and needs a keyboard entry point.
        tabIndex={0}
        className="design-example-code"
      >
        <pre className="text-mono">
          <code>{code}</code>
        </pre>
      </div>
      <p
        role="status"
        className="design-example-feedback text-body-sm text-secondary"
        data-visible={!!feedback}
      >
        {feedback === "copied"
          ? "Code copied."
          : feedback === "failed"
            ? "Couldn’t copy. Select the code and copy it manually."
            : ""}
      </p>
    </div>
  );
}
