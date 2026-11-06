# Cài receiver PHP trên phau.io.vn

1. Upload `server/receive-orders.php` lên document root của domain để URL thành `https://phau.io.vn/receive-orders.php`.
2. Mở file trên hosting và thay giá trị `AUTOPICK_UPLOAD_TOKEN` bằng secret ngẫu nhiên dài ít nhất 32 ký tự. Có thể tạo bằng lệnh `openssl rand -hex 32`. Không chia sẻ token công khai.
3. Trong app AutoPick Pro v6.6.4, mở **Cấu hình → Token upload**, nhập đúng token vừa đặt.
4. Bật **Lấy dữ liệu đơn lên host**. Tính năng mặc định tắt; khi tắt app không gửi response lên server.
5. Mở màn hình tài xế/đơn đã nhận để app nhận response từ `/api/v6/delivery/get-order-list`. Chỉ response HTTP 200, API `code: 0` và `data.orders` không rỗng mới được gửi.

## Dữ liệu được lưu

Mỗi upload ghi đè atomically file `autopick-private-data/orders-latest.json`. PHP cố gắng đặt thư mục này ở bên ngoài `DOCUMENT_ROOT` để không thể tải trực tiếp qua URL. Hosting cần cho PHP quyền tạo thư mục bên cạnh document root; nếu hosting khóa quyền đó, cần đổi `$storageDirectory` sang một thư mục riêng tư mà nhà cung cấp hosting cho phép và không công khai nó.

Endpoint yêu cầu POST, JSON và header `X-AutoPick-Token`. Token không hợp lệ bị từ chối; response có danh sách `orders` trống hoặc API code khác 0 cũng bị từ chối. Receiver không ghi raw payload vào error log.

**Quyền riêng tư:** response mẫu chứa số điện thoại, tên liên hệ, địa chỉ và tọa độ. Khi bật tính năng, những dữ liệu đó được gửi đến host của bạn. Chỉ bật khi bạn có quyền thu thập/xử lý dữ liệu này và bảo vệ token cũng như hosting.

## Kiểm tra an toàn

- `GET /receive-orders.php` phải trả HTTP 405.
- POST thiếu token hoặc token sai phải trả HTTP 401.
- Response JSON có `data.orders: []` phải trả HTTP 422 và không thay file cũ.
- POST hợp lệ có token và `data.orders` không rỗng phải trả HTTP 200 và ghi đè file JSON mới nhất.
