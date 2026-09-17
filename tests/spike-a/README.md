Diagnostic git-conflict simulations for the spike-a seam; not wired into `npm test`/CI (Task 7 deliberately excludes them).

Run: `env -u OW_HOME node tests/spike-a/test-git-conflicts.mjs`

Scenario A: the active-doc reload pathway now re-anchors `fs.watch` after its own atomic write and re-applies the `_pending/{docId}.json` sidecar overlay to the reloaded canonical body. The canonical disk is never clobbered. Pending edits that have not yet reached the sidecar when the checkout races the debounced save are still dropped from the in-memory view; they survive the reload once the sidecar has captured them.
