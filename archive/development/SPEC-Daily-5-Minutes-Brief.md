# DAILY 5 MINUTES BRIEF — Bản mô tả hệ thống (v2)

> **Trạng thái đồng bộ:** cập nhật 2026-08-30 theo workflow n8n [`workflow/Daily-5-Minutes-Brief-v2.json`](workflow/Daily-5-Minutes-Brief-v2.json) — 45 node, workflow hiện có `active = false`.
> **v1.1 (bản cũ) đã lỗi thời:** toàn bộ SQL trong v1.1 viết cho schema Rework giả định (`rework_leads`/`rework_deals`) — **không khớp** với DB thật (bảng `deals` duy nhất). Đừng dùng lại SQL của v1.1.
> **Thứ tự nguồn sự thật:** JSON v2 là nguồn sự thật cho node, wiring, prompt, credential binding và SQL đang thực thi; `dm_base_crm_schema.md` là nguồn sự thật cho schema/business rule; file SPEC này diễn giải hành vi của JSON. Nếu SQL minh họa cũ trong SPEC khác JSON, dùng SQL trong JSON.
> Chỗ cần chốt đánh dấu 🔴 **[CẦN CHỐT]**.

---

## 1. Tổng quan

**Mục tiêu:** mỗi sáng, người đọc mất 5 phút biết: (1) hôm qua bán/lead bao nhiêu — bất thường không; (2) khóa nào tụt/tắc; (3) nhóm khóa "đến lượt hôm nay" tích cực hay tiêu cực; (4) tại sao, và hôm nay nên làm gì.

**Nguyên tắc thiết kế** (giữ nguyên từ v1.1):

| Nguyên tắc | Cụ thể |
|---|---|
| SQL làm toán, AI làm chữ | AI không tự tính lại số, chỉ đọc kết quả query và diễn giải |
| Một nguồn số liệu duy nhất | Toàn bộ số trong brief lấy từ `dm_base_crm.deals` (đã enrich qua `dim_course`) |
| 1 agent 1 việc | Writer / Analyst / Advisor tách riêng |
| Mọi ngưỡng nằm ở 1 chỗ | Node `Config` |
| Không im lặng bỏ sót | Deal/lead không map được `dim_course`, hoặc `selected_course` NULL, phải **hiện ra** trong brief |
| Luôn loại deal rác | Mọi query áp `WHERE NOT STARTS_WITH(IFNULL(failed_reason_id,''), 'Trash:')` — xem schema doc §9.1 |

✅ **[ĐÃ CHỐT — 2026-08-23]** Revenue **không** hiện trong brief (giữ nguyên tinh thần "chỉ đếm deal" của v1.1, tránh brief bị kéo sang bàn chuyện tiền). Conversion Rate **có** hiện — là tỷ lệ, không phải số tiền, không xung đột với nguyên tắc "một nguồn số liệu". `Build Payload` không đưa `revenue`/`avg_revenue_per_day`/`pct_change_revenue` vào JSON truyền cho Agent 1 (dù Q1/Q6 vẫn tính ra các trường này theo pattern §6.1–6.2 schema doc — chỉ đơn giản là không map sang payload output); `conversion_rate`/`cvr_change_pp` thì có.

**Output hiện tại:** `Final Brief` tạo field `final_brief_text`, sau đó `Log Run` ghi BigQuery và rẽ sang hai HTTP node Base.vn. `HTTP Request - Khánh` đang bật; `HTTP Request - Hưng` đang disabled. Trạng thái payload của hai node xem §11–§12.

---

## 2. Kiến trúc luồng

```
Schedule Trigger (cron 30 7 * * 1-6) / Manual Trigger
                         │
                      [Config]
                         │
                    [Resolve Day]
                         │
                    [Is Sunday?]
             ┌───────────┴────────────┐
          true                       false
             │                         │
[Sunday Message Writer]          [Is Saturday?]
             │                ┌────────┴─────────┐
[Assemble Sunday Message]     true              false
             │                │                  │
             │       Q7 Weekly Performance   Q0 Data Health
             │       → Content Performance   → Q1 KPI - Overall
             │       → Warning Snapshot      → Q2 → Q3 → Q4 → Q5
             │       → Weekly Data Health    → Q6 Focus Group1
             │                └────────┬─────────┘
             │                  [Build Payload]
             │                         │
             │              [Agent 1 - Brief Writer]
             │                         │
             │     [RCA Init → Planner → SQL Writer → Guardrail]
             │                         │
             │          valid → BigQuery → Evaluator ─┐
             │          invalid → Record Failure ─────┤
             │                                        ▼
             │                               [Continue RCA?]
             │                         true ↺ Planner · false ↓
             │                                  [RCA Finalizer]
             │                                        │
             │                         [Agent 3 - Action Advisor1]
             │                                        │
             │                                [Assemble Brief]
             └───────────────────────┬────────────────┘
                                     ▼
                               [Final Brief]
                                     │
                                  [Log Run]
                              ┌──────┴──────┐
                              ▼             ▼
                  [HTTP Request - Khánh] [HTTP Request - Hưng]
```

**Luồng RCA thực tế:** không dùng `googleBigQueryTool`. Planner, SQL Writer và Evaluator là ba LLM agent riêng; query được chạy bằng node BigQuery thường sau `SQL Guardrail`. Vòng lặp tối đa 3 lần, hoặc dừng sau 2 lỗi guardrail liên tiếp.

**Trạng thái lịch trong JSON:** thiết kế có đủ nhánh daily/weekly/Sunday, nhưng cron hiện là `30 7 * * 1-6` nên chỉ tự chạy Thứ 2–Thứ 7. Nhánh Chủ Nhật chỉ chạy được bằng Manual Trigger hoặc sau khi đổi cron sang chạy cả Chủ Nhật. Ngoài ra `Resolve Day` đang hard-code ngày test `2026-08-24T08:00:00+07:00`; dòng `new Date()` đang bị comment, nên mọi execution hiện được route như Thứ Hai cho đến khi tắt test mode.

---

## 3. Nguồn dữ liệu & chuẩn hoá khóa học

Toàn bộ chi tiết bảng, cột, business rule, cách loại deal rác → đọc [`dm_base_crm_schema.md`](dm_base_crm_schema.md). Tóm tắt phần liên quan tới workflow:

- Bảng trung tâm: `tmdatabase.dm_base_crm.deals` (1 row = 1 deal = 1 lead). Tên khóa **đã chuẩn hóa sẵn trong DB** (không cần 3 lớp chuẩn hoá phức tạp như v1.1 dự tính) — chỉ cần `LOWER(TRIM(...))` để nối với `dim_course`.
- `dim_course` sống ở Google Sheet và được connect thành `tmdatabase.dm_daily_brief.dim_course`. JSON v2 vẫn đọc `report_day` trực tiếp; việc đổi nhóm khóa T7 cũ sang `report_day = 6` phải được thực hiện trên Sheet nguồn.
- **JSON v2 không phụ thuộc `v_course_map`/`v_deal_enriched`.** Q0–Q7 tự khai báo `course_map`/`base`/`vde` hoặc JOIN `dim_course` inline trong từng SQL. Các view dưới đây chỉ còn là DDL tham khảo/định hướng refactor, không phải prerequisite runtime của v2:

```sql
CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_course_map` AS
SELECT LOWER(TRIM(course_key)) AS raw_key, course_key, course_name, course_type, report_day, is_active
FROM `${CONFIG_DATASET}.dim_course`
WHERE course_key IS NOT NULL AND TRIM(course_key) != ''          -- chặn dòng trống của external table Sheet, xem §9.4
UNION ALL
SELECT LOWER(TRIM(a)), course_key, course_name, course_type, report_day, is_active
FROM `${CONFIG_DATASET}.dim_course`, UNNEST(SPLIT(IFNULL(aliases, ''), ',')) AS a
WHERE TRIM(a) != '' AND course_key IS NOT NULL AND TRIM(course_key) != '';

CREATE OR REPLACE VIEW `${PROJECT}.${DATASET}.v_deal_enriched` AS
WITH src AS (
  SELECT
    d.*,
    LOWER(TRIM(REGEXP_REPLACE(IFNULL(d.selected_course, ''), r'\s+', ' '))) AS raw_key
  FROM `tmdatabase.dm_base_crm.deals` d
  WHERE NOT STARTS_WITH(IFNULL(d.failed_reason_id, ''), 'Trash:')   -- loại deal rác, xem schema doc §9.1
)
SELECT
  s.* EXCEPT(raw_key),
  IFNULL(m.course_key,  CONCAT('[unmapped] ', s.raw_key))                                       AS course_key_norm,
  IFNULL(m.course_name, IF(s.raw_key = '', '[CHƯA CHỌN KHÓA]', CONCAT('[CHƯA MAP] ', s.selected_course))) AS course_name_norm,
  IFNULL(m.course_type, 'Chưa phân loại')                                                     AS course_type_norm,
  m.report_day,
  IFNULL(m.is_active, FALSE)                                                                    AS is_active_course,
  (m.course_key IS NULL)                                                                        AS is_unmapped
FROM src s
LEFT JOIN `${PROJECT}.${DATASET}.v_course_map` m
  ON m.raw_key = s.raw_key AND s.raw_key != ''                    -- deal chưa chọn khóa KHÔNG được match, xem §9.4
;
```

- **Q0 Data Health:** trả `mapping_status`, `issue`, `selected_course_raw`, `course_name`, `deal_count`; nếu không có lỗi vẫn trả một row `mapping_status='OK'`, `deal_count=0`.
- **MQL / SQL Discovery / SQL Need-fit:** dùng đúng 3 list `stage_id` ở schema doc §4.3. ✅ **[ĐÃ CHỐT]** pipeline `TM AI xHust` (7 stage, id 1327–1333) đã được Data Owner bổ sung vào đúng 3 list (xem schema doc §4.3 và §9.3 — phân loại theo cùng cấu trúc với pipeline `Sales Prospecting`).

---

## 4. Nguồn dữ liệu phụ (Ads/GA/Facebook Post)

JSON v2 chưa dùng Ads/GA/Facebook Post. RCA SQL Writer chỉ được query `dm_base_crm.deals`, `stages`, `pipelines`, `deal_activities` và `dm_daily_brief.dim_course`.

---

## 5. Node `Config`

```json
{
  "gcp_project":  "tmdatabase",
  "bq_dataset":   "dm_base_crm",
  "config_dataset": "tmdatabase.dm_daily_brief",
  "timezone":     "Asia/Ho_Chi_Minh",

  "thresholds": {
    "kpi_normal_band_pct":       20,
    "warning_drop_pct":          20,
    "warning_zero_lead_days":     5,
    "warning_pending_days":       3,
    "warning_pending_min_count":  5,
    "warning_open_deal_days":    14,
    "warning_open_deal_min":      5,
    "cvr_drop_pp":                5,
    "focus_positive_pct":        15,
    "focus_negative_pct":       -15,
    "min_base_volume":            3,
    "unmapped_alert_min":         1
  },

  "limits": {
    "top_course_per_bu":   5,
    "top_utm_rows":         8,
    "top_utm_rows_weekly":      12,
    "weekly_min_content_leads":  3,
    "max_warning_rows":         12,
    "rca_max_loops":             3,
    "rca_max_rows":            200
  }
}
```

Ngưỡng lấy theo schema doc §4.8 (đã có phần Data Owner đề xuất: ±20% count, −5pp CVR, 3 ngày chưa chạm, 14 ngày tồn stage). `min_base_volume`, `unmapped_alert_min`, `warning_pending_min_count` là bổ sung từ thiết kế v1.1, giữ nguyên logic (xem SQL Q5 ở §7). 🔴 **[CẦN CHỐT]** toàn bộ số cụ thể — Data Owner tự chỉnh sau khi chạy thử vài lần.

---

## 6. Cửa sổ thời gian & time dimension

Daily Q0–Q6 dùng `Resolve Day.report_date` làm mốc; Q1 có current 7 ngày từ `report_date-6` đến hết `report_date`, previous 7 ngày liền trước. Lead/MQL/SQL theo `created_at`; Won/Lost/CVR theo `closed_at`. Q6 giữ TB7/TB30/TB90.

Q7 Weekly Performance, Content Performance và Weekly Data Health trong JSON lại dùng trực tiếp `CURRENT_DATE('Asia/Ho_Chi_Minh')`, lấy T2–T6 tương ứng khi node thật sự chạy vào Thứ 7. Điều này khác daily branch và không đi theo ngày test trong `Resolve Day`.

---

## 7. Các câu query

SQL thực thi nằm trực tiếp trong từng BigQuery node của JSON v2. Các đoạn SQL ở §7.1–§7.6 bên dưới mô tả logic nghiệp vụ và có thể chưa phản ánh từng tối ưu/cách format mới nhất; khi triển khai hoặc debug phải copy SQL từ JSON, không copy ngược từ SPEC.

| Node | Việc | Nguồn thực thi |
|---|---|---|
| Q0 Data Health | Mapping của lead trong `report_date`; luôn có row `OK` nếu không lỗi | JSON node `Q0 Data Health` |
| Q1 KPI - Overall | KPI hôm qua + current/previous 7 ngày; output đã round, CVR ở đơn vị % | JSON node `Q1 KPI - Overall` |
| Q2 | Breakdown `course_type` × khóa | §7.4 |
| Q3 UTM Daily | Top 8 combo UTM của `report_date` | JSON node `Q3 UTM Daily` |
| Q4 No-Lead Courses | Toàn bộ khóa active không có lead trong `report_date`; payload chỉ giữ tổng, số khóa ≥10 ngày và top 5 khóa ≥10 ngày | JSON node `Q4 No-Lead Courses` |
| Q5 Warning Scan | 5 cờ toàn khóa; payload normalize thành `lead_drop`, `won_drop`, `no_lead`, `pending`, `stale_open` | JSON node `Q5 Warning Scan` |
| Q6 Focus Group1 | Scope `report_day` T2–T6; TB7/30/90 | JSON node `Q6 Focus Group1` |
| Q7 Weekly bundle | `Weekly Performance` → `Content Performance` → `Warning Snapshot` → `Weekly Data Health` | 4 node Q7 trong JSON |

### 7.1. Q4 — Khóa active không ra lead hôm qua (đầy đủ)

```sql
WITH p AS (SELECT DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 1 DAY) AS d),
last_lead AS (
  SELECT course_key_norm, MAX(DATE(created_at)) AS last_lead_date
  FROM `${PROJECT}.${DATASET}.v_deal_enriched`
  GROUP BY course_key_norm
)
SELECT
  c.course_type, c.course_name,
  ll.last_lead_date,
  DATE_DIFF(p.d, IFNULL(ll.last_lead_date, DATE_SUB(p.d, INTERVAL 999 DAY)), DAY) AS days_no_lead
FROM `${CONFIG_DATASET}.dim_course` c
CROSS JOIN p
LEFT JOIN last_lead ll ON ll.course_key_norm = c.course_key
WHERE c.is_active
  AND (ll.last_lead_date IS NULL OR ll.last_lead_date < p.d)
ORDER BY days_no_lead DESC;
```

> Code node sau đó lấy nguyên danh sách này cho khối 🚫 (không lọc ngưỡng — bất kỳ khóa active nào 0 lead hôm qua đều hiện). Ngưỡng `warning_zero_lead_days` chỉ dùng ở Q5 để bắn cờ ⚠️ khi chuỗi ngày đủ dài.

### 7.2. Q5 — Warning scan toàn bộ khóa active (đầy đủ)

```sql
WITH p AS (SELECT DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 1 DAY) AS d),

lead_win AS (
  SELECT course_key_norm,
    COUNTIF(DATE(created_at) BETWEEN DATE_SUB(d, INTERVAL  6 DAY) AND d)                           AS lead_now,
    COUNTIF(DATE(created_at) BETWEEN DATE_SUB(d, INTERVAL 13 DAY) AND DATE_SUB(d, INTERVAL 7 DAY)) AS lead_prev
  FROM `${PROJECT}.${DATASET}.v_deal_enriched`, p
  WHERE DATE(created_at) >= DATE_SUB(d, INTERVAL 13 DAY)
  GROUP BY course_key_norm
),

deal_win AS (
  SELECT course_key_norm,
    COUNTIF(DATE(closed_at) BETWEEN DATE_SUB(d, INTERVAL  6 DAY) AND d)                           AS deal_now,
    COUNTIF(DATE(closed_at) BETWEEN DATE_SUB(d, INTERVAL 13 DAY) AND DATE_SUB(d, INTERVAL 7 DAY)) AS deal_prev
  FROM `${PROJECT}.${DATASET}.v_deal_enriched`, p
  WHERE deal_status = 'won'
    AND closed_at IS NOT NULL
    AND DATE(closed_at) >= DATE_SUB(d, INTERVAL 13 DAY)
  GROUP BY course_key_norm
),

no_lead AS (
  SELECT c.course_key,
    DATE_DIFF(p.d, IFNULL(MAX(DATE(v.created_at)), DATE_SUB(p.d, INTERVAL 999 DAY)), DAY) AS days_no_lead
  FROM `${CONFIG_DATASET}.dim_course` c
  CROSS JOIN p
  LEFT JOIN `${PROJECT}.${DATASET}.v_deal_enriched` v ON v.course_key_norm = c.course_key
  WHERE c.is_active
  GROUP BY c.course_key, p.d
),

-- "Pending" = deal open, TẠO trước ngưỡng warning_pending_days ngày, và CHƯA từng có 1 activity nào
activity_agg AS (
  SELECT deal_id, COUNT(*) AS activity_count
  FROM `tmdatabase.dm_base_crm.deal_activities`
  GROUP BY deal_id
),
pending AS (
  SELECT v.course_key_norm, COUNT(DISTINCT v.deal_id) AS pending_leads
  FROM `${PROJECT}.${DATASET}.v_deal_enriched` v
  LEFT JOIN activity_agg a ON a.deal_id = v.deal_id
  CROSS JOIN p
  WHERE v.deal_status = 'open'
    AND IFNULL(a.activity_count, 0) = 0
    AND DATE(v.created_at) <= DATE_SUB(p.d, INTERVAL @warning_pending_days DAY)
  GROUP BY v.course_key_norm
),

-- "Tồn đọng" = deal open, nằm ở stage HIỆN TẠI quá lâu (stage_start_at — chỉ tin cậy với deal open, schema doc §4.4)
open_deal AS (
  SELECT course_key_norm, COUNT(DISTINCT deal_id) AS stale_open_deals
  FROM `${PROJECT}.${DATASET}.v_deal_enriched`
  WHERE deal_status = 'open'
    AND stage_start_at IS NOT NULL
    AND DATETIME_DIFF(CURRENT_DATETIME('Asia/Ho_Chi_Minh'), stage_start_at, DAY) > @warning_open_deal_days
  GROUP BY course_key_norm
)

SELECT
  c.course_type, c.course_name,
  ROUND(IFNULL(lw.lead_now,0)/7, 2)   AS lead_per_day_now,
  ROUND(IFNULL(lw.lead_prev,0)/7, 2)  AS lead_per_day_prev,
  SAFE_DIVIDE(IFNULL(lw.lead_now,0) - IFNULL(lw.lead_prev,0), NULLIF(lw.lead_prev,0)) * 100 AS lead_delta_pct,
  ROUND(IFNULL(dw.deal_now,0)/7, 2)   AS deal_per_day_now,
  ROUND(IFNULL(dw.deal_prev,0)/7, 2)  AS deal_per_day_prev,
  SAFE_DIVIDE(IFNULL(dw.deal_now,0) - IFNULL(dw.deal_prev,0), NULLIF(dw.deal_prev,0)) * 100 AS deal_delta_pct,
  nl.days_no_lead,
  IFNULL(pd.pending_leads, 0)          AS pending_leads,
  IFNULL(od.stale_open_deals, 0)       AS stale_open_deals,

  (IFNULL(lw.lead_prev,0) >= @min_base_volume
     AND SAFE_DIVIDE(IFNULL(lw.lead_now,0) - lw.lead_prev, lw.lead_prev) * 100 <= -@warning_drop_pct) AS flag_lead_drop,
  (IFNULL(dw.deal_prev,0) >= @min_base_volume
     AND SAFE_DIVIDE(IFNULL(dw.deal_now,0) - dw.deal_prev, dw.deal_prev) * 100 <= -@warning_drop_pct) AS flag_deal_drop,
  (nl.days_no_lead >= @warning_zero_lead_days)              AS flag_no_lead,
  (IFNULL(pd.pending_leads,0) >= @warning_pending_min_count) AS flag_pending,
  (IFNULL(od.stale_open_deals,0) >= @warning_open_deal_min)  AS flag_stale_open

FROM `${CONFIG_DATASET}.dim_course` c
LEFT JOIN lead_win  lw ON lw.course_key_norm = c.course_key
LEFT JOIN deal_win  dw ON dw.course_key_norm = c.course_key
LEFT JOIN no_lead   nl ON nl.course_key = c.course_key
LEFT JOIN pending   pd ON pd.course_key_norm = c.course_key
LEFT JOIN open_deal od ON od.course_key_norm = c.course_key
WHERE c.is_active
ORDER BY lead_delta_pct ASC NULLS LAST;
```

> Code node sau Q5 chỉ giữ dòng có **≥1 cờ TRUE**, tối đa `max_warning_rows`, ưu tiên dòng nhiều cờ hơn lên trước.

**2 điểm khác biệt có chủ đích so với v1.1** (do schema thật không có sẵn field tương đương) — ✅ **cả 2 đã được xác nhận (2026-08-23):**

1. **`pending_leads`** — v1.1 định nghĩa qua `lead_status='pending' AND first_contacted_ts IS NULL` (field không tồn tại trong `deals`). Bản này định nghĩa lại: deal `open`, tạo trước `warning_pending_days` ngày, và **chưa có bất kỳ activity nào** trong `deal_activities`. ✅ Data Owner xác nhận đúng tinh thần nghiệp vụ.
2. **`stale_open_deals`** — v1.1 định nghĩa qua "deal tạo >14 ngày, vẫn open" (đo tổng thời gian sống). ✅ Data Owner xác nhận **đổi sang `stage_start_at`** (đo thời gian **kẹt ở stage hiện tại**) — đúng khuyến nghị đã chốt ở schema doc §4.4, chính xác hơn để phát hiện tắc ở đâu trong funnel. SQL ở trên đã dùng đúng cách này.

### 7.3. Q1 — KPI tổng hôm qua + TB7 (đầy đủ)

Không breakdown theo khóa (toàn công ty). Có `conversion_rate`/`cvr_change_pp` theo quyết định §1 (không có Revenue).

```sql
WITH p AS (
  SELECT
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 1  DAY) AS d,           -- hôm qua
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 7  DAY) AS curr_start,  -- D-7
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 1  DAY) AS curr_end,    -- D-1
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 14 DAY) AS prev_start,  -- D-14
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 8  DAY) AS prev_end     -- D-8
),

-- Đầu phễu: leads/MQL/SQL Discovery/SQL Need-fit theo created_at
leads AS (
  SELECT
    IF(DATE(created_at) BETWEEN p.curr_start AND p.curr_end, 'curr', 'prev') AS period,
    COUNT(DISTINCT deal_id) AS total_leads,
    COUNT(DISTINCT IF(stage_id IN (224,264,267,268,265,92,91,227,228,225,229,226,220,221,217,222,
                                    218,219,75,76,73,74,79,80,1328,1329,1330,1331,1332), deal_id, NULL)) AS mql,
    COUNT(DISTINCT IF(stage_id IN (224,267,268,92,91,227,228,225,229,226,220,221,222,218,219,75,76,
                                    74,80,1329,1330,1331,1332), deal_id, NULL)) AS sql_discovery,
    COUNT(DISTINCT IF(stage_id IN (224,267,268,92,91,227,228,225,229,226,220,221,222,219,75,76,
                                    1330,1331,1332), deal_id, NULL)) AS sql_needfit
  FROM `${PROJECT}.${DATASET}.v_deal_enriched`, p
  WHERE DATE(created_at) BETWEEN p.prev_start AND p.curr_end
  GROUP BY period
),

-- Kết quả: Won/Lost theo closed_at
outcomes AS (
  SELECT
    IF(DATE(closed_at) BETWEEN p.curr_start AND p.curr_end, 'curr', 'prev') AS period,
    COUNT(DISTINCT IF(deal_status = 'won',  deal_id, NULL)) AS won_deals,
    COUNT(DISTINCT IF(deal_status = 'lost', deal_id, NULL)) AS lost_deals
  FROM `${PROJECT}.${DATASET}.v_deal_enriched`, p
  WHERE closed_at IS NOT NULL AND DATE(closed_at) BETWEEN p.prev_start AND p.curr_end
  GROUP BY period
),

-- Số tuyệt đối riêng của "hôm qua" (không phải trung bình)
yesterday AS (
  SELECT
    COUNT(DISTINCT IF(DATE(created_at) = p.d, deal_id, NULL))                            AS leads_yesterday,
    COUNT(DISTINCT IF(deal_status='won' AND DATE(closed_at) = p.d, deal_id, NULL))        AS won_yesterday
  FROM `${PROJECT}.${DATASET}.v_deal_enriched`, p
),

combined AS (
  SELECT
    COALESCE(l.period, o.period)              AS period,
    COALESCE(l.total_leads,0)   / 7            AS avg_leads_per_day,
    COALESCE(l.mql,0)           / 7            AS avg_mql_per_day,
    COALESCE(l.sql_discovery,0) / 7            AS avg_sql_discovery_per_day,
    COALESCE(l.sql_needfit,0)   / 7            AS avg_sql_needfit_per_day,
    COALESCE(o.won_deals,0)     / 7            AS avg_won_per_day,
    COALESCE(o.lost_deals,0)    / 7            AS avg_lost_per_day,
    SAFE_DIVIDE(o.won_deals, o.won_deals + o.lost_deals) AS conversion_rate
  FROM leads l FULL OUTER JOIN outcomes o USING (period)
),

pivot AS (
  SELECT
    MAX(IF(period='curr', avg_leads_per_day,         NULL)) AS curr_leads,
    MAX(IF(period='prev', avg_leads_per_day,         NULL)) AS prev_leads,
    MAX(IF(period='curr', avg_mql_per_day,           NULL)) AS curr_mql,
    MAX(IF(period='prev', avg_mql_per_day,           NULL)) AS prev_mql,
    MAX(IF(period='curr', avg_sql_discovery_per_day, NULL)) AS curr_sql_discovery,
    MAX(IF(period='prev', avg_sql_discovery_per_day, NULL)) AS prev_sql_discovery,
    MAX(IF(period='curr', avg_sql_needfit_per_day,   NULL)) AS curr_sql_needfit,
    MAX(IF(period='prev', avg_sql_needfit_per_day,   NULL)) AS prev_sql_needfit,
    MAX(IF(period='curr', avg_won_per_day,           NULL)) AS curr_won,
    MAX(IF(period='prev', avg_won_per_day,           NULL)) AS prev_won,
    MAX(IF(period='curr', avg_lost_per_day,          NULL)) AS curr_lost,
    MAX(IF(period='prev', avg_lost_per_day,          NULL)) AS prev_lost,
    MAX(IF(period='curr', conversion_rate,           NULL)) AS curr_cvr,
    MAX(IF(period='prev', conversion_rate,           NULL)) AS prev_cvr
  FROM combined
)

SELECT
  p.d AS report_date,
  y.leads_yesterday,
  y.won_yesterday,
  pv.curr_leads AS leads_avg7,  SAFE_DIVIDE(pv.curr_leads - pv.prev_leads, NULLIF(pv.prev_leads,0)) AS leads_pct_change,
  pv.curr_won   AS won_avg7,    SAFE_DIVIDE(pv.curr_won   - pv.prev_won,   NULLIF(pv.prev_won,0))   AS won_pct_change,
  pv.curr_mql AS mql_avg7,                     SAFE_DIVIDE(pv.curr_mql - pv.prev_mql,                     NULLIF(pv.prev_mql,0))           AS mql_pct_change,
  pv.curr_sql_discovery AS sql_discovery_avg7, SAFE_DIVIDE(pv.curr_sql_discovery - pv.prev_sql_discovery, NULLIF(pv.prev_sql_discovery,0)) AS sql_discovery_pct_change,
  pv.curr_sql_needfit AS sql_needfit_avg7,     SAFE_DIVIDE(pv.curr_sql_needfit - pv.prev_sql_needfit,     NULLIF(pv.prev_sql_needfit,0))   AS sql_needfit_pct_change,
  pv.curr_lost AS lost_avg7,                   SAFE_DIVIDE(pv.curr_lost - pv.prev_lost,                   NULLIF(pv.prev_lost,0))          AS lost_pct_change,
  pv.curr_cvr AS conversion_rate, pv.curr_cvr - pv.prev_cvr AS cvr_change_pp
FROM p, yesterday y, pivot pv;
```

> Kết quả trả về **đúng 1 dòng**. `leads_yesterday`/`won_yesterday` dùng cho dòng số tuyệt đối trong khối 📊; `*_avg7`/`*_pct_change` dùng để so "bình thường ✓" theo `kpi_normal_band_pct`/`warning_drop_pct`. Build Payload **không** map field revenue nào vào JSON vì Q1 không tính revenue ngay từ đầu (đúng quyết định §1).

### 7.4. Q2 — Breakdown theo `course_type` × khóa (đầy đủ)

```sql
WITH p AS (SELECT DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 1 DAY) AS d),
l AS (
  SELECT course_type_norm, course_name_norm, COUNT(DISTINCT deal_id) AS leads
  FROM `${PROJECT}.${DATASET}.v_deal_enriched`, p
  WHERE DATE(created_at) = p.d AND NOT is_unmapped
  GROUP BY 1,2
),
w AS (
  SELECT course_type_norm, course_name_norm, COUNT(DISTINCT deal_id) AS deals
  FROM `${PROJECT}.${DATASET}.v_deal_enriched`, p
  WHERE deal_status = 'won' AND DATE(closed_at) = p.d AND NOT is_unmapped
  GROUP BY 1,2
)
SELECT
  COALESCE(l.course_type_norm, w.course_type_norm) AS course_type,
  COALESCE(l.course_name_norm, w.course_name_norm) AS course_name,
  IFNULL(l.leads, 0) AS leads,
  IFNULL(w.deals, 0) AS deals
FROM l FULL OUTER JOIN w
  ON l.course_type_norm = w.course_type_norm AND l.course_name_norm = w.course_name_norm
ORDER BY course_type, deals DESC, leads DESC;
```

> `NOT is_unmapped` — deal/lead chưa map khóa **không** vào đây, đã có Q0 xử lý riêng (🧩 Data health), tránh hiện 2 lần / hiện sai chỗ. Code node sau đó gộp: tổng deal/lead mỗi `course_type` + top `top_course_per_bu` khóa nhiều deal nhất + top khóa nhiều lead nhất.

### 7.5. Q6 — Focus Group theo `report_day` hôm nay (chỉ T2–T6, giữ TB7/TB30/TB90)

```sql
WITH p AS (SELECT DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 1 DAY) AS d),
scope AS (
  SELECT course_key, course_name, course_type
  FROM `${CONFIG_DATASET}.dim_course`
  WHERE report_day = @report_day AND is_active   -- T6 gồm TM AI + toàn bộ khóa được chuyển từ lịch T7 cũ
),
lead_agg AS (
  SELECT v.course_key_norm,
    COUNTIF(DATE(v.created_at) BETWEEN DATE_SUB(d, INTERVAL  6 DAY) AND d)                           AS n_now,
    COUNTIF(DATE(v.created_at) BETWEEN DATE_SUB(d, INTERVAL 13 DAY) AND DATE_SUB(d, INTERVAL 7 DAY)) AS n_p7,
    COUNTIF(DATE(v.created_at) BETWEEN DATE_SUB(d, INTERVAL 36 DAY) AND DATE_SUB(d, INTERVAL 7 DAY)) AS n_p30,
    COUNTIF(DATE(v.created_at) BETWEEN DATE_SUB(d, INTERVAL 96 DAY) AND DATE_SUB(d, INTERVAL 7 DAY)) AS n_p90
  FROM `${PROJECT}.${DATASET}.v_deal_enriched` v, p
  WHERE v.course_key_norm IN (SELECT course_key FROM scope)
    AND DATE(v.created_at) >= DATE_SUB(d, INTERVAL 96 DAY)
  GROUP BY v.course_key_norm
),
deal_agg AS (
  SELECT v.course_key_norm,
    COUNTIF(DATE(v.closed_at) BETWEEN DATE_SUB(d, INTERVAL  6 DAY) AND d)                           AS n_now,
    COUNTIF(DATE(v.closed_at) BETWEEN DATE_SUB(d, INTERVAL 13 DAY) AND DATE_SUB(d, INTERVAL 7 DAY)) AS n_p7,
    COUNTIF(DATE(v.closed_at) BETWEEN DATE_SUB(d, INTERVAL 36 DAY) AND DATE_SUB(d, INTERVAL 7 DAY)) AS n_p30,
    COUNTIF(DATE(v.closed_at) BETWEEN DATE_SUB(d, INTERVAL 96 DAY) AND DATE_SUB(d, INTERVAL 7 DAY)) AS n_p90
  FROM `${PROJECT}.${DATASET}.v_deal_enriched` v, p
  WHERE v.deal_status = 'won'
    AND v.course_key_norm IN (SELECT course_key FROM scope)
    AND v.closed_at IS NOT NULL
    AND DATE(v.closed_at) >= DATE_SUB(d, INTERVAL 96 DAY)
  GROUP BY v.course_key_norm
)
SELECT
  s.course_type, s.course_name,
  ROUND(IFNULL(la.n_now,0)/7,  2) AS lead_pd_now,
  ROUND(IFNULL(la.n_p7,0)/7,   2) AS lead_pd_prev7,
  ROUND(IFNULL(la.n_p30,0)/30, 2) AS lead_pd_prev30,
  ROUND(IFNULL(la.n_p90,0)/90, 2) AS lead_pd_prev90,
  ROUND(IFNULL(da.n_now,0)/7,  2) AS deal_pd_now,
  ROUND(IFNULL(da.n_p7,0)/7,   2) AS deal_pd_prev7,
  ROUND(IFNULL(da.n_p30,0)/30, 2) AS deal_pd_prev30,
  ROUND(IFNULL(da.n_p90,0)/90, 2) AS deal_pd_prev90
FROM scope s
LEFT JOIN lead_agg la ON la.course_key_norm = s.course_key
LEFT JOIN deal_agg da ON da.course_key_norm = s.course_key
ORDER BY deal_pd_now DESC;
```

**Phân loại** (Code node, theo `deal_pd_now`, tie-break bằng `lead_pd_now`) — giữ nguyên v1.1:

| Kết quả | Điều kiện |
|---|---|
| 🟢 Tích cực | `deal_pd_now` cao hơn **cả** prev7, prev30, prev90 ≥ `focus_positive_pct` |
| 🔴 Tiêu cực | `deal_pd_now` thấp hơn **cả** prev7, prev30, prev90 ≥ `focus_negative_pct` |
| ⚪ Bình thường | còn lại |

### 7.6. Q7 — Weekly Performance (chỉ Thứ 7, thay toàn bộ báo cáo theo khóa trong ngày)

Scope = **toàn bộ khóa active**, tổng hợp tuần làm việc vừa kết thúc (**T2–T6**) và so với T2–T6 tuần trước. Vì workflow chạy sáng Thứ 7, không đưa dữ liệu Thứ 7 đang diễn ra vào phép tính. Q7 là một **query bundle** gồm: bảng performance theo khóa bên dưới, Content Performance ở schema doc §6.11, snapshot cảnh báo Q5 và Data Health Q0 với cửa sổ tuần T2–T6. Q7 phải trả đủ dữ liệu để Writer nêu rõ khóa mạnh nhất, yếu nhất, tăng tốt nhất và giảm mạnh nhất.

```sql
WITH p AS (
  SELECT
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 5 DAY)  AS curr_start, -- T2 tuần này
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 1 DAY)  AS curr_end,   -- T6 tuần này
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 12 DAY) AS prev_start, -- T2 tuần trước
    DATE_SUB(CURRENT_DATE('Asia/Ho_Chi_Minh'), INTERVAL 8 DAY)  AS prev_end    -- T6 tuần trước
),
lead_agg AS (
  SELECT course_key_norm,
    COUNT(DISTINCT IF(DATE(created_at) BETWEEN p.curr_start AND p.curr_end, deal_id, NULL)) AS leads_this_week,
    COUNT(DISTINCT IF(DATE(created_at) BETWEEN p.prev_start AND p.prev_end, deal_id, NULL)) AS leads_last_week
  FROM `${PROJECT}.${DATASET}.v_deal_enriched`, p
  WHERE DATE(created_at) BETWEEN p.prev_start AND p.curr_end
  GROUP BY course_key_norm
),
close_agg AS (
  SELECT course_key_norm,
    COUNT(DISTINCT IF(DATE(closed_at) BETWEEN p.curr_start AND p.curr_end AND deal_status = 'won',  deal_id, NULL)) AS won_this_week,
    COUNT(DISTINCT IF(DATE(closed_at) BETWEEN p.curr_start AND p.curr_end AND deal_status = 'lost', deal_id, NULL)) AS lost_this_week,
    COUNT(DISTINCT IF(DATE(closed_at) BETWEEN p.prev_start AND p.prev_end AND deal_status = 'won',  deal_id, NULL)) AS won_last_week,
    COUNT(DISTINCT IF(DATE(closed_at) BETWEEN p.prev_start AND p.prev_end AND deal_status = 'lost', deal_id, NULL)) AS lost_last_week
  FROM `${PROJECT}.${DATASET}.v_deal_enriched`, p
  WHERE closed_at IS NOT NULL AND DATE(closed_at) BETWEEN p.prev_start AND p.curr_end
  GROUP BY course_key_norm
)
SELECT
  c.course_type, c.course_name,
  IFNULL(l.leads_this_week, 0) AS leads_this_week,
  IFNULL(l.leads_last_week, 0) AS leads_last_week,
  SAFE_DIVIDE(IFNULL(l.leads_this_week,0) - IFNULL(l.leads_last_week,0), NULLIF(l.leads_last_week,0)) * 100 AS lead_delta_pct,
  IFNULL(d.won_this_week, 0) AS won_this_week,
  IFNULL(d.lost_this_week, 0) AS lost_this_week,
  IFNULL(d.won_last_week, 0) AS won_last_week,
  IFNULL(d.lost_last_week, 0) AS lost_last_week,
  SAFE_DIVIDE(d.won_this_week, d.won_this_week + d.lost_this_week) AS conversion_rate_this_week,
  SAFE_DIVIDE(d.won_last_week, d.won_last_week + d.lost_last_week) AS conversion_rate_last_week,
  (SAFE_DIVIDE(d.won_this_week, d.won_this_week + d.lost_this_week)
   - SAFE_DIVIDE(d.won_last_week, d.won_last_week + d.lost_last_week)) * 100 AS cvr_change_pp
FROM `${CONFIG_DATASET}.dim_course` c
LEFT JOIN lead_agg l ON l.course_key_norm = c.course_key
LEFT JOIN close_agg d ON d.course_key_norm = c.course_key
WHERE c.is_active
ORDER BY won_this_week DESC, conversion_rate_this_week DESC, leads_this_week DESC;
```

**Quy tắc xếp hạng khóa (Code node, minh bạch và không để AI tự chọn):**

- **Mạnh nhất:** `won_this_week` cao nhất; nếu hòa thì ưu tiên `conversion_rate_this_week`, sau đó `leads_this_week`.
- **Yếu nhất:** `won_this_week` thấp nhất; nếu hòa thì ưu tiên CVR thấp hơn, sau đó mức giảm lead lớn hơn. Khóa không có mẫu đóng (`won + lost = 0`) phải ghi **“chưa đủ mẫu CVR”**, không tự coi CVR là 0%.
- **Tăng tốt nhất / giảm mạnh nhất:** xếp theo `lead_delta_pct`, kèm `cvr_change_pp` để tránh kết luận chỉ dựa trên lượng lead.

Đi kèm query Content Performance tuần ở schema doc §6.11. Code node tạo hai bảng độc lập: **content mang nhiều lead nhất** và **content chuyển đổi cao nhất**. Bảng chuyển đổi chỉ nhận content có `n_leads >= weekly_min_content_leads`; `(not set)` không được gọi là content và được chuyển sang mục chất lượng tracking.

Khối 📅 **WEEKLY PERFORMANCE** bắt buộc có các phần sau:

1. **Toàn cảnh tuần:** tổng Lead, Won, Lost, CVR và thay đổi so với tuần trước.
2. **Leaderboard khóa:** mạnh nhất, yếu nhất, tăng tốt nhất, giảm mạnh nhất; luôn kèm số và lý do xếp hạng.
3. **Content nổi bật:** top content theo lead và top content theo CVR đủ mẫu; ghi cả campaign/product để người đọc tìm lại được nội dung.
4. **Funnel & rủi ro:** điểm rơi nhiều nhất trong funnel, khóa 0 lead, khóa giảm mạnh, deal open kẹt stage và cảnh báo cần xử lý.
5. **Chất lượng dữ liệu:** tỷ lệ lead không có tracking, khóa chưa map/chưa chọn khóa và bất thường dữ liệu nếu có.
6. **Bài học & ưu tiên tuần tới:** 2 điều nên tiếp tục, 2 điều nên dừng/điều chỉnh, và tối đa 3 hành động có owner/đích đo lường rõ ràng nếu dữ liệu cho phép.

---

## 8. Lịch chạy theo ngày

| Thứ | Daily KPI / cảnh báo | 📚 Focus Group (Q6) | 📅 Weekly Performance (Q7) | Output khác |
|---|:---:|---|:---:|---|
| **T2** | ✅ | Marketing Day 1 (6 khóa) | — | — |
| **T3** | ✅ | Marketing Day 2 + Brand (Exec Ed) — 5+3 khóa | — | — |
| **T4** | ✅ | Executive Education (6 khóa) | — | — |
| **T5** | ✅ | Data School (6 khóa) | — | — |
| **T6** | ✅ | Scope lấy mọi khóa active có `report_day=6`; tiêu đề hiện tại trong JSON là `TM AI ALERT` | — | — |
| **T7** | — | — | ✅ **toàn bộ khóa active, tuần T2–T6** | — |
| **CN** | — | — | — | ✅ **1 thông điệp cuối tuần** |

Cron hiện tại là 07:30 ICT T2–T7 (`30 7 * * 1-6`). Chủ Nhật chưa được Schedule Trigger gọi. Khi bỏ hard-code test trong `Resolve Day`, T7 sẽ đi weekly branch; ở trạng thái JSON hiện tại mọi lần chạy đều dùng ngày test Thứ Hai 24/08/2026.

🔍 **AI ANALYZE** và 🎯 **SUGGESTED ACTION** chạy T2–T7. T2–T6 phân tích theo daily brief; T7 phân tích toàn tuần và ưu tiên hành động cho tuần kế tiếp.

### 8.1. Quy tắc thông điệp Chủ Nhật

- Chỉ **đúng 1 câu**, tối đa khoảng 40 từ; giọng vui, dí dỏm vừa phải, tích cực và tự nhiên.
- Bắt buộc có đủ ba ý: một nét hài hước, một nhịp động lực nhẹ, và lời chúc ngày cuối tuần vui vẻ.
- Không có KPI, cảnh báo, tên khóa học hay yêu cầu công việc; không biến lời chúc thành một “to-do list”.
- Prompt chỉ nhận `week_key` dạng `YYYY-M{month}W{weekOfMonth}`; JSON chưa query `brief_run_log` để chống lặp câu cũ.
- Mẫu giọng điệu: “Hôm nay deadline cũng cần nghỉ phép, mình cứ nạp đầy pin để tuần mới chạy mượt hơn nhé — chúc bạn một Chủ Nhật thật vui và nhẹ đầu!”

---

## 9. Các vai trò AI trong JSON v2

Tất cả model node dùng credential `OpenAI account TM`, model `gpt-4.1`. Writer/Planner/Evaluator có temperature `0.2`, SQL Writer `0.1`, Advisor `0.4`, Sunday Writer `0.9`.

### 9.1 AGENT 1 — BRIEF WRITER
Không đổi so với v1.1 (không tự tính toán, chỉ dùng số deal/lead). Bổ sung quy tắc theo §1: **cấm nhắc tới Revenue/doanh thu dưới mọi hình thức** dù JSON input có lọt trường đó — chỉ dùng số deal, lead, và Conversion Rate (%). Thêm quy tắc: nếu `data_health.unmapped_total > 0` **hoặc** có deal `selected_course IS NULL`, bắt buộc in dòng 🧩 Data health.

### 9.2 ROOT CAUSE ANALYST 🔍 — vòng lặp ba vai trò

- `RCA Planner`: chọn đúng một bất thường chưa kiểm chứng và trả `{state, hypothesis, rationale}`.
- `RCA SQL Writer`: tạo đúng một query read-only, cửa sổ tối đa 90 ngày, `LIMIT ≤ 200`, không `SELECT *`.
- `RCA Evaluator`: đọc `result_rows`, trả `{finding, continue, reason}` và phân biệt tương quan với nguyên nhân.

Phạm vi SQL:

```
Các bảng được phép đọc:
  tmdatabase.dm_base_crm.deals
  stages(stage_id, name, pipeline_id, order_nr)
  pipelines(pipeline_id, name)
  deal_activities(deal_id, user_id, type, created_at, ...) -- PHẢI aggregate theo deal_id trước khi JOIN
  tmdatabase.dm_daily_brief.dim_course
```

`SQL Guardrail` chấp nhận query bắt đầu bằng `SELECT` hoặc `WITH`; chặn từ khóa ghi/xóa, nhiều statement, `SELECT *`, bảng ngoài allowlist, thiếu `LIMIT` hoặc `LIMIT > 200`. `Continue RCA?` lặp tối đa `rca_max_loops=3`; `Record Guardrail Failure` dừng sau hai lỗi liên tiếp. `RCA Finalizer` chỉ đưa finding có `sql_valid=true` vào output.

### 9.3 AGENT 3 — ACTION ADVISOR 🎯

Nhận brief, root cause đã kiểm chứng và warnings; trả tối đa 3 hành động có việc làm, owner/bộ phận, kết quả đo được và thời hạn. Nếu RCA chưa đủ dữ liệu thì đề xuất bước kiểm tra, không bịa nguyên nhân.

### 9.4 SUNDAY MESSAGE WRITER

Chỉ nhận `week_key`; trả đúng một câu tiếng Việt, tối đa 40 từ, có hài hước nhẹ, động lực và lời chúc cuối tuần; không KPI/khóa học/giao việc.

---

## 10. Format output cuối

T2–T6 giữ khung như v1.1 (📊 HÔM QUA / 🔗 Nguồn lead / 🚫 Khóa không lead / 🧩 Data health / ⚠️ WARNING / 📚 Focus Group / 🔍 AI ANALYZE / 🎯 SUGGESTED ACTION). T7 và CN dùng format riêng:

1. **🔗 Nguồn lead** đổi từ top `utm_source` sang **top combo đầy đủ** `utm_source-utm_medium-utm_campaign-utm_content-utm_product` (Q3, §6.10/6.11 schema doc), tối đa `top_utm_rows` dòng. Combo `(not set)` ở cả 5 field ghi rõ là **"không qua tracking / lead tay"**, không gọi là "content".
2. **Thứ 7:** chỉ hiện 📅 **WEEKLY PERFORMANCE**, theo đúng 6 phần ở §7.6; không hiện 📊 HÔM QUA hay 📚 Focus Group.
3. **Chủ Nhật:** chỉ hiện thông điệp theo §8.1, không kèm bất kỳ khối dữ liệu nào.

🔴 **[CẦN CHỐT]** Cần 1 bản mẫu đầy đủ (giống v1.1 §10) chạy trên số liệu thật để duyệt format cuối — nên làm sau khi Q1–Q7 viết xong.

---

## 11. Danh sách node trong file JSON

JSON v2 có **45 node**:

| Nhóm | Node |
|---|---|
| Trigger/router | `Schedule Trigger`, `Manual Trigger`, `Config`, `Resolve Day`, `Is Sunday?`, `Is Saturday?` |
| Daily SQL | `Q0 Data Health`, `Q1 KPI - Overall`, `Q2 Breakdown`, `Q3 UTM Daily`, `Q4 No-Lead Courses`, `Q5 Warning Scan`, `Q6 Focus Group1` |
| Weekly SQL | `Q7 Weekly Performance`, `Q7 Content Performance`, `Q7 Warning Snapshot`, `Q7 Weekly Data Health` |
| Brief/Sunday | `Build Payload`, `Agent 1 - Brief Writer`, `Sunday Message Writer`, `Assemble Sunday Message` và hai model tương ứng |
| RCA | `RCA Init`, `RCA Planner`, `RCA SQL Writer`, `SQL Guardrail`, `Is SQL Valid?`, `BigQuery Execute RCA`, `Aggregate RCA Results`, `RCA Evaluator`, `Normalize RCA Evaluation`, `Record Guardrail Failure`, `Continue RCA?`, `RCA Finalizer` và ba model RCA |
| Action/output | `Agent 3 - Action Advisor1`, `Assemble Brief`, `Final Brief`, `Log Run`, `HTTP Request - Khánh`, `HTTP Request - Hưng` và model Advisor |

Không có node `googleBigQueryTool`. Workflow metadata hiện `active=false`.

---

## 12. Trạng thái triển khai thực tế của JSON v2

| Việc | Trạng thái |
|---|---|
| Schema `deals`/`stages`/`pipelines` | ✅ có (schema doc) |
| Dataset `tmdatabase.dm_daily_brief` (chứa `dim_course` + `brief_run_log`) | ✅ đã tạo (xem [`HUONG-DAN-Setup-dm_daily_brief.md`](HUONG-DAN-Setup-dm_daily_brief.md)) |
| `dim_course` | ✅ đã tạo table trên BigQuery, connect Google Sheet, đã test `SELECT` thành công |
| Chuyển `report_day` 7 → 6 cho Flexible Combo 2/3/4 + B2B Training trên Sheet nguồn | 🔴 cần cập nhật theo hướng dẫn Bước 2 |
| `brief_run_log` (log kết quả AI để đối chiếu) | ✅ đã tạo table |
| Workflow đã import/xuất từ n8n | ✅ JSON có workflow id/version/meta; hiện `active=false` |
| Credential OpenAI | ✅ sáu model node đã bind `OpenAI account TM` |
| Credential BigQuery daily + `Log Run` | ✅ đã bind OAuth `Google BigQuery account 2` |
| Credential BigQuery weekly Q7 | 🔴 cả 4 node Q7 chưa có credential trong JSON |
| Credential `BigQuery Execute RCA` | 🔴 chưa có credential trong JSON |
| View `v_course_map`, `v_deal_enriched` | Không cần cho JSON v2; query JOIN inline |
| Tiêu chí loại deal rác | ✅ đã chốt (schema doc §9.1) |
| SQL daily Q0–Q6 | ✅ có trong JSON và dùng `Resolve Day.report_date` |
| SQL weekly Q7 | ✅ có trong JSON nhưng dùng `CURRENT_DATE`, không dùng ngày test |
| Test mode `Resolve Day` | 🔴 đang hard-code `2026-08-24`; cần bật lại `const now = new Date()` trước production |
| Schedule Chủ Nhật | 🔴 cron hiện T2–T7, nên Sunday branch không tự chạy |
| `Build Payload` trên T7 | 🔴 đang đọc `Q1 KPI - Overall` trước nhánh `if (isSaturday)` dù Q1 không chạy trên weekly branch; cần test/sửa để tránh lỗi node chưa execute |
| Data Health daily | 🔴 Q0 trả `deal_count` nhưng `Build Payload` cộng field `n`; `unmapped_total` daily hiện có nguy cơ luôn bằng 0 |
| `HTTP Request - Khánh` | 🟠 đang bật nhưng parameter `base_content` chưa có value |
| `HTTP Request - Hưng` | 🟠 có `base_content={{ $json.final_brief_text }}` nhưng node đang disabled |
| Webhook secret | 🟠 URL thật đang nằm trực tiếp trong JSON; cần tránh chia sẻ công khai và rotate nếu file bị lộ |

---

## 13. Đã cân nhắc nhưng để v2

| Ý tưởng | Vì sao hoãn |
|---|---|
| Nguồn Ads/GA/Facebook Post cho Agent 2 | Chưa có schema thật, Data Owner xác nhận dùng nội bộ `deals` cho MVP |
| Bảng log `brief_warning_log` (để Weekly Performance nói chính xác "warning mấy/mấy ngày") | Cần quyền ghi BigQuery, làm sau khi MVP chạy ổn |
| So sánh cùng kỳ năm trước | Dữ liệu CRM mới có từ 2025-10, chưa đủ 12 tháng |
| CPL/CAC theo khóa | Cần nguồn Ads (xem trên) |
| Deep-dive theo sale/owner | Chưa chốt có nhạy cảm nội bộ không |

---

## 14. Trình tự triển khai đề xuất (cập nhật)

```
Bước 1 ─ ✅ JSON v2 đã có daily, weekly, Sunday, RCA loop, logging và delivery nodes
Bước 2 ─ Tắt test mode: comment ngày 2026-08-24 và bật `const now = new Date()` trong Resolve Day
Bước 3 ─ Sửa cron thành có Chủ Nhật nếu muốn Sunday Message tự chạy
Bước 4 ─ Gắn credential BigQuery cho 4 node Q7 và BigQuery Execute RCA
Bước 5 ─ Sửa Build Payload: chỉ đọc Q1 trong daily branch; đổi Data Health daily từ `row.n` sang `row.deal_count`
Bước 6 ─ Kiểm tra/cập nhật `report_day=6` trên Sheet và sửa focus title T6 nếu nhóm khóa đã gộp
Bước 7 ─ Sửa `base_content` của HTTP Request - Khánh; quyết định bật/tắt từng người nhận
Bước 8 ─ Manual test riêng T2, T6, T7 và CN; đối chiếu query với dashboard
Bước 9 ─ Kiểm tra Log Run nhận đủ field, sau đó mới bật workflow production
```

---

## 15. ✅ Checklist cần chốt (đã lược bỏ mục đã trả lời — full lịch sử xem trong lịch sử chat)

| # | Điểm cần chốt | Trạng thái |
|---|---|---|
| 1 | ~~Revenue/Conversion Rate có xuất hiện trong brief không~~ | ✅ đã chốt — không hiện Revenue, có hiện CR (§1) |
| 2 | ~~Stage `TM AI xHust` có tính vào MQL/SQL không~~ | ✅ đã chốt — đã bổ sung vào 3 list (schema doc §4.3/§9.3) |
| 3 | ~~Focus Group T6 giữ TB7/30/90 hay chỉ TB7~~ | ✅ đã chốt — giữ cả 3 mốc (§6) |
| 4 | Bộ ngưỡng ở Config (§5) | mặc định đã điền, tự chỉnh sau |
| 5 | Giờ chạy và lịch CN | 🔴 JSON hiện 07:30 T2–T7; Sunday branch có nhưng cron chưa gọi (§8) |
| 6 | ~~Q4/Q5 SQL đầy đủ theo schema thật~~ | ✅ đã viết (§7.1/§7.2) — còn 2 định nghĩa cần Data Owner xác nhận (`pending_leads`, `stale_open_deals`, xem note cuối §7.2) |
| 7 | Model OpenAI cụ thể | mặc định `gpt-4.1` |
| 8 | Ngày runtime | 🔴 đang khóa cứng 24/08/2026 để test |
| 9 | Credential Q7/RCA BigQuery | 🔴 chưa bind trong JSON |
| 10 | Người nhận Base.vn | 🟠 Khánh bật nhưng thiếu content; Hưng đủ expression nhưng disabled |

---

*Sửa trực tiếp vào file này hoặc nhắn từng mục theo số — mọi thứ về schema/business rule thật nằm ở [`dm_base_crm_schema.md`](dm_base_crm_schema.md), không sửa ở đây.*
