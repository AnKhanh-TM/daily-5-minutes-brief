# SQL Queries — Daily 5 Minutes Brief

Tài liệu này là nơi tra cứu nhanh toàn bộ SQL đang chạy trong workflow hiện tại. Mỗi phần trả lời bốn câu hỏi:

1. Query dùng để làm gì?
2. Query nhận input nào từ workflow?
3. Query đọc bảng nào?
4. Query trả output gì cho bước tiếp theo?

Nguồn code: `workflow/Daily-5-Minutes-Brief.json`.

## Quy ước chung

- Múi giờ của workflow: `Asia/Ho_Chi_Minh`.
- Daily lấy dữ liệu đến hết `report_date`, tức ngày liền trước ngày workflow chạy.
- Weekly chạy Thứ Bảy và so sánh Thứ Hai–Thứ Sáu vừa qua với Thứ Hai–Thứ Sáu của tuần trước.
- Deal có `failed_reason_id` bắt đầu bằng `Trash:` bị loại khỏi mọi KPI chính.
- Lead được tính theo `created_at`; Won/Lost được tính theo `closed_at`, trừ Q5 là cohort theo ngày tạo Lead trong tuần.
- Tên khóa được chuẩn hóa bằng lowercase, trim khoảng trắng và aliases trong `dim_course`.
- CVR trong Q1/Q3 là `Won / (Won + Lost)`. Nếu mẫu bằng 0, BigQuery trả `NULL` nhờ `SAFE_DIVIDE`.
- Các nhóm MQL, Discovery và Need-fit hiện được xác định bằng danh sách `stage_id` viết trực tiếp trong SQL. Khi CRM đổi stage, cần rà lại Q1, Q2 và Q3.

## Nguồn dữ liệu

| Bảng | Vai trò |
|---|---|
| `tmdatabase.dm_base_crm.deals` | Nguồn Lead/deal, stage, trạng thái Won/Lost, thời gian tạo/đóng và UTM. |
| `tmdatabase.dm_daily_brief.dim_course` | Danh mục khóa chuẩn, tên hiển thị, nhóm khóa, lịch báo cáo và aliases. |
| `tmdatabase.dm_daily_brief.brief_run_log` | Bảng nhận log sau khi bản brief được tạo xong. |

## Input thời gian từ Resolve Calendar

| Field | Ý nghĩa |
|---|---|
| `report_date` | Ngày dữ liệu Daily cần báo cáo, thường là hôm qua. |
| `report_day` | Nhóm thứ dùng để chọn khóa cho Daily: 2–6. |
| `curr7_start`, `curr7_end` | 7 ngày gần nhất, kết thúc tại `report_date`. |
| `prev7_start`, `prev7_end` | 7 ngày ngay trước cửa sổ hiện tại. |
| `prev30_start`, `prev30_end` | Baseline 30 ngày, không chồng lên 7 ngày hiện tại. |
| `prev90_start`, `prev90_end` | Baseline 90 ngày, không chồng lên 7 ngày hiện tại. |
| `week_curr_start`, `week_curr_end` | Thứ Hai–Thứ Sáu của tuần vừa hoàn tất. |
| `week_prev_start`, `week_prev_end` | Thứ Hai–Thứ Sáu của tuần trước đó. |

## Q0 Daily Data Health

**Mục đích:** Kiểm tra chất lượng mapping tên khóa của các Lead được tạo trong ngày báo cáo.

**Input:** `report_date`.

**Bảng đọc:** `deals`, `dim_course`.

**Bước dùng output:** `Build Daily Payload` dùng kết quả để tính số Lead thiếu tên khóa, tên khóa chưa map và tỷ lệ lỗi.

| Output | Ý nghĩa |
|---|---|
| `mapping_status` | `OK`, `MISSING_COURSE` hoặc `UNMAPPED_COURSE`. |
| `selected_course_raw` | Tên khóa gốc gây lỗi; để trống khi Lead thiếu tên khóa. |
| `issue_count` | Số Lead gặp lỗi trong từng nhóm. |
| `total_leads` | Tổng Lead của ngày báo cáo. |

### SQL

```sql
WITH
params AS (
  SELECT
    DATE('{{ $('Resolve Calendar').first().json.report_date }}') AS report_date,
    DATETIME(DATE('{{ $('Resolve Calendar').first().json.report_date }}')) AS day_start,
    DATETIME(DATE_ADD(DATE('{{ $('Resolve Calendar').first().json.report_date }}'), INTERVAL 1 DAY)) AS day_end
),

course_map AS (
  SELECT DISTINCT
    LOWER(TRIM(REGEXP_REPLACE(course_key, r'\s+', ' '))) AS raw_key
  FROM `tmdatabase.dm_daily_brief.dim_course`
  WHERE course_key IS NOT NULL AND TRIM(course_key) != ''

  UNION DISTINCT

  SELECT DISTINCT
    LOWER(TRIM(REGEXP_REPLACE(alias, r'\s+', ' '))) AS raw_key
  FROM `tmdatabase.dm_daily_brief.dim_course`,
  UNNEST(SPLIT(IFNULL(aliases, ''), ',')) AS alias
  WHERE course_key IS NOT NULL AND TRIM(course_key) != '' AND TRIM(alias) != ''
),

daily_leads AS (
  SELECT
    d.deal_id,
    d.selected_course,
    LOWER(TRIM(REGEXP_REPLACE(IFNULL(d.selected_course, ''), r'\s+', ' '))) AS raw_key
  FROM `tmdatabase.dm_base_crm.deals` d
  CROSS JOIN params p
  WHERE NOT STARTS_WITH(IFNULL(d.failed_reason_id, ''), 'Trash:')
    AND d.created_at >= p.day_start
    AND d.created_at < p.day_end
),

totals AS (
  SELECT COUNT(DISTINCT deal_id) AS total_leads
  FROM daily_leads
),

issues AS (
  SELECT
    l.deal_id,
    l.selected_course,
    CASE WHEN l.raw_key = '' THEN 'MISSING_COURSE' ELSE 'UNMAPPED_COURSE' END AS mapping_status
  FROM daily_leads l
  LEFT JOIN course_map m ON m.raw_key = l.raw_key AND l.raw_key != ''
  WHERE l.raw_key = '' OR m.raw_key IS NULL
),

summary AS (
  SELECT
    mapping_status,
    CASE WHEN mapping_status = 'MISSING_COURSE' THEN NULL ELSE selected_course END AS selected_course_raw,
    COUNT(DISTINCT deal_id) AS issue_count
  FROM issues
  GROUP BY mapping_status, selected_course_raw
)

SELECT
  IFNULL(s.mapping_status, 'OK') AS mapping_status,
  s.selected_course_raw,
  IFNULL(s.issue_count, 0) AS issue_count,
  t.total_leads
FROM totals t
LEFT JOIN summary s ON TRUE
ORDER BY issue_count DESC, mapping_status;
```

## Q1 Daily Overall Funnel

**Mục đích:** Tạo bức tranh funnel toàn công ty cho Daily: số hôm qua và so sánh 7 ngày gần nhất với 7 ngày trước.

**Input:** `report_date`, `curr7_start`, `prev7_start`, `prev7_end`.

**Bảng đọc:** `deals`.

**Bước dùng output:** `Build Daily Payload` chuyển các số này thành average/ngày, direction và câu tóm tắt toàn cảnh.

| Output | Ý nghĩa |
|---|---|
| Nhóm Lead | `leads_yesterday`, `leads_curr`, `leads_prev`, `leads_avg_curr`, `leads_avg_prev`, `leads_pct_change`. |
| Nhóm MQL | `mql_curr`, `mql_prev`, `mql_avg_curr`, `mql_avg_prev`, `mql_pct_change`. |
| Nhóm Discovery | `discovery_curr`, `discovery_prev`, `discovery_avg_curr`, `discovery_avg_prev`, `discovery_pct_change`. |
| Nhóm Need-fit | `needfit_curr`, `needfit_prev`, `needfit_avg_curr`, `needfit_avg_prev`, `needfit_pct_change`. |
| Nhóm Won | `won_yesterday`, `won_curr`, `won_prev`, `won_avg_curr`, `won_avg_prev`, `won_pct_change`. |
| Nhóm Lost | `lost_curr`, `lost_prev`, `lost_avg_curr`, `lost_avg_prev`, `lost_pct_change`. |
| CVR | `cvr_curr`, `cvr_prev`, `cvr_change_pp` — thay đổi tính bằng điểm phần trăm. |

### SQL

```sql
WITH
params AS (
  SELECT
    DATETIME(DATE('{{ $('Resolve Calendar').first().json.report_date }}')) AS report_start,
    DATETIME(DATE_ADD(DATE('{{ $('Resolve Calendar').first().json.report_date }}'), INTERVAL 1 DAY)) AS report_end,
    DATETIME(DATE('{{ $('Resolve Calendar').first().json.periods.curr7_start }}')) AS curr_start,
    DATETIME(DATE('{{ $('Resolve Calendar').first().json.periods.prev7_start }}')) AS prev_start,
    DATETIME(DATE_ADD(DATE('{{ $('Resolve Calendar').first().json.periods.prev7_end }}'), INTERVAL 1 DAY)) AS prev_end
),

lead_metrics AS (
  SELECT
    COUNT(DISTINCT IF(d.created_at >= p.report_start AND d.created_at < p.report_end, d.deal_id, NULL)) AS leads_yesterday,
    COUNT(DISTINCT IF(d.created_at >= p.curr_start AND d.created_at < p.report_end, d.deal_id, NULL)) AS leads_curr,
    COUNT(DISTINCT IF(d.created_at >= p.prev_start AND d.created_at < p.prev_end, d.deal_id, NULL)) AS leads_prev,
    COUNT(DISTINCT IF(d.created_at >= p.curr_start AND d.created_at < p.report_end AND d.stage_id IN (224,264,267,268,265,92,91,227,228,225,229,226,220,221,217,222,218,219,75,76,73,74,79,80,1328,1329,1330,1331,1332), d.deal_id, NULL)) AS mql_curr,
    COUNT(DISTINCT IF(d.created_at >= p.prev_start AND d.created_at < p.prev_end AND d.stage_id IN (224,264,267,268,265,92,91,227,228,225,229,226,220,221,217,222,218,219,75,76,73,74,79,80,1328,1329,1330,1331,1332), d.deal_id, NULL)) AS mql_prev,
    COUNT(DISTINCT IF(d.created_at >= p.curr_start AND d.created_at < p.report_end AND d.stage_id IN (224,267,268,92,91,227,228,225,229,226,220,221,222,218,219,75,76,74,80,1329,1330,1331,1332), d.deal_id, NULL)) AS discovery_curr,
    COUNT(DISTINCT IF(d.created_at >= p.prev_start AND d.created_at < p.prev_end AND d.stage_id IN (224,267,268,92,91,227,228,225,229,226,220,221,222,218,219,75,76,74,80,1329,1330,1331,1332), d.deal_id, NULL)) AS discovery_prev,
    COUNT(DISTINCT IF(d.created_at >= p.curr_start AND d.created_at < p.report_end AND d.stage_id IN (224,267,268,92,91,227,228,225,229,226,220,221,222,219,75,76,1330,1331,1332), d.deal_id, NULL)) AS needfit_curr,
    COUNT(DISTINCT IF(d.created_at >= p.prev_start AND d.created_at < p.prev_end AND d.stage_id IN (224,267,268,92,91,227,228,225,229,226,220,221,222,219,75,76,1330,1331,1332), d.deal_id, NULL)) AS needfit_prev
  FROM `tmdatabase.dm_base_crm.deals` d
  CROSS JOIN params p
  WHERE NOT STARTS_WITH(IFNULL(d.failed_reason_id, ''), 'Trash:')
    AND d.created_at >= p.prev_start AND d.created_at < p.report_end
),

outcome_metrics AS (
  SELECT
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.report_start AND d.closed_at < p.report_end, d.deal_id, NULL)) AS won_yesterday,
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.curr_start AND d.closed_at < p.report_end, d.deal_id, NULL)) AS won_curr,
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.prev_start AND d.closed_at < p.prev_end, d.deal_id, NULL)) AS won_prev,
    COUNT(DISTINCT IF(d.deal_status = 'lost' AND d.closed_at >= p.curr_start AND d.closed_at < p.report_end, d.deal_id, NULL)) AS lost_curr,
    COUNT(DISTINCT IF(d.deal_status = 'lost' AND d.closed_at >= p.prev_start AND d.closed_at < p.prev_end, d.deal_id, NULL)) AS lost_prev
  FROM `tmdatabase.dm_base_crm.deals` d
  CROSS JOIN params p
  WHERE NOT STARTS_WITH(IFNULL(d.failed_reason_id, ''), 'Trash:')
    AND d.deal_status IN ('won', 'lost')
    AND d.closed_at >= p.prev_start AND d.closed_at < p.report_end
)

SELECT
  l.*,
  o.*,
  ROUND(l.leads_curr / 7.0, 2) AS leads_avg_curr,
  ROUND(l.leads_prev / 7.0, 2) AS leads_avg_prev,
  ROUND(SAFE_DIVIDE(l.leads_curr - l.leads_prev, NULLIF(l.leads_prev, 0)) * 100, 1) AS leads_pct_change,
  ROUND(l.mql_curr / 7.0, 2) AS mql_avg_curr,
  ROUND(l.mql_prev / 7.0, 2) AS mql_avg_prev,
  ROUND(SAFE_DIVIDE(l.mql_curr - l.mql_prev, NULLIF(l.mql_prev, 0)) * 100, 1) AS mql_pct_change,
  ROUND(l.discovery_curr / 7.0, 2) AS discovery_avg_curr,
  ROUND(l.discovery_prev / 7.0, 2) AS discovery_avg_prev,
  ROUND(SAFE_DIVIDE(l.discovery_curr - l.discovery_prev, NULLIF(l.discovery_prev, 0)) * 100, 1) AS discovery_pct_change,
  ROUND(l.needfit_curr / 7.0, 2) AS needfit_avg_curr,
  ROUND(l.needfit_prev / 7.0, 2) AS needfit_avg_prev,
  ROUND(SAFE_DIVIDE(l.needfit_curr - l.needfit_prev, NULLIF(l.needfit_prev, 0)) * 100, 1) AS needfit_pct_change,
  ROUND(o.won_curr / 7.0, 2) AS won_avg_curr,
  ROUND(o.won_prev / 7.0, 2) AS won_avg_prev,
  ROUND(SAFE_DIVIDE(o.won_curr - o.won_prev, NULLIF(o.won_prev, 0)) * 100, 1) AS won_pct_change,
  ROUND(o.lost_curr / 7.0, 2) AS lost_avg_curr,
  ROUND(o.lost_prev / 7.0, 2) AS lost_avg_prev,
  ROUND(SAFE_DIVIDE(o.lost_curr - o.lost_prev, NULLIF(o.lost_prev, 0)) * 100, 1) AS lost_pct_change,
  ROUND(SAFE_DIVIDE(o.won_curr, o.won_curr + o.lost_curr) * 100, 1) AS cvr_curr,
  ROUND(SAFE_DIVIDE(o.won_prev, o.won_prev + o.lost_prev) * 100, 1) AS cvr_prev,
  ROUND((SAFE_DIVIDE(o.won_curr, o.won_curr + o.lost_curr) - SAFE_DIVIDE(o.won_prev, o.won_prev + o.lost_prev)) * 100, 1) AS cvr_change_pp
FROM lead_metrics l
CROSS JOIN outcome_metrics o;
```

## Q2 Daily Focus Trend

**Mục đích:** Lấy hiệu quả của đúng nhóm khóa được lên lịch trong ngày và đặt kết quả 7 ngày cạnh baseline 7/30/90 ngày.

**Input:** `report_day`, `report_date`, `curr7_start`, `prev7_start`, `prev30_start`, `prev90_start`.

**Bảng đọc:** `deals`, `dim_course`.

**Bước dùng output:** `Build Daily Payload` đánh giá từng khóa, gắn trạng thái xanh–cam–đỏ và chọn tối đa 3 vấn đề cần chú ý.

| Output | Ý nghĩa |
|---|---|
| Thông tin khóa | `course_key`, `course_name`, `course_type`. |
| Lead | `lead_n_curr7`, `lead_n_prev7`, `lead_n_prev30`, `lead_n_prev90`. |
| MQL | `mql_n_curr7`, `mql_n_prev7`. |
| Discovery | `discovery_n_curr7`, `discovery_n_prev7`. |
| Need-fit | `needfit_n_curr7`, `needfit_n_prev7`. |
| Won | `won_n_curr7`, `won_n_prev7`, `won_n_prev30`, `won_n_prev90`. |
| Lost | `lost_n_curr7`, `lost_n_prev7`. |
| Tình trạng Lead | `last_lead_date`, `days_no_lead`, `has_ever_had_lead`. |

### SQL

```sql
WITH
params AS (
  SELECT
    DATETIME(DATE('{{ $('Resolve Calendar').first().json.periods.curr7_start }}')) AS curr_start,
    DATETIME(DATE('{{ $('Resolve Calendar').first().json.periods.prev7_start }}')) AS prev7_start,
    DATETIME(DATE('{{ $('Resolve Calendar').first().json.periods.prev30_start }}')) AS prev30_start,
    DATETIME(DATE('{{ $('Resolve Calendar').first().json.periods.prev90_start }}')) AS prev90_start,
    DATETIME(DATE('{{ $('Resolve Calendar').first().json.periods.curr7_start }}')) AS baseline_end,
    DATETIME(DATE_ADD(DATE('{{ $('Resolve Calendar').first().json.report_date }}'), INTERVAL 1 DAY)) AS report_end
),

active_courses AS (
  SELECT
    course_key,
    course_name,
    course_type,
    report_day,
    aliases
  FROM `tmdatabase.dm_daily_brief.dim_course`
  WHERE is_active = TRUE
    AND course_key IS NOT NULL
    AND TRIM(course_key) != ''
),

course_map AS (
  SELECT DISTINCT
    LOWER(TRIM(REGEXP_REPLACE(course_key, r'\s+', ' '))) AS raw_key,
    course_key
  FROM active_courses

  UNION DISTINCT

  SELECT DISTINCT
    LOWER(TRIM(REGEXP_REPLACE(alias, r'\s+', ' '))) AS raw_key,
    course_key
  FROM active_courses,
  UNNEST(SPLIT(IFNULL(aliases, ''), ',')) AS alias
  WHERE TRIM(alias) != ''
),

scope AS (
  SELECT
    course_key,
    course_name,
    course_type
  FROM active_courses
  WHERE report_day = {{ $('Resolve Calendar').first().json.report_day }}
),

created_metrics AS (
  SELECT
    m.course_key,
    COUNT(DISTINCT IF(d.created_at >= p.curr_start AND d.created_at < p.report_end, d.deal_id, NULL)) AS lead_n_curr7,
    COUNT(DISTINCT IF(d.created_at >= p.prev7_start AND d.created_at < p.baseline_end, d.deal_id, NULL)) AS lead_n_prev7,
    COUNT(DISTINCT IF(d.created_at >= p.prev30_start AND d.created_at < p.baseline_end, d.deal_id, NULL)) AS lead_n_prev30,
    COUNT(DISTINCT IF(d.created_at >= p.prev90_start AND d.created_at < p.baseline_end, d.deal_id, NULL)) AS lead_n_prev90,

    COUNT(DISTINCT IF(d.created_at >= p.curr_start AND d.created_at < p.report_end
      AND d.stage_id IN (224,264,267,268,265,92,91,227,228,225,229,226,220,221,217,222,218,219,75,76,73,74,79,80,1328,1329,1330,1331,1332), d.deal_id, NULL)) AS mql_n_curr7,
    COUNT(DISTINCT IF(d.created_at >= p.prev7_start AND d.created_at < p.baseline_end
      AND d.stage_id IN (224,264,267,268,265,92,91,227,228,225,229,226,220,221,217,222,218,219,75,76,73,74,79,80,1328,1329,1330,1331,1332), d.deal_id, NULL)) AS mql_n_prev7,

    COUNT(DISTINCT IF(d.created_at >= p.curr_start AND d.created_at < p.report_end
      AND d.stage_id IN (224,267,268,92,91,227,228,225,229,226,220,221,222,218,219,75,76,74,80,1329,1330,1331,1332), d.deal_id, NULL)) AS discovery_n_curr7,
    COUNT(DISTINCT IF(d.created_at >= p.prev7_start AND d.created_at < p.baseline_end
      AND d.stage_id IN (224,267,268,92,91,227,228,225,229,226,220,221,222,218,219,75,76,74,80,1329,1330,1331,1332), d.deal_id, NULL)) AS discovery_n_prev7,

    COUNT(DISTINCT IF(d.created_at >= p.curr_start AND d.created_at < p.report_end
      AND d.stage_id IN (224,267,268,92,91,227,228,225,229,226,220,221,222,219,75,76,1330,1331,1332), d.deal_id, NULL)) AS needfit_n_curr7,
    COUNT(DISTINCT IF(d.created_at >= p.prev7_start AND d.created_at < p.baseline_end
      AND d.stage_id IN (224,267,268,92,91,227,228,225,229,226,220,221,222,219,75,76,1330,1331,1332), d.deal_id, NULL)) AS needfit_n_prev7,

    MAX(IF(d.created_at < p.report_end, DATE(d.created_at), NULL)) AS last_lead_date
  FROM `tmdatabase.dm_base_crm.deals` d
  CROSS JOIN params p
  INNER JOIN course_map m
    ON m.raw_key = LOWER(TRIM(REGEXP_REPLACE(IFNULL(d.selected_course, ''), r'\s+', ' ')))
  WHERE NOT STARTS_WITH(IFNULL(d.failed_reason_id, ''), 'Trash:')
    AND d.created_at < p.report_end
  GROUP BY m.course_key
),

closed_metrics AS (
  SELECT
    m.course_key,
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.curr_start AND d.closed_at < p.report_end, d.deal_id, NULL)) AS won_n_curr7,
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.prev7_start AND d.closed_at < p.baseline_end, d.deal_id, NULL)) AS won_n_prev7,
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.prev30_start AND d.closed_at < p.baseline_end, d.deal_id, NULL)) AS won_n_prev30,
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.prev90_start AND d.closed_at < p.baseline_end, d.deal_id, NULL)) AS won_n_prev90,
    COUNT(DISTINCT IF(d.deal_status = 'lost' AND d.closed_at >= p.curr_start AND d.closed_at < p.report_end, d.deal_id, NULL)) AS lost_n_curr7,
    COUNT(DISTINCT IF(d.deal_status = 'lost' AND d.closed_at >= p.prev7_start AND d.closed_at < p.baseline_end, d.deal_id, NULL)) AS lost_n_prev7
  FROM `tmdatabase.dm_base_crm.deals` d
  CROSS JOIN params p
  INNER JOIN course_map m
    ON m.raw_key = LOWER(TRIM(REGEXP_REPLACE(IFNULL(d.selected_course, ''), r'\s+', ' ')))
  WHERE NOT STARTS_WITH(IFNULL(d.failed_reason_id, ''), 'Trash:')
    AND d.deal_status IN ('won', 'lost')
    AND d.closed_at >= p.prev90_start
    AND d.closed_at < p.report_end
  GROUP BY m.course_key
)

SELECT
  s.course_key,
  s.course_name,
  s.course_type,
  IFNULL(c.lead_n_curr7, 0) AS lead_n_curr7,
  IFNULL(c.lead_n_prev7, 0) AS lead_n_prev7,
  IFNULL(c.lead_n_prev30, 0) AS lead_n_prev30,
  IFNULL(c.lead_n_prev90, 0) AS lead_n_prev90,
  IFNULL(c.mql_n_curr7, 0) AS mql_n_curr7,
  IFNULL(c.mql_n_prev7, 0) AS mql_n_prev7,
  IFNULL(c.discovery_n_curr7, 0) AS discovery_n_curr7,
  IFNULL(c.discovery_n_prev7, 0) AS discovery_n_prev7,
  IFNULL(c.needfit_n_curr7, 0) AS needfit_n_curr7,
  IFNULL(c.needfit_n_prev7, 0) AS needfit_n_prev7,
  IFNULL(o.won_n_curr7, 0) AS won_n_curr7,
  IFNULL(o.won_n_prev7, 0) AS won_n_prev7,
  IFNULL(o.won_n_prev30, 0) AS won_n_prev30,
  IFNULL(o.won_n_prev90, 0) AS won_n_prev90,
  IFNULL(o.lost_n_curr7, 0) AS lost_n_curr7,
  IFNULL(o.lost_n_prev7, 0) AS lost_n_prev7,
  c.last_lead_date,
  IF(c.last_lead_date IS NULL, NULL,
    DATE_DIFF(DATE('{{ $('Resolve Calendar').first().json.report_date }}'), c.last_lead_date, DAY)) AS days_no_lead,
  c.last_lead_date IS NOT NULL AS has_ever_had_lead
FROM scope s
LEFT JOIN created_metrics c USING (course_key)
LEFT JOIN closed_metrics o USING (course_key)
ORDER BY s.course_name;
```

## Q3 Weekly Overall Funnel

**Mục đích:** So sánh tổng funnel của tuần vừa qua với tuần trước, dùng cùng định nghĩa stage như Daily.

**Input:** `week_curr_start`, `week_curr_end`, `week_prev_start`, `week_prev_end`.

**Bảng đọc:** `deals`.

**Bước dùng output:** `Build Weekly Payload` dùng kết quả cho phần Performance tuần.

| Output | Ý nghĩa |
|---|---|
| Acquisition | `leads_curr/prev`, `mql_curr/prev` và `% change` tương ứng. |
| Sales Funnel | `discovery_curr/prev`, `needfit_curr/prev` và `% change` tương ứng. |
| Outcome | `won_curr/prev`, `lost_curr/prev` và `% change` tương ứng. |
| CVR | `cvr_curr`, `cvr_prev`, `cvr_change_pp`. |

### SQL

```sql
WITH
params AS (
  SELECT
    DATETIME(DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_start }}')) AS curr_start,
    DATETIME(DATE_ADD(DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_end }}'), INTERVAL 1 DAY)) AS curr_end,
    DATETIME(DATE('{{ $('Resolve Calendar').first().json.periods.week_prev_start }}')) AS prev_start,
    DATETIME(DATE_ADD(DATE('{{ $('Resolve Calendar').first().json.periods.week_prev_end }}'), INTERVAL 1 DAY)) AS prev_end
),

lead_metrics AS (
  SELECT
    COUNT(DISTINCT IF(d.created_at >= p.curr_start AND d.created_at < p.curr_end, d.deal_id, NULL)) AS leads_curr,
    COUNT(DISTINCT IF(d.created_at >= p.prev_start AND d.created_at < p.prev_end, d.deal_id, NULL)) AS leads_prev,
    COUNT(DISTINCT IF(d.created_at >= p.curr_start AND d.created_at < p.curr_end AND d.stage_id IN (224,264,267,268,265,92,91,227,228,225,229,226,220,221,217,222,218,219,75,76,73,74,79,80,1328,1329,1330,1331,1332), d.deal_id, NULL)) AS mql_curr,
    COUNT(DISTINCT IF(d.created_at >= p.prev_start AND d.created_at < p.prev_end AND d.stage_id IN (224,264,267,268,265,92,91,227,228,225,229,226,220,221,217,222,218,219,75,76,73,74,79,80,1328,1329,1330,1331,1332), d.deal_id, NULL)) AS mql_prev,
    COUNT(DISTINCT IF(d.created_at >= p.curr_start AND d.created_at < p.curr_end AND d.stage_id IN (224,267,268,92,91,227,228,225,229,226,220,221,222,218,219,75,76,74,80,1329,1330,1331,1332), d.deal_id, NULL)) AS discovery_curr,
    COUNT(DISTINCT IF(d.created_at >= p.prev_start AND d.created_at < p.prev_end AND d.stage_id IN (224,267,268,92,91,227,228,225,229,226,220,221,222,218,219,75,76,74,80,1329,1330,1331,1332), d.deal_id, NULL)) AS discovery_prev,
    COUNT(DISTINCT IF(d.created_at >= p.curr_start AND d.created_at < p.curr_end AND d.stage_id IN (224,267,268,92,91,227,228,225,229,226,220,221,222,219,75,76,1330,1331,1332), d.deal_id, NULL)) AS needfit_curr,
    COUNT(DISTINCT IF(d.created_at >= p.prev_start AND d.created_at < p.prev_end AND d.stage_id IN (224,267,268,92,91,227,228,225,229,226,220,221,222,219,75,76,1330,1331,1332), d.deal_id, NULL)) AS needfit_prev
  FROM `tmdatabase.dm_base_crm.deals` d
  CROSS JOIN params p
  WHERE NOT STARTS_WITH(IFNULL(d.failed_reason_id, ''), 'Trash:')
    AND d.created_at >= p.prev_start AND d.created_at < p.curr_end
),

outcome_metrics AS (
  SELECT
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.curr_start AND d.closed_at < p.curr_end, d.deal_id, NULL)) AS won_curr,
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.prev_start AND d.closed_at < p.prev_end, d.deal_id, NULL)) AS won_prev,
    COUNT(DISTINCT IF(d.deal_status = 'lost' AND d.closed_at >= p.curr_start AND d.closed_at < p.curr_end, d.deal_id, NULL)) AS lost_curr,
    COUNT(DISTINCT IF(d.deal_status = 'lost' AND d.closed_at >= p.prev_start AND d.closed_at < p.prev_end, d.deal_id, NULL)) AS lost_prev
  FROM `tmdatabase.dm_base_crm.deals` d
  CROSS JOIN params p
  WHERE NOT STARTS_WITH(IFNULL(d.failed_reason_id, ''), 'Trash:')
    AND d.deal_status IN ('won', 'lost')
    AND d.closed_at >= p.prev_start AND d.closed_at < p.curr_end
)

SELECT
  l.*,
  o.*,
  ROUND(SAFE_DIVIDE(l.leads_curr - l.leads_prev, NULLIF(l.leads_prev, 0)) * 100, 1) AS leads_pct_change,
  ROUND(SAFE_DIVIDE(l.mql_curr - l.mql_prev, NULLIF(l.mql_prev, 0)) * 100, 1) AS mql_pct_change,
  ROUND(SAFE_DIVIDE(l.discovery_curr - l.discovery_prev, NULLIF(l.discovery_prev, 0)) * 100, 1) AS discovery_pct_change,
  ROUND(SAFE_DIVIDE(l.needfit_curr - l.needfit_prev, NULLIF(l.needfit_prev, 0)) * 100, 1) AS needfit_pct_change,
  ROUND(SAFE_DIVIDE(o.won_curr - o.won_prev, NULLIF(o.won_prev, 0)) * 100, 1) AS won_pct_change,
  ROUND(SAFE_DIVIDE(o.lost_curr - o.lost_prev, NULLIF(o.lost_prev, 0)) * 100, 1) AS lost_pct_change,
  ROUND(SAFE_DIVIDE(o.won_curr, o.won_curr + o.lost_curr) * 100, 1) AS cvr_curr,
  ROUND(SAFE_DIVIDE(o.won_prev, o.won_prev + o.lost_prev) * 100, 1) AS cvr_prev,
  ROUND((SAFE_DIVIDE(o.won_curr, o.won_curr + o.lost_curr) - SAFE_DIVIDE(o.won_prev, o.won_prev + o.lost_prev)) * 100, 1) AS cvr_change_pp
FROM lead_metrics l
CROSS JOIN outcome_metrics o;
```

## Q4 Weekly Course Performance

**Mục đích:** Tổng hợp hiệu quả từng khóa để xếp nhóm đang tốt, cần theo dõi hoặc cần hành động ngay.

**Input:** Các mốc tuần; baseline 7/30/90 ngày được suy ra từ `week_curr_end`; `warning_open_deal_days` từ Config.

**Bảng đọc:** `deals`, `dim_course`.

**Bước dùng output:** `Build Weekly Payload` tính direction, leaderboard, nhóm pattern, danh sách no-lead và ưu tiên tuần sau.

| Output | Ý nghĩa |
|---|---|
| Thông tin khóa | `course_key`, `course_name`, `course_type`. |
| Tuần hiện tại/trước | `leads_this_week`, `leads_last_week`, `won_this_week`, `lost_this_week`, `won_last_week`, `lost_last_week`. |
| Xu hướng Lead | `lead_n_curr7`, `lead_n_prev7`, `lead_n_prev30`, `lead_n_prev90`. |
| Xu hướng Won | `won_n_curr7`, `won_n_prev7`, `won_n_prev30`, `won_n_prev90`. |
| No-lead | `last_lead_date`, `days_no_lead`, `has_ever_had_lead`. |
| Deal open lâu | `stale_open_deals` — đang được tính nhưng feature hiển thị hiện tắt trong Config. |

### SQL

```sql
WITH
params AS (
  SELECT
    DATETIME(DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_start }}')) AS week_curr_start,
    DATETIME(DATE_ADD(DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_end }}'), INTERVAL 1 DAY)) AS week_curr_end,
    DATETIME(DATE('{{ $('Resolve Calendar').first().json.periods.week_prev_start }}')) AS week_prev_start,
    DATETIME(DATE_ADD(DATE('{{ $('Resolve Calendar').first().json.periods.week_prev_end }}'), INTERVAL 1 DAY)) AS week_prev_end,
    DATETIME(DATE_SUB(DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_end }}'), INTERVAL 6 DAY)) AS trend_curr_start,
    DATETIME(DATE_SUB(DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_end }}'), INTERVAL 13 DAY)) AS trend_prev7_start,
    DATETIME(DATE_SUB(DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_end }}'), INTERVAL 36 DAY)) AS trend_prev30_start,
    DATETIME(DATE_SUB(DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_end }}'), INTERVAL 96 DAY)) AS trend_prev90_start,
    DATETIME(DATE_SUB(DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_end }}'), INTERVAL 6 DAY)) AS trend_baseline_end,
    DATETIME(DATE_ADD(DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_end }}'), INTERVAL 1 DAY)) AS trend_end
),

active_courses AS (
  SELECT course_key, course_name, course_type, report_day, aliases
  FROM `tmdatabase.dm_daily_brief.dim_course`
  WHERE is_active = TRUE AND course_key IS NOT NULL AND TRIM(course_key) != ''
),

course_map AS (
  SELECT DISTINCT
    LOWER(TRIM(REGEXP_REPLACE(course_key, r'\s+', ' '))) AS raw_key,
    course_key
  FROM active_courses

  UNION DISTINCT

  SELECT DISTINCT
    LOWER(TRIM(REGEXP_REPLACE(alias, r'\s+', ' '))) AS raw_key,
    course_key
  FROM active_courses,
  UNNEST(SPLIT(IFNULL(aliases, ''), ',')) AS alias
  WHERE TRIM(alias) != ''
),

lead_agg AS (
  SELECT
    m.course_key,
    COUNT(DISTINCT IF(d.created_at >= p.week_curr_start AND d.created_at < p.week_curr_end, d.deal_id, NULL)) AS leads_this_week,
    COUNT(DISTINCT IF(d.created_at >= p.week_prev_start AND d.created_at < p.week_prev_end, d.deal_id, NULL)) AS leads_last_week,
    COUNT(DISTINCT IF(d.created_at >= p.trend_curr_start AND d.created_at < p.trend_end, d.deal_id, NULL)) AS lead_n_curr7,
    COUNT(DISTINCT IF(d.created_at >= p.trend_prev7_start AND d.created_at < p.trend_baseline_end, d.deal_id, NULL)) AS lead_n_prev7,
    COUNT(DISTINCT IF(d.created_at >= p.trend_prev30_start AND d.created_at < p.trend_baseline_end, d.deal_id, NULL)) AS lead_n_prev30,
    COUNT(DISTINCT IF(d.created_at >= p.trend_prev90_start AND d.created_at < p.trend_baseline_end, d.deal_id, NULL)) AS lead_n_prev90,
    MAX(IF(d.created_at < p.week_curr_end, DATE(d.created_at), NULL)) AS last_lead_date
  FROM `tmdatabase.dm_base_crm.deals` d
  CROSS JOIN params p
  INNER JOIN course_map m ON m.raw_key = LOWER(TRIM(REGEXP_REPLACE(IFNULL(d.selected_course, ''), r'\s+', ' ')))
  WHERE NOT STARTS_WITH(IFNULL(d.failed_reason_id, ''), 'Trash:')
    AND d.created_at < p.week_curr_end
  GROUP BY m.course_key
),

outcome_agg AS (
  SELECT
    m.course_key,
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.week_curr_start AND d.closed_at < p.week_curr_end, d.deal_id, NULL)) AS won_this_week,
    COUNT(DISTINCT IF(d.deal_status = 'lost' AND d.closed_at >= p.week_curr_start AND d.closed_at < p.week_curr_end, d.deal_id, NULL)) AS lost_this_week,
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.week_prev_start AND d.closed_at < p.week_prev_end, d.deal_id, NULL)) AS won_last_week,
    COUNT(DISTINCT IF(d.deal_status = 'lost' AND d.closed_at >= p.week_prev_start AND d.closed_at < p.week_prev_end, d.deal_id, NULL)) AS lost_last_week,
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.trend_curr_start AND d.closed_at < p.trend_end, d.deal_id, NULL)) AS won_n_curr7,
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.trend_prev7_start AND d.closed_at < p.trend_baseline_end, d.deal_id, NULL)) AS won_n_prev7,
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.trend_prev30_start AND d.closed_at < p.trend_baseline_end, d.deal_id, NULL)) AS won_n_prev30,
    COUNT(DISTINCT IF(d.deal_status = 'won' AND d.closed_at >= p.trend_prev90_start AND d.closed_at < p.trend_baseline_end, d.deal_id, NULL)) AS won_n_prev90
  FROM `tmdatabase.dm_base_crm.deals` d
  CROSS JOIN params p
  INNER JOIN course_map m ON m.raw_key = LOWER(TRIM(REGEXP_REPLACE(IFNULL(d.selected_course, ''), r'\s+', ' ')))
  WHERE NOT STARTS_WITH(IFNULL(d.failed_reason_id, ''), 'Trash:')
    AND d.closed_at IS NOT NULL AND d.closed_at < p.week_curr_end
  GROUP BY m.course_key
),

stale_agg AS (
  SELECT
    m.course_key,
    COUNT(DISTINCT d.deal_id) AS stale_open_deals
  FROM `tmdatabase.dm_base_crm.deals` d
  CROSS JOIN params p
  INNER JOIN course_map m ON m.raw_key = LOWER(TRIM(REGEXP_REPLACE(IFNULL(d.selected_course, ''), r'\s+', ' ')))
  WHERE NOT STARTS_WITH(IFNULL(d.failed_reason_id, ''), 'Trash:')
    AND d.deal_status = 'open'
    AND d.stage_start_at IS NOT NULL
    AND DATETIME_DIFF(p.week_curr_end, d.stage_start_at, DAY) > {{ $('Config').first().json.thresholds.warning_open_deal_days }}
  GROUP BY m.course_key
)

SELECT
  c.course_key,
  c.course_name,
  c.course_type,
  IFNULL(l.leads_this_week, 0) AS leads_this_week,
  IFNULL(l.leads_last_week, 0) AS leads_last_week,
  IFNULL(o.won_this_week, 0) AS won_this_week,
  IFNULL(o.lost_this_week, 0) AS lost_this_week,
  IFNULL(o.won_last_week, 0) AS won_last_week,
  IFNULL(o.lost_last_week, 0) AS lost_last_week,
  IFNULL(l.lead_n_curr7, 0) AS lead_n_curr7,
  IFNULL(l.lead_n_prev7, 0) AS lead_n_prev7,
  IFNULL(l.lead_n_prev30, 0) AS lead_n_prev30,
  IFNULL(l.lead_n_prev90, 0) AS lead_n_prev90,
  IFNULL(o.won_n_curr7, 0) AS won_n_curr7,
  IFNULL(o.won_n_prev7, 0) AS won_n_prev7,
  IFNULL(o.won_n_prev30, 0) AS won_n_prev30,
  IFNULL(o.won_n_prev90, 0) AS won_n_prev90,
  l.last_lead_date,
  IF(l.last_lead_date IS NULL, NULL, DATE_DIFF(DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_end }}'), l.last_lead_date, DAY)) AS days_no_lead,
  l.last_lead_date IS NOT NULL AS has_ever_had_lead,
  IFNULL(s.stale_open_deals, 0) AS stale_open_deals
FROM active_courses c
LEFT JOIN lead_agg l USING (course_key)
LEFT JOIN outcome_agg o USING (course_key)
LEFT JOIN stale_agg s USING (course_key)
ORDER BY c.course_name;
```

## Q5 Weekly Content Performance

**Mục đích:** Xếp hạng nguồn/content tạo Lead và kết quả Won/Lost trong cohort Lead được tạo ở tuần vừa qua.

**Input:** `week_curr_start`, `week_curr_end`.

**Bảng đọc:** `deals`.

**Bước dùng output:** `Build Weekly Payload` tạo Top 10 theo Lead, Top theo Won/CVR và tính tỷ lệ thiếu tracking.

| Output | Ý nghĩa |
|---|---|
| Thông tin UTM | `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_product`; giá trị trống đổi thành `(not set)`. |
| Sản lượng | `n_leads`, `n_won`, `n_lost`, `n_closed`. |
| Hiệu quả | `cohort_cvr_pct` = Won / số deal đã closed trong cohort. |
| Tracking | `is_untracked` = true khi `utm_content` bị thiếu. |

### SQL

```sql
WITH
params AS (
  SELECT
    DATETIME(
      DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_start }}')
    ) AS week_start,

    DATETIME(
      DATE_ADD(
        DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_end }}'),
        INTERVAL 1 DAY
      )
    ) AS week_end
),

cohort AS (
  SELECT
    d.deal_id,
    d.deal_status,

    COALESCE(
      NULLIF(TRIM(d.utm_source), ''),
      '(not set)'
    ) AS utm_source,

    COALESCE(
      NULLIF(TRIM(d.utm_medium), ''),
      '(not set)'
    ) AS utm_medium,

    COALESCE(
      NULLIF(TRIM(d.utm_campaign), ''),
      '(not set)'
    ) AS utm_campaign,

    COALESCE(
      NULLIF(TRIM(d.utm_content), ''),
      '(not set)'
    ) AS utm_content,

    COALESCE(
      NULLIF(TRIM(d.utm_product), ''),
      '(not set)'
    ) AS utm_product

  FROM `tmdatabase.dm_base_crm.deals` d
  CROSS JOIN params p

  WHERE NOT STARTS_WITH(
    IFNULL(d.failed_reason_id, ''),
    'Trash:'
  )
    AND d.created_at >= p.week_start
    AND d.created_at < p.week_end
)

SELECT
  utm_source,
  utm_medium,
  utm_campaign,
  utm_content,
  utm_product,

  COUNT(DISTINCT deal_id) AS n_leads,

  COUNT(DISTINCT IF(
    deal_status = 'won',
    deal_id,
    NULL
  )) AS n_won,

  COUNT(DISTINCT IF(
    deal_status = 'lost',
    deal_id,
    NULL
  )) AS n_lost,

  COUNT(DISTINCT IF(
    deal_status IN ('won', 'lost'),
    deal_id,
    NULL
  )) AS n_closed,

  ROUND(
    SAFE_DIVIDE(
      COUNT(DISTINCT IF(
        deal_status = 'won',
        deal_id,
        NULL
      )),
      COUNT(DISTINCT IF(
        deal_status IN ('won', 'lost'),
        deal_id,
        NULL
      ))
    ) * 100,
    1
  ) AS cohort_cvr_pct,

  utm_content = '(not set)' AS is_untracked

FROM cohort

GROUP BY
  utm_source,
  utm_medium,
  utm_campaign,
  utm_content,
  utm_product

ORDER BY
  n_leads DESC,
  n_won DESC,
  n_lost ASC;
```

## Q6 Weekly Data Health

**Mục đích:** Kiểm tra chất lượng mapping khóa và tracking UTM trên toàn bộ Lead của tuần.

**Input:** `week_curr_start`, `week_curr_end`.

**Bảng đọc:** `deals`, `dim_course`.

**Bước dùng output:** `Build Weekly Payload` tính tỷ lệ lỗi mapping, số Lead untracked và cờ cảnh báo nghiêm trọng.

| Output | Ý nghĩa |
|---|---|
| `mapping_status` | `OK`, `MISSING_COURSE` hoặc `UNMAPPED_COURSE`. |
| `selected_course_raw` | Tên khóa gốc gây lỗi. |
| `issue_count` | Số Lead lỗi theo nhóm. |
| `total_leads` | Tổng Lead trong tuần. |
| `untracked_leads` | Số Lead thiếu `utm_content`. |

### SQL

```sql
WITH
params AS (
  SELECT
    DATETIME(DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_start }}')) AS week_start,
    DATETIME(DATE_ADD(DATE('{{ $('Resolve Calendar').first().json.periods.week_curr_end }}'), INTERVAL 1 DAY)) AS week_end
),

course_map AS (
  SELECT DISTINCT LOWER(TRIM(REGEXP_REPLACE(course_key, r'\s+', ' '))) AS raw_key
  FROM `tmdatabase.dm_daily_brief.dim_course`
  WHERE course_key IS NOT NULL AND TRIM(course_key) != ''

  UNION DISTINCT

  SELECT DISTINCT LOWER(TRIM(REGEXP_REPLACE(alias, r'\s+', ' '))) AS raw_key
  FROM `tmdatabase.dm_daily_brief.dim_course`,
  UNNEST(SPLIT(IFNULL(aliases, ''), ',')) AS alias
  WHERE course_key IS NOT NULL AND TRIM(course_key) != '' AND TRIM(alias) != ''
),

weekly_leads AS (
  SELECT
    d.deal_id,
    d.selected_course,
    LOWER(TRIM(REGEXP_REPLACE(IFNULL(d.selected_course, ''), r'\s+', ' '))) AS raw_key,
    COALESCE(NULLIF(TRIM(d.utm_content), ''), '(not set)') AS utm_content
  FROM `tmdatabase.dm_base_crm.deals` d
  CROSS JOIN params p
  WHERE NOT STARTS_WITH(IFNULL(d.failed_reason_id, ''), 'Trash:')
    AND d.created_at >= p.week_start AND d.created_at < p.week_end
),

totals AS (
  SELECT
    COUNT(DISTINCT deal_id) AS total_leads,
    COUNT(DISTINCT IF(utm_content = '(not set)', deal_id, NULL)) AS untracked_leads
  FROM weekly_leads
),

issues AS (
  SELECT
    l.deal_id,
    l.selected_course,
    CASE WHEN l.raw_key = '' THEN 'MISSING_COURSE' ELSE 'UNMAPPED_COURSE' END AS mapping_status
  FROM weekly_leads l
  LEFT JOIN course_map m ON m.raw_key = l.raw_key AND l.raw_key != ''
  WHERE l.raw_key = '' OR m.raw_key IS NULL
),

summary AS (
  SELECT
    mapping_status,
    CASE WHEN mapping_status = 'MISSING_COURSE' THEN NULL ELSE selected_course END AS selected_course_raw,
    COUNT(DISTINCT deal_id) AS issue_count
  FROM issues
  GROUP BY mapping_status, selected_course_raw
)

SELECT
  IFNULL(s.mapping_status, 'OK') AS mapping_status,
  s.selected_course_raw,
  IFNULL(s.issue_count, 0) AS issue_count,
  t.total_leads,
  t.untracked_leads
FROM totals t
LEFT JOIN summary s ON TRUE
ORDER BY issue_count DESC, mapping_status;
```

## Ghi log sau khi chạy

Node `Log Run` không chạy câu SQL tự viết; node BigQuery thực hiện thao tác **Insert** vào:

`tmdatabase.dm_daily_brief.brief_run_log`

| Field ghi vào log | Nguồn |
|---|---|
| `run_id` | ID duy nhất do `Resolve Calendar` tạo. |
| `report_date` | Ngày dữ liệu đang được báo cáo. |
| `sent_at` | Thời điểm đóng gói bản tin. |
| `query_results` | Toàn bộ payload đã tính, lưu dưới dạng JSON string. |
| `agent_output` | Nội dung text do Writer tạo. |
| `status` | Hiện nhánh thành công ghi `success`. |
| `error_message` | Để trống khi thành công. |

## Những điểm cần nhớ khi sửa SQL

- Nếu thêm hoặc đổi khóa: cập nhật bảng `dim_course` theo file Excel, không hard-code tên khóa vào query.
- Nếu đổi funnel stage: cập nhật đồng bộ Q1, Q2 và Q3; nếu chỉ sửa một query thì Daily và Weekly có thể lệch định nghĩa.
- Nếu đổi cách tính tuần: cập nhật `Resolve Calendar` trước, sau đó kiểm tra Q3–Q6.
- Q5 là cohort theo `created_at` của Lead trong tuần. Đây không phải báo cáo “mọi deal được Won/Lost trong tuần”.
- `SAFE_DIVIDE` cố ý trả `NULL` khi mẫu bằng 0; không nên đổi thành 0 nếu chưa thống nhất cách diễn giải business.
- Sau mỗi thay đổi, chạy test đủ một ngày Daily, một Thứ Bảy và một Chủ Nhật; đối chiếu tổng Lead/Won với BigQuery trước khi activate.

