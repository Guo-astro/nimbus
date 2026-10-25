// `navStateScript` is `restoreNavState` serialized into an inline script, so it
// must parse on its own and reference nothing but browser globals. A bundler
// helper or an import leaking into the function body would only fail in a
// reader's browser; this pins it at test time.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { navStateScript } from "../src/runtime.ts";
import { NAV_STATE_KEYS } from "../src/client/nav-sidebar.ts";

test("the inline sidebar-state script is self-contained and runs against an empty page", () => {
  assert.doesNotThrow(() => new vm.Script(navStateScript), "parses as a classic script");
  assert.doesNotMatch(navStateScript, /<\/script|<!--/i, "safe inside an inline <script>");
  assert.ok(
    navStateScript.includes(JSON.stringify(NAV_STATE_KEYS)),
    "carries the shared storage keys",
  );

  const listeners: string[] = [];
  const window: Record<string, unknown> = {};
  const context = vm.createContext({
    window,
    sessionStorage: { getItem: () => null },
    requestAnimationFrame: () => 0,
    HTMLElement: class {},
    SVGElement: class {},
    document: {
      querySelectorAll: () => [],
      addEventListener: (name: string) => listeners.push(name),
    },
  });
  vm.runInContext(navStateScript, context);
  vm.runInContext(navStateScript, context);
  assert.deepEqual(listeners, ["astro:after-swap"], "binds the swap listener once");
});
