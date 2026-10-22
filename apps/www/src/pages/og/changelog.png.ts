import { renderDocsOgCard } from "./_renderer";

export async function GET() {
  return new Response(await renderDocsOgCard({ section: "Releases", title: "Changelog" }), {
    headers: { "Content-Type": "image/png" },
  });
}
