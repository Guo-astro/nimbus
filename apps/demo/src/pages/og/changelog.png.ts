import { CHANGELOG_TITLE } from "@/components/changelog/changelog";
import { renderPageCard } from "./_card";

export const prerender = true;

export async function GET() {
  return new Response(await renderPageCard({ title: CHANGELOG_TITLE }), {
    headers: { "Content-Type": "image/png" },
  });
}
