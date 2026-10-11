import {
  getAgentEndpointAssetManifest,
  registerAgentEndpointAssetDemand,
  readLlmsEndpointPayload,
  readMarkdownEndpointPayload,
} from "./_internal/agent-endpoint-assets.js";
import type {
  PreparedLlmsArtifact,
  PreparedLlmsReference,
  PreparedMarkdownArtifact,
  PreparedMarkdownReference,
  PreparedMarkdownSurface,
} from "./types.js";
import { entryRouteKey } from "./_internal/astro-slug.js";

export type {
  PreparedLlmsArtifact,
  PreparedLlmsReference,
  PreparedMarkdownArtifact,
  PreparedMarkdownReference,
  PreparedMarkdownSurface,
} from "./types.js";

const projectRoot: unknown =
  typeof import.meta.env === "object"
    ? import.meta.env.NIMBUS_PROJECT_ROOT
    : undefined;

if (typeof projectRoot === "string" && projectRoot.length > 0) {
  registerAgentEndpointAssetDemand(projectRoot);
}

function configuredRoot(): string {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error(
      "nimbus-docs: build helpers require the Nimbus Astro integration.",
    );
  }
  return projectRoot;
}

/** @deprecated Use `getMarkdownStaticPaths` from `@cloudflare/nimbus-docs/agent-endpoints`; route props use `reference` instead of `artifact`. */
export async function getPreparedMarkdownStaticPaths(options: {
  collection: string;
  surface: PreparedMarkdownSurface;
}): Promise<
  Array<{
    params: { slug: string | undefined };
    props: { artifact: PreparedMarkdownReference };
    cacheKey: string;
  }>
> {
  const manifest = await getAgentEndpointAssetManifest(configuredRoot());
  return manifest.markdownAssets
    .filter(
      (artifact) =>
        artifact.collection === options.collection &&
        artifact.surface === options.surface,
    )
    .map((artifact) => ({
      params: { slug: entryRouteKey(artifact.id) || undefined },
      props: {
        artifact: {
          collection: artifact.collection,
          id: artifact.id,
          surface: artifact.surface,
        },
      },
      cacheKey: artifact.digest,
    }));
}

/** @deprecated Use `getMarkdownPayload` from `@cloudflare/nimbus-docs/agent-endpoints`. */
export function getPreparedMarkdownArtifact(
  reference: PreparedMarkdownReference,
): Promise<PreparedMarkdownArtifact> {
  return readMarkdownEndpointPayload(configuredRoot(), reference);
}

/** @deprecated Use `getLlmsStaticPaths` from `@cloudflare/nimbus-docs/agent-endpoints`; route props use `reference` instead of `artifact`. */
export async function getPreparedLlmsStaticPaths(): Promise<
  Array<{
    params: { section: string };
    props: { artifact: PreparedLlmsReference };
    cacheKey: string;
  }>
> {
  const manifest = await getAgentEndpointAssetManifest(configuredRoot());
  return manifest.llmsAssets
    .filter(
      (
        artifact,
      ): artifact is Extract<
        (typeof manifest.llmsAssets)[number],
        { scope: "section" }
      > => artifact.scope === "section" && artifact.surface === "index",
    )
    .map((artifact) => ({
      params: { section: artifact.section },
      props: {
        artifact: {
          scope: "section",
          surface: "index",
          section: artifact.section,
        },
      },
      cacheKey: artifact.digest,
    }));
}

/** @deprecated Use `getLlmsPayload` from `@cloudflare/nimbus-docs/agent-endpoints`. */
export function getPreparedLlmsArtifact(
  reference: PreparedLlmsReference,
): Promise<PreparedLlmsArtifact> {
  return readLlmsEndpointPayload(configuredRoot(), reference) as Promise<PreparedLlmsArtifact>;
}
