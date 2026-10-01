# Changelog

## [0.1.7] - 2026-10-01

### Added

- Explicit Codex `danger-full-access` mode for single runs and batch tasks, including exact-session corrections. Defaults remain read-only; failures never escalate automatically.
- Additional roots retain coordination locks in full-access mode without implying filesystem restrictions. Unsupported network overrides are rejected.
- Browser capability guidance distinguishes permission selection from tool installation and actual browser acceptance.

## [0.1.6] - 2026-10-01

### Added

- Optional Codex `writable_roots` and `network_access` permissions for single runs and each batch task, including exact-session resume.
- Shared admission claims for every explicit write scope, rejecting overlapping paths and Git aliases across concurrent calls and providers.

### Verification

- Deterministic MCP regressions for permission validation, resume, conflicting scopes, simultaneous admission and cancellation cleanup.
- Model-free Codex 0.159.2 sandbox checks: explicit roots writable, unrelated paths and Git metadata denied, TCP access disabled/enabled as requested.

## [0.1.5] - 2026-10-01

### Added

- `run_batch` on both provider servers: delegate 1–5 tasks concurrently through one pending MCP call.
- Whole-batch validation, distinct-checkout admission, ordered partial results and durable retry recovery without redispatching unknown work.
- Exact-session correction batches, per-task timeouts, cancellation cleanup and bounded results with evidence references.
- Batch examples and deterministic coverage for concurrency, isolation, resume, recovery, cancellation and both packaged plugins.

### Fixed

- Early cancellation now records a reusable worker completion.
- Same-server recovery no longer reports an unwound batch as active.
- Batches reject tasks that alias the same Git directory; independent linked worktrees remain supported.
- Late cancellation preserves recorded outcomes, and batch error handling accepts non-Error failures.

### Verification

- 82 deterministic tests, strict emitted-schema validation and offline package checks.
- Local Claude Code host acceptance: one batch call, five overlapping fixture workers and a 150-second wait without parent status polling.
