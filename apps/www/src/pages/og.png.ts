import { config } from "virtual:nimbus/config";
import { hero } from "@/home/variants/copy";
import { renderHomeOgCard } from "./og/_renderer";

export const prerender = true;

/** The site's card, linked from the homepage's `og:image`. */
export async function GET() {
  const png = await renderHomeOgCard({
    name: config.title,
    tagline: hero.line2,
    address: new URL(config.site).host,
  });
  return new Response(png, {
    headers: { "Content-Type": "image/png" },
  });
}
