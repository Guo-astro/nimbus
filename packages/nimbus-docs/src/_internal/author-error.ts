import { AstroError } from "astro/errors";

/**
 * A build error the author fixes in their content, not a Nimbus crash. Astro
 * prints the stack of any error a hook throws, and when the error has no
 * location it takes the first stack line mentioning `src` as one, which here
 * is a line of the message itself (`src/content/docs/x.mdx:5:1  <Foo />`), so
 * it prints a garbled path. Content errors carry their locations in the
 * message; drop the stack so Astro shows only the message and hint.
 */
export function authorError(message: string, hint?: string): Error {
  const error = new AstroError(message, hint);
  error.stack = "";
  return error;
}
