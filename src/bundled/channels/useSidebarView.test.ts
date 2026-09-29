import { expect, it } from "vitest";
import {
  CHANNEL_SIDEBAR_DEFAULT_WIDTH,
  CHANNEL_SIDEBAR_MAX_WIDTH,
  CHANNEL_SIDEBAR_MIN_WIDTH,
  clampChannelSidebarWidth,
} from "./useSidebarView";

it("bounds and rounds the persisted channel sidebar width", () => {
  expect(clampChannelSidebarWidth(CHANNEL_SIDEBAR_MIN_WIDTH - 1)).toBe(
    CHANNEL_SIDEBAR_MIN_WIDTH,
  );
  expect(clampChannelSidebarWidth(287.6)).toBe(288);
  expect(clampChannelSidebarWidth(CHANNEL_SIDEBAR_MAX_WIDTH + 1)).toBe(
    CHANNEL_SIDEBAR_MAX_WIDTH,
  );
  expect(CHANNEL_SIDEBAR_MIN_WIDTH).toBe(220);
  expect(CHANNEL_SIDEBAR_DEFAULT_WIDTH).toBe(260);
});
