# Dependency License Inventory

Status: **inventory generated; legal/redistribution review incomplete**

`node scripts/license-inventory.mjs` reads the production dependency tree reported by npm and prints declared package license identifiers, direct dependency versions, undeclared identifiers, and packages without an installed license text file. It is an inventory aid, not a legal compatibility determination.

Inventory generated on macOS arm64 from the pinned lockfile on 2026-09-19:

- 204 unique production package/version entries, including optional platform variants.
- All 204 declare a license identifier: MIT 106, Apache-2.0 71, BSD-3-Clause 15, ISC 8, BlueOak-1.0.0 2, 0BSD 1, Unlicense 1.
- 54 package entries had no `LICENSE`, `LICENCE`, or `COPYING` file in their installed package directory. Their declared identifiers were recorded, but their complete notice/attribution requirements still need review.
- The nine direct runtime dependencies declare MIT (eight packages) or ISC (`yaml`). Exact versions are pinned in `package.json` and `package-lock.json`.
- The application package has no `license` field and remains private. No project license was chosen or inferred.

Before any public redistribution, review the missing upstream license texts/notices, preserve required attributions, decide the project's license, and regenerate this report for each supported platform. The npm tarball does not vendor transitive dependencies; npm installs them separately.
