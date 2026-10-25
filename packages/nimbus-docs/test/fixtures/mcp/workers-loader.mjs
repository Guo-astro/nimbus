// Resolves `cloudflare:workers` to a stub whose ASSETS binding reads a
// built site's client directory, so a server entry built for the Cloudflare
// adapter can be imported and driven under Node.
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") {
    return { url: new URL("./workers-stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
