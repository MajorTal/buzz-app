import { useState } from "react";
import { PanelRight } from "lucide-react";
import type { RegisteredPanel } from "../../features/panels/service";

export function PanelLaunchers({
  panels,
  selected,
  launch,
}: {
  panels: readonly RegisteredPanel[];
  selected: RegisteredPanel | undefined;
  launch(panel: RegisteredPanel, trigger: HTMLButtonElement): void;
}) {
  return panels
    .filter((panel) => panel.launcher)
    .map((panel) => (
      <button
        type="button"
        key={`${panel.key}:${panel.revision}`}
        className="shell-icon"
        aria-label={panel.title}
        title={panel.title}
        aria-expanded={panel === selected}
        onClick={(event) => launch(panel, event.currentTarget)}
      >
        <LauncherIcon
          key={panel.launcher?.icon}
          src={panel.launcher?.icon ?? ""}
        />
      </button>
    ));
}
function LauncherIcon({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <PanelRight size={18} aria-hidden="true" />
  ) : (
    <img
      src={src}
      alt=""
      className="object-contain"
      onError={() => setFailed(true)}
    />
  );
}
