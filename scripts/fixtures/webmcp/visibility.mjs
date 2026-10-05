// Small visibility and version fixture for the browser regression harness.
export const visibilityDocs = [
  {
    url: "/guide/",
    title: "Guide",
    content:
      "## Install\nNebulacobalt body-only phrase.\n## Tokens\nNebulacobalt uses tokens & keys.",
    version: "v2",
  },
  {
    url: "/entities/",
    title: "Entities",
    content:
      "## Literal\nNebulacobalt entityneedle keeps &amp; and <b>tags</b> as written.",
    version: "v2",
  },
  {
    url: "/v1/guide/",
    title: "Old guide",
    content: "## Install\nNebulacobalt legacytokens.",
    version: "v1",
    deprecated: true,
  },
  {
    url: "/private/",
    title: "Private",
    content: "## Secrets\nNebulacobalt hiddenneedle.",
    hidden: true,
  },
  {
    url: "/draft/",
    title: "Draft",
    content: "## Draft\nNebulacobalt draftneedle.",
    draft: true,
  },
  {
    url: "/noindex/",
    title: "No index",
    content: "## Internal\nNebulacobalt noindexneedle.",
    noindex: true,
  },
  {
    url: "/opt-in/",
    title: "Search opt-in",
    content: "## Find\nNebulacobalt optinneedle.",
    noindex: true,
    searchable: true,
  },
];
export const visible = visibilityDocs.filter(
  (doc) =>
    !doc.hidden &&
    !doc.draft &&
    doc.searchable !== false &&
    (!doc.noindex || doc.searchable === true),
);
