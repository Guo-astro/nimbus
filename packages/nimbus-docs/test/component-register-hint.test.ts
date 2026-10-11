import assert from "node:assert/strict";
import { test } from "node:test";

import { registerHint } from "../src/cli/component.js";
import type { ComponentItem } from "../src/cli/resolver.js";

function ui(name: string, exports: string): ComponentItem {
  return {
    name,
    type: "registry:ui",
    title: name,
    description: name,
    dependencies: [],
    registryDependencies: [],
    files: [{ path: `components/ui/${name}/index.ts`, content: `export { ${exports} } from "./${name}.astro";\n` }],
  };
}

test("add hints registration only for the component that was asked for", () => {
  const hint = registerHint([ui("tabs", "Tabs, TabItem"), ui("icon", "Icon")], "tabs", "src");
  assert.match(hint ?? "", /import \{ Tabs, TabItem \} from "\.\/components\/ui\/tabs"/);
  assert.doesNotMatch(hint ?? "", /icon/i);
  assert.equal(registerHint([ui("icon", "Icon")], "tabs", "src"), null);
});

test("an item's own next step replaces the components.ts hint", () => {
  const layout = { ...ui("api-layout", "ApiLayout"), docs: "API pages need a route: create src/pages/api/[...slug].astro." };
  assert.equal(registerHint([layout], "api-layout", "src"), layout.docs);
  assert.match(registerHint([ui("badge", "Badge")], "badge", "src") ?? "", /register in src\/components\.ts/);
});
