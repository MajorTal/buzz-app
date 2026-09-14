import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";
import { authoringFindings, compareBaseline } from "./authoring-rules.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const current = [];
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (
      entry.isFile() &&
      /\.(css|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.tsx$/.test(entry.name)
    ) {
      const file = relative(root, path).replaceAll("\\", "/");
      current.push(
        ...authoringFindings(file, readFileSync(path, "utf8")).map(
          (finding) => ({ file, ...finding }),
        ),
      );
    }
  }
}
scan(resolve(root, "src"));
scan(resolve(root, "tests/fixtures/design-system"));
const baseline = JSON.parse(
  readFileSync(new URL("./authoring-baseline.json", import.meta.url), "utf8"),
);
const errors = compareBaseline(current, baseline);
if (errors.length) {
  console.error(errors.join("\n"));
  console.error(
    "Use shared tokens/type roles/component variants. Different light/dark steps belong in a semantic token, never a local override. Preserve approved patterns and record their @earned reason beside the token. Ask when approval is unknown. Do not refresh the legacy baseline to pass. See src/shared/design-system/AGENTS.md.",
  );
  process.exitCode = 1;
} else {
  console.log(
    `✓ Authoring: no new violations; ${baseline.length} exact legacy findings retained`,
  );
}
