import type { PluginModule } from "../../plugins/api";
import { LinkLabel, linkKind } from "./InlineLink";
import styles from "../../shared/InlineReference.module.css";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerLink({
    id: "links",
    title: "Links",
    matches: (url) => linkKind(url) !== null,
    className: styles.link,
    component: ({ url }) => <LinkLabel href={url} />,
  });
};
