import type { APIRoute } from "astro";
import { capabilities, options } from "virtual:nimbus/agent-capabilities";
import { markdownAssets, pageIndex } from "virtual:nimbus/agent-endpoint-assets";
import { readStagedAsset } from "../staged-asset-reader.js";
import { createDocsMcpHandler, type DocsMcpHandler } from "./handler.js";
import { mcpServerIdentity } from "./identity.js";
import type { McpPageIndex } from "./page-index.js";

export const prerender = false;

const ASSET_PREFIX = "_nimbus/agent-endpoint-assets/";
const markdownByPath = new Map(
  markdownAssets
    .filter((asset) => asset.surface === "markdown")
    .map((asset) => [asset.url, asset] as const),
);
let index: Promise<McpPageIndex> | undefined;
let handler: DocsMcpHandler | undefined;

function docsMcpHandler(): DocsMcpHandler {
  handler ??= createDocsMcpHandler({
    identity: mcpServerIdentity({
      site: options.site,
      base: options.base,
      title: options.title,
      version: options.nimbusVersion ?? "0.0.0",
      endpointUrl: capabilities.mcpUrl,
    }),
    base: options.base,
    source: {
      readIndex(request) {
        index ??= readStagedAsset(`${ASSET_PREFIX}${pageIndex.path}`, { request })
          .then((body) => JSON.parse(body) as McpPageIndex)
          .catch((error: unknown) => {
            index = undefined;
            throw error;
          });
        return index;
      },
      async readPage(record, request) {
        const asset = markdownByPath.get(record.markdownPath);
        if (!asset) return null;
        const body = await readStagedAsset(`${ASSET_PREFIX}${asset.path}`, { request });
        return body.slice(asset.contentStart, asset.contentEnd);
      },
    },
  });
  return handler;
}

export const ALL: APIRoute = ({ request }) => {
  if (!capabilities.mcpUrl) return new Response("Not found", { status: 404 });
  return docsMcpHandler().fetch(request);
};
