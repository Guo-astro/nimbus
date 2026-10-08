/**
 * Cross-version alternates for API families — the coordinate-identity axis.
 *
 * Where the docs axis (`../version-alternates.ts`) links pages by slug equality
 * plus author-declared `previousSlug` edges, an API family links pages by a
 * structural key it already owns: the **operation coordinate**. Same
 * `operationId` in two versions ⇒ the same logical operation ⇒ one equivalence
 * class. No heuristics, no author annotation — the linking is deterministic.
 *
 * Identity comes first: same `operationId` in two versions is one class, and
 * an `operationId` match is never overridden. When an id is missing from
 * another version, a **method-and-path fallback** pairs operations whose wire
 * shape (`operationShape`: lowercased method, parameter-name-blind path)
 * matches — only when the pairing is unambiguous between that pair of
 * versions, and only when merging every such candidate stays consistent. The
 * matching is two-phase (collect candidates for every version pair, then
 * merge with union-find and discard any contradictory connected component),
 * so the result cannot depend on the order versions are configured in. An
 * ambiguous or competing pairing stays unmatched and goes to the version
 * landing, as before: the picker never guesses.
 *
 * Runs once at `astro:config:setup` and reads the spec files directly (via
 * `projectRoot`), never the content layer — so it does not depend on the
 * virtual config module that has not been built yet at that point. The output
 * merges into the same `VersionAlternatesTable` the docs axis produces; keys
 * carry the `family@version` version key, kept disjoint from docs keys by the
 * `@` (which assumes docs version slugs stay `@`-free).
 */

import type { ApiSpec } from "../../types.js";
import type {
  VersionAlternatesTable,
  VersionPageRef,
} from "../version-alternates.js";

/** Build the alternates table for every versioned API family. */
export async function buildApiVersionAlternates(
  api: ApiSpec[] | undefined,
  projectRoot: string,
): Promise<VersionAlternatesTable> {
  const families = (api ?? []).filter(
    (e) => e.versions && e.versions.length > 1,
  );
  if (families.length === 0) return {};

  const { pageUrl, resolveApiFamily } = await import("./resolve-versions.js");
  const { resolveSpecSource } = await import("./resolve-spec.js");
  const { buildApiModel, getApiPageSlugs } = await import("../../api/index.js");
  const { operationShapes } = await import("./view-model.js");
  const { unwrapModel } = await import("./model-handle.js");

  const table: VersionAlternatesTable = {};

  for (const entry of families) {
    const targets = resolveApiFamily(entry);
    const defaultVersion = targets.find((t) => t.isDefault)!.version!;
    const hiddenVersions = new Set(
      targets.filter((t) => t.hidden).map((t) => t.version!),
    );
    const versionOrder = new Map(targets.map((t, i) => [t.version!, i]));

    // Group every page across every version by its coordinate, and keep
    // each version's operation wire shapes for the fallback matcher.
    const byCoordinate = new Map<string, VersionPageRef[]>();
    const shapesByVersion = new Map<string, Map<string, string>>();
    for (const target of targets) {
      let model;
      try {
        const source = await resolveSpecSource(
          {
            collection: target.namespace,
            spec: target.spec,
            label: target.label,
            mountPath: target.mountPath,
            requireOperationId: target.requireOperationId,
            schemaPages: target.schemaPages,
            routes: target.routes,
            samples: target.samples,
          },
          projectRoot,
        );
        model = await buildApiModel(source);
      } catch (err) {
        // Runs at config:setup, before the loader's try/catch — match its context.
        throw new Error(
          `nimbus-docs: failed to build the API reference for "${target.label}" while computing cross-version alternates:\n${(err as Error).message}`,
          { cause: err },
        );
      }
      shapesByVersion.set(target.version!, operationShapes(unwrapModel(model)));
      for (const { coordinate, slug } of getApiPageSlugs(model)) {
        const ref: VersionPageRef = {
          collection: target.versionKey,
          version: target.version!,
          slug: coordinate,
          url: pageUrl(target, slug),
        };
        const bucket = byCoordinate.get(coordinate);
        if (bucket) bucket.push(ref);
        else byCoordinate.set(coordinate, [ref]);
      }
    }

    // ---- Method-and-path fallback, two phases. -------------------------
    //
    // Phase 1 — candidates, computed against the exact-id classes only. For
    // every pair of versions (A, B), an operation is eligible when its class
    // has a member in one version and none in the other (eligibility is
    // about the pair, not class size, so `{v2:new, v3:new}` can gain
    // `v1:old`). A candidate joins the two classes where exactly one
    // eligible operation on each side has the wire shape. Every candidate is
    // collected before anything merges, so no candidate can see another's
    // result.
    //
    // Phase 2 — merge consistently. Union every candidate (union-find); a
    // resulting class holding two operations from one version is a
    // contradiction, and every fallback candidate in that connected
    // component is discarded — its exact-id classes stand unchanged. Exact-
    // id classes are never split: the fallback only adds versions to a
    // class.
    const classVersions = new Map<string, Set<string>>();
    for (const [coordinate, refs] of byCoordinate) {
      classVersions.set(coordinate, new Set(refs.map((ref) => ref.version)));
    }
    const versionIds = targets.map((t) => t.version!);
    const candidates: Array<[string, string]> = [];
    for (let i = 0; i < versionIds.length; i++) {
      for (let j = i + 1; j < versionIds.length; j++) {
        const a = versionIds[i]!;
        const b = versionIds[j]!;
        const eligible = (side: string, other: string) => {
          // Walk only this version's operations, never every class.
          const byShape = new Map<string, string[]>();
          for (const [coordinate, shape] of shapesByVersion.get(side) ?? []) {
            if (classVersions.get(coordinate)?.has(other)) continue;
            const bucket = byShape.get(shape);
            if (bucket) bucket.push(coordinate);
            else byShape.set(shape, [coordinate]);
          }
          return byShape;
        };
        const sideA = eligible(a, b);
        const sideB = eligible(b, a);
        for (const [shape, inA] of sideA) {
          const inB = sideB.get(shape);
          if (inA.length === 1 && inB?.length === 1) {
            candidates.push([inA[0]!, inB[0]!]);
          }
        }
      }
    }

    // Union by size with full path compression keeps every chain short, so
    // a long contradictory component stays near-linear to collect.
    const parent = new Map<string, string>();
    const size = new Map<string, number>();
    const find = (key: string): string => {
      let root = key;
      while (parent.has(root) && parent.get(root) !== root) {
        root = parent.get(root)!;
      }
      for (let node = key; node !== root; ) {
        const next = parent.get(node)!;
        parent.set(node, root);
        node = next;
      }
      return root;
    };
    const union = (a: string, b: string) => {
      let ra = find(a);
      let rb = find(b);
      if (ra === rb) return;
      if ((size.get(ra) ?? 1) > (size.get(rb) ?? 1)) [ra, rb] = [rb, ra];
      parent.set(ra, rb);
      size.set(rb, (size.get(ra) ?? 1) + (size.get(rb) ?? 1));
    };
    for (const [a, b] of candidates) union(a, b);

    const components = new Map<string, string[]>();
    for (const key of new Set(candidates.flat())) {
      const root = find(key);
      const members = components.get(root);
      if (members) members.push(key);
      else components.set(root, [key]);
    }
    const mergedClasses: VersionPageRef[][] = [];
    const absorbed = new Set<string>();
    for (const members of components.values()) {
      const seen = new Set<string>();
      let contradiction = false;
      for (const coordinate of members) {
        for (const version of classVersions.get(coordinate) ?? []) {
          if (seen.has(version)) {
            contradiction = true;
            break;
          }
          seen.add(version);
        }
        if (contradiction) break;
      }
      if (contradiction) continue;
      const refs = members.flatMap(
        (coordinate) => byCoordinate.get(coordinate) ?? [],
      );
      mergedClasses.push(refs);
      for (const coordinate of members) absorbed.add(coordinate);
    }
    const finalClasses: VersionPageRef[][] = [
      ...mergedClasses,
      ...[...byCoordinate]
        .filter(([coordinate]) => !absorbed.has(coordinate))
        .map(([, refs]) => refs),
    ];

    // Emit one record per page. Canonical is the default-version member (API's
    // equivalent of the docs "current"); alternates exclude hidden versions.
    for (const refs of finalClasses) {
      refs.sort(
        (a, b) => versionOrder.get(a.version)! - versionOrder.get(b.version)!,
      );
      const canonicalRef =
        refs.find((r) => r.version === defaultVersion) ?? null;
      for (const self of refs) {
        const alternates = refs.filter(
          (m) => m !== self && !hiddenVersions.has(m.version),
        );
        const canonical =
          canonicalRef && canonicalRef !== self ? canonicalRef : null;
        table[`${self.collection}:${self.slug}`] = {
          self,
          alternates,
          canonical,
        };
      }
    }
  }

  return table;
}
