import { PageHeader } from "./primitives";
import { useColorScheme } from "../../../../src/shared/design-system/theme/useColorScheme";

export function MessagesPage() {
  const { scheme } = useColorScheme();
  const source = `./message-gallery.html?theme=${scheme}`;
  return (
    <section className="messages-page">
      <PageHeader
        title="Messages"
        intro="Current message layouts and states, rendered by the app’s components with sample data."
      />
      <iframe title="Message types and states" src={source} />
    </section>
  );
}
