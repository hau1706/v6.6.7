# AutoPick Pro v6.6.7 — Assignment Re-Pick + Response Notification Fix

**Build:** 75  
**Date:** 2026-11-04  
**Base:** `AutoPick-Pro-v6.6.7-LoggingPro-v3-BatchNotify-Code0-SPLITALL-Fix.zip`

## 1. Findings from the supplied test log

The log for Assignment `1792469759` shows three requests submitted for order IDs `1063420456`, `1063419681`, and `1063420592`. The server returned three explicit replies:

```json
{"msg":"error_driver_location_not_found","code":1,"data":null}
```

The previous build treated the replies as uncorrelated generic batch failures and moved all three items to `UNKNOWN`. The batch notification was generated, but its result could be gated by the general notification preferences. The reply itself is a failure (`code: 1`); the application must show the returned reason instead of hiding it as `UNKNOWN`.

The returned message is preserved verbatim. It does not, by itself, prove that another driver received the order; the notification reports the exact response the server supplied.

## 2. Changes

### Assignment history and Pick again

- When the user selects **Bỏ qua** on an Assignment popup, the app stores the Assignment ID, order IDs, expected count, group state, price, distance, and timestamps locally using `NSUserDefaults`.
- History retains the latest 50 records and displays 12 per page with previous/next navigation.
- The main menu now has **Assignment đã bỏ qua**. Users can inspect a saved Assignment, remove it, or use **Pick lại / Pick lẻ ALL** when its saved order list is complete.
- Re-Pick uses the existing single-Pick or split-Pick request route. It does not invent a new endpoint or assign uncorrelated server replies to arbitrary order IDs.
- History statuses update to `PICKING`, `PICKED`, `PARTIAL`, `FAILED`, or `UNKNOWN` based on the observed request outcome.

### Assignment popup result notifications

- Manual Assignment popup **Pick lẻ ALL** now explicitly sets `SPLIT_ALL_CODE_ONLY`, `forceNotify`, `assignmentId`, and source metadata.
- For this split-all flow, explicit `code: 0` replies count as successful responses and explicit nonzero `code` replies count as failed responses even when the reply has no `delivery_order_id`.
- If replies are uncorrelated, aggregate counts are reported without pretending to know which individual order ID belongs to which response. Mixed outcomes remain aggregate-only rather than being assigned to arbitrary orders.
- The result toast and local notification are forced for Assignment popup actions, independently of the general success/match notification switches.
- Notifications include server `msg` and `code`. Failure reasons are prioritized; a concise local request-preparation reason is shown when no server response exists.
- Single Assignment Pick success/failure notifications also include the response message and code. A definitely pre-handoff preparation failure now produces a visible failure result; an ambiguous exception after handoff remains `UNKNOWN`.
- Batch-start logs now record Assignment ID, source, response mode, and force-notify state for easier diagnosis in future logs.

## 3. Expected notification for the supplied failure case

```text
❌ PICK LẺ ALL · 0/3 THÀNH CÔNG
📦 3 đơn  |  ✅ 0  ❌ 3
Server: error_driver_location_not_found (code 1)
```

For three successful replies:

```text
✅ PICK LẺ ALL · 3/3 THÀNH CÔNG
📦 3 đơn  |  ✅ 3  ❌ 0
Server: success (code 0)
```

## 4. Preserved behavior

- Existing match notification method is byte-for-byte unchanged versus the base ZIP.
- Pick/MPICK endpoint and request body construction are unchanged.
- Order filtering/selection, reservations, timeout fail-closed protections, and late-response handling are not redesigned.
- Core Spawn/Attach lifecycle method bodies are unchanged; only native message handling and the new Assignment re-pick bridge were extended.
- `frida-agent.js` and `Sources/frida-agent-bundle.js` are byte-for-byte identical.

## 5. Verification

Passed:

- `assignment-flow.test.js`
- `assignment-history.test.js` (includes an actual VM exercise of the `assignment_repick` message path)
- `batch-notification-ui.test.js`
- `batch-summary.test.js` (includes the supplied `code: 1` / no-order-ID pattern, all-failed and mixed-response cases)
- `build-fix.test.js`
- `log-viewer-ui.test.js`
- `logging-integration.test.js`
- `logging-schema.test.js`
- `rebase-integrity.test.js`
- `refresh-lifecycle.test.js` (16 tests, including 500 randomized differential comparisons)
- `v667-safety-verbose.test.js` (15 tests)
- JavaScript syntax checks, PHP lint, YAML parse, Info.plist parse, native GZIP C harness, agent/bundle parity.
- ZIP integrity check after packaging.

## 6. Build limitation

This environment does not contain Xcode or the iOS SDK, so an Objective-C/iOS build and an on-device notification/Assignment re-pick test could not be run here. Build number was incremented from 74 to 75 for the next installable build.
