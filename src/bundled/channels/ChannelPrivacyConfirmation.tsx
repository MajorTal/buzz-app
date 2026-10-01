import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { readView, writeView } from "../../shared/view-state";

type Visibility = "private" | "public";
const preferenceKey = "channel-privacy-confirmation:dismissed";

// View intent only: shared by Create/Edit and both directions, never authorization.
export function skipPrivacyConfirmation(scope: string) {
  // Honor opt-outs saved before the two directions shared one preference.
  return [
    preferenceKey,
    "channel-privacy-confirmation:private:dismissed",
    "channel-privacy-confirmation:public:dismissed",
  ].some((key) => readView<unknown>(scope, key, false) === true);
}

export function rememberPrivacyConfirmation(scope: string) {
  writeView(scope, preferenceKey, true);
}

export function ChannelPrivacyConfirmation({
  visibility,
  checked,
  onCheckedChange,
}: {
  visibility: Visibility;
  checked: boolean;
  onCheckedChange(checked: boolean): void;
}) {
  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <BaseDialog.Description>
        {visibility === "private"
          ? "Only channel members will have access."
          : "Everyone in this community will be able to view this channel’s full history."}
      </BaseDialog.Description>
      <Checkbox
        label="Don’t show me this again"
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
