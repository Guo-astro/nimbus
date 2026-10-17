import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";

const nimbusConfig = defineNimbusConfig({
  site: "https://nimbus-docs.com",
  title: "Nimbus",
  description: "Docs for the agentic web.",
  locale: "en",
  github: "https://github.com/cloudflare/nimbus",
  socialImageAlt: "Nimbus documentation preview",
  editPattern: "https://github.com/cloudflare/nimbus/edit/main/apps/www/{path}",
  // The sidebar follows the content tree: each top-level folder's index.mdx
  // names its group and its place (sidebar.group, sidebar.order).
  sidebar: {
    indexDisplay: "overview-leaf",
    defaultCollapsed: true,
    items: [
      { autogenerate: { collection: "docs" } },
      { label: "Components", icon: "ph:puzzle-piece", autogenerate: { collection: "components" } },
    ],
  },
});

// Pages that moved when the docs were reorganized by task. Each old URL
// reaches its new page in one hop; public/_redirects adds the `/old/` forms
// and the Markdown versions.
const moved = {
  "/get-started": "/start-here/quickstart",
  "/installation": "/start-here/quickstart",
  "/project-structure": "/start-here/project-structure",
  "/philosophy": "/start-here/why-nimbus",
  "/api-reference": "/writing/openapi",
  "/partial-builds": "/publish/partial-builds",
  "/adding-components": "/styling/add-components",
  "/ai/metadata-and-seo": "/publish/metadata-and-seo",
  "/writing/frontmatter": "/reference/frontmatter",
  "/configuration": "/reference/configuration",
  "/cli": "/reference/cli",
  "/registry": "/reference/registry",
  "/writing/recipes": "/style-guide",
  ...Object.fromEntries(
    ["overview", "quickstart", "tutorial", "how-to", "concept", "reference", "example", "troubleshooting", "changelog"].map(
      (type) => [`/writing/recipes/${type}`, `/style-guide/${type}`],
    ),
  ),
};

export default defineConfig({
  output: "static",
  redirects: Object.fromEntries(Object.entries(moved).map(([from, to]) => [from, { status: 301, destination: to }])),
  integrations: [react(), nimbus(nimbusConfig, { markdown: { hastPlugins: [tableScroll()] } })],
  vite: {
    // Tailwind v4 via its Vite plugin (replaces the PostCSS plugin, which
    // doesn't build under Astro 7's Vite 8 bundler).
    plugins: [tailwindcss()],
    // Dedupe React across the module graph. In dev, Vite serves modules
    // individually and a separate React instance can sneak in via
    // pre-bundled deps (framer-motion, @astrojs/react renderer, our card
    // components) — surfaces as "Invalid hook call" in the SSR log. Forcing
    // single resolution fixes it.
    resolve: {
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      include: ["react", "react-dom", "react-dom/client", "framer-motion"],
    },
    ssr: {
      noExternal: ["framer-motion"],
    },
  },
});
