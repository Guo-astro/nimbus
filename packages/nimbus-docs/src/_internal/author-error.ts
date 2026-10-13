import { AstroError } from "astro/errors";

import { ApiBuildError } from "./api/coordinates.js";

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

/**
 * Run `fn`, rethrowing an `ApiBuildError` as an author error. No `cause`:
 * Astro would print the cause's stack under "Caused by".
 */
export async function withApiErrorsAsAuthorErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiBuildError) throw authorError(err.message);
    throw err;
  }
}
