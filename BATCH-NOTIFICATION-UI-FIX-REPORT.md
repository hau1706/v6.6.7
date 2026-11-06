# AutoPick Pro v6.6.7 — Batch Pick Notification UI Fix

## Input
- Based on `AutoPick-Pro-v6.6.7-LoggingPro-v3-LogViewer.zip`.
- User supplied JSONL log dated 2026-11-04 and screenshot `IMG_0769.png`.

## Findings from supplied log/image
- Batch `batch-1793753554553-99886` contained 3 split-pick orders.
- Three server responses returned `{"msg":"success","code":0,"data":null}` without `delivery_order_id`.
- The agent correctly refused to assign those responses to arbitrary order IDs and marked all 3 as `UNKNOWN`.
- Summary counts were SUCCESS 0, FAILED 0, UNKNOWN 3, NOT_SENT 0.
- The iOS notification became excessively tall because the body listed every order and repeated the long UNKNOWN explanation. The match notification below it is separate and is intentionally unchanged.

## Changes
- Changed only `Sources/APFMenu.m` batch-summary notification presentation.
- Compact title: `PICK LẺ ALL · x/y ...`.
- Compact two-line body: one count line and one short explanation.
- Removed per-order detail list from push/in-app notification; per-order IDs/status/detail remain in structured `PICK.BATCH.NOTIFICATION` log context and Log Center.
- Active-app summary now uses the same compact toast style as the existing match notification, instead of a tall UIAlertController.
- System notification no longer builds a long body then truncates it mid-sentence.
- Existing match notification method/body was not changed.
- No changes to Frida agent, request order, PICK/MPICK logic, reservation, response correlation, or SUCCESS/FAILED/UNKNOWN classification.

## Example for supplied case
Title: `⚠️ PICK LẺ ALL · 0/3 XÁC MINH`
Body:
`📦 3 đơn | ✅ 0 ❌ 0 ⚠️ 3 ⏭ 0`
`Server có response chưa đối chiếu được mã đơn.`

This deliberately does NOT claim success merely because the server returned code 0; without order correlation the 3 orders remain UNKNOWN.

## Tests
- All JavaScript syntax checks passed.
- All 10 Node.js test files passed, including new `batch-notification-ui.test.js`.
- `project.yml` YAML parse passed.
- `frida-agent.js` and `Sources/frida-agent-bundle.js` byte parity passed.
- Existing rebase integrity test passed (FridaController / Spawn / Attach baseline unchanged).
- Native Xcode build/device verification not available in this environment.
