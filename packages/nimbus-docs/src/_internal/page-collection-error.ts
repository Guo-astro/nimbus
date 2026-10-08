/**
 * The error for routing a non-page collection through Nimbus. Lives in its own
 * module with no `node:` imports so request-time code (request-rendered prose
 * routes on any adapter) can import it.
 */
export function notAPageCollectionMessage(collection: string): string {
  return (
    `nimbus-docs: collection "${collection}" is not a Nimbus page collection, so Nimbus cannot route it. ` +
    `Create it with docsCollection({ base: "${collection}" }) or wrap its loader with withNimbusMarkdown(loader), ` +
    "or read it with getCollection() as plain Astro data."
  );
}
