/**
 * The injected authored-source route for a mounted collection
 * (`/<mount>/[...slug]/index.mdx`). See `mounted-markdown-route.ts`; entries
 * without an authored body (API pages) emit nothing and 404 on request.
 */
import { markdownSourceRoute } from "../agent-endpoints.js";

export const { GET, getStaticPaths } = markdownSourceRoute();
