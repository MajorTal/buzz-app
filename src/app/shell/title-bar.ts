import type { MouseEventHandler } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type TitleBarActions = Readonly<{
  startDragging: () => void;
  doubleClick: () => void;
}>;

export type TitleBarDragHandlers = Readonly<{
  onMouseDown: MouseEventHandler<HTMLElement>;
  onMouseUp: MouseEventHandler<HTMLElement>;
}>;

export function createTitleBarDragHandlers(
  actions: TitleBarActions,
): TitleBarDragHandlers {
  let doubleClickStart: Readonly<{ x: number; y: number }> | undefined;

  return {
    onMouseDown(event) {
      if (
        event.button !== 0 ||
        event.target !== event.currentTarget ||
        (event.detail !== 1 && event.detail !== 2)
      ) {
        return;
      }

      if (event.detail === 2) {
        doubleClickStart = { x: event.clientX, y: event.clientY };
        return;
      }

      event.preventDefault();
      actions.startDragging();
    },
    onMouseUp(event) {
      const start = doubleClickStart;
      doubleClickStart = undefined;
      if (
        event.button !== 0 ||
        event.detail !== 2 ||
        event.target !== event.currentTarget ||
        start?.x !== event.clientX ||
        start.y !== event.clientY
      ) {
        return;
      }

      event.preventDefault();
      actions.doubleClick();
    },
  };
}

export const macTitleBarDragHandlers = createTitleBarDragHandlers({
  startDragging: () => {
    void getCurrentWindow().startDragging();
  },
  doubleClick: () => {
    void invoke("title_bar_double_click");
  },
});
