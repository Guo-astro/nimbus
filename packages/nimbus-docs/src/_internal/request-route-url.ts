import { entryRouteUrl } from "./astro-slug.js";

export function requestInventoryEntryUrl(prefix: string, entryId: string): string {
  return entryId === "index" ? prefix || "/" : `${prefix}/${entryId}`;
}

export function contentInventoryEntryUrl(
  prefix: string,
  entryId: string,
  request: boolean,
): string {
  return request
    ? requestInventoryEntryUrl(prefix, entryId)
    : entryRouteUrl(prefix, entryId);
}

export function requestInventoryVersionStatusKey(
  collection: string,
  api: boolean,
  version?: string,
): string {
  return api && version ? `${collection}@${version}` : collection;
}

export interface RequestRouteInventoryEntry {
  collection: string;
  url: string;
  request: boolean;
  discoverable: boolean;
  searchable: boolean;
  title: string;
  description?: string;
  content?: string;
  language: string;
  version?: string;
  deprecated?: boolean;
}
