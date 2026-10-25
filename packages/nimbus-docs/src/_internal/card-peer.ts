/**
 * Loads one of the share cards' optional peers (satori, @resvg/resvg-js)
 * through a computed specifier, so bundlers leave it out of the framework and
 * a site without cards never resolves it.
 */
export async function loadCardPeer<T>(name: string): Promise<T> {
  const specifier = name;
  try {
    return (await import(/* @vite-ignore */ specifier)) as T;
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = String((error as Error).message ?? "");
    if ((code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") && message.includes(`'${name}'`)) {
      throw new Error(`[og] Share cards need ${name}. Install satori and @resvg/resvg-js in your project.`);
    }
    // Installed but broken, such as a native binding missing for this
    // platform: keep the original error.
    throw new Error(`[og] ${name} is installed but failed to load.`, { cause: error });
  }
}
