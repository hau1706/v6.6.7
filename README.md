# AutoPick Pro v6.6.7 — Stability & Performance Update

Bản này được rebase từ mã nguồn v6.6.4 tại `https://github.com/hau1706/v6.6.4`.

## Bản phát hành

- App version: `6.6.7`
- Build: `74`
- Frida Core target trong workflow: `16.7.19`
- `Sources/FridaController.m` được giữ byte-for-byte từ baseline v6.6.4 để tránh lặp lại thay đổi native lifecycle từng gây lỗi Spawn/Attach.

## Thay đổi chính

### PICK / MPICK safety

- START không xóa `pickedIds`, `notifiedIds`, pending metadata hoặc batch còn chờ.
- Chỉ reset bộ đếm phiên khi không còn request đang chờ hoặc UNKNOWN.
- SINGLE, MPICK và batch phân biệt lỗi chuẩn bị trước handoff với lỗi xảy ra sau khi bắt đầu handoff.
- Lỗi chắc chắn trước handoff: giải phóng reservation vì request chưa được gửi.
- Lỗi sau khi bắt đầu handoff: đánh dấu UNKNOWN, giữ reservation và không tự gửi lại.
- Timeout không còn bị coi là thất bại. Reservation và busy gate được giữ đến khi response muộn giải quyết request.
- Khi batch không gửi được request nào, reservation nhóm cũng được giải phóng; nếu đã có request gửi/UNKNOWN thì giữ khóa nhóm để tránh gửi lặp.
- Response batch không có mã đơn cụ thể được tính vào số response nhưng không gán nhầm cho một ID.

**Lưu ý vận hành:** nếu server không bao giờ phản hồi, PICK sẽ giữ trạng thái UNKNOWN và Auto Pick không tự gửi đơn mới để tránh trùng. Refresh vẫn tiếp tục. Nếu agent bị unload/reload trước khi response đến, trạng thái runtime chưa có journal bền vững qua lần reload; hãy đối chiếu trạng thái đơn trên app tài xế trước khi bật Auto Pick lại.

### Refresh / backoff

- Refresh tiếp tục hoạt động độc lập khi PICK đang chờ; vẫn single-flight, không gửi chồng refresh.
- HTTP 503: hai lỗi liên tiếp đầu tiên giữ nguyên chu kỳ cấu hình; từ lần thứ ba bắt đầu backoff 500 ms, sau đó tăng gấp đôi đến tối đa 8 giây.
- HTTP 429 và các lỗi 5xx khác: backoff từ 1 giây, tăng gấp đôi đến tối đa 15 giây.
- Đọc và tôn trọng `Retry-After` (giới hạn tối đa 60 giây).
- Chỉ xóa backoff khi response JSON hợp lệ được xử lý; không xóa chỉ vì callback HTTP đã chạy.

### Verbose filter log

Khi bật `verboseLog`, các đơn không đạt bộ lọc hiển thị:

- Mã đơn.
- Quãng đường theo km.
- Giá theo định dạng VND.
- Lý do loại (giá, khoảng cách, COD, danh mục, quận, chế độ chỉ pick chùm hoặc MinDistance).

Log cùng một mã đơn/lý do được throttle trong 10 giây và bảng throttle có giới hạn 512 mục để không tăng vô hạn.

### Memory / response buffers

- Chunk buffer tái sử dụng cùng mảng; không sao chép `chunks.slice()` ở mỗi callback.
- Ghép response một lần khi hoàn chỉnh.
- Giới hạn 2.048 chunk cho mỗi response buffer.
- Duy trì giới hạn từng stream và tổng 6 Mi UTF-16 code units.
- Giải phóng dữ liệu không gửi được; giữ metadata/reservation khi kết quả handoff chưa xác định.

## Quy tắc nghiệp vụ được giữ nguyên

Các điều kiện lọc giá, khoảng cách, COD, khu vực/quận, danh mục, đơn lẻ/chùm, Pick lẻ ALL trong chùm và thuật toán chọn đơn có điểm giá cao nhất không được thay đổi. Test differential so sánh 500 cấu hình/dữ liệu giả lập với fixture v6.6.4.

## Kiểm thử cục bộ

```sh
node --check frida-agent.js
node --check Sources/frida-agent-bundle.js
node tests/assignment-flow.test.js
node tests/assignment-history.test.js
node tests/batch-notification-ui.test.js
node tests/batch-summary.test.js
node tests/refresh-lifecycle.test.js
node tests/rebase-integrity.test.js
node tests/v667-safety-verbose.test.js
php -l server/receive-orders.php
cc -O1 -Wall -o /tmp/gunzip_test tests/native/gunzip_logic_test.c -lz && /tmp/gunzip_test
```

## Giới hạn xác minh

Môi trường tạo gói không có macOS/Xcode/iOS SDK và thiết bị iPhone. Vì vậy test JavaScript/PHP/GZIP và kiểm tra source đã chạy, nhưng chưa có Xcode compile/link, IPA, Spawn/Attach trên iPhone, benchmark RAM/RSS hoặc latency P50/P95/P99 trên mạng thực. Native controller được xác nhận giống baseline v6.6.4 bằng SHA-256; đây không thay thế bài test runtime trên thiết bị.


## Logging Pro v2 — Batch PICK result summary

The Logging Pro v2 patch adds a single summary notification for Pick-lẻ ALL batches. Each delivery order is tracked independently as `SUCCESS`, `FAILED`, `UNKNOWN`, or `NOT_SENT`. A server response is only assigned to an order when its `delivery_order_id` can be correlated safely. Missing/invalid response codes, ambiguous handoffs, timeouts, and uncorrelated responses remain `UNKNOWN`; they are never automatically replayed.

The summary popup contains per-order statuses and aggregate counts. Unknown items keep the PICK single-flight gate closed until a late correlated response resolves them or the operator reconciles the state.

See [LOGGING-PRO-V2-REPORT.md](LOGGING-PRO-V2-REPORT.md) for event codes, safety invariants, test results, and native-build limitations.
