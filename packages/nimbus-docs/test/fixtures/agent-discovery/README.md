# Pinned discovery schemas

`ard-entry.schema.json` and `ai-catalog.schema.json` are copied unchanged from
[ards-project/ard-spec at b76f235a](https://github.com/ards-project/ard-spec/tree/b76f235a8f461876ad4f1e77abd0eb0eb302b48d/spec/schemas).
The accompanying spec is ARD v0.91, dated 2026-08-26. Its `ArdManifest` definition
accepts the AI Catalog 1.0 transport envelope, so both discovery URLs can serve
identical bytes. Tests validate both independently. The upstream Apache 2.0
license is included here. `docs-only.json` is Nimbus's own expected output.
