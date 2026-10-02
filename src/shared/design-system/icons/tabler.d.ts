// Tabler ships types for its barrel, but not its individual ESM modules.
// Keep runtime imports small without weakening the upstream component contract.
declare module "@tabler/icons-react/dist/esm/icons/*" {
  import type { TablerIcon } from "@tabler/icons-react";
  const Icon: TablerIcon;
  export default Icon;
}
