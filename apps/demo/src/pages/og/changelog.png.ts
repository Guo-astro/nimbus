import { renderPageCard } from "./_card";

export const prerender = true;

export async function GET() {
  return new Response(await renderPageCard({ title: "Changelog" }), {
    headers: { "Content-Type": "image/png" },
  });
}
