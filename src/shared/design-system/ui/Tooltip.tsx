import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import {
  cloneElement,
  useId,
  useState,
  type AriaAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

/** A short supplementary hint. The trigger still owns its accessible name. */
export function Tooltip({
  children,
  content,
  delay = 0,
  disableHoverablePopup = false,
  side = "top",
}: {
  children: ReactElement<
    Pick<AriaAttributes, "aria-describedby" | "aria-expanded">
  >;
  content: ReactNode;
  delay?: number;
  disableHoverablePopup?: boolean;
  side?: "top" | "right";
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const expanded =
    children.props["aria-expanded"] === true ||
    children.props["aria-expanded"] === "true";
  const describedBy =
    [children.props["aria-describedby"], open && !expanded ? id : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <BaseTooltip.Root
      open={open}
      onOpenChange={setOpen}
      disabled={expanded}
      disableHoverablePopup={disableHoverablePopup}
    >
      <BaseTooltip.Trigger
        delay={delay}
        // Base UI merges render-element props last. Put the combined link on
        // that element so its original description cannot replace the hint.
        render={cloneElement(children, { "aria-describedby": describedBy })}
      />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
          side={side}
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
