/**
 * nimbus-docs.com's release history: every version in the packages'
 * CHANGELOG.md files that has a release tag, dated from the tag. Read once at
 * build, from the repo; no network.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Loader } from "astro/loaders";
import { fromHtml } from "hast-util-from-html";
import { defaultSchema, sanitize } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import { markdownToMdast } from "satteri";

/** The packages, in the order their same-moment releases are listed. */
export const PACKAGES = ["nimbus-docs", "create-nimbus-docs"] as const;
export type PackageName = (typeof PACKAGES)[number];

export interface ParsedRelease {
  package: PackageName;
  version: string;
  /** The release's notes, its headings one level up (`### Patch Changes` → `##`). */
  body: string;
}

export interface Release extends ParsedRelease {
  id: string;
  title: string;
  /** When the release was tagged; unset when the build has no tags. */
  date?: Date;
}

/** A release heading: `## 0.18.1`, or a pre-release such as `## 1.0.0-next.2`. */
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.]{1,40})?$/;

/**
 * The releases in a package's CHANGELOG.md, in file order: each top-level
 * `## <version>` heading, as the site's Markdown parser reads the file, up to
 * the next one. The section's own headings move up a level so a release's
 * page lists them as its sections.
 */
export function parseChangelog(pkg: PackageName, markdown: string): ParsedRelease[] {
  const nodes = ((markdownToMdast(markdown) as { children?: unknown[] }).children ?? []) as Array<{
    type: string;
    depth?: number;
    children?: Array<{ type: string; value?: string }>;
    position?: { start: { offset: number }; end: { offset: number } };
  }>;
  const versionOf = (node: (typeof nodes)[number]) => {
    const text = node.children?.length === 1 && node.children[0]!.type === "text" ? node.children[0]!.value! : "";
    return VERSION.test(text) ? text : undefined;
  };
  const starts = nodes.flatMap((node, index) =>
    node.type === "heading" && node.depth === 2 && versionOf(node) ? [index] : [],
  );
  return starts.map((at, i) => {
    const heading = nodes[at]!;
    const next = starts[i + 1] === undefined ? undefined : nodes[starts[i + 1]!]!;
    const start = heading.position!.end.offset;
    const end = next ? next.position!.start.offset : markdown.length;
    // Section headings are ATX (`### Patch Changes`): drop one `#` from each.
    let body = "";
    let from = start;
    for (const node of nodes.slice(at + 1, starts[i + 1] ?? nodes.length)) {
      if (node.type !== "heading" || (node.depth ?? 0) < 3) continue;
      const offset = node.position!.start.offset;
      const hash = markdown.indexOf("#", offset);
      body += markdown.slice(from, hash);
      from = hash + 1;
    }
    body += markdown.slice(from, end);
    return { package: pkg, version: versionOf(heading)!, body: body.trim() };
  });
}

/** `@cloudflare/<package>@<version>` tag dates, from `git for-each-ref` output. */
export function parseTagDates(output: string): Map<string, Date> {
  const dates = new Map<string, Date>();
  for (const line of output.split("\n")) {
    const match = line.match(/^@cloudflare\/(\S+@\S+) (\S+)$/);
    if (match) dates.set(match[1]!, new Date(match[2]!));
  }
  return dates;
}

const compareVersions = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
};

/**
 * Releases newest first. With tags, a version is listed only if it was
 * tagged (released); ties put nimbus-docs first, then the higher version.
 * Without any tags (a shallow preview build), every version is listed
 * undated, in file order, nimbus-docs first.
 */
export function orderReleases(parsed: ParsedRelease[], tags: Map<string, Date>): Release[] {
  const named = (release: ParsedRelease, date?: Date): Release => ({
    ...release,
    id: `${release.package}-${release.version.replace(/\./g, "-")}`,
    title: `${release.package} ${release.version}`,
    ...(date ? { date } : {}),
  });
  const rank = (pkg: PackageName) => PACKAGES.indexOf(pkg);
  if (tags.size === 0) {
    return parsed.map((release) => named(release)).sort((a, b) => rank(a.package) - rank(b.package));
  }
  return parsed
    .flatMap((release) => {
      const date = tags.get(`${release.package}@${release.version}`);
      return date ? [named(release, date)] : [];
    })
    .sort(
      (a, b) =>
        b.date!.getTime() - a.date!.getTime() ||
        rank(a.package) - rank(b.package) ||
        compareVersions(b.version, a.version),
    );
}

/** Every release, read from the repo at `root`. */
export function readReleases(root: URL): Release[] {
  const parsed = PACKAGES.flatMap((pkg) =>
    parseChangelog(pkg, readFileSync(new URL(`packages/${pkg}/CHANGELOG.md`, root), "utf8")),
  );
  let refs = "";
  try {
    refs = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short) %(creatordate:iso-strict)", "refs/tags/@cloudflare/"],
      { cwd: root, encoding: "utf8" },
    );
  } catch {}
  const tags = parseTagDates(refs);
  if (tags.size === 0) console.warn("[changelog] No release tags in this checkout: releases are listed undated.");
  return orderReleases(parsed, tags);
}

/**
 * The `releases` collection: one entry per release, its notes rendered with
 * the site's Markdown processor. `order` is its place, newest first.
 */
/**
 * Release notes come from changeset files any contributor writes, so their
 * HTML goes through GitHub's allowlist: no scripts, event handlers or
 * `javascript:` links. Ids keep the allowlist's `user-content-` prefix except
 * on headings, which keep the ids "On this page" links to.
 */
export function safeHtml(html: string): string {
  const tree = sanitize(fromHtml(html, { fragment: true }), defaultSchema);
  const visit = (node: { type: string; tagName?: string; properties?: Record<string, unknown>; children?: unknown[] }) => {
    const id = node.properties?.id;
    if (node.type === "element" && /^h[1-6]$/.test(node.tagName!) && typeof id === "string") {
      node.properties!.id = id.replace(/^user-content-/, "");
    }
    for (const child of node.children ?? []) visit(child as typeof node);
  };
  visit(tree as never);
  return toHtml(tree);
}

export function releasesLoader(root: URL): Loader {
  return {
    name: "nimbus-releases",
    load: async ({ store, parseData, renderMarkdown }) => {
      store.clear();
      for (const [order, release] of readReleases(root).entries()) {
        const data = await parseData({
          id: release.id,
          data: {
            title: release.title,
            package: release.package,
            version: release.version,
            order,
            ...(release.date ? { date: release.date } : {}),
          },
        });
        const rendered = await renderMarkdown(release.body);
        store.set({ id: release.id, data, body: release.body, rendered: { ...rendered, html: safeHtml(rendered.html) } });
      }
    },
  };
}
