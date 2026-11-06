## Logging Pro v3 — Log Viewer UI

- Thêm màn hình Log Center chuyên biệt với dashboard tổng log, SUCCESS, FAILED và UNKNOWN.
- Thêm tìm kiếm, lọc theo mức độ/giai đoạn, Live pause/resume, xem JSON, sao chép, xuất và xóa log.
- Rút gọn khung log ở màn hình điều khiển, bổ sung nút mở Log Center.
- Sửa thao tác xóa để xóa cả log legacy và JSONL.

# AutoPick Pro v6.6.7 — Stability & Performance

## Version
- `CFBundleShortVersionString`: 6.6.7
- `CFBundleVersion`: 74
- Agent version: 6.6.7

## Fixes

1. **START state safety**
   - START no longer clears picked/notified de-duplication stores or pending PICK/MPICK metadata.
   - Pending or UNKNOWN work keeps the busy gate active; the session count resets only when no pick work remains.

2. **SINGLE / MPICK / batch handoff safety**
   - Track PREPARING → HANDOFF → SUBMITTED / UNKNOWN → RESOLVED.
   - A failure before entering RCTNetworking releases only reservations known not to have been submitted.
   - A failure after handoff starts is UNKNOWN; metadata and reservations remain and no automatic retry is made.
   - Batch stops after an ambiguous handoff. IDs not handed off are released.
   - Group reservation is released when no batch request could be handed off; it remains if any request was submitted or ambiguous.

3. **Timeout semantics**
   - A 12-second timeout no longer treats unanswered requests as rejected.
   - Pending response slots, metadata and busy lock remain until a late response resolves them.
   - Refresh continues while pick is UNKNOWN.

4. **Refresh backoff**
   - First two consecutive HTTP 503 responses keep the configured cadence.
   - From the third consecutive 503: 500 ms, then exponential growth capped at 8 seconds.
   - HTTP 429 and other 5xx: 1 second exponential backoff capped at 15 seconds.
   - Backoff exponent is retained after a wait expires and resets only after a valid successful order-list response.
   - Numeric or HTTP-date `Retry-After` is honored, capped at 60 seconds.
   - Backoff clears only after valid list JSON processing.

5. **Verbose filter detail**
   - Non-matching orders show order ID, distance in km, earnings in VND and the rejection reason.
   - Duplicate logs are throttled for 10 seconds; throttle map is bounded to 512 entries.

6. **Memory and chunking**
   - Chunk arrays are reused in-place rather than copied with `slice()` on every callback.
   - Response is joined once after completion.
   - Per-buffer chunk count is capped at 2,048 in addition to per-stream and global 6 Mi UTF-16-unit caps.

7. **Reservation cleanup**
   - Single, group and split-batch paths release reservations after a confirmed pre-handoff failure.
   - The batch path clears `isBusy` correctly when every request failed before handoff.

## Preserved

- The core Spawn/Attach method bodies in `Sources/FridaController.m` are preserved; subsequent notification and Assignment-history handlers are isolated additions.
- Original order filtering and selection decisions remain equivalent to v6.6.4 in the randomized differential suite.
- Assignment handling, upload feature gating, GZIP handling, UI and existing configuration keys are preserved apart from the visible app version.

## Verification

- JavaScript syntax checks: PASS.
- Assignment/PICK/MPICK suite: PASS.
- Refresh lifecycle / memory / 60-minute virtual soak / 500-case differential suite: PASS (16 tests).
- v6.6.7 safety and verbose regression suite: PASS (14 tests).
- Native baseline / plist / bundle parity checks: PASS.
- PHP lint: PASS.
- Native GZIP C harness: PASS.
- ZIP integrity: PASS after packaging.

## Known limitations

- Pending UNKNOWN state is not persisted durably across an agent unload/reload. The in-memory fail-closed lock protects against duplicate sends only while the agent remains alive. After detach/reload, the operator must check the driver app before re-enabling Auto Pick.
- No Xcode build/IPA or real Spawn/Attach run was possible in the Linux environment.
- No real-device RAM, network latency percentiles, battery, crash or 2–4 hour physical soak measurements are claimed.
- The v6.6.4 native controller source was preserved exactly, but only an iPhone test can validate the Frida server, signing, entitlement and target-app combination.


## Logging Pro v2 — 2026-11-04
- Added a single per-batch PICK summary event and UI alert for Pick-lẻ ALL.
- Added per-order SUCCESS / FAILED / UNKNOWN / NOT_SENT tracking.
- Uncorrelated responses and missing/invalid response codes remain UNKNOWN; no order ID is guessed.
- UNKNOWN items preserve reservations and the single-flight PICK gate; late correlated responses can resolve them without duplicate summary popups.
- Added structured SPAWN, ATTACH, HOOK, REFRESH, FILTER, PICK, RESPONSE, and ASSIGNMENT event coverage.
- Added batch summary, timeout, uncorrelated-response, and malformed-code regression tests.


### Logging Pro v2 build-fix
- Removed duplicate `TestViewController` dealloc implementation while preserving timer cleanup and observer removal in the existing dealloc.
- Updated iPad idiom detection to the current UIKit API.


## Assignment Re-Pick + Response Notifications — 2026-11-04 (build 75)

- Added persistent local history for Assignment prompts dismissed with **Bỏ qua**. Up to 50 records are retained, with 12 records per page and previous/next navigation.
- Added a guarded **Pick lại / Pick lẻ ALL** action for saved SKIPPED or FAILED Assignment records. The saved order IDs are passed through the existing Pick request path; no new API endpoint or guessed order/response mapping is introduced.
- Manual Assignment-popup Pick lẻ ALL explicitly uses `SPLIT_ALL_CODE_ONLY`, carries `assignmentId`, `source`, and `forceNotify`, and therefore counts each explicit `code: 0` response as success and each explicit nonzero `code` response as failure even when the response has no `delivery_order_id`.
- The batch result notification now shows server `msg` and `code`, prioritizes failure reasons, and can fall back to local handoff/preparation reasons. Manual Assignment results are forced to appear in-app and as a local notification regardless of general notification toggles.
- Single Assignment Pick results show server response code/message; definitely pre-handoff preparation failures also emit a forced failure result. Ambiguous post-handoff exceptions remain UNKNOWN and are not falsely labeled as server failures.
- Batch-start logs now include Assignment ID, source, response mode, and force-notify state to make future test logs traceable.
- Match notification implementation is byte-for-byte unchanged. PICK/MPICK payloads, endpoints, filter/selection logic, reservation protections, and core Spawn/Attach lifecycle methods are preserved.
- Added regression coverage for persistent Assignment history/pagination, manual popup SPLIT ALL `code: 0`/nonzero classification, response reason notifications, and visible pre-handoff failure feedback.


## Objective-C Logger Selector Build Fix — 2026-11-04 (build 76)

- Fixed the forced Assignment Pick result logger call in `Sources/APFMenu.m`: it now supplies the required `correlationID:` selector argument declared by `APFLogManager.h`.
- Uses the Assignment ID as the structured log correlation ID when available; otherwise passes `nil`.
- Added `tests/logging-api-signature.test.js` and included it in the GitHub Actions build workflow to prevent this selector mismatch from recurring.
- No PICK/MPICK request payload, endpoint, assignment-history, notification text, filter, reservation, or Spawn/Attach behavior was changed by this compile fix.
- Incremented `CFBundleVersion` from 75 to 76.
