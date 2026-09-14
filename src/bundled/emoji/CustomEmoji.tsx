import { useState } from "react";
import type { CustomEmoji as Emoji } from "../../features/relay/emoji";
import styles from "./Emoji.module.css";

/** Event URLs never bypass the captured community's media policy. */
export function CustomEmoji({
  emoji,
  media,
}: {
  emoji: Emoji;
  media(url: string): string | undefined;
}) {
  const src = media(emoji.url);
  const [failed, setFailed] = useState<string>();
  const literal = `:${emoji.shortcode}:`;
  return src && failed !== src ? (
    <img
      className={styles.customEmoji}
      data-copy-emoji={literal}
      draggable={false}
      src={src}
      alt={literal}
      title={literal}
      width={22}
      height={22}
      loading="lazy"
      onError={() => setFailed(src)}
    />
  ) : (
    literal
  );
}
