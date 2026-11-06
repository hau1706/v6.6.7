# AutoPick Pro v6.6.7 — Logging Pro v2 & Batch Summary

## Scope
This patch starts from `AutoPick-Pro-v6.6.7-LoggingPro-patched-source.zip` and extends that source. It does not rebase on the separate GitHub `main` branch.

## Batch Pick summary
- Every item in a Pick-lẻ ALL batch now carries an individual status: `SUCCESS`, `FAILED`, `UNKNOWN`, or `NOT_SENT`.
- `SUCCESS` is assigned only when the server returns an explicit numeric `code: 0` and the response can be correlated to the correct `delivery_order_id`.
- `FAILED` is assigned only for an explicit non-zero numeric server code correlated to that order.
- Missing/invalid response code, timeout, ambiguous native handoff, or response without a safely correlatable order ID remains `UNKNOWN`.
- Requests not handed to RCTNetworking are `NOT_SENT`; they are not reported as server failures.
- Batch completion emits one `pick_batch_summary` event with counts and per-order results. It no longer emits separate batch `pick_success` and `pick_failed` events.
- In-app UI displays one summary alert with all order IDs and statuses. If system notifications are enabled, one compact system notification is also requested.
- Unresolved UNKNOWN items keep the single-flight PICK gate closed. A late response with a matching ID may resolve the item without showing a duplicate summary. The code never replays an UNKNOWN request.

## Pipeline event coverage
- Native Frida lifecycle: device acquisition, Spawn, Attach, script creation/load, Resume, duplicate attach guard and failures.
- Agent hook readiness/unavailability.
- Refresh request start/submission, HTTP failures and parsed/empty responses (repetitive INFO events are throttled).
- Filter selected/no-match diagnostics and verbose rejection logs.
- PICK/MPICK queued/handoff/submitted events, per-item batch transitions, server response outcomes and batch summary.
- Assignment detection with assignment ID and order IDs.

## Key event codes
- `FRIDA.SPAWN.SUCCESS`, `FRIDA.SPAWN.FAILED`
- `FRIDA.ATTACH.SUCCESS`, `FRIDA.ATTACH.FAILED`, `FRIDA.ATTACH.EXISTING_PROCESS`
- `FRIDA.HOOK.SCRIPT_READY`, `HOOK.INSTALLED`, `HOOK.RCTNETWORKING_MISSING`
- `REFRESH.REQUEST.STARTED`, `REFRESH.HTTP_ERROR`, `REFRESH.RESPONSE.PARSED`
- `FILTER.MATCH_SELECTED`, `FILTER.DIAGNOSTIC`
- `PICK.BATCH.STARTED`, `PICK.ITEM.SUCCESS`, `PICK.ITEM.FAILED`, `PICK.ITEM.UNKNOWN`, `PICK.ITEM.NOT_SENT`, `PICK.BATCH.SUMMARY`
- `PICK.RESPONSE.SUCCESS`, `PICK.RESPONSE.FAILED`, `PICK.RESPONSE.UNKNOWN_CODE`
- `ASSIGNMENT.DETECTED`

## Safety invariants
- Request payloads, endpoints, dispatch order (far-to-near for Pick-lẻ ALL), filtering, reservation behavior, and retry rules were not intentionally changed.
- No automatic retry/replay was added for UNKNOWN.
- A response without a usable order ID is never attached to an arbitrary order in a multi-order batch.
- A valid JSON response without an explicit numeric API code is UNKNOWN, not FAILED.
- `FridaController` changes add logging only; Spawn → Attach → create/load script → Resume order remains guarded by regression tests.

## Validation completed
- `node --check` for `frida-agent.js`, bundled agent, and all Node test files.
- `tests/assignment-flow.test.js` PASS.
- `tests/batch-summary.test.js` PASS (4-order mixed result, uncorrelated response, timeout/late response, missing response code).
- `tests/logging-integration.test.js` PASS.
- `tests/logging-schema.test.js` PASS.
- `tests/rebase-integrity.test.js` PASS (Spawn/Attach/script-load/Resume ordering and bundle parity).
- `tests/refresh-lifecycle.test.js` PASS (16 cases; includes 500 randomized differential comparisons).
- `tests/v667-safety-verbose.test.js` PASS (14 cases).

## Not validated here
- Native Objective-C compile/link and runtime behavior require macOS with Xcode 15.4 and the correct Frida static libraries. This environment does not provide the iOS SDK/Xcode build toolchain.
- The new UIKit alert and iOS notification presentation must be exercised on a device.
- GitHub's connected toolset available in this session does not expose repository-creation/upload-to-new-repository operations. The source package is ready, but a new GitHub repository has not been created or uploaded by this patch process.


## Build fix (2026-11-04)
- Fixed the Xcode compile error `duplicate declaration of method 'dealloc'` in `Sources/TestViewController.m` by removing the redundant early `dealloc`. The existing final `dealloc` remains and continues to invalidate `prefsSyncTimer`, `logReloadTimer`, `statusCheckTimer`, and unregister NotificationCenter observers.
- Replaced deprecated `UI_USER_INTERFACE_IDIOM()` with `UIDevice.currentDevice.userInterfaceIdiom` in the iPad share-sheet anchor check. This removes the warning seen in the supplied Xcode 16.4 log.
- The supplied log showed one compile error and one deprecation warning in this file. It did not establish that the entire build would pass after this fix; remaining compilation must be verified by rerunning the same Xcode build.
