import { ResizeHandle } from "../panels/ResizeHandle";
import {
  CHANNEL_SIDEBAR_DEFAULT_WIDTH,
  CHANNEL_SIDEBAR_MIN_WIDTH,
  CHANNEL_SIDEBAR_MAX_WIDTH,
} from "../../bundled/channels/useSidebarView";
import styles from "../../bundled/channels/Channels.module.css";

export function ChannelSidebarResizeHandle({
  width,
  setWidth,
}: {
  width: number;
  setWidth(width: number): void;
}) {
  return (
    <ResizeHandle
      width={width}
      setWidth={setWidth}
      min={CHANNEL_SIDEBAR_MIN_WIDTH}
      max={CHANNEL_SIDEBAR_MAX_WIDTH}
      reset={() => setWidth(CHANNEL_SIDEBAR_DEFAULT_WIDTH)}
      label="Resize channel sidebar"
      className={styles.sidebarResizeHandle}
    />
  );
}
