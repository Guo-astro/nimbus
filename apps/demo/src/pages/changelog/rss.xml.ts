/** /changelog/rss.xml — the changelog's RSS feed, newest release first. */
import rss from "@astrojs/rss";
import { withBase } from "@cloudflare/nimbus-docs/runtime";
import { config } from "virtual:nimbus/config";
import { CHANGELOG_TITLE, getReleaseIndex, releaseHref } from "@/components/changelog/release";

export const prerender = true;

export async function GET() {
  const url = (path: string) => new URL(withBase(path, import.meta.env.BASE_URL), config.site).href;
  const { releases } = await getReleaseIndex();
  return rss({
    title: `${config.title} ${CHANGELOG_TITLE}`,
    description: config.description ?? CHANGELOG_TITLE,
    site: url("/changelog/"),
    xmlns: { atom: "http://www.w3.org/2005/Atom" },
    customData:
      `<language>${config.locale ?? "en"}</language>` +
      `<atom:link href="${url("/changelog/rss.xml")}" rel="self" type="application/rss+xml"/>`,
    items: releases.map((entry) => ({
      title: entry.data.title,
      link: url(releaseHref(entry)),
      pubDate: entry.data.date,
      description: entry.data.description,
      categories: entry.data.tags,
    })),
  });
}
