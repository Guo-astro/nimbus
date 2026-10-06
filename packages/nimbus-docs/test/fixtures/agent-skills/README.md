# Pinned Agent Skills discovery fixtures

The implementation follows the Agent Skills Discovery RFC v0.2.0 at
[cloudflare/agent-skills-discovery-rfc@1bd1167](https://github.com/cloudflare/agent-skills-discovery-rfc/tree/1bd1167983fa5ac9cd47987710c525308eda1a98)
(updated 2026-03-12) and the [Agent Skills specification](https://agentskills.io/specification)
for `SKILL.md` frontmatter. The RFC's `$schema` URI is an opaque identifier and does not
resolve, and the RFC repository ships no JSON Schema, so `index.schema.json` is Nimbus's
own transcription of the RFC's field table. `two-skills.json` is Nimbus's expected index
for the unit-test fixture (one `skill-md` skill, one `archive` skill).
