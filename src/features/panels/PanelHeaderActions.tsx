import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Local card chrome, independent of the public panel contribution contract.
export const PanelHeaderActionsContext = createContext<HTMLElement | null>(
  null,
);

export function PanelHeaderActions({ children }: { children: ReactNode }) {
  const target = useContext(PanelHeaderActionsContext);
  return target ? createPortal(children, target) : children;
}
