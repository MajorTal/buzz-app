import agentsSource from "../../../../src/shared/design-system/AGENTS.md?raw";
import designSource from "../../../../src/shared/design-system/DESIGN.md?raw";
import maintainingSource from "../../../../src/shared/design-system/MAINTAINING_DESIGN_SYSTEM.md?raw";
import { MarkdownPage } from "./MarkdownPage";

const DOCUMENTS = {
  maintaining: {
    source: maintainingSource,
    documentPath: "src/shared/design-system/MAINTAINING_DESIGN_SYSTEM.md",
  },
  design: {
    source: designSource,
    documentPath: "src/shared/design-system/DESIGN.md",
  },
  agents: {
    source: agentsSource,
    documentPath: "src/shared/design-system/AGENTS.md",
  },
} as const;

export function SystemDocumentPage({
  document,
}: {
  document: keyof typeof DOCUMENTS;
}) {
  return <MarkdownPage {...DOCUMENTS[document]} />;
}
