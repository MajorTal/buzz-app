import type { ComponentProps, ReactNode } from "react";
import { Panel } from "./Panel";

type FullPageSurfaceProps = {
  children?: ReactNode;
} & Omit<ComponentProps<"section">, "children" | "className">;

/**
 * The optional single surface filling a page's available workspace.
 *
 * The page remains responsible for content padding, scrolling, alignment, and
 * spatial composition. Pages arranging multiple panels do not use this.
 */
export function FullPageSurface({ children, ...props }: FullPageSurfaceProps) {
  return <Panel {...props}>{children}</Panel>;
}
