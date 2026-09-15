import type { ComposerInputElement } from "../messages/composer-dom";
import {
  useLayoutEffect,
  useCallback,
  useRef,
  useState,
  type RefObject,
  type KeyboardEvent,
} from "react";
import type { ComposerObservation } from "./contracts";

/** One synchronous invalidation owner; stale React closures cannot revive an edit. */
export function useCompletionEditor(
  input: RefObject<ComposerInputElement | null>,
  enabled: boolean,
) {
  const [observation, setObservation] = useState<ComposerObservation>();
  const current = useRef<ComposerObservation | undefined>(undefined);
  const revision = useRef(0);
  const last = useRef<ComposerObservation | undefined>(undefined);
  const composing = useRef(false);
  const keys = useRef<
    ((event: KeyboardEvent<ComposerInputElement>) => boolean) | undefined
  >(undefined);
  const invalidate = useCallback(() => {
    ++revision.current;
    current.current = undefined;
    setObservation(undefined);
  }, []);
  function observe(force = false) {
    const element = input.current;
    if (
      !enabled ||
      !element?.isConnected ||
      element.disabled ||
      element.readOnly ||
      element.ownerDocument.activeElement !== element ||
      composing.current ||
      element.selectionStart !== element.selectionEnd
    ) {
      // Returning from an ineligible selection needs fresh evidence, even at the
      // same caret. Explicit dismissal keeps `last` to ignore redundant events.
      last.current = undefined;
      if (current.current) invalidate();
      return;
    }
    const previous = last.current;
    if (
      !force &&
      previous?.text === element.value &&
      previous.start === element.selectionStart &&
      previous.end === element.selectionEnd
    )
      return;
    const next = Object.freeze({
      revision: ++revision.current,
      text: element.value,
      start: element.selectionStart,
      end: element.selectionEnd,
    });
    last.current = next;
    current.current = next;
    setObservation(next);
  }
  function valid(expected: ComposerObservation) {
    const element = input.current;
    return (
      current.current === expected &&
      enabled &&
      !!element?.isConnected &&
      !element.disabled &&
      !element.readOnly &&
      !composing.current &&
      element.ownerDocument.activeElement === element &&
      element.value === expected.text &&
      element.selectionStart === expected.start &&
      element.selectionEnd === expected.end
    );
  }
  useLayoutEffect(() => {
    if (current.current && !valid(current.current)) observe();
  });
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    const select = () => observe();
    element.addEventListener("select", select);
    element.ownerDocument.addEventListener("selectionchange", select);
    return () => {
      element.removeEventListener("select", select);
      element.ownerDocument.removeEventListener("selectionchange", select);
    };
  });
  useLayoutEffect(() => {
    if (!enabled) invalidate();
    return () => {
      current.current = undefined;
      ++revision.current;
    };
  }, [enabled, invalidate]);
  return { observation, valid, observe, invalidate, keys, composing };
}
export type CompletionEditor = ReturnType<typeof useCompletionEditor>;
