/**
 * The injected clean-Markdown route for a mounted collection
 * (`/<mount>/[...slug]/index.md`). Injected by the integration when the
 * rendering policy is set and the project has no route file at the pattern,
 * with `prerender` following the collection's rendering mode. The shared
 * factory serves only the asset URLs this route's own pattern matches, so
 * one module serves every mount.
 */
import { markdownRoute } from "../agent-endpoints.js";

export const { GET, getStaticPaths } = markdownRoute();
