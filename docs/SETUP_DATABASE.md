# Hướng dẫn: dựng dataset `dm_daily_brief` trên BigQuery

> Dataset này **tách riêng** khỏi `tmdatabase.dm_base_crm` (dataset CRM gốc, chỉ đọc) — dùng để chứa 2 bảng phục vụ workflow: `dim_course` (config khóa học, team tự sửa) và `brief_run_log` (log lại mỗi lần chạy để đối chiếu). Không ghi gì vào `dm_base_crm`.

---

## 🔴 Trạng thái (cập nhật 2026-08-23) — TẠM DỪNG

**Đã xong:** Bước 0–3 — dataset `dm_daily_brief` (location `us-central1`) + 2 bảng `dim_course` và `brief_run_log` đã tạo xong trên BigQuery.

**Đang chặn:** Bước 4 (gán quyền Service Account cho n8n) — hiện tại **không có quyền tạo Service Account** trên project. Tạm dừng ở đây, sẽ quay lại làm Bước 4–5 sau khi xin được quyền (IAM & Admin, hoặc nhờ người có quyền Owner/Admin trên project `tmdatabase` tạo giúp).

**Việc cần làm khi quay lại:** đọc Bước 4 bên dưới, tạo Service Account (hoặc dùng OAuth cá nhân tạm thời cho credential BigQuery trong n8n nếu muốn test trước khi có Service Account), sau đó sang Bước 5.

---

## Bước 0 — Kiểm tra region của `dm_base_crm`

BigQuery chỉ JOIN được các bảng **cùng region**. Trước khi tạo dataset mới:

1. Vào BigQuery Console → Explorer → mở dataset `tmdatabase.dm_base_crm` → tab **Details**.
2. Ghi lại giá trị **Data location** (ví dụ `asia-southeast1`, `US`...).

Dataset `dm_daily_brief` ở Bước 1 **phải tạo cùng location này** — nếu khác, mọi query JOIN `dim_course` với `deals` sẽ báo lỗi.

---

## Bước 1 — Tạo dataset `dm_daily_brief`

BigQuery Console → chọn project `tmdatabase` → nút **Create dataset**:

- Dataset ID: `dm_daily_brief`
- Location: **đúng bằng** location đã ghi ở Bước 0
- Default table expiration: để trống (không cần tự xoá)

Hoặc bằng SQL (chạy trong BigQuery Studio, sau khi đã biết location):

```sql
CREATE SCHEMA IF NOT EXISTS `tmdatabase.dm_daily_brief`
OPTIONS (location = 'us-central1');  -- đổi lại đúng location Bước 0
```

---

## Bước 2 — Đưa `dim_course` (Google Sheet) vào dataset này

Cách khuyến nghị: **Connected/External table trỏ thẳng vào Google Sheet** — team sửa trên Sheet, BigQuery đọc bản mới nhất ngay lần query sau, không cần đồng bộ tay.

1. Mở Google Sheet chứa `dim_course` → **Share** → thêm quyền **Viewer** cho email service account BigQuery sẽ dùng để chạy query (email dạng `...@tmdatabase.iam.gserviceaccount.com` — lấy ở IAM & Admin → Service Accounts; nếu bạn tự thao tác bằng tài khoản cá nhân trong Console thì bỏ qua bước share này).
2. Copy URL của Google Sheet.
3. BigQuery Console → dataset `dm_daily_brief` → **Create table**:
   - Source: **Drive**
   - Chọn **Select Drive URI** → dán URL Sheet
   - File format: **Google Sheet**
   - Destination table: `dm_daily_brief.dim_course`
   - Table type: **External table** (để tự sync theo Sheet — khuyến nghị) *hoặc* **Native table** nếu muốn "chốt cứng" 1 bản chụp tại thời điểm import (khi đó phải làm lại bước này mỗi lần Sheet đổi).
   - Schema: bỏ **Auto-detect**, khai tay theo đúng kiểu cột:

     | Tên cột | Kiểu |
     |---|---|
     | `course_key` | STRING |
     | `course_name` | STRING |
     | `course_type` | STRING |
     | `report_day` | INT64 |
     | `is_combo` | BOOLEAN |
     | `aliases` | STRING |
     | `is_active` | BOOLEAN |
     | `note` | STRING |

   - Trong phần **Sheet Range**, nếu Sheet của bạn có dòng tiêu đề ở hàng 1, tick **"Header rows to skip" = 1**.

   `report_day` chỉ dùng giá trị 2 (T2) đến 6 (T6) cho lịch Focus Group; không còn dùng giá trị 7.
4. Nhấn **Create table**.
5. Kiểm tra: chạy thử `SELECT * FROM \`tmdatabase.dm_daily_brief.dim_course\` LIMIT 10` — phải ra đúng dữ liệu đang có trên Sheet.

**Cập nhật lịch 2026-08-30:** trong Google Sheet nguồn, đổi `report_day` từ `7` thành `6` cho Flexible Combo 2/3/4 và B2B Training. Sau đó kiểm tra không còn khóa active ở ngày 7:

```sql
SELECT course_name, report_day
FROM `tmdatabase.dm_daily_brief.dim_course`
WHERE is_active AND report_day = 7;
```

Query phải trả về 0 dòng. Thứ 7 không lấy khóa từ `dim_course`; workflow chạy Q7 Weekly Performance trên toàn bộ khóa active.

⚠️ Lưu ý khi dùng External table trỏ Sheet: nếu ai đó merge cell, chèn dòng trống giữa bảng, hoặc đổi thứ tự cột trên Sheet, query sẽ lỗi hoặc lệch cột. Nên khoá cấu trúc cột (dùng Google Sheet "Protected ranges" cho hàng tiêu đề) để tránh hỏng workflow.

---

## Bước 3 — Tạo bảng `brief_run_log`

Bảng log lại mỗi lần workflow chạy, để đối chiếu khi cần debug ("hôm đó agent thấy số liệu gì mà viết ra kết luận này").

```sql
CREATE TABLE IF NOT EXISTS `tmdatabase.dm_daily_brief.brief_run_log` (
  run_id          STRING      NOT NULL,   -- UUID, sinh ở node Code trước khi query, dùng chung xuyên suốt workflow
  report_date     DATE,                   -- ngày được báo cáo (D-1) — tách riêng để lọc/join nhanh, không phải đào trong JSON
  sent_at         TIMESTAMP   NOT NULL,   -- thời điểm Final Brief được tạo/gửi
  query_results   STRING,                 -- toàn bộ kết quả Q0–Q7 (Build Payload), dạng JSON string
  agent_output    STRING,                 -- toàn văn bản brief cuối cùng (Assemble Brief) — những gì thực sự được gửi
  status          STRING,                 -- 'success' | 'error' — optional, hữu ích khi debug workflow lỗi giữa chừng
  error_message   STRING                  -- optional, chỉ có giá trị khi status = 'error'
)
PARTITION BY report_date
OPTIONS (
  description = "Log mỗi lần chạy Daily 5 Minutes Brief — dùng để đối chiếu số liệu Agent đã thấy vs. kết luận đã viết."
);
```

**Vì sao vài quyết định thiết kế:**

- `run_id` STRING (UUID) thay vì số tự tăng — BigQuery không có auto-increment thật, dùng `GENERATE_UUID()` ở node Code của n8n trước khi ghi log là đơn giản và đủ dùng.
- `report_date` (DATE) tách riêng ngoài yêu cầu gốc — để bạn lọc `WHERE report_date = '2026-08-22'` trực tiếp thay vì phải đào trong `query_results`. Có thể bỏ nếu không cần, `sent_at` vẫn đủ dùng nhưng kém tiện hơn khi tra cứu theo ngày.
- `PARTITION BY report_date` — miễn phí về mặt thiết kế (BigQuery tự quản lý), giúp query log của "1 ngày cụ thể" rẻ hơn nhiều so với quét cả bảng khi log tích luỹ lâu dài.
- `query_results`/`agent_output` dùng **STRING chứa JSON** (không dùng kiểu `JSON` gốc của BigQuery) — vì n8n BigQuery node ghi dữ liệu qua API dạng string/object đơn giản sẽ ổn định hơn, tránh lỗi kiểu dữ liệu khi insert. Đọc lại vẫn dùng được hàm JSON của BigQuery, ví dụ:
  ```sql
  SELECT run_id, JSON_VALUE(query_results, '$.kpi.leads_yesterday') AS leads_yesterday
  FROM `tmdatabase.dm_daily_brief.brief_run_log`
  WHERE report_date = '2026-08-22';
  ```
- `status`/`error_message` không nằm trong 4 cột bạn yêu cầu — thêm vì rẻ (2 cột STRING) và giúp phân biệt "hôm đó không gửi vì lỗi" với "hôm đó gửi nhưng không có gì bất thường", tránh hiểu nhầm khi nhìn log về sau. Bỏ được nếu bạn thấy không cần.

---

## Bước 4 — Quyền cho Service Account chạy n8n

Service Account BigQuery dùng cho credential n8n cần:

| Role | Phạm vi | Vì sao |
|---|---|---|
| BigQuery Data Viewer | `tmdatabase.dm_base_crm` | Đọc `deals`, `stages`, `pipelines`, `deal_activities` |
| BigQuery Data Viewer | `tmdatabase.dm_daily_brief` (bảng `dim_course`) | Đọc config khóa học |
| BigQuery Data Editor | `tmdatabase.dm_daily_brief` (bảng `brief_run_log`) | Ghi log mỗi lần chạy |
| BigQuery Job User | project `tmdatabase` | Chạy được query (mọi job BigQuery cần quyền này ở cấp project) |

Có thể gán 1 role duy nhất **BigQuery Data Editor + Job User ở cấp dataset `dm_daily_brief`** và **Data Viewer ở cấp dataset `dm_base_crm`** (thay vì cấp project) để service account không đọc/ghi được gì ngoài phạm vi cần — an toàn hơn.

---

## Bước 5 — Cập nhật node `Config` trong workflow

Sau khi xong Bước 1–3, giá trị `config_dataset` trong node `Config` (SPEC §5) đã đúng sẵn là:

```json
"config_dataset": "tmdatabase.dm_daily_brief"
```

Không cần sửa gì thêm — mọi query ở SPEC §3/§7 (`${CONFIG_DATASET}.dim_course`) sẽ tự trỏ đúng.

---

## Checklist nhanh

- [x] Xác nhận location của `dm_base_crm` (`us-central1`)
- [x] Tạo dataset `dm_daily_brief` cùng location
- [x] Tạo table `dim_course`
- [x] Chạy DDL tạo `brief_run_log`
- [x] Chạy thử `SELECT * FROM dim_course LIMIT 10` — đối chiếu đúng dữ liệu Sheet (nếu chưa kiểm tra, nên làm trước khi rời máy). Tôi đã chạy thử thành công
- [ ] 🔴 **Đang chặn:** tạo/gán quyền Service Account (Bước 4) — không có quyền, tạm dừng
- [ ] Cập nhật node `Config` (Bước 5) — làm sau khi xong Bước 4
