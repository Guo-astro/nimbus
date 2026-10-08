---
"@cloudflare/nimbus-docs": patch
---

- The version picker keeps a reader on the same operation when its `operationId` changed between versions but its HTTP method and path shape did not (parameter renames included). The pairing is order-independent and never guesses: anything ambiguous stays unmatched and goes to the version landing, as before.
