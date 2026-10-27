# Design agent upgrade

User authorization: upgrade both local MCPs after the 27 October retrospective.
Preserve simple image generation; add a persistent Codex design task, without Paseo.

- [x] Persistent task start/status/continue/cancel tools, bounded self-review, artifact provenance.
- [x] Source repositories read-only; per-task writable output; no nested MCPs/hooks/plugins.
- [x] Tests for completion, continuation, failure, timeout, cancellation and restart recovery.
- [x] Documentation and build; live smoke when account capabilities permit.

Companion Forge work: preflight, bounded structural audit and revision-checked checkpoint
registry; update stale font guidance, add workflow instructions and regression proof.
No edits to MOSA source, existing designs or host MCP registrations are required.

Limits: visual self-review is model judgment, not pixel-exact proof. Image-generation
budget is interrupted at tool start when observable; an already-dispatched call can
finish. Do not promise cancellation rolls back generated artifacts.


## Validation completed 2026-10-27

- Imagegen: `npm test` compiles and passes 31 tests. Cases include persisted
  same-thread resume, missing images/review/actual image-view, image aliases,
  disconnect, timeout, cancel, budget, isolation and source/output overlap.
- Forge: 11 tests pass; `bun run check` builds server/plugin, typechecks and formats.
- Live MCP → Codex generated one 1254×1254 card after reading a source fixture,
  opened it for inspection, and resumed the same thread after MCP restart.
  Final task state completed with observed imageView and explicit passing criteria.
  Runtime task/thread identifiers are retained locally, not published.
- Live smoke exposed renamed image aliases: now normalize only byte-identical
  copies within task output using SHA-256. Regression test added.
- Agent once described a saved copy incorrectly despite identical SHA-256 to the
  original; parent inspected it and confirmed correct labels. Self-review is not
  independent proof and remains labelled as such.
- Live Forge typed tools verified exact SF Pro Text Regular availability/loading,
  bounded page audit and empty checkpoint lookup. Audit correctly reported an
  unavailable remote component lookup as a lookup failure, not a missing main.
  Added a tested 5-second default budget after this live discovery. Latest plugin
  build must be reopened to activate the budget in an already-open Figma session.
- No product frames modified, no MOSA source changes, no host registration changes,
  during validation. Builds are available at the existing configured dist paths.

Activation: restart/reconnect each MCP client for new tools; reopen the Forge
plugin to load the latest bundle. Read README.md and the companion FORGE.md.
