# Database Schema & Business Rules — `dm_base_crm`

> **Mục đích file:** đây là tài liệu duy nhất mà AI Agent (node trong luồng n8n) đọc để **sinh SQL BigQuery** cho hệ thống *Daily 5 Minutes Brief*. File gồm 3 phần: (1) schema kỹ thuật, (2) business rules đã được Data Owner xác nhận — **bắt buộc tuân thủ**, (3) mẫu SQL sẵn dùng.
>
> **Nguồn schema:** `results-20260813-135848.xlsx` (7 bảng). Constraint/uniqueness không được export nên PK/FK ghi là **candidate**.
> **Nguồn business rules:** Data Owner xác nhận vòng 1 và vòng 2, ngày 2026-08-19 (mục 4).
> **Quy ước:** ✅ = đã xác nhận, dùng được. 🚫 = **cấm dùng** trong query. ⚠️ = còn cần làm rõ (xem mục 8–9).

---

## 0. TL;DR cho Agent viết SQL

Đọc 12 dòng này trước, phần còn lại là chi tiết:

1. Project: `tmdatabase`. Dataset: `dm_base_crm`. Luôn ghi full path: `` `tmdatabase.dm_base_crm.<table>` ``.
2. Bảng trung tâm là `deals` (1 row = 1 deal = 1 lead). Hầu hết câu hỏi nghiệp vụ giải quyết được **chỉ với `deals` + `stages` + `pipelines`**.
3. **Hai time dimension, dùng đúng chỗ:**
   - Chỉ số **đầu phễu** (Lead mới, MQL, SQL Discovery, SQL Need-fit) → đếm theo `deals.created_at`.
   - Chỉ số **kết quả** (Won, Lost, Revenue, Conversion Rate) → đếm theo `deals.closed_at`. ✅ Data Owner chốt.
4. `deals.deal_status` ∈ {`won`, `lost`, `open`} — **luôn viết thường, không có NULL** (đã xác nhận trên dữ liệu thật).
5. Doanh thu = `SUM(deal_value)` với `deal_status = 'won'`, quy về **ngày `closed_at`**. Đơn vị **VND thô, không nhân hệ số**, không có deal ngoại tệ.
6. Conversion Rate = `won / (won + lost)` trên các deal đóng trong kỳ (`closed_at`) — **mẫu số KHÔNG bao gồm `open`**.
7. MQL / SQL Discovery / SQL Need-fit xác định bằng `deals.stage_id` (mục 4.3), đếm trên **toàn bộ deal** tạo trong kỳ, **không lọc theo `deal_status`**.
8. **Phạm vi:** toàn bộ pipeline, không loại trừ pipeline nào.
9. **Kỳ so sánh chuẩn của bản tin:** trung bình 7 ngày gần nhất (D-7…D-1) vs 7 ngày liền trước (D-14…D-8) — xem mục 4.8.
10. 🚫 **Không dùng bất kỳ cột nào bắt đầu bằng `pipedrive_`** — chỉ để tham chiếu lịch sử khi đổi CRM.
11. 🚫 Không dùng các cột `status` dạng số (`account_status`, `deal_activities.status`, `stages.status`), `currency_id`, `creator_id`, `stages.user_id`.
12. Danh sách 🚫 đầy đủ ở mục 4.7 — đọc trước khi viết `SELECT`.

---

## 1. Database Overview

**project_id:** `tmdatabase` — **dataset:** `dm_base_crm`

Schema mô tả một CRM phục vụ bán khóa học: **account/doanh nghiệp, contact/khách hàng, deal (lead/cơ hội bán hàng), pipeline–stage, activity và user/nhân sự tư vấn**. `deals` là fact trung tâm; `accounts`, `contacts`, `pipelines`, `stages`, `users` là dimension/lookup; `deal_activities` là bảng event theo deal.

### Các bảng

| Table | Loại | Grain | Vai trò | Mức độ dùng cho Daily Brief |
|---|---|---|---|---|
| `deals` | FACT | 1 row ≈ 1 deal / 1 lead | Deal/lead chính: trạng thái bán hàng, giá trị, stage, attribution UTM, khóa học, thông tin form đăng ký. | **Chính** |
| `stages` | DIMENSION / LOOKUP | 1 row ≈ 1 stage | Danh mục stage thuộc từng pipeline; nguồn để đặt tên MQL/SQL. | **Chính** |
| `pipelines` | DIMENSION / LOOKUP | 1 row ≈ 1 pipeline | Danh mục pipeline bán hàng. | **Chính** |
| `users` | DIMENSION | 1 row ≈ 1 user | Nhân sự CRM (sales/tư vấn viên) — dùng để hiển thị tên owner. | Thấp (bản tin không breakdown theo nhân sự) |
| `contacts` | DIMENSION | 1 row ≈ 1 contact | Hồ sơ khách hàng cá nhân: học vấn, nghề nghiệp, nhu cầu. | Trung bình (segmentation) |
| `accounts` | DIMENSION | 1 row ≈ 1 doanh nghiệp | Account/tổ chức (mảng B2B). | Thấp |
| `deal_activities` | FACT / EVENT | 1 row ≈ 1 activity của 1 deal | Activity/tương tác gắn với deal. | Thấp – Trung bình |

### Database map

```text
users ─────┬──────────────> accounts        (account_owner_id)
           ├──────────────> contacts        (contact_owner_id)
           ├──────────────> deals           (deal_owner_id)
           └──────────────> deal_activities (user_id)
           ✗ stages.user_id — ý nghĩa không xác định, KHÔNG dùng

accounts ────────────────> contacts         (account_id, INT64 = INT64 ✅)
accounts ────────────────> deals            (account_id, STRING ↔ INT64 ⚠️ cần CAST)
contacts ────────────────> deals            (contact_id, STRING ↔ INT64 ⚠️ cần CAST)
pipelines ───────────────> stages ─────> deals
pipelines ─────────────────────────────> deals
deals ────────────────────────────────> deal_activities
```

### Critical join warnings

1. **Datatype mismatch:** `accounts.account_id` và `contacts.contact_id` là `INT64`, trong khi `deals.account_id` và `deals.contact_id` là `STRING`. **Bắt buộc dùng `SAFE_CAST(d.contact_id AS INT64)`**, không JOIN trực tiếp.
2. **Không JOIN bằng tên/email:** `account_name`, `contact_name`, `customer_name`, `email`, `customer_email` là thuộc tính denormalized, chỉ để hiển thị.
3. **`deal_activities` là grain nhiều dòng trên một deal:** JOIN trực tiếp vào `deals` sẽ nhân số dòng (fan-out). Phải aggregate theo `deal_id` trong CTE trước.
4. **Nhiều field số/ngày đang lưu STRING** (`product_quantity`, `product_amount`, `birth_year`, `deal_created_at_form`...): phần lớn nằm trong danh sách 🚫 không dùng; nếu buộc phải dùng thì luôn `SAFE_CAST`.
5. **`stage_id` phải đi kèm `pipeline_id`** khi phân tích funnel — các pipeline khác nhau có stage trùng tên.

---

## 2. Table specifications

### 2.1. Table `deals` — bảng chính

**Full name:** `tmdatabase.dm_base_crm.deals`
**Type:** FACT · **Grain:** 1 row ≈ 1 deal (≡ 1 lead) · **PK candidate:** `deal_id`
**Description:** Deal/cơ hội bán hàng — đơn vị phân tích chính của toàn hệ thống. Mỗi deal tương ứng một lead do khách hàng để lại (qua form đăng ký khóa học hoặc do sales tạo), mang trạng thái bán hàng (`deal_status`), vị trí trong funnel (`stage_id`), giá trị (`deal_value`), nguồn marketing (`utm_*`), khóa học quan tâm/đăng ký và các thông tin khách hàng tự khai trong form.

#### Columns

| Column | Data type | Description | Key / relationship | Dùng được? |
|---|---|---|---|---|
| `deal_id` | `INT64` | Mã định danh deal/lead. | PK candidate | ✅ |
| `deal_name` | `STRING` | Tên deal. |  | ✅ |
| `deal_value` | `INT64` | **Giá trị deal — cột duy nhất dùng để tính doanh thu.** Đơn vị **VND thô** (không nhân hệ số nghìn/triệu). Toàn bộ deal đều là VND, không cần quy đổi ngoại tệ. Chỉ cộng dồn khi `deal_status = 'won'`. |  | ✅ |
| `deal_status` | `STRING` | **Trạng thái deal, chỉ có 3 giá trị: `won`, `lost`, `open`** — đã xác nhận trên dữ liệu thật: **luôn viết thường và không có dòng NULL**. Nền tảng của mọi KPI kết quả. |  | ✅ |
| `stage_id` | `INT64` | **Stage hiện tại của deal.** Nghiệp vụ dùng cột này để xác định lead là MQL / SQL Discovery / SQL Need-fit (mục 4.3). | FK → `stages.stage_id` | ✅ |
| `pipeline_id` | `INT64` | Pipeline chứa deal. Luôn dùng kèm `stage_id`. | FK → `pipelines.pipeline_id` | ✅ |
| `deal_owner_id` | `INT64` | Nhân sự phụ trách deal (sales/tư vấn). | FK → `users.user_id` | ✅ |
| `created_at` | `DATETIME` | **Thời điểm nghiệp vụ lead được tạo.** Time dimension mặc định cho báo cáo "lead mới theo ngày". |  | ✅ |
| `closed_at` | `DATETIME` | **Thời điểm deal được đóng — áp dụng cho CẢ won và lost.** Dùng cho báo cáo doanh thu/kết quả theo ngày đóng. |  | ✅ |
| `stage_start_at` | `DATETIME` | Thời điểm deal **bắt đầu stage hiện tại** (`stage_id`). Dùng để tính "số ngày nằm ở stage hiện tại"/deal ứ đọng. Bảng chỉ lưu current stage nên **không dựng được stage history** từ cột này. ⚠️ Hành vi của cột với deal đã đóng chưa xác nhận → **chỉ dùng cho deal `open`**. |  | ✅ (chỉ deal open) |
| `updated_at` | `DATETIME` | Lần cập nhật bản ghi gần nhất. |  | ✅ |
| `expected_close_at` | `DATETIME` | Ngày dự kiến đóng deal. |  | ✅ |
| `expected_deadline_at` | `DATETIME` | Deadline dự kiến của deal. |  | ✅ |
| `failed_reason_id` | `STRING` | Mã lý do deal thất bại. | ⚠️ chưa có bảng mapping | ✅ (raw) |
| `failed_content` | `STRING` | Mô tả chi tiết lý do thất bại (text tự do). |  | ✅ |
| `failed_info` | `STRING` | Thông tin bổ sung về nguyên nhân thất bại. |  | ✅ |
| `pending_reason` | `STRING` | Lý do deal đang pending. |  | ✅ |
| `pending_reason_detail` | `STRING` | Chi tiết lý do pending. |  | ✅ |
| `next_step` | `STRING` | Bước tiếp theo được sales ghi nhận. |  | ✅ |
| `note` | `STRING` | Ghi chú nội bộ của deal. |  | ✅ |
| `labels` | `STRING` | Nhãn/tag gắn với deal. |  | ✅ |
| `probability` | `INT64` | Xác suất thắng deal (thang đo ⚠️ chưa xác nhận). |  | ✅ (thận trọng) |
| `market_id` | `INT64` | ID thị trường/nhóm thị trường. Không có bảng lookup. |  | ✅ (raw) |
| `currency_id` | `INT64` | Mã tiền tệ. **Bỏ qua — toàn bộ deal là VND.** |  | 🚫 |
| `account_id` | `STRING` | Account/doanh nghiệp của deal. | FK → `accounts.account_id` (**STRING ↔ INT64**) | ✅ qua `SAFE_CAST` |
| `contact_id` | `STRING` | Contact/khách hàng của deal. | FK → `contacts.contact_id` (**STRING ↔ INT64**) | ✅ qua `SAFE_CAST` |
| `creator_id` | `STRING` | ID người tạo deal. Về kỹ thuật join được sang `users.user_id`, nhưng **nghiệp vụ không dùng** và **không phân biệt được lead tự đăng ký vs lead sales tạo tay** qua cột này. |  | 🚫 |
| `account_name` | `STRING` | Tên account (denormalized) — chỉ hiển thị. |  | ✅ display-only |
| `contact_name` | `STRING` | Tên contact (denormalized) — chỉ hiển thị. |  | ✅ display-only |
| `customer_name` | `STRING` | Tên khách hàng (denormalized). PII. |  | ✅ display-only |
| `customer_email` | `STRING` | Email khách hàng. **PII** — hạn chế đưa vào output. |  | ⚠️ PII |
| `facebook_link` | `STRING` | URL Facebook khách hàng. **PII**. |  | ⚠️ PII |
| `interested_course` | `STRING` | Khóa học khách hàng quan tâm (nhu cầu ban đầu). **Data Owner xác nhận (2026-08-23): đây là tên hiển thị trên landing page, thay đổi khá nhiều/không chuẩn hóa → KHÔNG dùng cột này để báo cáo/phân tích.** Mọi thống kê "khóa học" (kể cả phía lead mới) đều dùng `selected_course`. |  | 🚫 (chỉ giữ raw, không dùng cho reporting) |
| `selected_course` | `STRING` | **Khóa học cuối cùng khách hàng chọn và đăng ký trong lead này.** Đây là cột dùng khi hỏi "khách mua khóa gì". |  | ✅ |
| `class_code` | `STRING` | Mã lớp. |  | ✅ |
| `learning_mode` | `STRING` | Hình thức học (online/offline...). |  | ✅ |
| `promotion_code` | `STRING` | Mã chương trình/ưu đãi. |  | ✅ |
| `gift` | `STRING` | Quà tặng đi kèm deal. |  | ✅ |
| `expectation` | `STRING` | Kỳ vọng/mục tiêu khách hàng khai trong form. |  | ✅ |
| `utm_source` | `STRING` | Nguồn traffic/marketing. |  | ✅ |
| `utm_medium` | `STRING` | Phương tiện/kênh marketing. |  | ✅ |
| `utm_campaign` | `STRING` | Tên/mã campaign. |  | ✅ |
| `utm_content` | `STRING` | Biến thể nội dung/quảng cáo. |  | ✅ |
| `utm_product` | `STRING` | UTM tùy biến cho sản phẩm/khóa học. |  | ✅ |
| `utm_person` | `STRING` | UTM tùy biến cho nguồn cá nhân. |  | ✅ |
| `is_alumni` | `STRING` | **Khách hàng tự điền khi đăng ký khóa học** — cho biết có phải học viên cũ không. Giá trị là text tự do, phải `LOWER()`/`TRIM()` và gom nhóm trước khi đếm. |  | ✅ (chuẩn hóa trước) |
| `has_pain_point` | `STRING` | Khách hàng tự điền trong form. Text tự do. |  | ✅ (chuẩn hóa trước) |
| `has_follow_up` | `STRING` | Khách hàng tự điền trong form. Text tự do. |  | ✅ (chuẩn hóa trước) |
| `need_consulting` | `STRING` | Khách hàng tự điền trong form — có cần tư vấn không. Text tự do. |  | ✅ (chuẩn hóa trước) |
| `group_registration` | `STRING` | Khách hàng tự điền trong form — đăng ký theo nhóm. Text tự do. |  | ✅ (chuẩn hóa trước) |
| `work_location` | `STRING` | Địa điểm làm việc của khách hàng. |  | ✅ |
| `birth_year` | `STRING` | Năm sinh (STRING). Cần `SAFE_CAST(... AS INT64)`. |  | ⚠️ cast |
| `consulting_time` | `STRING` | Thời gian tư vấn, format tự do. |  | ⚠️ format chưa rõ |
| `citizen_id` | `STRING` | Số CCCD. **PII nhạy cảm — KHÔNG đưa vào SELECT/prompt/output.** |  | 🚫 PII |
| `bank_statement` | `STRING` | Thông tin sao kê/thanh toán. **Nhạy cảm — không đưa vào output.** |  | 🚫 PII |
| `product_quantity` | `STRING` | Số lượng sản phẩm. **Nghiệp vụ không dùng.** |  | 🚫 |
| `product_amount` | `STRING` | Số tiền sản phẩm. **Không dùng — doanh thu lấy từ `deal_value`.** |  | 🚫 |
| `deal_created_at_form` | `STRING` | Thời điểm tạo từ form (STRING). **Không dùng — dùng `created_at`.** |  | 🚫 |
| `pipedrive_note` | `STRING` | Ghi chú đồng bộ từ Pipedrive. |  | 🚫 |
| `pipedrive_contact_id` | `STRING` | ID contact trên Pipedrive. |  | 🚫 |
| `pipedrive_organization_id` | `STRING` | ID organization trên Pipedrive. |  | 🚫 |
| `pipedrive_deal_id` | `STRING` | ID deal trên Pipedrive. |  | 🚫 |
| `pipedrive_won_time` | `STRING` | Thời điểm won theo Pipedrive. **Không dùng — dùng `closed_at`.** |  | 🚫 |
| `pipedrive_lost_time` | `STRING` | Thời điểm lost theo Pipedrive. **Không dùng — dùng `closed_at`.** |  | 🚫 |
| `pipedrive_lost_reason` | `STRING` | Lý do lost theo Pipedrive. |  | 🚫 |

> **Quy tắc `pipedrive_*`:** toàn bộ nhóm cột này là dữ liệu di trú từ CRM cũ, **chỉ giữ để tham chiếu khi đổi CRM**. Agent tuyệt đối không đưa vào `SELECT`, `WHERE`, `JOIN` hay `ORDER BY`.

#### Relationships (candidate)

| From | To | Confidence | Note |
|---|---|---|---|
| `deals.pipeline_id` | `pipelines.pipeline_id` | HIGH | Deal thuộc pipeline. |
| `deals.stage_id` | `stages.stage_id` | HIGH | Deal thuộc stage hiện tại. |
| `deals.deal_owner_id` | `users.user_id` | HIGH | Owner/sales phụ trách deal. |
| `deals.account_id` | `accounts.account_id` | MEDIUM | STRING ↔ INT64 → `SAFE_CAST`. |
| `deals.contact_id` | `contacts.contact_id` | MEDIUM | STRING ↔ INT64 → `SAFE_CAST`. |

---

### 2.2. Table `stages`

**Full name:** `tmdatabase.dm_base_crm.stages`
**Type:** DIMENSION / LOOKUP · **Grain:** 1 row ≈ 1 stage · **PK candidate:** `stage_id`
**Description:** Danh mục stage của từng pipeline. Đây là bảng tra cứu ý nghĩa của `deals.stage_id` — nền tảng để diễn giải funnel MQL → SQL Discovery → SQL Need-fit và để đặt tên stage trong báo cáo.

| Column | Data type | Description | Key / relationship | Dùng được? |
|---|---|---|---|---|
| `stage_id` | `INT64` | Mã stage. | PK candidate | ✅ |
| `name` | `STRING` | Tên stage — dùng để hiển thị trong báo cáo. |  | ✅ |
| `pipeline_id` | `INT64` | Pipeline chứa stage. | FK → `pipelines.pipeline_id` | ✅ |
| `order_nr` | `INT64` | Thứ tự stage trong pipeline — dùng để sắp xếp funnel theo đúng chiều. |  | ✅ |
| `user_id` | `INT64` | **Ý nghĩa nghiệp vụ không xác định** — Data Owner xác nhận đây KHÔNG phải nhân viên tư vấn. **Bỏ qua hoàn toàn.** Muốn biết người phụ trách lead thì dùng `deals.deal_owner_id`. |  | 🚫 |
| `add_time` | `TIMESTAMP` | Thời điểm stage được thêm vào hệ thống nguồn. |  | ✅ |
| `update_time` | `TIMESTAMP` | Thời điểm stage được cập nhật. |  | ✅ |
| `status` | `INT64` | Mã trạng thái stage — **nghiệp vụ không dùng, bỏ qua.** |  | 🚫 |
| `_loaded_at` | `TIMESTAMP` | Thời điểm load vào warehouse (metadata ETL). |  | 🚫 |

---

### 2.3. Table `pipelines`

**Full name:** `tmdatabase.dm_base_crm.pipelines`
**Type:** DIMENSION / LOOKUP · **Grain:** 1 row ≈ 1 pipeline · **PK candidate:** `pipeline_id`
**Description:** Danh mục pipeline bán hàng. Dùng để lấy tên pipeline cho `deals.pipeline_id` và để nhóm/lọc báo cáo theo dòng sản phẩm hoặc đội bán hàng.

| Column | Data type | Description | Key / relationship | Dùng được? |
|---|---|---|---|---|
| `pipeline_id` | `INT64` | Mã pipeline. | PK candidate | ✅ |
| `name` | `STRING` | Tên pipeline. |  | ✅ |
| `add_time` | `TIMESTAMP` | Thời điểm pipeline được thêm. |  | ✅ |
| `update_time` | `TIMESTAMP` | Thời điểm cập nhật gần nhất. |  | ✅ |

---

### 2.4. Table `users`

**Full name:** `tmdatabase.dm_base_crm.users`
**Type:** DIMENSION · **Grain:** 1 row ≈ 1 user · **PK candidate:** `user_id`
**Description:** Nhân sự sử dụng CRM (chủ yếu là sales/tư vấn viên). Là dimension chung cho mọi cột `*_owner_id` / `user_id` ở các bảng khác. Dùng để hiển thị tên người phụ trách trong báo cáo hiệu suất.

| Column | Data type | Description | Key / relationship | Dùng được? |
|---|---|---|---|---|
| `user_id` | `INT64` | Mã nhân sự. | PK candidate | ✅ |
| `username` | `STRING` | Tên đăng nhập/tên hiển thị. |  | ✅ |
| `first_name` | `STRING` | Tên. |  | ✅ |
| `last_name` | `STRING` | Họ. |  | ✅ |
| `job_title` | `STRING` | Chức danh. |  | ✅ |
| `manager` | `STRING` | Quản lý trực tiếp. ⚠️ chưa rõ là tên, email hay ID → không dùng làm join key. |  | ⚠️ |
| `email` | `STRING` | Email nội bộ. |  | ✅ |
| `phone_number` | `STRING` | Số điện thoại. PII. |  | ⚠️ PII |
| `current_address` | `STRING` | Địa chỉ. PII. |  | ⚠️ PII |
| `date_of_birth` | `STRING` | Ngày sinh (STRING). |  | ⚠️ PII |

> Tên hiển thị nên dựng bằng `COALESCE(NULLIF(TRIM(CONCAT(COALESCE(last_name,''),' ',COALESCE(first_name,''))),''), username, CAST(user_id AS STRING))`.

---

### 2.5. Table `contacts`

**Full name:** `tmdatabase.dm_base_crm.contacts`
**Type:** DIMENSION · **Grain:** 1 row ≈ 1 contact · **PK candidate:** `contact_id`
**Description:** Hồ sơ khách hàng cá nhân: thông tin liên hệ, học vấn, nghề nghiệp, nhu cầu và pain point. Dùng để **segmentation** (theo trường, nơi làm việc, ngành, mục đích học) khi phân tích deal, không dùng để đo kết quả bán hàng.

| Column | Data type | Description | Key / relationship | Dùng được? |
|---|---|---|---|---|
| `contact_id` | `INT64` | Mã contact. | PK candidate | ✅ |
| `customer_name` | `STRING` | Tên khách hàng. PII. |  | ✅ display-only |
| `email` | `STRING` | Email liên hệ. **PII.** |  | ⚠️ PII |
| `primary_phone` | `STRING` | Số điện thoại chính. **PII.** |  | ⚠️ PII |
| `contact_owner_id` | `INT64` | Nhân sự phụ trách contact. | FK → `users.user_id` | ✅ |
| `account_id` | `INT64` | Doanh nghiệp của contact. | FK → `accounts.account_id` (INT64 = INT64, join trực tiếp được) | ✅ |
| `account_name` | `STRING` | Tên account (denormalized). |  | ✅ display-only |
| `date_of_birth` | `STRING` | Ngày sinh (STRING) — cần parse trước khi tính tuổi. **PII.** |  | ⚠️ |
| `learning_purpose` | `STRING` | Mục đích học tập. |  | ✅ |
| `location` | `STRING` | Khu vực của khách hàng. |  | ✅ |
| `university` | `STRING` | Trường đại học. |  | ✅ |
| `academic_year` | `STRING` | Niên khóa/năm học. ⚠️ định nghĩa chưa rõ. |  | ⚠️ |
| `workplace` | `STRING` | Nơi làm việc hiện tại. |  | ✅ |
| `company_size` | `STRING` | Quy mô công ty của khách hàng. |  | ✅ |
| `industry` | `STRING` | Ngành nghề. |  | ✅ |
| `why_tm` | `STRING` | Lý do khách hàng chọn/quan tâm Tomorrow Marketers. |  | ✅ |
| `pain_point` | `STRING` | Pain point của khách hàng. |  | ✅ |
| `brand_awareness` | `STRING` | Nguồn/mức độ nhận biết thương hiệu. ⚠️ chưa có coding. |  | ⚠️ |
| `facebook_profile` | `STRING` | Profile Facebook. **PII.** |  | ⚠️ PII |
| `operation_stage_id` | `INT64` | Stage vận hành của contact. **Không có bảng lookup → không diễn giải được, không dùng.** |  | 🚫 |
| `customer_course` | `STRING` | Kết quả form khảo sát đầu vào. **Không dùng — thông tin khóa học lấy từ `deals.selected_course` / `deals.interested_course`.** |  | 🚫 |
| `created_at` | `DATETIME` | Thời điểm nghiệp vụ contact được tạo. |  | ✅ |
| `updated_at` | `DATETIME` | Lần cập nhật gần nhất. |  | ✅ |
| `pipedrive_person_id` | `STRING` | ID person trên Pipedrive. |  | 🚫 |
| `pipedrive_account_id` | `STRING` | ID organization trên Pipedrive. |  | 🚫 |

---

### 2.6. Table `accounts`

**Full name:** `tmdatabase.dm_base_crm.accounts`
**Type:** DIMENSION · **Grain:** 1 row ≈ 1 account/doanh nghiệp · **PK candidate:** `account_id`
**Description:** Thông tin doanh nghiệp/tổ chức trong CRM, phục vụ mảng B2B (đào tạo doanh nghiệp). Dùng để segment deal theo ngành, quy mô, thị trường.

| Column | Data type | Description | Key / relationship | Dùng được? |
|---|---|---|---|---|
| `account_id` | `INT64` | Mã account. | PK candidate | ✅ |
| `account_name` | `STRING` | Tên doanh nghiệp. |  | ✅ |
| `domain` | `STRING` | Domain doanh nghiệp. |  | ✅ |
| `website` | `STRING` | Website. |  | ✅ |
| `brand_name` | `STRING` | Tên thương hiệu. |  | ✅ |
| `industry` | `STRING` | Ngành nghề. |  | ✅ |
| `business_domain` | `STRING` | Mảng kinh doanh. |  | ✅ |
| `company_size` | `STRING` | Quy mô doanh nghiệp. |  | ✅ |
| `account_owner_id` | `INT64` | Nhân sự phụ trách account. | FK → `users.user_id` | ✅ |
| `market_id` | `INT64` | ID thị trường. Không có lookup. |  | ✅ (raw) |
| `currency_id` | `INT64` | Mã tiền tệ. **Bỏ qua — toàn bộ giá trị là VND.** |  | 🚫 |
| `account_value` | `NUMERIC` | Giá trị account. **Không dùng cho doanh thu — doanh thu lấy từ `deals.deal_value`.** |  | 🚫 |
| `address` | `STRING` | Địa chỉ. |  | ✅ |
| `latitude` | `FLOAT64` | Vĩ độ. |  | ✅ |
| `longitude` | `FLOAT64` | Kinh độ. |  | ✅ |
| `facebook` | `STRING` | Trang Facebook. |  | ✅ |
| `linkedin_profile` | `STRING` | LinkedIn. |  | ✅ |
| `tax_code` | `STRING` | Mã số thuế. Nhạy cảm. |  | ⚠️ |
| `invoice_email` | `STRING` | Email hóa đơn. Nhạy cảm. |  | ⚠️ |
| `description` | `STRING` | Mô tả bổ sung. |  | ✅ |
| `account_stage_id` | `INT64` | Stage của account. **Không có lookup → không dùng.** |  | 🚫 |
| `account_status` | `INT64` | Mã trạng thái account. **Nghiệp vụ không dùng, bỏ qua.** |  | 🚫 |
| `created_at` | `DATETIME` | Thời điểm nghiệp vụ account được tạo. |  | ✅ |
| `updated_at` | `DATETIME` | Lần cập nhật gần nhất. |  | ✅ |
| `pipedrive_organization_id` | `STRING` | ID organization trên Pipedrive. |  | 🚫 |

---

### 2.7. Table `deal_activities`

**Full name:** `tmdatabase.dm_base_crm.deal_activities`
**Type:** FACT / EVENT · **Grain:** 1 row ≈ 1 activity của 1 deal · **PK candidate:** `activity_id`
**Description:** Nhật ký activity/tương tác gắn với deal (cuộc gọi, ghi chú, task...). Dùng để đo mức độ chăm sóc lead: số activity, thời điểm chạm gần nhất, deal chưa được follow-up. **Luôn aggregate về `deal_id` trước khi JOIN vào `deals`.**

| Column | Data type | Description | Key / relationship | Dùng được? |
|---|---|---|---|---|
| `activity_id` | `INT64` | Mã activity. | PK candidate | ✅ |
| `deal_id` | `INT64` | Deal chứa activity. | FK → `deals.deal_id` (INT64 = INT64) | ✅ |
| `user_id` | `INT64` | Nhân sự thực hiện activity. | FK → `users.user_id` | ✅ |
| `type` | `STRING` | Loại activity. |  | ✅ |
| `metatype` | `STRING` | Nhóm/metadata type. ⚠️ taxonomy chưa xác nhận. |  | ⚠️ |
| `content` | `STRING` | Nội dung activity (text tự do). |  | ✅ |
| `created_at` | `TIMESTAMP` | Thời điểm activity được tạo. |  | ✅ |
| `updated_at` | `TIMESTAMP` | Lần cập nhật gần nhất. |  | ✅ |
| `add_time` | `TIMESTAMP` | Thời điểm thêm vào hệ thống nguồn. ⚠️ khác biệt với `created_at` chưa rõ. |  | ⚠️ |
| `due_datetime` | `TIMESTAMP` | Thời hạn của activity. |  | ✅ |
| `status` | `INT64` | Mã trạng thái activity. **Nghiệp vụ không dùng, bỏ qua.** |  | 🚫 |

> ⚠️ Lưu ý kiểu dữ liệu: các cột thời gian ở `deal_activities` là **`TIMESTAMP`** (UTC-aware), trong khi `deals`/`contacts`/`accounts` dùng **`DATETIME`** (không timezone). Khi so sánh hai bên phải quy về cùng kiểu — xem quy tắc timezone ở mục 4.5.

---

## 3. Cross-table Relationships

| From Table | From Column | To Table | To Column | Confidence | Cardinality dự kiến | Important note |
|---|---|---|---|---|---|---|
| `deals` | `pipeline_id` | `pipelines` | `pipeline_id` | HIGH | N:1 | Deal thuộc pipeline. |
| `deals` | `stage_id` | `stages` | `stage_id` | HIGH | N:1 | Stage **hiện tại** của deal. |
| `deals` | `deal_owner_id` | `users` | `user_id` | HIGH | N:1 | Owner của deal. |
| `deals` | `contact_id` | `contacts` | `contact_id` | MEDIUM | N:1 | **STRING ↔ INT64** → `SAFE_CAST`. |
| `deals` | `account_id` | `accounts` | `account_id` | MEDIUM | N:1 | **STRING ↔ INT64** → `SAFE_CAST`. |
| `deal_activities` | `deal_id` | `deals` | `deal_id` | HIGH | **N:1 (fan-out)** | Phải aggregate trước khi JOIN. |
| `deal_activities` | `user_id` | `users` | `user_id` | HIGH | N:1 | User thực hiện activity. |
| `stages` | `pipeline_id` | `pipelines` | `pipeline_id` | HIGH | N:1 | Stage thuộc pipeline. |
| ~~`stages`~~ | ~~`user_id`~~ | ~~`users`~~ | ~~`user_id`~~ | 🚫 | — | **Không dùng** — ý nghĩa nghiệp vụ không xác định. |
| `contacts` | `account_id` | `accounts` | `account_id` | HIGH | N:1 | Cùng INT64 → join trực tiếp. |
| `contacts` | `contact_owner_id` | `users` | `user_id` | HIGH | N:1 | Người phụ trách contact. |
| `accounts` | `account_owner_id` | `users` | `user_id` | HIGH | N:1 | Owner của account. |

---

## 4. Business Rules ✅ (Data Owner xác nhận — BẮT BUỘC)

Đây là phần quan trọng nhất. Agent **phải** áp dụng đúng các định nghĩa dưới đây, **không được tự suy diễn KPI** từ tên cột.

### 4.1. Trạng thái deal

`deals.deal_status` chỉ có **3 giá trị**, **luôn viết thường**, và **không có dòng NULL** (Data Owner đã kiểm chứng trên dữ liệu thật) → so sánh trực tiếp bằng `=` là an toàn, không cần `LOWER()`/`COALESCE`.

| Khái niệm | Định nghĩa SQL |
|---|---|
| Deal / Lead | 1 row trong `deals` |
| Won | `deal_status = 'won'` |
| Lost | `deal_status = 'lost'` |
| Open (đang chạy) | `deal_status = 'open'` |
| Deal đã đóng | `deal_status IN ('won','lost')` |

### 4.2. Doanh thu & Conversion Rate — ghi nhận theo `closed_at`

**Quy tắc chốt:** cả doanh thu lẫn Conversion Rate đều tính trên tập deal **đóng trong kỳ**, tức lọc theo `closed_at`, **không phải** `created_at`.

```sql
-- Khung chuẩn cho mọi chỉ số kết quả
FROM `tmdatabase.dm_base_crm.deals`
WHERE closed_at IS NOT NULL
  AND DATE(closed_at) BETWEEN @start_date AND @end_date

-- Doanh thu: CHỈ tính trên deal won, CHỈ dùng deal_value (đơn vị VND thô)
SUM(IF(deal_status = 'won', deal_value, 0))  AS revenue

-- Conversion Rate = won / (won + lost)  -- KHÔNG tính deal open vào mẫu số
SAFE_DIVIDE(
  COUNTIF(deal_status = 'won'),
  COUNTIF(deal_status IN ('won','lost'))
) AS conversion_rate
```

- Vì đã lọc `closed_at IS NOT NULL` nên trong tập này thực tế chỉ còn `won` và `lost`; mẫu số `COUNTIF(... IN ('won','lost'))` giữ lại để phòng trường hợp deal `open` có `closed_at`.
- 🚫 Không dùng `product_amount`, `account_value` cho doanh thu. 🚫 Không quy đổi tiền tệ, không dùng `currency_id`.
- 🚫 Không dùng `pipedrive_won_time` / `pipedrive_lost_time` để xác định won/lost — dùng `deal_status` và `closed_at`.

### 4.3. Phân loại lead theo funnel: MQL / SQL Discovery / SQL Need-fit

Nghiệp vụ xác định chất lượng lead bằng **`deals.stage_id` hiện tại** nằm trong các danh sách cố định sau:

```python
# Logic gốc từ nghiệp vụ (pandas)

# Từ Needs Exploration trở đi
sql_discovery_stages = [
    224, 267, 268, 92, 91, 227, 228, 225, 229, 226,
    220, 221, 222, 218, 219, 75, 76, 74, 80,
    1329, 1330, 1331, 1332
]


# Từ Solution Fit trở đi
sql_needfit_stages = [
    224, 267, 268, 92, 91, 227, 228, 225, 229, 226,
    220, 221, 222, 219, 75, 76,
    1330, 1331, 1332
]

# Từ stage Engaged trở đi
mql_stages = [
    224, 264, 267, 268, 265, 92, 91, 227, 228, 225,
    229, 226, 220, 221, 217, 222, 218, 219, 75, 76,
    73, 74, 79, 80,
    1328, 1329, 1330, 1331, 1332
]

data['is_sql_discovery'] = data['stage_id'].isin(sql_discovery_stages).astype(int)
data['is_sql_needfit']   = data['stage_id'].isin(sql_needfit_stages).astype(int)
data['is_mql']           = data['stage_id'].isin(mql_stages).astype(int)
```

**Cấu trúc lồng nhau (đã kiểm chứng):** `sql_needfit_stages` ⊂ `sql_discovery_stages` ⊂ `mql_stages`.
→ Funnel đọc theo chiều: **Tổng lead ≥ MQL ≥ SQL Discovery ≥ SQL Need-fit**. Một deal là SQL Need-fit thì đương nhiên cũng là SQL Discovery và MQL. **Không cộng ba nhóm này lại với nhau** (chúng chồng lấn), chỉ so sánh theo bậc.

Bản dịch sang BigQuery SQL — Agent dùng nguyên khối này:

```sql
-- Flags phân loại lead (đặt trong SELECT của CTE base)
IF(stage_id IN (224,264,267,268,265,92,91,227,228,225,
                229,226,220,221,217,222,218,219,75,76,
                73,74,79,80,
                1328,1329,1330,1331,1332), 1, 0)          AS is_mql,

IF(stage_id IN (224,267,268,92,91,227,228,225,229,226,
                220,221,222,218,219,75,76,74,80,
                1329,1330,1331,1332), 1, 0)               AS is_sql_discovery,

IF(stage_id IN (224,267,268,92,91,227,228,225,229,226,
                220,221,222,219,75,76,
                1330,1331,1332), 1, 0)                    AS is_sql_needfit
```

**Tập đếm ✅ (Data Owner chốt):** MQL / SQL Discovery / SQL Need-fit đếm trên **toàn bộ deal** tạo trong kỳ (theo `created_at`), **không lọc `deal_status`** — deal đã won hoặc lost vẫn được tính. Vì phân loại dựa trên **stage hiện tại**, một deal đã `lost` sẽ mang stage tại thời điểm rớt.

> ⚠️ Ba danh sách `stage_id` này là hằng số nghiệp vụ nằm cứng trong file. Nếu CRM thêm stage mới, chúng **không tự cập nhật** — cần Data Owner rà lại (xem mục 9).

### 4.4. Time dimension — chọn đúng cột

Đây là quy tắc dễ sai nhất trong bản tin: **chỉ số đầu phễu và chỉ số kết quả dùng hai mốc thời gian khác nhau**, nên một query gộp là không đủ — phải tách hai CTE (xem mẫu 6.1).

| Câu hỏi nghiệp vụ | Cột thời gian |
|---|---|
| Lead mới trong kỳ | `deals.created_at` ✅ |
| MQL / SQL Discovery / SQL Need-fit trong kỳ | `deals.created_at` ✅ |
| Won, Lost, Revenue, Conversion Rate trong kỳ | `deals.closed_at` ✅ **(không dùng `created_at`)** |
| Deal open đang tồn đọng ở stage bao lâu | `deals.stage_start_at` ✅ (chỉ với deal `open`) |
| Deal dự kiến đóng | `expected_close_at` / `expected_deadline_at` |
| Lần chăm sóc gần nhất | `MAX(deal_activities.created_at)` sau khi aggregate |
| ❌ Không bao giờ dùng | `pipedrive_won_time`, `pipedrive_lost_time`, `deal_created_at_form` 🚫 |

`created_at` ở tất cả các bảng là **thời điểm nghiệp vụ**, không phải thời điểm sync warehouse → dùng trực tiếp cho reporting.

### 4.5. Timezone

- Dữ liệu nghiệp vụ theo giờ Việt Nam **GMT+7**.
- Các cột `DATETIME` (`deals.*`, `contacts.*`, `accounts.*`) không mang timezone — hiểu là giờ VN, so sánh trực tiếp với `CURRENT_DATETIME('Asia/Ho_Chi_Minh')`.
- Các cột `TIMESTAMP` (`deal_activities.*`, `pipelines.*`, `stages.*`) là UTC-aware — quy đổi bằng `DATETIME(ts, 'Asia/Ho_Chi_Minh')` trước khi so sánh với các cột `DATETIME`.
- "Hôm qua" trong báo cáo daily = `DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 1 DAY)`.

### 4.6. Các cột form khách hàng tự điền

`is_alumni`, `has_pain_point`, `has_follow_up`, `need_consulting`, `group_registration` là **giá trị khách hàng tự điền khi đăng ký khóa học**, lưu STRING tự do (không phải boolean chuẩn). Trước khi `GROUP BY` hoặc đếm:

```sql
NULLIF(LOWER(TRIM(is_alumni)), '') AS is_alumni_norm
```

Không viết `WHERE is_alumni = 'true'` khi chưa biết tập giá trị thực tế; nếu cần con số chính xác, hãy `GROUP BY` để liệt kê giá trị trước.

### 4.7. Danh sách cột 🚫 CẤM dùng (tổng hợp)

```text
-- Toàn bộ nhóm Pipedrive (chỉ tham chiếu khi đổi CRM)
deals.pipedrive_note, deals.pipedrive_contact_id, deals.pipedrive_organization_id,
deals.pipedrive_deal_id, deals.pipedrive_won_time, deals.pipedrive_lost_time,
deals.pipedrive_lost_reason, contacts.pipedrive_person_id,
contacts.pipedrive_account_id, accounts.pipedrive_organization_id

-- Trạng thái dạng mã số không có mapping
accounts.account_status, accounts.account_stage_id,
contacts.operation_stage_id, deal_activities.status, stages.status

-- Đo lường trùng lặp / sai nguồn
deals.product_amount, deals.product_quantity, accounts.account_value,
deals.deal_created_at_form

-- Tiền tệ: toàn bộ deal là VND, không quy đổi
deals.currency_id, accounts.currency_id

-- Ý nghĩa nghiệp vụ không xác định hoặc không dùng đến
stages.user_id, deals.creator_id, contacts.customer_course, stages._loaded_at

-- PII nhạy cảm (không đưa vào SELECT/output)
deals.citizen_id, deals.bank_statement
```

### 4.8. Spec bản tin *Daily 5 Minutes Brief* ✅

**Phạm vi:** toàn bộ pipeline, không loại trừ pipeline nào.
**Breakdown:** mặc định **tổng toàn công ty**. Có thể kèm một bảng nhỏ theo khóa học (`selected_course` cho deal won, `interested_course` cho lead mới) — top 5, không đi sâu hơn. **Không** breakdown theo nhân sự phụ trách.

**Bộ chỉ số cố định (v1):**

| # | Chỉ số | Nguồn | Time dimension |
|---|---|---|---|
| 1 | Lead mới | `COUNT(DISTINCT deal_id)` | `created_at` |
| 2 | MQL | `SUM(is_mql)` | `created_at` |
| 3 | SQL Discovery | `SUM(is_sql_discovery)` | `created_at` |
| 4 | SQL Need-fit | `SUM(is_sql_needfit)` | `created_at` |
| 5 | Won | `COUNTIF(deal_status='won')` | `closed_at` |
| 6 | Lost | `COUNTIF(deal_status='lost')` | `closed_at` |
| 7 | Revenue | `SUM(IF(deal_status='won', deal_value, 0))` | `closed_at` |
| 8 | Conversion Rate | `won / (won + lost)` | `closed_at` |
| 9 | Top UTM source | `GROUP BY utm_source` | `created_at` |
| 10 | Top khóa học | `GROUP BY selected_course` (deal won: `closed_at`; lead mới: `created_at`) — **không dùng `interested_course`, xem ghi chú ở mục 2.1** | `closed_at` / `created_at` |
| 11 | Deal open tồn đọng | `stage_start_at` quá N ngày | — |
| 12 | UTM combo nổi bật (`utm_source × utm_medium × utm_campaign × utm_content × utm_product`) | top N theo `top_utm_rows`, kèm n_won/n_lost của chính các lead đó | `created_at`. **Daily:** cửa sổ D-1. **Thứ 7:** tuần làm việc T2–T6 vừa kết thúc — xem mẫu 6.10/6.11. `(not set)` ở cả 5 field = lead không qua tracking (lead tay/sales tạo), Agent Writer phải gọi tên rõ, không liệt vào "content". |

**Kỳ so sánh chuẩn ✅ — trung bình 7 ngày, để thấy trend:**

- **Kỳ hiện tại (curr):** `D-7` → `D-1` (7 ngày, không tính hôm nay vì dữ liệu chưa đủ).
- **Kỳ so sánh (prev):** `D-14` → `D-8` (7 ngày liền trước).
- Mỗi chỉ số báo cáo dưới dạng **trung bình/ngày** của từng kỳ, kèm `% thay đổi = (curr - prev) / prev`.
- `D` = `CURRENT_DATE('Asia/Ho_Chi_Minh')`.
- Riêng Conversion Rate: tính tỷ lệ trên **tổng cả kỳ** (không lấy trung bình của các tỷ lệ ngày), rồi so sánh **chênh lệch điểm phần trăm** giữa hai kỳ.

**Ngưỡng highlight (đề xuất mặc định v1 — Data Owner chỉnh sau):**

| Tín hiệu | Ngưỡng | Mức |
|---|---|---|
| Chỉ số số lượng (Lead, MQL, SQL, Won, Revenue) giảm so với kỳ trước | ≥ 20% | 🔴 cảnh báo |
| … tăng so với kỳ trước | ≥ 20% | 🟢 tin tốt |
| Biến động | < 10% | ⚪ coi như đi ngang, không bình luận |
| Conversion Rate giảm | ≥ 5 điểm phần trăm | 🔴 cảnh báo |
| Deal `open` không có activity nào | > 3 ngày | 🟠 nhắc follow-up |
| Deal `open` nằm ở stage hiện tại | > 14 ngày | 🟠 tồn đọng |
| Số ngày liên tiếp không có deal won | ≥ 3 ngày | 🔴 cảnh báo |

---

## 5. Agent Query Guidelines

1. **Luôn ghi full table path** `` `tmdatabase.dm_base_crm.<table>` `` — n8n chạy query không có default dataset.
2. **Xác định grain trước khi JOIN/aggregate.** `deals` là deal-level; `deal_activities` là activity-level (fan-out).
3. **Ưu tiên ID làm join key**, không dùng name/email.
4. **Kiểm tra datatype trước JOIN:** `deals.account_id` / `deals.contact_id` là STRING ↔ dimension key INT64 → `SAFE_CAST`.
5. **Uniqueness của `deal_id` chưa được xác nhận** → **mặc định dùng `COUNT(DISTINCT deal_id)`** cho mọi số đếm lead/deal, không dùng `COUNT(*)`.
6. **Không assume NULL = 0 / false.** Toàn bộ cột đều nullable (ngoại lệ đã xác nhận: `deal_status` không NULL); dùng `COALESCE`, `SAFE_DIVIDE`, `COUNTIF` thay vì phép chia trần.
7. **Cột STRING chứa số/ngày phải `SAFE_CAST` trước khi tính** — nhưng phần lớn đã nằm trong danh sách 🚫.
8. **Dùng đúng time dimension** theo bảng ở mục 4.4 — đầu phễu theo `created_at`, kết quả theo `closed_at`; luôn kèm timezone `Asia/Ho_Chi_Minh` khi lấy ngày hiện tại.
9. **`stage_id` luôn đi kèm `pipeline_id`** khi phân tích funnel theo tên stage.
10. **Hạn chế PII trong output:** không SELECT `citizen_id`, `bank_statement`; hạn chế email/phone/địa chỉ trừ khi câu hỏi yêu cầu danh sách liên hệ.
11. **Không tự định nghĩa KPI.** Won/Lost/Revenue/Conversion Rate/MQL/SQL đã định nghĩa ở mục 4 — dùng đúng, không sáng tạo thêm.
12. **Query cho Daily Brief nên gọn:** lọc khoảng thời gian trong CTE trước rồi mới aggregate, hạn chế `SELECT *` để giảm chi phí quét BigQuery.
13. **Luôn loại deal rác:** thêm `WHERE NOT STARTS_WITH(IFNULL(failed_reason_id, ''), 'Trash:')` vào mọi query đếm deal/lead (xem mục 9.1). Không tự loại theo tên/label chứa "test" — sẽ trùng deal A/B testing thật.

---

## 6. Suggested SQL Patterns

### 6.1. Base CTE chuẩn cho Daily Brief (khuyến nghị dùng làm khung chung)

**Nguyên tắc:** đầu phễu đếm theo `created_at`, kết quả đếm theo `closed_at` → hai CTE riêng, JOIN lại theo ngày.

```sql
WITH
-- (1) Đầu phễu: đếm theo NGÀY TẠO LEAD
lead_daily AS (
  SELECT
    DATE(d.created_at)                AS report_date,
    COUNT(DISTINCT d.deal_id)         AS total_leads,
    COUNT(DISTINCT IF(d.stage_id IN (224,264,267,268,265,92,91,227,228,225,
                                     229,226,220,221,217,222,218,219,75,76,
                                     73,74,79,80,
                                     1328,1329,1330,1331,1332), d.deal_id, NULL))          AS mql,
    COUNT(DISTINCT IF(d.stage_id IN (224,267,268,92,91,227,228,225,229,226,
                                     220,221,222,218,219,75,76,74,80,
                                     1329,1330,1331,1332), d.deal_id, NULL)) AS sql_discovery,
    COUNT(DISTINCT IF(d.stage_id IN (224,267,268,92,91,227,228,225,229,226,
                                     220,221,222,219,75,76,
                                     1330,1331,1332), d.deal_id, NULL))           AS sql_needfit
  FROM `tmdatabase.dm_base_crm.deals` d
  WHERE DATE(d.created_at) BETWEEN @start_date AND @end_date
  GROUP BY report_date
),
-- (2) Kết quả bán hàng: đếm theo NGÀY ĐÓNG DEAL
outcome_daily AS (
  SELECT
    DATE(d.closed_at)                                     AS report_date,
    COUNT(DISTINCT IF(d.deal_status = 'won',  d.deal_id, NULL))  AS won_deals,
    COUNT(DISTINCT IF(d.deal_status = 'lost', d.deal_id, NULL))  AS lost_deals,
    SUM(IF(d.deal_status = 'won', d.deal_value, 0))              AS revenue
  FROM `tmdatabase.dm_base_crm.deals` d
  WHERE d.closed_at IS NOT NULL
    AND DATE(d.closed_at) BETWEEN @start_date AND @end_date
  GROUP BY report_date
)
SELECT
  COALESCE(l.report_date, o.report_date)          AS report_date,
  COALESCE(l.total_leads, 0)                      AS total_leads,
  COALESCE(l.mql, 0)                              AS mql,
  COALESCE(l.sql_discovery, 0)                    AS sql_discovery,
  COALESCE(l.sql_needfit, 0)                      AS sql_needfit,
  COALESCE(o.won_deals, 0)                        AS won_deals,
  COALESCE(o.lost_deals, 0)                       AS lost_deals,
  COALESCE(o.revenue, 0)                          AS revenue,
  SAFE_DIVIDE(o.won_deals, o.won_deals + o.lost_deals) AS conversion_rate
FROM lead_daily l
FULL OUTER JOIN outcome_daily o USING (report_date)
ORDER BY report_date DESC
```

### 6.2. Query chính của bản tin — so sánh trung bình 7 ngày vs 7 ngày trước

Đây là query dùng trực tiếp cho node n8n sinh Daily Brief (mục 4.8).

```sql
WITH params AS (
  SELECT
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 7  DAY) AS curr_start,  -- D-7
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 1  DAY) AS curr_end,    -- D-1
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 14 DAY) AS prev_start,  -- D-14
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 8  DAY) AS prev_end     -- D-8
),
-- Đầu phễu theo created_at
leads AS (
  SELECT
    IF(DATE(d.created_at) BETWEEN p.curr_start AND p.curr_end, 'curr', 'prev') AS period,
    COUNT(DISTINCT d.deal_id) AS total_leads,
    COUNT(DISTINCT IF(d.stage_id IN (224,264,267,268,265,92,91,227,228,225,
                                     229,226,220,221,217,222,218,219,75,76,
                                     73,74,79,80,
                                     1328,1329,1330,1331,1332), d.deal_id, NULL))          AS mql,
    COUNT(DISTINCT IF(d.stage_id IN (224,267,268,92,91,227,228,225,229,226,
                                     220,221,222,218,219,75,76,74,80,
                                     1329,1330,1331,1332), d.deal_id, NULL)) AS sql_discovery,
    COUNT(DISTINCT IF(d.stage_id IN (224,267,268,92,91,227,228,225,229,226,
                                     220,221,222,219,75,76,
                                     1330,1331,1332), d.deal_id, NULL))           AS sql_needfit
  FROM `tmdatabase.dm_base_crm.deals` d, params p
  WHERE DATE(d.created_at) BETWEEN p.prev_start AND p.curr_end
  GROUP BY period
),
-- Kết quả theo closed_at
outcomes AS (
  SELECT
    IF(DATE(d.closed_at) BETWEEN p.curr_start AND p.curr_end, 'curr', 'prev') AS period,
    COUNT(DISTINCT IF(d.deal_status = 'won',  d.deal_id, NULL)) AS won_deals,
    COUNT(DISTINCT IF(d.deal_status = 'lost', d.deal_id, NULL)) AS lost_deals,
    SUM(IF(d.deal_status = 'won', d.deal_value, 0))             AS revenue
  FROM `tmdatabase.dm_base_crm.deals` d, params p
  WHERE d.closed_at IS NOT NULL
    AND DATE(d.closed_at) BETWEEN p.prev_start AND p.curr_end
  GROUP BY period
),
combined AS (
  SELECT
    COALESCE(l.period, o.period)                                AS period,
    COALESCE(l.total_leads, 0)    / 7                           AS avg_leads_per_day,
    COALESCE(l.mql, 0)            / 7                           AS avg_mql_per_day,
    COALESCE(l.sql_discovery, 0)  / 7                           AS avg_sql_discovery_per_day,
    COALESCE(l.sql_needfit, 0)    / 7                           AS avg_sql_needfit_per_day,
    COALESCE(o.won_deals, 0)      / 7                           AS avg_won_per_day,
    COALESCE(o.lost_deals, 0)     / 7                           AS avg_lost_per_day,
    COALESCE(o.revenue, 0)        / 7                           AS avg_revenue_per_day,
    SAFE_DIVIDE(o.won_deals, o.won_deals + o.lost_deals)        AS conversion_rate
  FROM leads l
  FULL OUTER JOIN outcomes o USING (period)
)
pivot AS (
  SELECT
    MAX(IF(period = 'curr', avg_leads_per_day,          NULL)) AS curr_leads,
    MAX(IF(period = 'prev', avg_leads_per_day,          NULL)) AS prev_leads,
    MAX(IF(period = 'curr', avg_mql_per_day,            NULL)) AS curr_mql,
    MAX(IF(period = 'prev', avg_mql_per_day,            NULL)) AS prev_mql,
    MAX(IF(period = 'curr', avg_sql_discovery_per_day,  NULL)) AS curr_sql_discovery,
    MAX(IF(period = 'prev', avg_sql_discovery_per_day,  NULL)) AS prev_sql_discovery,
    MAX(IF(period = 'curr', avg_sql_needfit_per_day,    NULL)) AS curr_sql_needfit,
    MAX(IF(period = 'prev', avg_sql_needfit_per_day,    NULL)) AS prev_sql_needfit,
    MAX(IF(period = 'curr', avg_won_per_day,            NULL)) AS curr_won,
    MAX(IF(period = 'prev', avg_won_per_day,            NULL)) AS prev_won,
    MAX(IF(period = 'curr', avg_lost_per_day,           NULL)) AS curr_lost,
    MAX(IF(period = 'prev', avg_lost_per_day,           NULL)) AS prev_lost,
    MAX(IF(period = 'curr', avg_revenue_per_day,        NULL)) AS curr_revenue,
    MAX(IF(period = 'prev', avg_revenue_per_day,        NULL)) AS prev_revenue,
    MAX(IF(period = 'curr', conversion_rate,            NULL)) AS curr_cvr,
    MAX(IF(period = 'prev', conversion_rate,            NULL)) AS prev_cvr
  FROM combined
)
SELECT
  *,
  SAFE_DIVIDE(curr_leads         - prev_leads,         NULLIF(prev_leads, 0))         AS pct_change_leads,
  SAFE_DIVIDE(curr_mql           - prev_mql,           NULLIF(prev_mql, 0))           AS pct_change_mql,
  SAFE_DIVIDE(curr_sql_discovery - prev_sql_discovery, NULLIF(prev_sql_discovery, 0)) AS pct_change_sql_discovery,
  SAFE_DIVIDE(curr_sql_needfit   - prev_sql_needfit,   NULLIF(prev_sql_needfit, 0))   AS pct_change_sql_needfit,
  SAFE_DIVIDE(curr_won           - prev_won,           NULLIF(prev_won, 0))           AS pct_change_won,
  SAFE_DIVIDE(curr_lost          - prev_lost,          NULLIF(prev_lost, 0))          AS pct_change_lost,
  SAFE_DIVIDE(curr_revenue       - prev_revenue,       NULLIF(prev_revenue, 0))       AS pct_change_revenue,
  curr_cvr - prev_cvr                                                                 AS cvr_change_pp
FROM pivot
```

> **Lưu ý cách đọc kết quả:** query trả về **đúng 1 dòng**. Các chỉ số số lượng so sánh bằng `pct_change_*` (ngưỡng ±20% ở mục 4.8). Riêng Conversion Rate so sánh bằng `cvr_change_pp` — **chênh lệch điểm phần trăm**, không dùng % tương đối (ngưỡng −5pp).

### 6.3. Funnel theo Pipeline → Stage (đúng thứ tự)

```sql
SELECT
  p.name                        AS pipeline_name,
  s.name                        AS stage_name,
  s.order_nr,
  COUNT(DISTINCT d.deal_id)     AS deals
FROM `tmdatabase.dm_base_crm.deals` d
LEFT JOIN `tmdatabase.dm_base_crm.stages`    s ON d.stage_id    = s.stage_id
LEFT JOIN `tmdatabase.dm_base_crm.pipelines` p ON d.pipeline_id = p.pipeline_id
WHERE DATE(d.created_at) BETWEEN @start_date AND @end_date
GROUP BY pipeline_name, stage_name, s.order_nr
ORDER BY pipeline_name, s.order_nr
```

### 6.4. Top khóa học won trong kỳ (breakdown nhẹ cho bản tin)

```sql
SELECT
  COALESCE(NULLIF(TRIM(d.selected_course), ''), '(không ghi nhận)') AS course,
  COUNT(DISTINCT d.deal_id)                       AS won_deals,
  SUM(d.deal_value)                               AS revenue
FROM `tmdatabase.dm_base_crm.deals` d
WHERE d.deal_status = 'won'
  AND d.closed_at IS NOT NULL
  AND DATE(d.closed_at) BETWEEN @start_date AND @end_date
GROUP BY course
ORDER BY revenue DESC
LIMIT 5
```

### 6.5. Top UTM source của lead mới trong kỳ

```sql
SELECT
  COALESCE(NULLIF(TRIM(d.utm_source), ''), '(not set)')   AS utm_source,
  COUNT(DISTINCT d.deal_id)                               AS leads
FROM `tmdatabase.dm_base_crm.deals` d
WHERE DATE(d.created_at) BETWEEN @start_date AND @end_date
GROUP BY utm_source
ORDER BY leads DESC
LIMIT 5
```

> Nếu cần ghép thêm Won/Revenue theo UTM, phải tách hai CTE như mẫu 6.1 (lead theo `created_at`, kết quả theo `closed_at`) — **không gộp chung một `WHERE` được**.

### 6.5b. Hiệu suất theo nhân sự phụ trách *(tùy chọn — bản tin v1 không dùng)*

```sql
SELECT
  COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.last_name,''),' ',COALESCE(u.first_name,''))),''),
           u.username, CAST(d.deal_owner_id AS STRING))  AS owner_name,
  COUNT(DISTINCT d.deal_id)                              AS closed_deals,
  COUNT(DISTINCT IF(d.deal_status = 'won', d.deal_id, NULL)) AS won_deals,
  SUM(IF(d.deal_status = 'won', d.deal_value, 0))        AS revenue
FROM `tmdatabase.dm_base_crm.deals` d
LEFT JOIN `tmdatabase.dm_base_crm.users` u ON d.deal_owner_id = u.user_id
WHERE d.closed_at IS NOT NULL
  AND DATE(d.closed_at) BETWEEN @start_date AND @end_date
GROUP BY owner_name
ORDER BY revenue DESC
```

### 6.6. Deal → Contact (datatype-safe)

```sql
SELECT d.deal_id, c.university, c.workplace, c.industry
FROM `tmdatabase.dm_base_crm.deals` d
LEFT JOIN `tmdatabase.dm_base_crm.contacts` c
  ON SAFE_CAST(d.contact_id AS INT64) = c.contact_id
```

### 6.7. Deal → Account (datatype-safe)

```sql
SELECT d.deal_id, a.account_name, a.industry, a.company_size
FROM `tmdatabase.dm_base_crm.deals` d
LEFT JOIN `tmdatabase.dm_base_crm.accounts` a
  ON SAFE_CAST(d.account_id AS INT64) = a.account_id
```

### 6.8. Deal open chưa được chăm sóc > 3 ngày (cảnh báo follow-up)

```sql
WITH activity_agg AS (
  SELECT
    deal_id,
    COUNT(*)                                          AS activity_count,
    DATETIME(MAX(created_at), 'Asia/Ho_Chi_Minh')     AS last_activity_at_vn
  FROM `tmdatabase.dm_base_crm.deal_activities`
  GROUP BY deal_id
)
SELECT
  d.deal_id,
  d.deal_name,
  COALESCE(ag.activity_count, 0)                      AS activity_count,
  ag.last_activity_at_vn,
  DATETIME_DIFF(CURRENT_DATETIME('Asia/Ho_Chi_Minh'),
                COALESCE(ag.last_activity_at_vn, d.created_at), DAY) AS days_since_touch
FROM `tmdatabase.dm_base_crm.deals` d
LEFT JOIN activity_agg ag ON d.deal_id = ag.deal_id
WHERE d.deal_status = 'open'
  AND DATETIME_DIFF(CURRENT_DATETIME('Asia/Ho_Chi_Minh'),
                    COALESCE(ag.last_activity_at_vn, d.created_at), DAY) > 3
ORDER BY days_since_touch DESC
```

### 6.9. Deal open tồn đọng ở stage hiện tại > 14 ngày

```sql
SELECT
  d.deal_id,
  d.deal_name,
  s.name                                                        AS stage_name,
  p.name                                                        AS pipeline_name,
  d.stage_start_at,
  DATETIME_DIFF(CURRENT_DATETIME('Asia/Ho_Chi_Minh'), d.stage_start_at, DAY) AS days_in_stage
FROM `tmdatabase.dm_base_crm.deals` d
LEFT JOIN `tmdatabase.dm_base_crm.stages`    s ON d.stage_id    = s.stage_id
LEFT JOIN `tmdatabase.dm_base_crm.pipelines` p ON d.pipeline_id = p.pipeline_id
WHERE d.deal_status = 'open'          -- bắt buộc: stage_start_at chỉ tin cậy với deal open
  AND d.stage_start_at IS NOT NULL
  AND DATETIME_DIFF(CURRENT_DATETIME('Asia/Ho_Chi_Minh'), d.stage_start_at, DAY) > 14
ORDER BY days_in_stage DESC
```

---

### 6.10. UTM combo nổi bật — hôm qua (dùng cho khối 🔗 hằng ngày)

```sql
WITH p AS (SELECT DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 1 DAY) AS d)
SELECT
  COALESCE(NULLIF(TRIM(utm_source),   ''), '(not set)') AS utm_source,
  COALESCE(NULLIF(TRIM(utm_medium),   ''), '(not set)') AS utm_medium,
  COALESCE(NULLIF(TRIM(utm_campaign), ''), '(not set)') AS utm_campaign,
  COALESCE(NULLIF(TRIM(utm_content),  ''), '(not set)') AS utm_content,
  COALESCE(NULLIF(TRIM(utm_product),  ''), '(not set)') AS utm_product,
  COUNT(DISTINCT deal_id)      AS n_leads,
  COUNTIF(deal_status = 'won')  AS n_won,
  COUNTIF(deal_status = 'lost') AS n_lost
FROM `tmdatabase.dm_base_crm.deals`, p
WHERE DATE(created_at) = p.d
GROUP BY 1,2,3,4,5
ORDER BY n_leads DESC
LIMIT @top_utm_rows   -- Config.limits.top_utm_rows, mặc định 8
```

> `n_won`/`n_lost` là trạng thái **hiện tại** của đúng những lead tạo hôm qua — vì mới tạo nên phần lớn sẽ là `open`, số này chủ yếu có ý nghĩa ở bản Weekly (6.11) khi lead có đủ thời gian chín.

### 6.11. Content Performance — tuần T2–T6 (dùng cho Weekly Performance chạy Thứ 7)

Query giữ đủ UTM combo để truy ngược đúng content/campaign/product. Output được tách thành hai ranking ở Code node: (1) nhiều lead nhất; (2) CVR cao nhất với điều kiện `n_leads >= @weekly_min_content_leads`. Dòng `utm_content = '(not set)'` không được đưa vào ranking content; chỉ dùng để tính chất lượng tracking.

```sql
WITH p AS (
  SELECT
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 5 DAY) AS d_start, -- T2
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 1 DAY) AS d_end   -- T6
)
SELECT
  COALESCE(NULLIF(TRIM(utm_source),   ''), '(not set)') AS utm_source,
  COALESCE(NULLIF(TRIM(utm_medium),   ''), '(not set)') AS utm_medium,
  COALESCE(NULLIF(TRIM(utm_campaign), ''), '(not set)') AS utm_campaign,
  COALESCE(NULLIF(TRIM(utm_content),  ''), '(not set)') AS utm_content,
  COALESCE(NULLIF(TRIM(utm_product),  ''), '(not set)') AS utm_product,
  COUNT(DISTINCT deal_id)       AS n_leads,
  COUNTIF(deal_status = 'won')  AS n_won,
  COUNTIF(deal_status = 'lost') AS n_lost,
  SAFE_DIVIDE(COUNTIF(deal_status='won'), COUNTIF(deal_status IN ('won','lost'))) AS conversion_rate,
  COUNTIF(deal_status IN ('won','lost')) AS n_closed,
  COALESCE(NULLIF(TRIM(utm_content), ''), '(not set)') = '(not set)' AS is_untracked_content
FROM `tmdatabase.dm_base_crm.deals`, p
WHERE DATE(created_at) BETWEEN p.d_start AND p.d_end
GROUP BY 1,2,3,4,5
ORDER BY n_leads DESC
LIMIT @top_utm_rows_weekly   -- mặc định 12; ranking CVR áp thêm n_leads >= @weekly_min_content_leads
```

> `conversion_rate` ở đây là trạng thái hiện tại của cohort lead được tạo trong tuần. Vì một phần lead chưa đủ thời gian chín, Writer phải ghi chú “CVR cohort hiện tại” và không diễn giải như CVR cuối cùng. Khi xếp hạng CVR, bắt buộc áp ngưỡng mẫu tối thiểu để tránh content 1 lead/1 won đứng đầu thiếu tin cậy.

---

## 7. Recommended companion knowledge files

- `dim_course` ✅ đã dựng — bảng cấu hình `course_key → course_name (rút gọn) → course_type → report_day (2=T2…6=T6) → is_combo → aliases → is_active`, map từ danh sách `selected_course` thật (mục dưới). **Nguồn thật là Google Sheet do Data Owner tự chỉnh**, đã connect thành table `tmdatabase.dm_daily_brief.dim_course` trên BigQuery (đã tạo xong 2026-08-23 — xem [`HUONG-DAN-Setup-dm_daily_brief.md`](HUONG-DAN-Setup-dm_daily_brief.md), tạm dừng ở bước cấp quyền Service Account). Cột phân loại có tên thật trong bảng là **`course_type`** (không phải `business_unit` như bản nháp ban đầu) — mọi SQL tham chiếu phải dùng đúng tên này.
  - `is_active = FALSE`: `Employer Branding & Hiring`, `Sales Manager`, `Trade Marketing`, `Data Analysis (DA + Python)`, `Mentoring Program` — Data Owner đã xác nhận **ngừng active**, không gán `course_type`/`report_day`, tự động loại khỏi cảnh báo "không ra lead" và khỏi mọi nhóm deep-dive.
  - **Cập nhật lịch 2026-08-30:** không còn khóa active nào dùng `report_day = 7`. Toàn bộ **Flexible Combo (2/3/4) + B2B Training** đổi sang `report_day = 6`, để deep-dive cùng TM AI vào Thứ 6. Thứ 7 dùng Q7 toàn bộ khóa và không đọc scope `report_day`.
- `value_mappings.md`: mapping `market_id`, `failed_reason_id`, và tập giá trị thực tế của các cột form khách hàng tự điền.
- `query_rules.md`: tiêu chí loại trừ deal test/rác khi đã xác minh (xem mục 9.1), rule deduplication và dữ liệu nhạy cảm.
- `verified_relationships.md`: PK/FK và cardinality đã được kiểm chứng bằng query thực tế.

---

## 8. ⚠️ Câu hỏi còn treo với Data Owner

> Các câu hỏi vòng 1 và vòng 2 đã trả lời đều được nhúng thẳng vào mục 2 & 4, không lặp lại ở đây. Dưới đây là những điểm còn thiếu, kèm **cách Agent tạm xử lý** để luồng n8n vẫn chạy được.

| # | Câu hỏi | Cách xử lý tạm thời của Agent |
|---|---|---|
| 1 | **`deal_id` có thực sự unique trong `deals` không?** | Mặc định dùng `COUNT(DISTINCT deal_id)` ở mọi phép đếm. Nếu xác nhận unique, có thể đổi sang `COUNT(*)` cho nhanh. |
| 2 | **`deals` sync về BigQuery mấy lần/ngày, vào giờ nào?** | Bản tin chốt cửa sổ tại `D-1` (không tính hôm nay) để tránh dữ liệu thiếu. Cần biết giờ sync để đặt lịch chạy n8n cho đúng. |
| 3 | **`stage_start_at` với deal đã đóng có bị reset không?** | Chỉ dùng `stage_start_at` cho deal `deal_status = 'open'`; không dùng cho deal won/lost. |
| 4 | **Ba danh sách `stage_id` (MQL/SQL) ai cập nhật khi CRM thêm stage mới?** | Đang hard-code trong mục 4.3. Cần rà lại định kỳ, nếu không stage mới sẽ âm thầm bị đếm thiếu. |

---

## 9. 📌 GHI CHÚ CẦN XỬ LÝ SAU (Data Owner tự nhắc)

### 9.1. Deal test / deal rác ✅ Data Owner đã chốt tiêu chí (2026-08-23)

**Quy tắc loại trừ chính thức:** chỉ loại deal có `failed_reason_id` bắt đầu bằng `Trash:` (hiện có 2 giá trị: `Trash: Không có nhu cầu`, `Trash: Đăng ký trùng deal`). **Không** loại theo `deal_name`/`labels` chứa "test" — vì trùng với deal A/B testing thật của team, sẽ loại nhầm.

```sql
-- Mệnh đề loại trừ chuẩn — thêm vào WHERE của MỌI query đếm deal/lead ở mục 6
WHERE NOT STARTS_WITH(IFNULL(failed_reason_id, ''), 'Trash:')
```

> Áp dụng cho tất cả pattern SQL ở mục 6 (base CTE, warning scan, funnel...) và cho view tổng hợp khi build workflow — gỡ guideline "không tự loại trừ" cũ ở mục 5 #13, thay bằng: **luôn thêm mệnh đề trên**.

**`failed_content`** (text tự do lý do lost/trash, ví dụ: "LOST vì học coursera rồi", "không có nhu cầu, từ chối nghe tư vấn"...) — Data Owner xác nhận: **Agent 2 (Root Cause Analyst) nên đọc cột này** khi phân tích deal lost, vì cho ngữ cảnh định tính mà `failed_reason_id` (mã hoá) không thể hiện được. Đưa `failed_content` vào danh sách cột Agent 2 được phép SELECT (mục 5 §9.2 workflow spec).

### 9.2. Bộ chỉ số & ngưỡng cảnh báo là bản v1 tạm

- Bộ 11 chỉ số ở mục 4.8 là "tạm thế đã", Data Owner sẽ chỉnh sau.
- Toàn bộ **ngưỡng highlight** (±20%, −5pp, 3 ngày, 14 ngày) do Agent tự đề xuất, **chưa được nghiệp vụ duyệt** — cần review lại sau vài lần chạy thực tế.
- Breakdown theo khóa học hiện giới hạn top 5; chưa quyết định có tách theo pipeline hay không.

### 9.3. `pipeline_id` không liên quan đến khóa học / business unit ❗

**Data Owner xác nhận (2026-08-23): `pipelines` chỉ là pipeline tư vấn (CS Retention, Sales Prospecting, B2B, Nurturing, TM AI xHust) — không map với khóa học hay Business Unit (Marketing / Executive Education / Data School / TM AI).** Không dùng `pipeline_id`/`pipeline_name` để suy ra business unit trong bất kỳ query hay báo cáo nào.

→ Hệ quả: `dim_course` (course_name → course_type → report_day) **phải build thủ công theo tên khóa**, không có shortcut nào từ `pipeline_id`.

✅ **Đã xử lý (2026-08-23):** Data Owner đã bổ sung `stage_id` của pipeline **`TM AI xHust` (id 5936)** vào cả 3 list ở mục 4.3 (và đã đồng bộ vào SQL pattern ở mục 4.3 + mục 6.1/6.2). Cách phân loại áp dụng đúng theo cấu trúc stage của pipeline này — **giống hệt** pipeline `Sales Prospecting` (cùng 7 tên stage, cùng thứ tự: Lead In → Interested → Engaged → Needs Exploration → Solution Fit → Ready to Purchase → Payment Completion):

| Stage TM AI xHust | order_nr | MQL | SQL Discovery | SQL Need-fit |
|---|---|:---:|:---:|:---:|
| 1327 Lead In | 0 | | | |
| 1333 Interested | 1 | | | |
| 1328 Engaged | 2 | ✅ | | |
| 1329 Needs Exploration | 3 | ✅ | ✅ | |
| 1330 Solution Fit | 4 | ✅ | ✅ | ✅ |
| 1331 Ready to Purchase | 5 | ✅ | ✅ | ✅ |
| 1332 Payment Completion | 6 | ✅ | ✅ | ✅ |

(`Lead In`, `Interested` không tính vào tier nào — đúng pattern đã áp dụng cho `Sales Prospecting`.)

⚠️ Vẫn còn: các `stage_id` 264, 265, 267, 268 trong 3 list **không còn tồn tại** trong bảng `stages` hiện tại (có thể là stage cũ đã xóa/đổi id) — vô hại về mặt kết quả (không match được gì nên không đếm sai), chỉ là dấu hiệu 3 list gốc có phần lỗi thời, không cần xử lý gấp cho MVP.

### 9.4. 🐛 Đã sửa: JOIN với `dim_course` nhân bản hàng chục nghìn dòng ảo (2026-08-23)

**Triệu chứng:** chạy thử Q5 (Warning Scan) trả về vài chục nghìn dòng dù `dim_course` chỉ có ~40 khóa. Q6 (Focus Group) chạy rất chậm dù output không phình.

**Nguyên nhân:** `dim_course` là external table trỏ Google Sheet — Sheet mặc định có hàng nghìn dòng trống phía dưới vùng dữ liệu thật, các dòng này được BigQuery đọc vào table với `course_key = ''` (chuỗi rỗng, không phải NULL). Đồng thời, các deal **chưa chọn khóa** (`selected_course` rỗng — 203 deal ở lần audit gần nhất, mục 3.2) cũng chuẩn hoá thành `raw_key = ''`. Khi JOIN `v_course_map`/`v_deal_enriched` bằng `raw_key`, **mỗi deal thiếu khóa khớp với TẤT CẢ các dòng trống của `dim_course`** → nhân dòng ảo theo cấp số nhân (deal × số dòng trống). Q5 lộ số dòng vì JOIN thẳng ra output; Q6 không lộ số dòng (có filter `IN (SELECT course_key FROM scope)` ở cuối) nhưng vẫn phải tính phần phình đó bên trong nên chậm — cùng 1 gốc bệnh.

**Đã sửa (2 lớp, ở cả DDL view §3 và ở toàn bộ query inline trong `Daily-5-Minutes-Brief_v1.1_MVP.workflow.json`):**
1. `v_course_map`/`course_map` loại thẳng dòng `dim_course` có `course_key` rỗng/NULL trước khi đưa vào map.
2. Điều kiện JOIN thêm chặn `raw_key != ''` — deal không có khóa không được phép match với bất kỳ dòng nào, tự động rơi đúng vào nhánh `[CHƯA CHỌN KHÓA]`/`is_unmapped` như thiết kế ban đầu, không cần biết `dim_course` có sạch hay không.

**Khuyến nghị bổ sung (không bắt buộc vì SQL đã tự chống được):** giới hạn lại **Sheet Range** khi tạo external table `dim_course` (Bước 2, [`HUONG-DAN-Setup-dm_daily_brief.md`](HUONG-DAN-Setup-dm_daily_brief.md)) về đúng vùng có dữ liệu (vd. `dim_course!A1:H42`) thay vì để mặc định cả sheet — giảm số dòng trống import vào, đỡ tốn quét dù logic SQL đã chặn được.
