/**
 * The mount context a build recorded, from a project root as a path or
 * Astro's `root` URL. Node-only, for build code that knows the root as a path.
 */

import { pathToFileURL } from "node:url";

import { getMountContext, type MountContext } from "./collection-mount.js";

export function projectMountContext(root: URL | string): MountContext {
  if (root instanceof URL) return getMountContext(root);
  const url = pathToFileURL(root);
  return getMountContext(new URL(url.href.endsWith("/") ? url.href : `${url.href}/`));
}
