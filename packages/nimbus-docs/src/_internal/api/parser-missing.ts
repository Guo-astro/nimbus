/**
 * The message for a missing OpenAPI parser, naming the project's package
 * manager. A dynamic import, so the package-manager helpers load only on that
 * error and stay out of request-time bundles that import the parser module.
 */
export async function openApiParserMissing(): Promise<string> {
  const { openApiParserMessage } = await import("../server-adapter.js");
  return openApiParserMessage(process.cwd());
}
