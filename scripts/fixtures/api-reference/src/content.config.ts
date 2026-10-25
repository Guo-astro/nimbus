import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import {
  apiCollection,
  docsCollection,
  partialsCollection,
} from "@cloudflare/nimbus-docs/content";

export const collections = {
  docs: defineCollection(
    docsCollection({
      schemaFields: { audience: z.literal("human").optional() },
    }),
  ),
  partials: defineCollection(partialsCollection()),
  api: defineCollection(apiCollection()),
};
