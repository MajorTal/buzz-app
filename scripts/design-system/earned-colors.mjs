import postcss from "postcss";

const ROLE = /^--(?:bg|text|border)-[a-z0-9-]+$/;
const ANNOTATION = /^@earned (modes|pattern|rule|material):\s*(\S[\s\S]*)$/;

/** Validate recorded evidence, not approval or the quality of a design reason. */
export function earnedColorFailures(css) {
  const root = postcss.parse(css);
  const defaults = new Map();
  const dark = new Map();
  const failures = [];
  root.walkDecls((decl) => {
    if (!ROLE.test(decl.prop) || decl.parent.type !== "rule") return;
    const selector = decl.parent.selector;
    if (selector === ":root") {
      if (defaults.has(decl.prop))
        failures.push(`${decl.prop}: duplicate default declaration`);
      defaults.set(decl.prop, decl);
    } else if (/\.dark\b|data-color-mode/.test(selector)) {
      dark.set(decl.prop, decl.value);
    }
  });
  root.walkComments((comment) => {
    if (!comment.text.startsWith("@earned")) return;
    if (
      comment.next()?.type !== "decl" ||
      !ROLE.test(comment.next().prop) ||
      comment.parent.selector !== ":root"
    ) {
      failures.push(
        "@earned must immediately precede a default semantic color declaration",
      );
    }
  });
  for (const [name, decl] of defaults) {
    const previous = decl.prev();
    const match =
      previous?.type === "comment" ? ANNOTATION.exec(previous.text) : null;
    if (!match) {
      failures.push(
        `${name}: record @earned modes, rule, material or pattern with a reason immediately before its default declaration. Preserve an approved name; if pattern approval is unknown, ask Morgan rather than inventing a reason or replacing the token.`,
      );
      continue;
    }
    if (
      match[1] === "modes" &&
      (!dark.has(name) || dark.get(name) === decl.value)
    ) {
      failures.push(
        `${name}: @earned modes needs different default/dark definitions. An approved same-step pattern is valid: record @earned pattern with its actual reason instead.`,
      );
    }
  }
  for (const name of dark.keys()) {
    if (!defaults.has(name))
      failures.push(`${name}: dark definition has no default semantic color`);
  }
  return failures;
}
