/**
 * Dev-server invalidation that reaches every Vite environment. A server's
 * `moduleGraph` is a compatibility view of the client and `ssr` graphs only;
 * adapters add their own (`@astrojs/cloudflare` runs prerendered routes in a
 * `prerender` environment), and a module invalidated in one graph keeps its
 * old evaluation in the others.
 */

export interface DevModuleGraph {
  getModuleById(id: string): unknown;
  invalidateModule(module: never): void;
  invalidateAll?(): void;
}

export interface DevServerGraphs {
  moduleGraph: DevModuleGraph;
  environments?: Record<string, { moduleGraph: DevModuleGraph }>;
}

/** Invalidates `ids` (or, without them, every module) in every graph the server has. */
export function invalidateDevModules(server: DevServerGraphs, ids?: Iterable<string>): void {
  const graphs = server.environments
    ? Object.values(server.environments).map((environment) => environment.moduleGraph)
    : [server.moduleGraph];
  const list = ids === undefined ? undefined : [...ids];
  for (const graph of graphs) {
    if (list === undefined && graph.invalidateAll) {
      graph.invalidateAll();
      continue;
    }
    for (const id of list ?? []) {
      const module = graph.getModuleById(id);
      if (module) graph.invalidateModule(module as never);
    }
  }
}
