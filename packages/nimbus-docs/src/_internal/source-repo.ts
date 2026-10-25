/**
 * Pure rules about a source's `repo` string, shared by config validation,
 * the git runner and `check`. Nimbus never holds a credential: a `repo` that
 * carries one is refused before git runs, and git's own output has any URL
 * userinfo removed before it reaches a message.
 */

const COMMIT = /^[0-9a-f]{40}$/;

/** A 40-character commit: fetched once, cached forever. */
export function isCommitRef(ref: string): boolean {
  return COMMIT.test(ref);
}

const SCHEME_URL = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
// scp-like `[user[:password]@]host:path`, no scheme.
const SCP_LIKE = /^([^/:@]+(?::[^/@]*)?)@[^/:]+:/;

/**
 * Why `repo` can't be used, or `undefined`. Refused: any userinfo in an
 * `http(s)://` URL (a token as username or password), a password in a URL of
 * any scheme, and a password in an scp-like remote. An ssh username
 * (`git@host:org/repo`, `ssh://git@host/org/repo`) is not a credential.
 */
export function repoCredentialFault(repo: string): string | undefined {
  const scheme = SCHEME_URL.exec(repo);
  if (scheme) {
    const protocol = scheme[1]!.toLowerCase();
    const authority = scheme[2]!;
    const at = authority.lastIndexOf("@");
    if (at === -1) return undefined;
    const userinfo = authority.slice(0, at);
    if (protocol === "http" || protocol === "https") return "has a username or token in the URL";
    if (userinfo.includes(":")) return "has a password in the URL";
    return undefined;
  }
  const scp = SCP_LIKE.exec(repo);
  if (scp && scp[1]!.includes(":")) return "has a password in the URL";
  return undefined;
}

/** `repo` with any userinfo replaced by `***`, for messages. */
export function redactRepo(repo: string): string {
  const scheme = SCHEME_URL.exec(repo);
  if (scheme) {
    const authority = scheme[2]!;
    const at = authority.lastIndexOf("@");
    if (at === -1) return repo;
    return `${scheme[1]}://***@${authority.slice(at + 1)}${repo.slice(scheme[0].length)}`;
  }
  const scp = SCP_LIKE.exec(repo);
  if (scp && scp[1]!.includes(":")) return `***@${repo.slice(scp[1]!.length + 1)}`;
  return repo;
}

// A URL's scheme and `//`, raw or percent-encoded, then userinfo up to `@`
// (raw or `%40`), at any length.
const URL_USERINFO =
  /(\b[a-z][a-z0-9+.-]*(?::|%3a)(?:\/\/|%2f%2f))[^\s/@]*?(?:%40|@)(?=[^\s]*)/gi;

/**
 * Text with the userinfo of every URL-shaped string removed: defence in
 * depth over git's stderr, not the guarantee (that is refusing the
 * credential in `repo`, and git keeping its own credentials to itself).
 */
export function redactUrlUserinfo(text: string): string {
  return text.replace(URL_USERINFO, (_match, prefix: string) => `${prefix}***@`);
}

/** A source or spec path: forward slashes, no leading `./` or slashes, no doubled or trailing slash. */
export function normalizeSourcePath(value: string | undefined): string {
  return (value ?? "")
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/** The `{ source, path }` form of `api[].spec`, as distinct from an inline document. */
export function isSpecFromSource(spec: unknown): spec is { source: string; path: string } {
  return (
    typeof spec === "object" &&
    spec !== null &&
    !Array.isArray(spec) &&
    typeof (spec as { source?: unknown }).source === "string" &&
    !("openapi" in spec) &&
    !("swagger" in spec)
  );
}
