/**
 * The shape of a content-source snapshot path, shared by the build-time
 * source module and the runtime helpers (`getEditUrl`, `getLastUpdated`)
 * that only need to recognise one. Pure: nothing here touches the disk or git.
 */

/** Project-relative folder every snapshot lives under. */
export const SOURCES_DIR = ".nimbus/sources";

const SOURCE_PATH =
  /^(?:\.\/)?\.nimbus\/sources\/([a-z0-9-]+)\/([0-9a-f]{16})\/([0-9a-f]{40})\/(.*)$/;

export interface ContentSourcePath {
  /** The source's name in `sources`. */
  name: string;
  /** The snapshot's identity: repo, configured ref and path. */
  identity: string;
  commit: string;
  /** Repository-relative file path: the sparse checkout keeps the layout. */
  path: string;
}

/**
 * Split a project-relative entry path such as
 * `.nimbus/sources/sdk/<identity>/<commit>/docs/guide.md` into its parts.
 * `undefined` for any other path.
 */
export function parseContentSourcePath(filePath: string): ContentSourcePath | undefined {
  const match = SOURCE_PATH.exec(filePath.replaceAll("\\", "/"));
  if (!match) return undefined;
  return { name: match[1]!, identity: match[2]!, commit: match[3]!, path: match[4]! };
}

export function isContentSourcePath(filePath: string): boolean {
  return parseContentSourcePath(filePath) !== undefined;
}
