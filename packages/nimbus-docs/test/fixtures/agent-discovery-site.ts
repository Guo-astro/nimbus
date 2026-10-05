import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import nimbus from "../../src/index.js";
import { runningNimbusVersion } from "../../src/_internal/upgrades.js";

export async function discoveryFixture(
  rootContent?: string,
  collection = "docs",
  withApi = false,
  skills?: Record<string, string>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "nimbus-discovery-"));
  const write = async (file: string, body: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  };
  const content = pathToFileURL(
    path.resolve(import.meta.dirname, "../../src/content.ts"),
  ).href;
  const endpoints = pathToFileURL(
    path.resolve(import.meta.dirname, "../../src/agent-endpoints.ts"),
  ).href;
  await symlink(
    path.resolve(import.meta.dirname, "../../node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  await write("package.json", '{"type":"module"}');
  await write(
    "nimbus.json",
    JSON.stringify({ lastReviewedNimbusVersion: runningNimbusVersion() }),
  );
  await write(
    "src/content.config.ts",
    `import { defineCollection } from "astro:content"; import { docsCollection, apiCollection } from ${JSON.stringify(content)};\nexport const collections = { ${collection}: defineCollection(docsCollection({ base: "${collection}" }))${withApi ? ", pets: defineCollection(apiCollection())" : ""} };`,
  );
  await write(
    `src/content/${collection}/guide.mdx`,
    "---\ntitle: Guide\n---\n## Start\nHello discovery.",
  );
  if (rootContent)
    await write(`src/content/${collection}/index.mdx`, rootContent);
  for (const [file, body] of Object.entries(skills ?? {}))
    await write(`skills/${file}`, body);
  await write(
    "src/pages/index.astro",
    '---\nAstro.response.headers.set("Link", \'<https://example.net/help>; rel="help"\');\n---\n<html><head><title>Home</title></head><body>Owner homepage</body></html>',
  );
  await write(
    "src/pages/llms.txt.ts",
    `import { llmsRoute } from ${JSON.stringify(endpoints)}; export const prerender = true; export const { GET } = llmsRoute();`,
  );
  await write(
    "src/pages/[...slug]/index.md.ts",
    `import { markdownRoute } from ${JSON.stringify(endpoints)}; export const prerender = true; export const { GET, getStaticPaths } = markdownRoute();`,
  );
  await write(
    "public/_headers",
    '/custom\n  X-Owner: unchanged\n/docs/\n  Link: <https://example.net/help>; rel="help"',
  );
  const config = {
    root: pathToFileURL(root + path.sep),
    configFile: false as const,
    logLevel: "silent" as const,
    base: "/docs",
    integrations: [
      nimbus(
        {
          site: "https://example.test",
          title: "Example",
          search: false,
          ...(withApi
            ? {
                api: [
                  {
                    collection: "pets",
                    spec: path.resolve(import.meta.dirname, "api/smallco.yaml"),
                  },
                ],
              }
            : {}),
        },
        { sitemap: false, icons: false, validateMdx: false },
      ),
    ],
  };
  return {
    root,
    config,
    write,
    read: (file: string) => readFile(path.join(root, file), "utf8"),
    readBytes: (file: string) => readFile(path.join(root, file)),
  };
}
