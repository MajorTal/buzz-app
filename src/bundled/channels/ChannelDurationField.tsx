import { motion, useReducedMotion } from "motion/react";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { MinusIcon, PlusIcon } from "../../shared/design-system/icons";
import styles from "./ChannelDurationField.module.css";

const durations = [86400, 604800, 1209600];

/** Draft-only lifetime controls shared by Create and Edit. */
export function ChannelDurationField({
  temporary,
  ttlSeconds,
  disabled = false,
  error,
  onChange,
}: {
  temporary: boolean;
  ttlSeconds: number;
  disabled?: boolean;
  error?: string | undefined;
  onChange(ttlSeconds: number | undefined): void;
}) {
  const reduceMotion = useReducedMotion();
  const instant =
    reduceMotion ||
    (typeof document !== "undefined" &&
      document.documentElement.hasAttribute("data-keyboard-navigation"));
  const transition = {
    duration: instant ? 0 : 0.2,
    ease: [0.2, 0.8, 0.2, 1] as const,
  };
  const shorter = [...durations].reverse().find((value) => value < ttlSeconds);
  const longer = durations.find((value) => value > ttlSeconds);
  const [duration, unit] =
    ttlSeconds === 1209600
      ? [2, "week"]
      : ttlSeconds % 86400 === 0
        ? [ttlSeconds / 86400, "day"]
        : ttlSeconds % 3600 === 0
          ? [ttlSeconds / 3600, "hour"]
          : ttlSeconds % 60 === 0
            ? [ttlSeconds / 60, "minute"]
            : [ttlSeconds, "second"];
  const label = `${duration} ${unit}${duration === 1 ? "" : "s"}`;
  return (
    <Field label={<span className="sr-only">Duration</span>} error={error}>
      <RadioGroup
        value={temporary ? "temporary" : "ongoing"}
        disabled={disabled}
        onValueChange={(value) => {
          if (!disabled)
            onChange(value === "temporary" ? ttlSeconds : undefined);
        }}
      >
        <Radio
          value="ongoing"
          variant="card"
          label="Ongoing"
          description="Keeps its history until you archive it."
        />
        <div className={styles.temporary}>
          <Radio
            value="temporary"
            variant="card"
            label="Temporary"
            description={
              <>
                <span className="sr-only">
                  {temporary
                    ? `Cleans up after ${label} without activity.`
                    : "Cleans up without activity."}
                </span>
                <span aria-hidden="true">
                  Cleans up{" "}
                  <motion.span
                    className={styles.durationReveal}
                    initial={false}
                    animate={{
                      width: temporary ? "auto" : 0,
                      opacity: temporary ? 1 : 0,
                    }}
                    transition={transition}
                  >
                    <strong className={styles.duration}>after {label}</strong>
                    {"\u00a0"}
                  </motion.span>
                  without activity.
                </span>
              </>
            }
          />
          <motion.div
            className={styles.reveal}
            initial={false}
            animate={{
              width: temporary ? "auto" : 0,
              opacity: temporary ? 1 : 0,
            }}
            transition={transition}
            inert={!temporary}
            aria-hidden={!temporary || undefined}
          >
            <div className={styles.adjustments}>
              <IconButton
                aria-label="Decrease duration"
                icon={<MinusIcon />}
                variant="subtle"
                size="sm"
                disabled={disabled || shorter === undefined}
                onClick={() => {
                  if (shorter !== undefined) onChange(shorter);
                }}
              />
              <IconButton
                aria-label="Increase duration"
                icon={<PlusIcon />}
                variant="subtle"
                size="sm"
                disabled={disabled || longer === undefined}
                onClick={() => {
                  if (longer !== undefined) onChange(longer);
                }}
              />
            </div>
          </motion.div>
        </div>
      </RadioGroup>
    </Field>
  );
}
