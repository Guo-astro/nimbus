import assert from "node:assert/strict";
import { test } from "node:test";

import { cliChangesetReasons, starterFileShips } from "./freshness-guard.mjs";

const names = { nimbusName: "@cloudflare/nimbus-docs", cliName: "@cloudflare/create-nimbus-docs" };
const manifest = {
  registryOnlyComponents: ["accordion", "api-layout"],
  registryOnlyPaths: ["src/components/react/"],
  devOnlyPaths: ["src/pages/_dev/"],
};
const reasons = (changedFiles, bumps = {}) => cliChangesetReasons({ changedFiles, bumps, manifest, ...names });

test("starter files that ship need a CLI changeset", () => {
  for (const file of [
    "packages/nimbus-starter-source/src/pages/404.astro",
    "packages/nimbus-starter-source/src/components/ui/tabs/Tabs.astro",
    "packages/nimbus-starter-source/starter.manifest.mjs",
    "packages/nimbus-starter-source/package.json",
    "packages/nimbus-starter-source/AGENT.md",
  ]) {
    assert.equal(starterFileShips(file, manifest), true, file);
    assert.equal(reasons([file]).length, 1, file);
  }
});

test("registry-only and dev-only starter files need none", () => {
  for (const file of [
    "packages/nimbus-starter-source/src/components/ui/accordion/Accordion.astro",
    "packages/nimbus-starter-source/src/components/ui/api-layout/parts/ApiBody.astro",
    "packages/nimbus-starter-source/src/components/react/diagram/Diagram.tsx",
    "packages/nimbus-starter-source/src/pages/_dev/playground.astro",
  ]) {
    assert.equal(starterFileShips(file, manifest), false, file);
    assert.deepEqual(reasons([file]), [], file);
  }
  // A component whose slug merely starts like a registry-only one still ships.
  assert.equal(starterFileShips("packages/nimbus-starter-source/src/components/ui/accordion-group/A.astro", manifest), true);
});

test("files outside the starter count only when the scaffolder bundles them", () => {
  assert.deepEqual(reasons(["packages/nimbus-docs/src/integration.ts", "apps/www/src/pages/index.astro"]), []);
  assert.equal(reasons(["packages/nimbus-docs/src/_internal/adapters.ts"]).length, 1);
});

test("a nimbus-docs minor or major bump needs a CLI changeset; a patch doesn't", () => {
  assert.equal(reasons([], { "@cloudflare/nimbus-docs": "minor" }).length, 1);
  assert.equal(reasons([], { "@cloudflare/nimbus-docs": "major" }).length, 1);
  assert.deepEqual(reasons([], { "@cloudflare/nimbus-docs": "patch" }), []);
});

test("a pending CLI changeset satisfies every reason", () => {
  assert.deepEqual(
    reasons(["packages/nimbus-starter-source/src/pages/404.astro"], {
      "@cloudflare/nimbus-docs": "minor",
      "@cloudflare/create-nimbus-docs": "patch",
    }),
    [],
  );
});

test("the real starter manifest is the default policy", () => {
  assert.equal(starterFileShips("packages/nimbus-starter-source/src/components/ui/accordion/Accordion.astro"), false);
  assert.equal(starterFileShips("packages/nimbus-starter-source/src/components/react/Diagram.tsx"), false);
  assert.equal(starterFileShips("packages/nimbus-starter-source/src/layouts/DocsLayout.astro"), true);
});
