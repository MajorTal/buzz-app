import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { useId, useState, type ReactElement, type ReactNode } from "react";

/** A short supplementary hint. The trigger still owns its accessible name. */
export function Tooltip({
  children,
  content,
}: {
  children: ReactElement<{ "aria-describedby"?: string }>;
  content: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <BaseTooltip.Root open={open} onOpenChange={setOpen}>
      <BaseTooltip.Trigger
        delay={0}
        render={children}
        aria-describedby={
          [children.props["aria-describedby"], open ? id : undefined]
            .filter(Boolean)
            .join(" ") || undefined
        }
      />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
          side="top"
          sideOffset={4}
          className="buzz-tooltip-positioner"
        >
          <BaseTooltip.Popup
            role="tooltip"
            id={id}
            data-buzz-ui=""
            className="buzz-tooltip"
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
