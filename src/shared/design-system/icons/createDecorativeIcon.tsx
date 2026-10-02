import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from "react";

export type IconProps = Omit<ComponentPropsWithoutRef<"svg">, "stroke"> &
  RefAttributes<SVGSVGElement> & {
    stroke?: string;
    color?: string;
    size?: string | number;
    title?: string;
  };
type Icon = ForwardRefExoticComponent<IconProps>;

type IntendedSize = Readonly<{ width: number; height: number }>;
export type IconDefinition =
  | Readonly<{ source: "tabler" }>
  | Readonly<{
      source: "custom";
      meaning: string;
      category: string;
      provenance: string;
      intendedSizes: readonly IntendedSize[];
    }>;

const ICON_DEFINITION = Symbol("buzz.iconDefinition");
export type DefinedIcon = Icon & { readonly [ICON_DEFINITION]: IconDefinition };

/** Defines every public icon's source and decorative-by-default behavior together. */
export function defineIcon(source: "tabler", IconComponent: Icon): DefinedIcon;
export function defineIcon(
  source: "custom",
  IconComponent: Icon,
  detail: Omit<Extract<IconDefinition, { source: "custom" }>, "source">,
): DefinedIcon;
export function defineIcon(
  source: IconDefinition["source"],
  IconComponent: Icon,
  detail?: Omit<Extract<IconDefinition, { source: "custom" }>, "source">,
): DefinedIcon {
  const Defined = forwardRef<SVGSVGElement, IconProps>(function DefinedIcon(
    { "aria-hidden": ariaHidden = true, size = "1em", ...props },
    ref,
  ) {
    return (
      <IconComponent
        ref={ref}
        aria-hidden={ariaHidden}
        size={typeof size === "number" ? `${size / 16}rem` : size}
        {...props}
      />
    );
  }) as DefinedIcon;

  Object.defineProperty(Defined, ICON_DEFINITION, {
    value: source === "tabler" ? { source } : { source, ...detail },
  });
  return Defined;
}

export function getIconDefinition(value: unknown): IconDefinition | undefined {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  )
    return undefined;
  return (value as Partial<DefinedIcon>)[ICON_DEFINITION];
}
