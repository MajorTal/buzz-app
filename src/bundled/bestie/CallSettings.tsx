import { Menu } from "@base-ui/react/menu";
import { IconCheck, IconDots } from "@tabler/icons-react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import type { BestieCall, CallSnapshot } from "./call";
import styles from "./Bestie.module.css";

export function CallSettings({
  call,
  state,
  busy,
}: {
  call: BestieCall;
  state: CallSnapshot;
  busy: boolean;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <IconButton
            icon={<IconDots size={18} />}
            aria-label="Bestie call settings"
          />
        }
      />
      <Menu.Portal>
        <Menu.Positioner
          sideOffset={8}
          align="end"
          className={styles.menuPositioner}
        >
          <Menu.Popup
            data-buzz-ui=""
            className={`${styles.menu} text-body`}
            aria-label="Bestie call settings"
            onKeyDown={(event) => {
              if (event.key === "Escape") event.stopPropagation();
            }}
          >
            <Menu.CheckboxItem
              checked={state.showTranscript}
              onCheckedChange={call.setShowTranscript}
              closeOnClick
              className={styles.menuItem}
            >
              Show transcript
              <Menu.CheckboxItemIndicator>
                <IconCheck size={16} />
              </Menu.CheckboxItemIndicator>
            </Menu.CheckboxItem>
            <Menu.Separator className={styles.separator} />
            <Menu.Group>
              <Menu.GroupLabel className={`${styles.menuLabel} text-body-sm`}>
                Thinking
              </Menu.GroupLabel>
              <Menu.RadioGroup
                value={state.thinking}
                onValueChange={call.setThinking}
                disabled={busy}
              >
                {[
                  ["none", "Off"],
                  ["minimal", "Minimal"],
                  ["low", "Low"],
                  ["medium", "Medium"],
                  ["high", "High"],
                ].map(([value, label]) => (
                  <Menu.RadioItem
                    closeOnClick
                    key={value}
                    value={value}
                    className={styles.menuItem}
                  >
                    {label}
                    <Menu.RadioItemIndicator>
                      <IconCheck size={16} />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
            <Menu.Separator className={styles.separator} />
            <Menu.Group>
              <Menu.GroupLabel className={`${styles.menuLabel} text-body-sm`}>
                Tool approval
              </Menu.GroupLabel>
              <Menu.RadioGroup
                value={state.approval}
                onValueChange={call.setApproval}
                disabled={busy}
              >
                <Menu.RadioItem
                  closeOnClick
                  value="auto"
                  className={styles.menuItem}
                >
                  Automatically approve
                  <Menu.RadioItemIndicator>
                    <IconCheck size={16} />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
                <Menu.RadioItem
                  closeOnClick
                  value="ask"
                  className={styles.menuItem}
                >
                  Ask each time
                  <Menu.RadioItemIndicator>
                    <IconCheck size={16} />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              </Menu.RadioGroup>
            </Menu.Group>
            {busy && (
              <p className={`${styles.menuHint} text-body-sm`}>
                End the call to change thinking or tool approval.
              </p>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
