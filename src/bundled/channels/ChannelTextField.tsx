import { useId, type Ref } from "react";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import styles from "./ChannelTextField.module.css";

type Props = {
  value: string;
  onChange(value: string): void;
  error?: string | undefined;
  disabled?: boolean | undefined;
} & (
  | { field: "name"; inputRef?: Ref<HTMLInputElement>; creation?: boolean }
  | { field: "description"; inputRef?: Ref<HTMLTextAreaElement> }
);

/** Shared presentation/input policy, not draft or persistence ownership. */
export function ChannelTextField(props: Props) {
  const countId = useId();
  const isName = props.field === "name";
  const limit = isName ? 120 : 1000;
  const count = [...props.value].length;
  const showCount = count >= limit * 0.9 && !props.error;
  const countLabel = count.toLocaleString("en-US");
  const limitLabel = limit.toLocaleString("en-US");
  const control = {
    value: props.value,
    disabled: props.disabled,
    ...(showCount ? { "aria-describedby": countId } : {}),
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => props.onChange(boundedInput(event.currentTarget, props.value, limit)),
  };
  return (
    <Field
      label={
        <span className={styles.label}>
          <span>{isName ? "Name" : "Description"}</span>
          {showCount && (
            <span
              aria-hidden="true"
              className="text-body-sm text-subtle tabular-nums"
            >
              {countLabel}/{limitLabel}
            </span>
          )}
        </span>
      }
      error={props.error}
    >
      {props.field === "name" ? (
        <Input
          {...control}
          ref={props.inputRef}
          data-create-channel-name={props.creation ? "" : undefined}
          required
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="release-notes"
        />
      ) : (
        <Textarea
          {...control}
          ref={props.inputRef}
          rows={3}
          placeholder="What this channel is for"
        />
      )}
      {showCount && (
        <span id={countId} className="sr-only">
          {countLabel} of {limitLabel} characters
        </span>
      )}
    </Field>
  );
}

/** Unlike native maxLength, count Unicode code points without splitting emoji.
 * Trim only inserted growth, preserving existing text even above the UI limit. */
function boundedInput(
  input: HTMLInputElement | HTMLTextAreaElement,
  previous: string,
  limit: number,
): string {
  const ceiling = Math.max(limit, [...previous].length);
  const excess = [...input.value].length - ceiling;
  if (excess <= 0) return input.value;
  // The caret follows the inserted text. Remove overflow there, not from the
  // end of the field, so typing/pasting in the middle cannot eat existing text.
  const caret = input.selectionStart ?? input.value.length;
  const before = [...input.value.slice(0, caret)];
  const prefix = before.slice(0, Math.max(0, before.length - excess)).join("");
  const value = prefix + input.value.slice(caret);
  input.value = value;
  input.setSelectionRange(prefix.length, prefix.length);
  return value;
}
