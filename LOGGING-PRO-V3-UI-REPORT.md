# AutoPick Pro v6.6.7 — Logging Pro v3 Log Viewer UI

## Baseline

This patch was made directly from `AutoPick-Pro-v6.6.7-LoggingPro-v2-buildfix.zip` (the previous build-fix package). It is not rebased from a different source tree.

## New Log Center screen

- Dashboard counters: total log events, SUCCESS, FAILED and UNKNOWN.
- Search across event code, message, source, event ID, correlation ID and JSON context.
- Severity filters: all, SUCCESS, WARNING, ERROR, UNKNOWN and INFO.
- Stage filters: SPAWN, ATTACH, HOOK, REFRESH, FILTER, PICK, RESPONSE and ASSIGNMENT.
- Live pause/resume. When resumed, the screen refreshes recent persisted events.
- Tap an event to view its complete, pretty-printed JSON and copy it to the clipboard.
- Export JSONL and clear centralized JSONL logs with a destructive confirmation.
- Empty-state text when there are no events or a filter has no matches.

## Main screen UI

- Replaced the tall log panel with a compact 190-point preview.
- Added a direct `Log Center` entry point beside Export and Clear.
- Clear on the main screen now clears the legacy app/agent log files and APFLogManager JSONL records together, after confirmation.
- Existing SPAWN, ATTACH, START, STOP and settings buttons remain in place.

## Log data loading

`APFLogManager` exposes `loadRecentEventsWithLimit:completion:`. It drains queued events, reads current + archived JSONL, retains the in-memory fallback records if disk access is temporarily unavailable, parses valid JSON lines, sorts newest first and applies a bounded read limit (maximum 5,000). Completion is delivered on the main queue.

## Safety boundaries

These files were verified byte-identical to the v2 build-fix input:

- `Sources/FridaController.m`
- `frida-agent.js`
- `Sources/frida-agent-bundle.js`

The new viewer only reads and filters logging data. Its filters do not affect request execution or PICK/MPICK decisions. No Spawn/Attach lifecycle, request ordering, PICK sending, timeout, reservation, retry or UNKNOWN safety logic was changed.

## Automated validation

Passed:

1. `assignment-flow.test.js`
2. `batch-summary.test.js`
3. `build-fix.test.js`
4. `log-viewer-ui.test.js`
5. `logging-integration.test.js`
6. `logging-schema.test.js`
7. `rebase-integrity.test.js`
8. `refresh-lifecycle.test.js` — includes 500 randomized differential comparisons
9. `v667-safety-verbose.test.js` — 14 safety cases

Also passed JavaScript `node --check`, `project.yml` YAML parsing, Frida agent/bundle byte parity, and source delimiter-balance checks.

## Not verified in this environment

`xcodebuild` and the iOS SDK are not available here. Therefore this package has **not** been natively compiled with Xcode and the new UIKit layout has not been rendered or exercised on a physical iPhone. Please build with the project's Xcode 15.4 toolchain and test on-device before using it for live order processing.
