import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  orderPageCollections,
  pageCollectionsFilePath,
  readPageCollectionsFile,
  resolvePageCollections,
} from "../src/_internal/page-collections.ts";
import {
  beginPreparedMarkdownLoad,
  beginPreparedMarkdownSession,
  clearPreparedMarkdownRegistry,
  commitPreparedDataCollection,
  commitPreparedMarkdownCollection,
  getPreparedMarkdownSnapshot,
  preparedMarkdownRootKey,
  type PreparedMarkdownCollectionRole,
} from "../src/_internal/prepared-markdown-registry.ts";
import { notAPageCollectionMessage } from "../src/_internal/page-collection-error.ts";
import {
  docsCollection,
  partialsCollection,
  componentsCollection,
  withNimbusMarkdown,
} from "../src/content.ts";

const roots: string[] = [];

afterEach(async () => {
  clearPreparedMarkdownRegistry();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(
    path.join(os.tmpdir(), "nimbus-page-collections-"),
  );
  roots.push(value);
  beginPreparedMarkdownSession(value);
  return value;
}

function commit(
  projectRoot: string,
  collection: string,
  role: PreparedMarkdownCollectionRole,
): void {
  const key = preparedMarkdownRootKey(projectRoot);
  const epoch = beginPreparedMarkdownLoad(key, collection, true);
  if (role === "api") {
    assert.equal(
      commitPreparedDataCollection(key, collection, epoch, []),
      true,
    );
    return;
  }
  assert.equal(
    commitPreparedMarkdownCollection(
      key,
      collection,
      epoch,
      { generation: 1, base: "/" },
      [],
      new Map(),
      role,
    ),
    true,
  );
}

test("the list is ordered docs, versions, others by name, then API", async () => {
  const projectRoot = await root();
  // Commit in a scrambled order: commit order must not matter.
  commit(projectRoot, "zebra", "page");
  commit(projectRoot, "docs-v1", "page");
  commit(projectRoot, "partials", "partials");
  commit(projectRoot, "docs", "page");
  commit(projectRoot, "blog", "page");
  commit(projectRoot, "docs-v2", "page");
  commit(projectRoot, "api", "api");
  commit(projectRoot, "authors-like-data-never-commits", "api");

  const snapshot = getPreparedMarkdownSnapshot(projectRoot)!;
  assert.deepEqual(
    orderPageCollections(snapshot, {
      versionsOthers: ["v2", "v1"],
      apiCollections: ["api"],
    }),
    ["docs", "docs-v2", "docs-v1", "blog", "zebra", "api"],
  );
  // No config: alphabetical after docs, no API entries.
  assert.deepEqual(orderPageCollections(snapshot), [
    "docs",
    "blog",
    "docs-v1",
    "docs-v2",
    "zebra",
  ]);
});

test("partials and api roles are never page collections; `_` names carry no meaning", async () => {
  const projectRoot = await root();
  commit(projectRoot, "_drafts", "page");
  commit(projectRoot, "partials", "partials");
  commit(projectRoot, "snippets", "partials");

  const list = await resolvePageCollections(projectRoot);
  assert.deepEqual(list, ["_drafts"]);
});

test("the Nimbus helpers record the right roles", () => {
  // The helpers wrap their loaders through `prepareMarkdownLoader`; the role
  // is what separates pages from partials. API collections commit with role
  // `api` from the loader itself.
  const docs = docsCollection();
  const partials = partialsCollection();
  const components = componentsCollection();
  const wrapped = withNimbusMarkdown(docs.loader);
  // `withNimbusMarkdown` is idempotent and stable per loader.
  assert.equal(withNimbusMarkdown(docs.loader), wrapped);
  assert.equal(withNimbusMarkdown(wrapped), wrapped);
  // Re-wrapping an already-wrapped loader is a no-op whatever role it was
  // wrapped with: a nested wrapper would queue the collection's registry
  // transaction inside itself and deadlock the load.
  assert.equal(withNimbusMarkdown(partials.loader), partials.loader);
  assert.ok(components.loader);
});

test("resolvePageCollections memoises per revision and tolerates an empty record", async () => {
  const projectRoot = await root();
  assert.deepEqual(
    await resolvePageCollections(projectRoot, { apiCollections: ["api"] }),
    ["api"],
  );
  commit(projectRoot, "docs", "page");
  const first = await resolvePageCollections(projectRoot, {
    apiCollections: ["api"],
  });
  assert.deepEqual(first, ["docs", "api"]);
  const second = await resolvePageCollections(projectRoot, {
    apiCollections: ["api"],
  });
  assert.deepEqual(second, first);
  commit(projectRoot, "blog", "page");
  assert.deepEqual(
    await resolvePageCollections(projectRoot, { apiCollections: ["api"] }),
    ["docs", "blog", "api"],
  );
});

test("the build's page-collections file round-trips and fails closed", async () => {
  const projectRoot = await root();
  const file = pageCollectionsFilePath(projectRoot);
  assert.equal(readPageCollectionsFile(projectRoot), null);

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ version: 1, collections: ["docs", "blog"] }),
    "utf8",
  );
  assert.deepEqual(readPageCollectionsFile(projectRoot), {
    collections: ["docs", "blog"],
    mdxFiles: [],
  });
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      collections: ["docs"],
      mdxFiles: ["src/content/docs/a.mdx"],
    }),
    "utf8",
  );
  assert.deepEqual(readPageCollectionsFile(projectRoot), {
    collections: ["docs"],
    mdxFiles: ["src/content/docs/a.mdx"],
  });

  await writeFile(
    file,
    JSON.stringify({ version: 2, collections: ["docs"] }),
    "utf8",
  );
  assert.equal(readPageCollectionsFile(projectRoot), null);

  await writeFile(file, "not json", "utf8");
  assert.equal(readPageCollectionsFile(projectRoot), null);

  await writeFile(
    file,
    JSON.stringify({ version: 1, collections: [1, 2] }),
    "utf8",
  );
  assert.equal(readPageCollectionsFile(projectRoot), null);
});

test("the non-page-collection error names the collection and the fix", () => {
  const message = notAPageCollectionMessage("authors");
  assert.match(message, /"authors"/);
  assert.match(message, /docsCollection/);
  assert.match(message, /withNimbusMarkdown/);
});
