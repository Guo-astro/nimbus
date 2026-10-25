import { capabilities, options } from "virtual:nimbus/agent-capabilities";
import {
  API_CATALOG_MEDIA_TYPE,
  apiCatalog,
  apiCatalogLink,
} from "./agent-api-catalog.js";
export const prerender = true;
export function GET() {
  const catalog = apiCatalog(capabilities);
  if (!catalog) return new Response(null, { status: 404 });
  return new Response(JSON.stringify(catalog, null, 2) + "\n", {
    headers: {
      "Content-Type": API_CATALOG_MEDIA_TYPE,
      "Access-Control-Allow-Origin": "*",
      Link: apiCatalogLink(options.site),
    },
  });
}
