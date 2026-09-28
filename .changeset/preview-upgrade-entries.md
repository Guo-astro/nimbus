---
"@cloudflare/nimbus-docs": patch
---

Prerelease versions, such as the PR previews published to pkg.pr.new, select the upgrade entries of the release they preview. Two prereleases of the same release no longer count as newer than each other, so recording one and installing another doesn't fail the build.
