import type { ComponentType, SVGProps } from "react";
import * as gatewayIcons from "./index";
import { getIconDefinition, type IconDefinition } from "./createDecorativeIcon";

export type GatewayIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>;

type GatewayExports = Record<string, unknown>;
type InventoryEntry = {
  name: string;
  component: GatewayIcon;
};
type CustomInventoryEntry = InventoryEntry &
  Omit<Extract<IconDefinition, { source: "custom" }>, "source">;

export function createIconInventory(exports: GatewayExports): {
  tabler: InventoryEntry[];
  custom: CustomInventoryEntry[];
} {
  const tabler: InventoryEntry[] = [];
  const custom: CustomInventoryEntry[] = [];

  for (const [name, value] of Object.entries(exports)) {
    const definition = getIconDefinition(value);
    if (!definition)
      throw new Error(`Unclassified icon gateway export: ${name}`);

    const component = value as GatewayIcon;
    if (definition.source === "tabler") tabler.push({ name, component });
    else {
      const { source: _, ...detail } = definition;
      custom.push({ name, component, ...detail });
    }
  }

  tabler.sort((a, b) => a.name.localeCompare(b.name));
  custom.sort((a, b) => a.name.localeCompare(b.name));
  return { tabler, custom };
}

const inventory = createIconInventory(gatewayIcons);
export const TABLER_ICONS = inventory.tabler;
export const CUSTOM_ICONS = inventory.custom;
