# Báo cáo cập nhật AutoPick Pro v6.6.7 — Pick lẻ ALL code:0

## Mục tiêu

Sửa trường hợp bật **Pick lẻ ALL** cho chùm đơn: mỗi đơn được gửi bằng một request riêng, nhưng response thành công từ server chỉ có `code: 0` và không có `delivery_order_id`. Không yêu cầu đối chiếu mã đơn cho trường hợp này.

## Thay đổi

### 1. Phân loại phản hồi Pick lẻ ALL

- Chỉ nhánh lựa chọn `PICK.SPLIT_ALL.SELECTED` truyền cờ `splitAllCodeOnlySuccess`.
- Khi response của nhánh này có `code: 0` nhưng không có mã đơn, agent ghi nhận đó là một response thành công của batch; không tăng `UNKNOWN` và không phát cảnh báo “response không có mã đơn”.
- Chỉ khi **tất cả request đã gửi đều nhận response `code: 0`**, số response thành công bằng số request đã handoff, và không có lỗi/timeout/handoff mơ hồ, agent mới chốt toàn bộ chùm là `SUCCESS`.
- Không gán một response không có mã vào một đơn ngẫu nhiên. Việc xác nhận được thực hiện ở cấp batch bằng số lượng response thành công.
- Thêm `codeOnlySuccessCount` vào dữ liệu tổng kết và log để truy vết.

Các trường hợp thiếu response, thiếu `code`, lỗi server, timeout hoặc handoff mơ hồ không bị tự động xem là thành công. Các batch khác và MPICK giữ nguyên cơ chế cũ.

### 2. Thông báo Pick lẻ ALL

Khi toàn bộ chùm thành công, nội dung hiển thị gọn:

```text
✅ PICK LẺ ALL · 3/3 THÀNH CÔNG
📦 3 đơn  |  ✅ 3 thành công
Đã Pick thành công toàn bộ đơn.
```

Không còn dòng `XÁC MINH`, `UNKNOWN` hoặc bộ đếm cảnh báo bằng 0 trong thông báo toàn thành công. Khi có kết quả không thành công, thông báo vẫn giữ các bộ đếm chẩn đoán.

### 3. Giữ nguyên phần khác

- Khối thông báo **đơn khớp** không thay đổi.
- Không thay đổi payload, thứ tự gửi request, điều kiện chọn đơn, reservation, Spawn/Attach hoặc luồng MPICK.
- Chi tiết theo từng đơn và log kỹ thuật vẫn được giữ trong Log Center.

## Các tệp được cập nhật

- `frida-agent.js`
- `Sources/frida-agent-bundle.js` (đồng bộ byte-for-byte với `frida-agent.js`)
- `Sources/APFMenu.m` (rút gọn thông báo toàn thành công)
- `tests/batch-summary.test.js`
- `tests/batch-notification-ui.test.js`

## Kiểm thử

- **10/10** tệp kiểm thử JavaScript: PASS.
- Bổ sung test hồi quy: 3 response `code: 0` không có `delivery_order_id` trong Pick lẻ ALL phải cho kết quả `3/3 SUCCESS`, `0 UNKNOWN`.
- Test batch thông thường vẫn giữ `UNKNOWN` khi response không thể đối chiếu mã đơn.
- `node --check`: 13/13 tệp JavaScript hợp lệ.
- Parse YAML workflow: PASS.
- `frida-agent.js` và `Sources/frida-agent-bundle.js`: giống nhau từng byte.
- Kiểm tra cấu trúc ZIP: PASS.

## Giới hạn xác minh

Môi trường tạo bản vá không có Xcode/iOS SDK, vì vậy chưa thể biên dịch Objective-C hoặc chạy giao diện trên thiết bị. Cần build lại bằng Xcode 15.4 và kiểm tra trên iPhone trước khi triển khai thực tế.
