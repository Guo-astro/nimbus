# Pinned API catalog fixtures

The catalog follows [RFC 9727](https://www.rfc-editor.org/rfc/rfc9727) (the
`/.well-known/api-catalog` well-known URI, the `api-catalog` link relation, and
the `https://www.rfc-editor.org/info/rfc9727` profile) serialised as an
[RFC 9264](https://www.rfc-editor.org/rfc/rfc9264) JSON linkset. Neither RFC
publishes a JSON Schema, so `linkset.schema.json` is Nimbus's transcription of
RFC 9264 §4.2's serialisation rules, with the RFC 8631 relations the catalog
uses. `two-apis.json` is Nimbus's expected catalog for the unit-test record.
