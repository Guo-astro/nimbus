/**
 * The opaque `ApiModel` handle ↔ spine `DocsModel` mapping. The public `/api`
 * seam hands out handles and never exposes the IR; internal callers (the
 * citation index) unwrap here instead of widening that seam.
 */

import type { DocsModel } from "./model.js";
import type { ApiModel } from "./view-model.js";

// One store per process: a dev server can evaluate this module more than once
// (a module graph reset while an import is in flight), and a handle from one
// copy must still unwrap in another.
const MODEL_STORE = Symbol.for("@cloudflare/nimbus-docs/api-model-handles/v1");
const modelGlobals = globalThis as typeof globalThis & {
  [MODEL_STORE]?: WeakMap<object, DocsModel>;
};
const modelStore = (modelGlobals[MODEL_STORE] ??= new WeakMap<object, DocsModel>());

export function wrapModel(model: DocsModel): ApiModel {
  const handle = Object.freeze({}) as ApiModel;
  modelStore.set(handle as unknown as object, model);
  return handle;
}

export function unwrapModel(model: ApiModel): DocsModel {
  const docs = modelStore.get(model as unknown as object);
  if (!docs) {
    throw new Error(
      "Invalid ApiModel handle — pass the value returned by buildApiModel().",
    );
  }
  return docs;
}
