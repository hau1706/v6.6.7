# AutoPick Pro v6.6.7 — Full Upgrade & Test Report

## 1. Baseline

- User-provided source baseline: `https://github.com/hau1706/v6.6.4` (`main`).
- Rebased from the v6.6.6 Rebased source ZIP supplied in this session, which retained the v6.6.4 native controller.
- `Sources/FridaController.m` SHA-256 remains:
  `f8651099c907c77887f3deab440cb80fb6737dc584572bbde7973374a68e778c`
- App / agent version: `6.6.7`.
- Build: `74`.
- Embedded `Sources/frida-agent-bundle.js` is copied from the final `frida-agent.js` and tested byte-for-byte.

## 2. Changes implemented

### 2.1 START does not erase pending state

The previous START branch forcibly cleared `isBusy`, `pickedIds`, `notifiedIds`, pending metadata, pending response count and active batch. That could permit the same order to be re-dispatched while an old server request was still running.

v6.6.7 now:
- Keeps all pending/UNKNOWN metadata and active batch information.
- Keeps the de-duplication caches across STOP/START.
- Keeps `isBusy` true whenever pending response slots, metadata or a batch remain.
- Resets only the per-session success counter when there is no pending pick work.
- Allows refresh to restart independently while the pick gate remains active.

### 2.2 SINGLE / MPICK / batch handoff classification

Every pick metadata item now tracks a lifecycle status:

`PREPARING → HANDOFF → SUBMITTED → RESOLVED`

An exception after entering `sendRequest_responseType_incrementalUpdates_responseSender_` is `UNKNOWN`, not a definite failure. In that case:
- The app keeps the order reservation and pending response slot.
- It does not automatically retry.
- Later IDs in a batch are not sent.

If preparation fails before entering RCTNetworking:
- The pending count and metadata are removed.
- Only confirmed-unsent order/group reservations are released.
- A new retry can be considered on a later valid order response.

Batch bookkeeping now includes submitted/ambiguous counts and the originating group reservation. If no request in a split batch was handed off, the group reservation is released. If at least one request was submitted or is ambiguous, the group reservation remains to avoid replaying the whole group.

Uncorrelated batch responses consume one response slot but are not attributed to a guessed order ID.

### 2.3 Timeout fail-closed behavior

The old 12-second timeout cleared pending metadata and set `isBusy=false`, although it could not prove the server had rejected the request. This created a duplicate-pick risk.

Now timeout:
- Changes outstanding metadata to `UNKNOWN`.
- Keeps `pendingPickResponses`, `pickedIds` and `isBusy`.
- Finalizes the visible batch summary as unresolved while retaining metadata for late responses.
- Allows refresh to continue.
- Releases busy only when actual late server responses reduce the pending count to zero.

**Tradeoff:** when a response is permanently lost, Auto Pick stays blocked. This is intentional fail-closed behavior. There is not yet a durable journal across agent unload/reload; after reattach the user must check the driver app before turning Auto Pick back on.

### 2.4 Adaptive refresh backoff

- HTTP 503: first two consecutive overload responses do not add a wait. Starting at the third consecutive 503, backoff is 500 ms, then doubles to an 8-second cap.
- HTTP 429 and other 5xx: starts at 1 second, doubles to a 15-second cap.
- Numeric and HTTP-date `Retry-After` values are parsed and honored, capped at 60 seconds.
- Expiring the current wait does not reset the exponential exponent; the exponent resets only after a valid successful list response. This prevents repeated server errors from getting stuck at the first backoff interval.
- Backoff clears only after valid list JSON processing, not merely on entry to the parser.
- Refresh remains single-flight and continues independently from pick busy state.

### 2.5 Verbose log for non-matching orders

With `verboseLog=true`, each rejected candidate can show:
- Delivery order ID.
- `delivery_distance` converted from meters to km.
- `total_earnings_amount` formatted in VND.
- The first rejection reason returned by the unchanged filter evaluation.

Examples:

`[FILTER] Bỏ qua #706 · 12.5 km · 42.000đ · Gia thap`

`[FILTER] Bỏ qua #707 · 68.0 km · 61.000đ · Xa qua`

Repeated order/reason logs are throttled for 10 seconds. The throttle map is capped at 512 entries to avoid a diagnostic cache growing indefinitely. Passing candidates are also logged at a throttled rate.

### 2.6 Buffer optimization

- `bufferAppend()` now reuses the existing chunk array instead of running `slice()` on each callback.
- The response is joined once after completion.
- Each response buffer is limited to 2,048 chunks.
- Existing per-stream caps and the global 6,291,456 UTF-16-code-unit cap remain.
- Buffer eviction and rejection counters remain available through memory stats.

## 3. Files changed

- `frida-agent.js`
- `Sources/frida-agent-bundle.js`
- `Sources/Info.plist` (6.6.7 / build 74)
- `Sources/TestViewController.m` (visible title)
- `Sources/APFMenu.m` (visible menu title)
- `.github/workflows/build.yml` (new regression suite and v6.6.7 artifact names)
- `tests/assignment-flow.test.js` (updated adaptive 503 assertions)
- `tests/refresh-lifecycle.test.js` (adaptive 503 timing and in-place chunk-array checks)
- `tests/rebase-integrity.test.js` (baseline native hash, version, title and bundle parity)
- `tests/v667-safety-verbose.test.js` (14 safety/verbose regression checks)
- `README.md`, `CHANGELOG-PRO-v6.6.7.md`

`Sources/FridaController.m`, filtering configuration and the core selection algorithm were not modified.

## 4. Test results

| Check | Result | Notes |
|---|---|---|
| `node --check frida-agent.js` | PASS | JS syntax |
| `node --check Sources/frida-agent-bundle.js` | PASS | Embedded JS syntax |
| `tests/assignment-flow.test.js` | PASS | Assignment, PICK/MPICK, batch response handling, upload gating, gzip handoff |
| `tests/refresh-lifecycle.test.js` | PASS — 16 tests | Includes 60-minute virtual soak and 500 randomized selection comparisons against v6.6.4 |
| `tests/rebase-integrity.test.js` | PASS | Native controller SHA, Spawn/Attach call sequence, plist version/build, UI title and agent parity |
| `tests/v667-safety-verbose.test.js` | PASS — 14 tests | START preservation, timeout UNKNOWN, START/API-test gate, SINGLE/MPICK/batch pre-/post-handoff, Retry-After, exponential growth after wait expiry, verbose km/price, chunk-array reuse, chunk-count ceiling |
| `php -l server/receive-orders.php` | PASS | No syntax errors |
| `tests/native/gunzip_logic_test.c` | PASS | Valid/passthrough/truncated/corrupt/short/oversized and 3 MB payload cases |
| Agent/bundle `cmp` | PASS | Byte-for-byte identical |
| ZIP `unzip -t` | PASS | Checked after final package |

## 5. Overall assessment

### Improved

- START no longer wipes pending pick/de-duplication state.
- SINGLE, MPICK and batch share the same conservative treatment of ambiguous handoff.
- Timeout no longer silently turns an unknown server result into a retryable state.
- Confirmed-unsent requests release their reservation, including the batch group reservation when no handoff occurred.
- Verbose filter logs now report ID/km/price/reason without flooding the log at every refresh cycle.
- Buffer callbacks avoid copying the accumulated chunk array repeatedly.
- 503 handling protects the configured fast cadence for two transient failures, then slows down on sustained overload; 429/5xx and Retry-After are handled.

### Tradeoffs / outstanding risks

1. **UNKNOWN can block Auto Pick indefinitely.** This is safer than an automatic duplicate, but can reduce pick throughput if the server never sends a response. A future native/UI reconciliation flow should let the operator confirm the actual order status without blindly resending.
2. **No persistent pending-pick journal across agent unload/reload.** The current state is in agent memory. A robust durable journal should be designed with the native side and tested before adding synchronous disk writes to the request path.
3. **Spawn/Attach is source-preserved, not device-proven.** The controller is byte-identical to v6.6.4, but still needs a real device test with the exact Frida server/entitlements/target app.
4. **Performance numbers are not device benchmarks.** No physical iPhone RAM/RSS, power, crash rate, or request-latency P50/P95/P99 measurements are available.

## 6. Not performed in this environment

The current environment is Linux and does not provide macOS, Xcode, XcodeGen with an iOS SDK, Frida iOS devkit linking environment, or the user's iPhone. Therefore Objective-C compilation/linking, IPA creation, real Spawn/Attach and real-device soak/latency/RAM measurement are not claimed. The GitHub Actions workflow was updated to run all source tests before building on macOS, but a successful Actions run is still required to confirm IPA build success.

## 7. Recommendation

v6.6.7 is a safer source update than v6.6.6 for the START and ambiguous PICK paths, and it preserves the known v6.6.4 native controller. Before using unattended for long periods, test the IPA on the iPhone and validate a late/missing response. The most valuable next step after device validation is a durable UNKNOWN-state reconciliation journal that survives detach/reload without blocking the main queue.
