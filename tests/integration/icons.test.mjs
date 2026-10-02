import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkIconManifest,
  checkIconSource,
} from "../../scripts/design-system/check-icons.mjs";
test("icon dependency policy rejects retired families and aliases", () => {
  for (const name of [
    "lucide-react",
    "@phosphor-icons/react",
    "@phosphor-icons/core",
    "react-icons",
    "@heroicons/react",
    "@mui/icons-material",
    "bootstrap-icons",
  ])
    assert.equal(
      checkIconManifest({ dependencies: { [name]: "1" } }).length,
      1,
    );
  assert.equal(
    checkIconManifest({ devDependencies: { sneaky: "npm:lucide-react@1" } })
      .length,
    1,
  );
  assert.deepEqual(
    checkIconManifest({
      dependencies: {
        "@tabler/icons-react": "3.46.0",
        "@tabler/icons": "3.46.0",
      },
    }),
    [],
  );
});
test("unlisted icon catalogs fail closed without blocking ordinary dependencies", () => {
  assert.equal(
    checkIconManifest({ dependencies: { "new-artwork-catalog": "1.0.0" } })
      .length,
    1,
  );
  assert.equal(
    checkIconSource(
      "src/probe.ts",
      'import { Mark } from "new-artwork-catalog";',
    ).length,
    1,
  );
  assert.deepEqual(checkIconManifest({ dependencies: { yaml: "1.0.0" } }), []);
  assert.deepEqual(
    checkIconSource("src/probe.ts", 'import { helper } from "yaml";'),
    [],
  );
});

test("gateway allows individual exports, never the whole catalog", () => {
  const path = "src/shared/design-system/icons/index.ts";
  assert.deepEqual(
    checkIconSource(
      path,
      'export { default as HouseIcon } from "@tabler/icons-react/dist/esm/icons/IconHome.mjs";',
    ),
    [],
  );
  assert.ok(
    checkIconSource(path, 'export * from "@tabler/icons-react";').length,
  );
});
test("real local linter rejects upstream imports outside the gateway", () => {
  for (const specifier of [
    "lucide-react",
    "lucide-react/dist/esm/icons/x.js",
    "@tabler/icons-react",
    "@tabler/icons-react/dist/esm/icons/IconX.mjs",
    "@tabler/icons/outline/x.svg?raw",
    "iconoir-react",
    "iconsax-react",
    "@radix-ui/react-icons",
    "@phosphor-icons/react",
    "@phosphor-icons/react/dist/csr/House",
    "@phosphor-icons/core/assets/regular/house.svg?raw",
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "buzz-icon-policy-"));
    const file = join(dir, "probe.ts");
    writeFileSync(
      file,
      `import { HouseIcon } from "${specifier}";\nexport { HouseIcon };\n`,
    );
    const result = spawnSync(
      "bin/pnpm",
      ["exec", "biome", "lint", "--config-path=biome.json", file],
      { encoding: "utf8" },
    );
    rmSync(dir, { recursive: true });
    assert.notEqual(result.status, 0, specifier);
    assert.match(result.stdout + result.stderr, /noRestrictedImports/);
  }
  execFileSync("bin/pnpm", [
    "exec",
    "biome",
    "lint",
    "src/shared/design-system/icons",
  ]);
});
test("icon checks are part of the normal design gate", () => {
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(scripts["design:check"], /check-icons.mjs/);
});

test("all import forms and subpaths obey the shared gateway", () => {
  const families = [
    "lucide-react/dist/esm/icons/x.js",
    "@tabler/icons-react/dist/esm/icons/IconX.mjs",
    "@tabler/icons/outline/x.svg?raw",
    "iconoir-react",
    "iconsax-react",
    "@radix-ui/react-icons",
    "@mui/icons-material/Add",
    "bootstrap-icons/icons/alarm.svg",
    "@phosphor-icons/react/dist/csr/House",
  ];
  for (const specifier of families) {
    for (const source of [
      `import { X } from "${specifier}";`,
      `export { X } from "${specifier}";`,
      `export * from "${specifier}";`,
      `import "${specifier}";`,
      `const X = require /* comment */ ("${specifier}");`,
      `const X = import("${specifier}");`,
      `import X = require("${specifier}");`,
    ])
      assert.ok(checkIconSource("src/probe.ts", source).length, source);
  }
  for (const path of [
    "src/shared/design-system/icons/index.ts",
    "src/shared/design-system/icons/legacy.cjs",
  ]) {
    for (const source of [
      'const icons = require("@tabler/icons-react");',
      'const icons = import("@tabler/icons-react");',
      'export * from "./other";',
    ])
      assert.ok(checkIconSource(path, source).length, source);
  }
  assert.deepEqual(
    checkIconSource(
      "src/probe.ts",
      `// require("lucide-react")
const example = 'import { X } from "lucide-react";';`,
    ),
    [],
  );
});
test("other known families and aliases cannot reintroduce a second catalog", () => {
  for (const name of [
    "iconoir-react",
    "iconsax-react",
    "@radix-ui/react-icons",
  ])
    assert.ok(checkIconManifest({ dependencies: { [name]: "1.0.0" } }).length);
  assert.ok(
    checkIconManifest({
      dependencies: { "@tabler/icons-react": "npm:lucide-react@1.0.0" },
    }).length,
  );
});

test("syntax-aware inspection handles templates, JSX and regexes", () => {
  for (const source of [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: parser fixture, not evaluated text.
    'const label = `Hello ${name}`; const icons = require("lucide-react");',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: parser fixture, not evaluated text.
    'const label = `Hello ${require("lucide-react")}`;',
    'const view = <span>from "lucide-react"</span>; const icons = require("lucide-react");',
  ])
    assert.ok(checkIconSource("src/probe.tsx", source).length, source);
  for (const source of [
    'const pattern = /require("lucide-react")/;',
    'const view = <span>import "lucide-react"</span>;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: parser fixture, not evaluated text.
    'const label = `from "lucide-react" ${name}`;',
  ])
    assert.deepEqual(checkIconSource("src/probe.tsx", source), [], source);
});

test("gateway permits asset modules and type-only barrel imports, not runtime catalogs", () => {
  const path = "src/shared/design-system/icons/probe.ts";
  assert.deepEqual(
    checkIconSource(
      path,
      'import type { TablerIcon } from "@tabler/icons-react";',
    ),
    [],
  );
  assert.deepEqual(
    checkIconSource(path, 'import x from "@tabler/icons/outline/x.svg?raw";'),
    [],
  );
  for (const source of [
    'import { IconHome } from "@tabler/icons-react";',
    'import * as icons from "@tabler/icons-react";',
    'import icons from "@tabler/icons/tabler-nodes-outline.json";',
    'import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";',
  ])
    assert.ok(checkIconSource(path, source).length, source);
});
