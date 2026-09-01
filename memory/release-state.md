---
name: release-contract
description: A release is one verified source tree bound separately to Git, GitHub and npm evidence; current versions are always queried, never remembered
type: project
---

Git source, a GitHub repository/release, an npm package, a global local symlink and a Hoop/Nix
installation are different evidence layers. A version number in any one of them never proves
the others. Before release, bind a clean source commit and hcode tree hash to the tarball file
list, tarball integrity, tag and release notes; after release, query the public registry and
GitHub again and perform a clean temporary install. npm versions and public Git tags are
immutable, so a mismatch means stop and cut a new version rather than overwrite history.

**Why:** a stale remembered version or a successful command is not publication proof. The owner
must be able to trace exactly what became public and a later agent must be able to refute every
layer independently.

**How to apply:** never push, publish, create a public repository or bump a version without the
owner's explicit authorization. When authorized: read the current release ledger, query npm and
GitHub live, run syntax + full tests, inspect `npm pack --dry-run --json`, scan the public tree
and tarball for private identifiers and secret shapes, publish from the exact committed tree,
then record public URLs, hashes and verification results in the release ledger. Never copy npm
credentials between machines or record their values.
