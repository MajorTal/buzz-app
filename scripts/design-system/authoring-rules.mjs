import postcss from "postcss";
import { createRequire } from "node:module";
// Reuse the parser shipped by our pinned Vite build tool; no second compiler.
const { parseSync } = createRequire(import.meta.resolve("vite"))(
  "rolldown/utils",
);

const PAINT =
  /^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-start|-end)?)?(?:-color)?|outline(?:-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration-color)$/;
const RAW_COLOR =
  /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color|color-mix)\s*\(/i;
const NAMED_COLOR =
  /^(?:black|white|red|green|blue|yellow|purple|orange|gray|grey|pink|cyan|magenta|lime|navy|teal|aqua|maroon|olive|silver|fuchsia|rebeccapurple)$/i;
const MODE =
  /\.dark\b|data-color-mode\s*[=~|^$*]?=\s*["']?(?:dark|light)|prefers-color-scheme/;
const STOCK =
  /(?:^|:)(?:bg|text|border|ring|fill|stroke|shadow|outline|from|via|to)-(?:slate|gray|zinc|stone|neutral|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|950|[1-9]00)(?:$|\/)/;
const COLOR_CLASS =
  /(?:^|:)(?:bg|text|border|ring|fill|stroke|shadow|outline|divide|decoration|accent|caret|from|via|to)-/;
const COLOR_OPACITY =
  /(?:^|:)(?:bg|text|border|ring|fill|stroke|shadow|outline|divide|decoration|accent|caret|from|via|to)-[^/]+\/(?:\d+|\[.+\])$/;
const TEXT_SIZE =
  /(?:^|:)text-(?:xs|sm|base|lg|xl|[2-9]xl|\[[\d.]+(?:px|rem|em)[^\]]*\])$/;
const TYPE_CLASS =
  /(?:^|:)(?:font-(?:medium|bold|light|thin|black|extrabold|extralight)|tracking-.+|uppercase)$/;
const RESTYLE =
  /(?:^|:)(?:bg-|text-|border-|ring-|shadow-|opacity-|fill-|stroke-|outline-|font-|leading-|tracking-)|(?:^|:)(?:hover|active|focus|focus-visible|disabled):/;
const LAYOUT_TEXT =
  /^(?:text-(?:left|right|center|justify|start|end|ellipsis|clip|wrap|nowrap|balance|pretty))$/;
const ROLES =
  /^(?:text-(?:display|title|heading|body(?:-lg|-sm)?|mono(?:-lg|-sm)?))$/;

/** Findings are stable structural evidence, not line numbers or whole-file exemptions. */
export function authoringFindings(file, source) {
  const findings = [];
  const add = (rule, evidence) => findings.push({ rule, evidence });
  const central = file === "src/shared/design-system/styles/tokens.css";
  const typeOwner = file === "src/shared/design-system/styles/typography.css";
  function declaration(prop, value, context, mode) {
    const paint = PAINT.test(prop);
    const customColor =
      prop.startsWith("--") &&
      (RAW_COLOR.test(value) ||
        /var\(--(?:bg|text|border|neutral|purple|red|green|amber|blue|cyan|orange)-/.test(
          value,
        ));
    if (!central && (paint || customColor)) {
      if (RAW_COLOR.test(value) || NAMED_COLOR.test(value))
        add("local-color", `${context} | ${prop}: ${value}`);
      if (mode) add("mode-color", `${context} | ${prop}: ${value}`);
    }
    if (!typeOwner && /^(font-size|font-weight|letter-spacing)$/.test(prop)) {
      const allowed =
        prop === "font-weight"
          ? /^(?:400|600|normal|inherit|var\(--)/
          : /^(?:inherit|var\(--)/;
      if (!allowed.test(value))
        add("local-type", `${context} | ${prop}: ${value}`);
    }
  }
  if (file.endsWith(".css")) {
    const css = postcss.parse(source);
    css.walkDecls((decl) => {
      const parents = [];
      for (let p = decl.parent; p && p.type !== "root"; p = p.parent) {
        parents.unshift(
          p.type === "rule" ? p.selector : `@${p.name} ${p.params}`,
        );
      }
      const context = parents.join(" > ");
      declaration(decl.prop, decl.value, context, MODE.test(context));
    });
    return findings;
  }
  if (!/\.tsx$/.test(file)) return findings;
  // Static JSX authoring only. Dynamic identifiers and runtime values remain
  // review responsibilities. Parse syntax so callbacks/comments are not markup.
  const parsed = parseSync(file, source);
  if (parsed.errors.length)
    throw new Error(
      `Cannot audit ${file}: ${parsed.errors.map((e) => e.message).join("; ")}`,
    );
  const shared = new Set();
  for (const node of parsed.program.body) {
    if (
      node.type !== "ImportDeclaration" ||
      !/design-system\/ui(?:\/|$)/.test(node.source.value)
    )
      continue;
    for (const specifier of node.specifiers) shared.add(specifier.local.name);
  }
  function strings(node) {
    if (!node) return [];
    if (node.type === "Literal" && typeof node.value === "string")
      return [node.value];
    if (node.type === "TemplateLiteral")
      return node.quasis.map((q) => q.value.cooked ?? q.value.raw);
    if (node.type === "ConditionalExpression")
      return [...strings(node.consequent), ...strings(node.alternate)];
    if (node.type === "LogicalExpression")
      return [...strings(node.left), ...strings(node.right)];
    if (node.type === "JSXExpressionContainer") return strings(node.expression);
    return [];
  }
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "JSXOpeningElement") {
      const tag = source.slice(node.name.start, node.name.end);
      const isShared = shared.has(tag.split(".")[0]);
      for (const attribute of node.attributes) {
        if (attribute.type !== "JSXAttribute") continue;
        if (attribute.name.name === "className") {
          const classes = strings(attribute.value)
            .flatMap((v) => v.split(/\s+/))
            .filter(Boolean);
          for (const value of classes) {
            if (STOCK.test(value)) add("stock-color", `${tag} | ${value}`);
            if (COLOR_CLASS.test(value) && RAW_COLOR.test(value))
              add("local-color", `${tag} | ${value}`);
            if (COLOR_OPACITY.test(value))
              add("color-opacity", `${tag} | ${value}`);
            if (
              /(?:^|:)dark:|data-color-mode|prefers-color-scheme/.test(value) &&
              COLOR_CLASS.test(value)
            )
              add("mode-color", `${tag} | ${value}`);
            if (
              TEXT_SIZE.test(value) ||
              TYPE_CLASS.test(value) ||
              (/(?:^|:)leading-/.test(value) &&
                classes.some((c) => ROLES.test(c)))
            )
              add("local-type", `${tag} | ${value}`);
            if (isShared && RESTYLE.test(value) && !LAYOUT_TEXT.test(value))
              add("component-restyle", `${tag} | ${value}`);
          }
        }
        if (
          attribute.name.name === "style" &&
          attribute.value?.expression?.type === "ObjectExpression"
        ) {
          for (const property of attribute.value.expression.properties) {
            if (property.type !== "Property" || property.computed) continue;
            const prop = (property.key.name ?? property.key.value).replace(
              /[A-Z]/g,
              (c) => `-${c.toLowerCase()}`,
            );
            for (const value of strings(property.value))
              declaration(prop, value, tag, false);
            if (typeof property.value.value === "number")
              declaration(prop, String(property.value.value), tag, false);
            if (isShared && PAINT.test(prop))
              add("component-restyle", `${tag} | style ${prop}`);
          }
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) visit(child);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(parsed.program);
  return findings;
}

/** Exact multiplicities prevent another occurrence inheriting a legacy exemption. */
export function compareBaseline(current, baseline) {
  const counts = new Map();
  for (const finding of current) {
    const key = JSON.stringify([finding.file, finding.rule, finding.evidence]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const errors = [];
  for (const entry of baseline) {
    const key = JSON.stringify([entry.file, entry.rule, entry.evidence]);
    if (
      !entry.reason?.trim() ||
      !Number.isInteger(entry.count) ||
      entry.count < 1
    )
      errors.push(`Invalid baseline entry: ${key}`);
    const count = counts.get(key) ?? 0;
    if (count < entry.count) errors.push(`Remove stale legacy finding: ${key}`);
    counts.set(key, count - entry.count);
  }
  for (const [key, count] of counts)
    if (count > 0) errors.push(`New authoring violation (${count}): ${key}`);
  return errors;
}
