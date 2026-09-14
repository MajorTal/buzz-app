import agentsSource from "../../../../src/shared/design-system/AGENTS.md?raw";
import designSource from "../../../../src/shared/design-system/DESIGN.md?raw";
import { MarkdownPage } from "./MarkdownPage";

const DOCUMENTS = {
  design: designSource,
  agents: agentsSource,
} as const;

export function SystemDocumentPage({
  document,
}: {
  document: keyof typeof DOCUMENTS;
}) {
  return <MarkdownPage source={DOCUMENTS[document]} />;
}
