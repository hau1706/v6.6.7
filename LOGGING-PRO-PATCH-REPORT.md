# AutoPick Pro v6.6.7 — Logging Pro Patch Report

## Scope

This patch integrates a persistent structured logging pipeline while preserving the protected native Frida lifecycle path. The original v6.6.7 source archive was used as the base.

## Implemented

- Added `Sources/APFLogManager.h/.m`.
- Four levels: INFO, SUCCESS, WARNING, ERROR.
- Structured event schema with version, unique host event ID, UTC timestamp, level, event code, source, message, context and optional correlation ID.
- JSONL persistence under `Library/Application Support/AutoPick/Logs/`.
- Serial I/O queue, 1-second INFO batching, immediate flush for SUCCESS/WARNING/ERROR, 2 MiB rotation target, four archives plus current, bounded pending queue and bounded in-memory fallback.
- File protection and backup exclusion; common secret/customer-data context keys are redacted.
- Agent adapter emits a structured marker through the existing legacy `logs` message envelope. The existing UI bridge parses and persists it. Legacy log lines continue to display as before.
- Source and bundled agent are byte-identical.
- App lifecycle events are additionally written to the central logger; legacy `app_lifecycle.log` is retained for compatibility.
- Log Viewer receives native structured events; added JSONL export through the iOS share sheet and persistent-history clearing.
- Added `loggingEnabled` preference (default YES) to suppress INFO only; SUCCESS/WARNING/ERROR remain recorded. Existing preferences and defaults are retained.
- APFMenu records notification request outcomes and logs match-notification construction exceptions.
- Added schema and integration regression tests.

## Safety decisions

- `Sources/FridaController.m` is intentionally unchanged and remains byte-identical to the protected baseline SHA-256:
  `f8651099c907c77887f3deab440cb80fb6737dc584572bbde7973374a68e778c`
- No Spawn/Attach/session lifecycle ordering was modified.
- PICK/MPICK business logic and reservation transitions were not changed.
- UNKNOWN remains distinct from FAILED; no automatic replay was added.
- Structured diagnostics are best-effort and must not alter request or reservation state.

## Validation performed

Passed:

- `node --check` for `frida-agent.js`, `Sources/frida-agent-bundle.js`, and all JS tests.
- `tests/assignment-flow.test.js`
- `tests/logging-integration.test.js`
- `tests/logging-schema.test.js`
- `tests/rebase-integrity.test.js`
- `tests/refresh-lifecycle.test.js` (16 cases, including 500 differential pick comparisons)
- `tests/v667-safety-verbose.test.js` (14 cases)
- `project.yml` YAML parse.
- Agent/bundle byte parity.
- FridaController protected baseline SHA-256.

Not performed:

- Xcode/iOS compile and device runtime validation. This environment has no `xcodebuild` / iOS SDK. The patch must be opened with XcodeGen/Xcode 15.4 and built on macOS before installation.
- Objective-C unit/runtime tests for file rotation, iOS file protection, share sheet and background flush.

## Important limitation

The current structured adapter converts existing `sendLog()` messages into structured events and classifies common PICK/REFRESH/FILTER/ASSIGNMENT/JS-error text patterns. It does not yet replace every individual silent `catch` in the large Frida agent, and it does not implement a durable PICK journal/recovery protocol. Those require targeted state-transition changes and separate regression tests; they are deliberately not guessed or altered in this safety-focused patch.
