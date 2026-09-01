# DAILY 5 MINUTES BRIEF — SPEC HỆ THỐNG v3.2

> **Trạng thái:** Implementation contract đang chạy cho workflow v3.2.  
> **Cập nhật:** 2026-09-01.  
> **Phạm vi:** Daily và Sunday giữ contract v3.1; Weekly dùng contract v3.2 với compact `writer_payload`.  
> **Nguồn sự thật implementation:** `workflow/Daily-5-Minutes-Brief-v3.2.json`; schema/business rule: `dm_base_crm_schema.md`.  
> **Ký hiệu:** **ĐÃ CHỐT** = workflow đang thực thi; 🔴 **[CẦN CHỐT]** = threshold/policy cần review sau production data.

---

## Mục lục

1. Mục tiêu và nguyên tắc v3
2. Nguồn sự thật và conflict
3. Phạm vi chức năng
4. Business rule dữ liệu
5. Run date, report date và lịch chạy
6. Lịch Focus Group và display title
7. Daily T2–T6
8. Comparison direction và Daily status
9. Daily priority
10. Weekly Thứ 7 — MVP
11. Chủ Nhật
12. Kiến trúc workflow v3
13. Query/data contract
14. Payload contract
15. Brief Writer contract
16. Config v3
17. Data Health và logging
18. Migration / Differences from v2.1
19. Output mẫu
20. Acceptance tests
21. Danh sách `[CẦN CHỐT]`

---

## 1. Mục tiêu và nguyên tắc v3

### 1.1. Mục tiêu business

Mỗi sáng, người đọc cần nhanh chóng biết:

1. funnel toàn business đang vận động thế nào;
2. toàn bộ khóa thuộc Focus Group của **ngày chạy** đang tốt, xấu hay chưa đủ mẫu;
3. tối đa ba điểm nào cần ưu tiên theo dõi.

Daily T2–T6 phải ngắn và dễ scan. Focus là phần chính. Weekly Thứ 7 review performance T2–T6 vừa kết thúc, xác định tín hiệu tốt/xấu và định hướng tuần kế tiếp. Chủ Nhật chỉ có một thông điệp cuối tuần.

### 1.2. Nguyên tắc đã chốt

| Nguyên tắc | Yêu cầu |
|---|---|
| SQL/Code làm toán | Query, KPI, comparison, classification, status và ranking đều hoàn tất trước AI. |
| AI chỉ làm chữ | Brief Writer đọc payload và diễn đạt; không tự tính hoặc tự chọn signal. |
| Triage, không RCA | Không root-cause claim, không SQL động do LLM sinh. |
| Không Action Advisor | Priority nằm sẵn trong payload; Writer chỉ viết gọn. |
| Không revenue | Query/payload/output v3 không chứa hoặc nhắc doanh thu. |
| Một nguồn khóa học | Chỉ dùng `deals.selected_course` map sang `dim_course`. |
| Không lặp | Daily không có Warning/No Lead/Pipeline section riêng; Weekly absorb warning vào course classification và không gửi object course trùng lặp cho Writer. |
| Sample-aware | Volume nhỏ không bị cảnh báo đỏ chỉ vì current bằng 0. |
| Dễ debug | Dùng rule table và sort tuple minh bạch; không dùng “AI score”. |

---

## 2. Nguồn sự thật và conflict

### 2.1. Thứ tự nguồn sự thật

| Nội dung | Nguồn sự thật |
|---|---|
| Schema và business rule CRM | `dm_base_crm_schema.md` |
| Lịch khóa, tên, `course_type`, `report_day`, active | `dim_course_daily_brief.xlsx` / `tmdatabase.dm_daily_brief.dim_course` |
| Implementation tham khảo | `workflow/Daily-5-Minutes-Brief-v2.1.json` |
| Baseline sản phẩm cũ | `SPEC-Daily-5-Minutes-Brief.md` |
| Lịch sử thử nghiệm RCA | Hai PLAN RCA; không thuộc kiến trúc v3 |

Workflow cũ không được ưu tiên hơn schema hoặc quyết định nghiệp vụ trong SPEC này.

### 2.2. Conflict đã phát hiện

Trong `dm_base_crm_schema.md`, phần mô tả cột và ghi chú mới đánh dấu `interested_course` là 🚫, yêu cầu mọi reporting khóa dùng `selected_course`. Tuy nhiên một câu cũ trong §4.8 vẫn nhắc breakdown lead theo `interested_course`, rồi ngay sau đó lại ghi không dùng cột này.

**Quyết định cho v3 đã chốt:** chỉ dùng `deals.selected_course`; tuyệt đối không dùng `interested_course`. Conflict tài liệu nguồn được ghi nhận nhưng không làm thay đổi contract v3. Việc sửa schema doc, nếu cần, là bước riêng ngoài phạm vi SPEC này.

Revenue được định nghĩa hợp lệ trong schema nhưng bị loại khỏi brief theo quyết định sản phẩm. Đây không phải conflict dữ liệu.

---

## 3. Phạm vi chức năng

### 3.1. Có trong v3 MVP

- Daily T2–T6: `TOÀN CẢNH` → `FOCUS` → `ƯU TIÊN HÔM NAY`.
- Daily Overall theo funnel ba tầng.
- Daily course trend Lead/Won so với baseline 7d/30d/90d.
- Daily No Lead gắn trực tiếp vào course review.
- Weekly Thứ 7 gồm đúng năm section ở §10.
- Weekly course performance chia deterministic thành `good`, `watch`, `action_now`; warning chỉ là input kỹ thuật.
- Weekly No Lead tách `recent_zero` và `history`, đều do Code xác định.
- Sunday message đúng một câu.
- Data-quality check chạy nền và logging đầy đủ.

### 3.2. Không thuộc v3 MVP

- Toàn bộ RCA và block `🔍 AI ANALYZE`.
- `Agent 3 - Action Advisor`.
- Root-cause claim hoặc một AI khác giả vờ phân tích nguyên nhân.
- Revenue/doanh thu.
- Pending: `pending_leads`, `flag_pending`, `PENDING_FOLLOWUP`, các threshold pending.
- Query `deal_activities` nếu chỉ phục vụ pending.
- Open/stale pipeline trong Daily query, payload, classification hoặc output.
- Owner, deadline và task-management wording.
- Sửa database/schema/`dim_course` trong giai đoạn này.

---

## 4. Business rule dữ liệu

### 4.1. Grain và loại deal rác

- `deals`: 1 row ≈ 1 deal ≈ 1 lead.
- Uniqueness của `deal_id` chưa được xác nhận; mọi count dùng `COUNT(DISTINCT deal_id)`.
- Mọi query lead/deal phải loại:

```sql
NOT STARTS_WITH(IFNULL(failed_reason_id, ''), 'Trash:')
```

- Không loại theo tên/label chứa “test”.

### 4.2. Time dimension

| KPI/signal | Cột thời gian | Rule |
|---|---|---|
| Lead, MQL, SQL Discovery, SQL Need-fit | `deals.created_at` | MQL/SQL dựa trên `stage_id` hiện tại; không lọc theo `deal_status`. |
| Won, Lost, CVR | `deals.closed_at` | CVR = won / (won + lost), không gồm `open`. |
| Stale open Weekly-only | `deals.stage_start_at` | Chỉ deal `open`; không dùng trong Daily. |

### 4.3. Mapping khóa học

- Dùng duy nhất `deals.selected_course`.
- Không dùng `interested_course`.
- Không suy ra course/course type từ pipeline.
- Chuẩn hóa key bằng `LOWER(TRIM(REGEXP_REPLACE(..., r'\s+', ' ')))`.
- Map cả `course_key` và alias không rỗng của `dim_course`.
- Loại row `dim_course.course_key` rỗng/NULL và chặn `raw_key != ''` khi join để tránh fan-out từ external Sheet.
- Chỉ `is_active=TRUE` được đưa vào Focus, Weekly ranking, Warning và No Lead.

### 4.4. Timezone và dữ liệu cấm

- Timezone: `Asia/Ho_Chi_Minh`.
- `deals.*` dạng `DATETIME` được hiểu theo giờ Việt Nam.
- Không dùng `pipedrive_*`, `deal_created_at_form`, `product_amount`, `currency_id` hoặc cột bị cấm trong schema.
- Không đưa PII vào payload/prompt/output.

---

## 5. Run date, report date và lịch chạy

### 5.1. Định nghĩa

| Field | Định nghĩa |
|---|---|
| `run_date` | Ngày workflow chạy theo giờ Việt Nam. |
| `report_date` | `run_date - 1 ngày`; Daily chốt dữ liệu đến hết ngày này. |
| `report_day` | Thứ của **run_date**: 2=T2, 3=T3, 4=T4, 5=T5, 6=T6, 7=T7, 0=CN. |
| `report_mode` | `daily` T2–T6, `weekly` T7, `sunday` CN. |

Ví dụ chạy sáng Thứ Hai 24/08/2026:

```text
run_date    = 2026-08-24
report_date = 2026-08-23
report_day  = 2
focus scope = dim_course.report_day = 2
```

Header dùng weekday/ngày của `run_date`; dòng dữ liệu dùng `report_date`.

### 5.2. Lịch chạy

- Workflow v2.1 hiện dùng cron `30 7 * * 1-6`, nên không gọi Sunday.
- `Resolve Day` v2.1 còn hard-code ngày test 24/08/2026.
- **KHUYẾN NGHỊ KỸ THUẬT:** v3 chạy `30 7 * * *`, dùng runtime thật và route đủ bảy ngày.
- 🔴 **[CẦN CHỐT]** xác nhận 07:30 ICT là giờ production và Sunday message cần gửi tự động.

### 5.3. Daily windows

Với `report_date = D`:

| Window | Khoảng | Số ngày |
|---|---|---:|
| current 7 | D-6 → D | 7 |
| previous 7 (`7d`) | D-13 → D-7 | 7 |
| previous 30 (`30d`) | D-36 → D-7 | 30 |
| previous 90 (`90d`) | D-96 → D-7 | 90 |

Baseline 30d và 90d đều kết thúc ngay trước current window. Chúng có overlap với previous 7 theo thiết kế baseline lịch sử của MVP.

### 5.4. Weekly windows

Với `run_date` là Thứ 7:

| Window | Khoảng |
|---|---|
| `week_curr_start/end` | T2→T6 vừa kết thúc (`run_date-5` → `run_date-1`) |
| `week_prev_start/end` | T2→T6 tuần trước (`run_date-12` → `run_date-8`) |

Mọi Weekly query nhận date từ `Resolve Calendar`; không tự dùng `CURRENT_DATE()` độc lập.

---

## 6. Lịch Focus Group và display title

### 6.1. Snapshot lịch hiện tại

Nguồn: `dim_course_daily_brief.xlsx`, `Sheet1!A1:H42`, đọc ngày 2026-08-30. Có 41 khóa: **36 active, 5 inactive**. Không có khóa active `report_day=7`.

| report_day | Số khóa | Danh sách active hiện tại |
|---:|---:|---|
| 2 — T2 | 6 | Marketing Foundation; Case Mastery; Master Interview; Management Trainee; Marketing Case; AAM Program |
| 3 — T3 | 8 | Content Marketing; Digital Foundation; Digital Performance; Digital Advanced; Performance Marketing; Brand Development; Brand Advanced; Brand Growth |
| 4 — T4 | 6 | Strategy Formulation; Consumer Psychology; Decision Science; DMM Program; CMO Program; CEO Program |
| 5 — T5 | 6 | Power BI; SQL; Excel; Analytics for Strategy; Business Intelligence; PDA Program |
| 6 — T6 | 10 | Python; Generative AI; AI Marketing; Professional AI Program; Transform Org with AI; AI System; Flexible Combo 2; Flexible Combo 3; Flexible Combo 4; B2B Training |

Inactive: Employer Branding, Sales Manager, Trade Marketing, Data Analysis (DA+Python), Mentoring Program.

Bảng trên là snapshot review. Runtime không hard-code danh sách; luôn query:

```sql
WHERE report_day = @report_day
  AND is_active = TRUE
```

### 6.2. Display title cố định

Title được Code map theo `report_day`; đây chỉ là display text, không quyết định scope khóa:

| report_day | `daily_display_title` | `focus_group_label` |
|---:|---|---|
| 2 | `📚 MARKETING ENTRY MONDAY` | `MARKETING` |
| 3 | `📣 MARKETING GROWTH TUESDAY` | `MARKETING GROWTH` |
| 4 | `🧠 EXECUTIVE WEDNESDAY` | `EXECUTIVE` |
| 5 | `📊 DATA THURSDAY` | `DATA` |
| 6 | `🤖 AI FRIDAY` | `AI` |

Writer chỉ in các field này; không tự đặt title và không hard-code course list.

---

## 7. Daily T2–T6

Daily có đúng ba section chính:

1. `📊 TOÀN CẢNH`
2. `📚 FOCUS`
3. `🎯 ƯU TIÊN HÔM NAY`

Không có section riêng cho Warning, Data Health, Source/UTM, RCA, Suggested Action, Pipeline/Open deal.

### 7.1. Header và note

```text
☀️ DAILY BRIEF — THỨ HAI 24/08
📚 MARKETING ENTRY MONDAY
_Dữ liệu đến hết 23/08_

ℹ️ Lead/ngày & Won/ngày = TB 7 ngày gần nhất.
🟢↑ cao hơn | 🔴↓ thấp hơn | ⚪→ tương đương với baseline 7d / 30d / 90d.
```

- Số đầu dòng course = average/day current 7.
- `7d` = previous 7 ngay trước current window.
- `30d` = previous 30 kết thúc trước current window.
- `90d` = previous 90 kết thúc trước current window.
- Icon/mũi tên lấy từ comparison direction do Code tạo.

### 7.2. `📊 TOÀN CẢNH` — funnel ba tầng

Daily luôn hiển thị bốn dòng số:

```text
Hôm qua: [Lead] Lead | [Won] Won
Acquisition: [Lead/ngày] ([±%]) | [MQL/ngày] ([±%])
Sales Funnel: [Discovery/ngày] ([±%]) | [Need-fit/ngày] ([±%])
Outcome: [Won/ngày] ([±%]) | CVR [x%] ([±xđ%])
```

| Tầng | KPI | Time dimension |
|---|---|---|
| Acquisition | Lead, MQL | `created_at` |
| Sales Funnel | SQL Discovery, SQL Need-fit | `created_at` |
| Outcome | Won, CVR | `closed_at` |

Lost có thể query/log nhưng không xuất mặc định trong Daily. Chỉ bổ sung sau này khi có business rule mới được duyệt.

Conclusion dùng `overall.summary_code` deterministic. Writer chỉ verbalize code; không tự nhìn nhiều phần trăm rồi kết luận.

### 7.3. Daily Overall `summary_code`

Code tạo direction current7 vs previous7 cho bốn count KPI và CVR:

- `lead_direction`, `mql_direction`, `discovery_direction`, `needfit_direction`, `won_direction`;
- `cvr_direction` dùng pp threshold riêng nếu giữ trong Config.

Với các count KPI Overall, Code dùng `trend_direction_pct`; nếu cả current7 và previous7 raw count đều dưới `min_base_volume` thì direction=`flat`. Baseline 0/current đủ mẫu=`up`; current 0/baseline đủ mẫu=`down`. CVR dùng `cvr_direction_pp` và chỉ có direction khác flat khi cả hai kỳ có mẫu số closed >0.

Sau đó gán một code theo thứ tự:

| Ưu tiên | Điều kiện khái quát | `summary_code` | Ý được phép diễn đạt |
|---:|---|---|---|
| 1 | Acquisition và Sales Funnel down; Outcome down | `FUNNEL_BROAD_SLOWDOWN` | Cả đầu, giữa và outcome đang chậm lại. |
| 2 | Acquisition/Sales Funnel down; Outcome không down | `INPUT_MID_DOWN_OUTCOME_OK` | Đầu/giữa funnel chậm, outcome hiện chưa xấu tương ứng. |
| 3 | Acquisition không down; Outcome down | `OUTCOME_DOWN_INPUT_OK` | Đầu vào chưa yếu rõ, cần chú ý outcome. |
| 4 | Có up rõ ở ít nhất hai tầng, không có tầng down | `FUNNEL_IMPROVING` | Nhịp chung cải thiện. |
| 5 | Còn lại | `FUNNEL_MIXED_OR_STABLE` | Tín hiệu mixed hoặc tương đối ổn định. |

“Một tầng down” khi ít nhất một KPI đủ mẫu trong tầng có direction `down`; “tầng up” tương tự. Code lưu cả component directions để debug.

### 7.4. `📚 FOCUS` — mọi khóa bắt buộc xuất hiện

Mọi khóa active thuộc `report_day` phải có một course block, kể cả normal, low-volume, Lead=0 hoặc Won=0.

Mỗi KPI nằm đúng một dòng:

```text
[Status icon] [Course]
Lead/ngày: [current7] | [icon] [prev7] (7d) | [icon] [prev30] (30d) | [icon] [prev90] (90d)
Won/ngày: [current7] | [icon] [prev7] (7d) | [icon] [prev30] (30d) | [icon] [prev90] (90d)
[No Lead line nếu đáng chú ý]
→ [Một câu interpretation]
```

Không in pending, open deal hoặc stale pipeline trong Daily Focus.

### 7.5. No Lead trong Daily

No Lead chỉ hiện trong course block khi:

1. `days_no_lead >= warning_zero_lead_days`; và
2. historical demand đủ sample theo `lead_n_prev90 >= min_base_volume`.

Gate này dùng **tổng mẫu lịch sử 90 ngày**, không dùng expected volume trong một tuần. Nhờ vậy, khóa có rate nhỏ nhưng đã từng có đủ Lead trong lịch sử vẫn có thể được cảnh báo sau một chuỗi dài không Lead; khóa chỉ có 0–2 Lead trong cả 90 ngày không bị báo động quá mức. `has_ever_had_lead=false` phải được giữ riêng; không gán giả 999 ngày.

### 7.6. Daily UTM, breakdown và pipeline

- Bỏ Daily UTM query/block.
- Bỏ Daily Breakdown query/block nếu không phục vụ contract khác.
- Bỏ Q4 No-Lead toàn bộ active; No Lead được tính trong Focus query cho scope ngày.
- Bỏ Daily Warning query riêng.
- Daily không query hoặc truyền stale open.

---

## 8. Comparison direction và Daily status

### 8.1. Comparison direction

Mỗi Lead/Won course KPI có ba direction do Code trả:

```text
lead_vs_prev7, lead_vs_prev30, lead_vs_prev90
won_vs_prev7,  won_vs_prev30,  won_vs_prev90
```

Giá trị hợp lệ:

| Value | Display | Ý nghĩa |
|---|---|---|
| `up` | `🟢↑` | Current 7 cao hơn baseline đủ ngưỡng. |
| `down` | `🔴↓` | Current 7 thấp hơn baseline đủ ngưỡng. |
| `flat` | `⚪→` | Chênh lệch trong flat band hoặc cả hai phía quá nhỏ để đánh giá. |

### 8.2. Rule deterministic cho `up/down/flat`

Cho mỗi KPI Lead/Won và mỗi baseline:

- `relative_change = (current_pd - baseline_pd) / baseline_pd` khi baseline > 0;
- `metric_history_n90` = raw count của KPI trong previous 90;
- `metric_is_low_volume = current_n7 < min_base_volume AND metric_history_n90 < min_base_volume`.

Rule theo thứ tự:

1. Nếu `metric_is_low_volume=true` → `flat` cho cả ba baseline của KPI đó.
2. Nếu baseline = 0 và current = 0 → `flat`.
3. Nếu baseline = 0 và current > 0 → `up`.
4. Nếu current = 0 và baseline > 0 → `down`.
5. Nếu `relative_change >= trend_direction_pct` → `up`.
6. Nếu `relative_change <= -trend_direction_pct` → `down`.
7. Còn lại → `flat`.

🔴 **[CẦN CHỐT]** `trend_direction_pct = 10%`. Đây là threshold chung cho arrow direction, thay thế việc AI tự so sánh.

### 8.3. Low-volume gate

`is_low_volume=true` khi `lead_n_curr7 < min_base_volume` và `lead_n_prev90 < min_base_volume`. Won dùng rule tương đương với `won_n_curr7`/`won_n_prev90` để tạo `is_low_won_volume`; Won low sample không tự làm status xấu hơn.

Một khóa low-volume:

- vẫn in đủ hai dòng 7d/30d/90d;
- direction có thể là `flat` theo sample gate;
- interpretation mặc định `LOW_VOLUME`;
- không được red/orange chỉ vì current=0.

### 8.4. Daily status

Daily status chỉ dùng Lead direction, Won direction, No Lead và sample size. Không dùng stale/open/pending.

Các helper:

```text
lead_down_count = số direction down trong lead_vs_prev7/30/90
won_down_count  = số direction down trong won_vs_prev7/30/90
lead_up_count   = số direction up trong ba baseline
won_up_count    = số direction up trong ba baseline
```

Code áp rule từ trên xuống:

| Status | Rule |
|---|---|
| `red` 🔴 | Không low-volume; Lead và Won đều `down` so với 7d, và ít nhất một trong hai KPI còn `down` so với 30d hoặc 90d. |
| `orange` 🟠 | Không red; `flag_no_lead=true`, **hoặc** `lead_down_count>=2`, **hoặc** `won_down_count>=2`, **hoặc** Lead và Won cùng down so với 7d. |
| `yellow` 🟡 | Không red/orange và có ít nhất một Lead/Won direction `down`. |
| `normal` ⚪ | Không có down đáng tin cậy; hoặc low-volume không có No Lead đủ historical sample. |

🔴 **[CẦN CHỐT]** bảng severity Daily trên.

### 8.5. Daily interpretation codes

Code gán đúng một primary code theo thứ tự; Writer có thể dùng directions bổ sung để làm rõ nhưng không tự tạo kết luận mới.

| Ưu tiên | Điều kiện | Code | Interpretation được phép |
|---:|---|---|---|
| 1 | No Lead đáng chú ý | `NO_LEAD` | Điểm đáng chú ý là đầu vào sau chuỗi ngày không có Lead. |
| 2 | Low-volume | `LOW_VOLUME` | Volume lịch sử thấp, chưa đủ dữ liệu đánh giá xu hướng. |
| 3 | Lead/Won down vs 7d | `LEAD_AND_WON_DOWN` | Lead và Won cùng yếu hơn tuần trước; có thể nhắc baseline dài hạn nào cũng down. |
| 4 | Lead down, Won không down | `LEAD_DOWN_WON_OK` | Đầu vào yếu; Won hiện chưa xấu tương ứng hoặc vẫn cao hơn baseline. |
| 5 | Lead không down, Won down | `WON_DOWN_LEAD_OK` | Lead chưa yếu rõ; cần chú ý outcome. |
| 6 | Có mixed up/down | `MIXED_TREND` | Xu hướng mixed, nêu đúng KPI/baseline đã có direction. |
| 7 | Không có down | `STABLE_OR_UP` | Tương đương hoặc cao hơn baseline. |

Không được viết nguyên nhân campaign, sales, content, ngân sách hoặc demand thực sự giảm nếu payload chỉ cho thấy signal định lượng. Cụm “cần theo dõi đầu vào/demand” là triage, không phải causal claim.

---

## 9. Daily priority

`🎯 ƯU TIÊN HÔM NAY` có tối đa ba item. Code tạo `priority_items` trước Writer.

### 9.1. Ranking tuple

Sort theo:

1. status rank: red=4, orange=3, yellow=2, normal=1;
2. `lead_down_count + won_down_count` giảm dần;
3. cả Lead và Won down vs 7d trước;
4. `flag_no_lead=true` trước;
5. `days_no_lead` giảm dần khi flag true;
6. Lead relative change vs 7d tăng dần;
7. Won relative change vs 7d tăng dần;
8. `course_name` A–Z.

Chỉ status khác normal được ưu tiên. Nếu có ít hơn ba item, không bịa thêm.

### 9.2. Grouping

Build Daily Payload chỉ gộp khóa khi:

- cùng `interpretation_code`;
- cùng status;
- cùng primary comparison pattern.

Writer không tự gộp hoặc tự chọn khóa.

Không owner, deadline, task-management wording hoặc root cause.

---

## 10. Weekly Thứ 7 — contract v3.2

Weekly không chạy Focus Group. Scope là toàn bộ khóa active. Mục tiêu: review performance tuần vừa kết thúc → xác định tín hiệu tốt/xấu → quyết định hướng thực hiện tuần kế tiếp.

### 10.1. Năm section bắt buộc

1. `📊 PERFORMANCE TUẦN`
2. `🏆 PERFORMANCE THEO KHÓA`
3. `📣 NGUỒN LEAD NỔI BẬT`
4. `🚫 KHÓA KHÔNG RA LEAD`
5. `🎯 TUẦN SAU`

Không có section Warning riêng. Warning vẫn tồn tại trong full technical payload để audit và làm input cho course classification/priority, nhưng không được dump vào Writer.

### 10.2. Performance tuần

So sánh T2–T6 vừa kết thúc với T2–T6 tuần trước. Lead/MQL/Discovery/Need-fit theo `created_at`; Won/Lost/CVR theo `closed_at`; CVR = Won/(Won+Lost), không gồm Open. Code cung cấp current, previous, change, direction và display. Mapping `up → ↑`, `down → ↓`, `flat → →`. Conclusion dùng `summary_code`; không root cause hoặc revenue.

### 10.3. Performance theo khóa

Leaderboard deterministic được giữ để gắn nhãn role:

| Role | Ranking |
|---|---|
| `STRONGEST` / Mạnh nhất | Won desc → CVR đủ sample desc → Lead desc → tên A–Z. |
| `MOST_IMPROVED` / Tăng tốt nhất | Lead % change desc → absolute delta desc → Won delta desc → tên A–Z. |
| `MOST_DECLINED` / Giảm mạnh nhất | Lead % change asc → absolute delta asc → Won delta asc → tên A–Z. |
| `WEAKEST` / Yếu nhất | Won asc → CVR đủ sample asc → Lead delta asc → tên A–Z. |

Một course có thể mang nhiều `role_codes` nhưng render một lần. Build Weekly Payload phân nhóm:

- `good` / 🟢 ĐANG TỐT: positive Lead signal, outcome không suy yếu, và có management signal đủ rõ.
- `watch` / 🟠 CẦN THEO DÕI: mixed performance; acquisition tăng nhưng outcome yếu; Lead giảm nhưng outcome chưa giảm tương ứng; hoặc leaderboard/warning chưa đủ Action Now.
- `action_now` / 🔴 HÀNH ĐỘNG NGAY: `weekly_status=red`, broad Lead+Won decline, hoặc recent-zero đi kèm deterioration.

Classification reuse weekly status, change tuần, sáu direction 7d/30d/90d, down counts, days no Lead, sample gate và role. Writer không tự thêm course hoặc đổi nhóm. Compact course chỉ giữ tên/group/role, Lead-Won-CVR, direction cần diễn giải, days no Lead và `interpretation_code`.

### 10.4. Nguồn Lead nổi bật

- `top_by_leads`: `lead_count DESC → won_count DESC → lost_count ASC → stable key ASC`.
- `top_by_won`: tracked row có `lead_count >= weekly_min_content_leads`, `closed_count > 0`, `won_count > 0`; sort `won_count DESC → lead_count DESC → lost_count ASC → stable key ASC`.
- `tracking`: chỉ untracked Lead và share %.

Cả hai ranking dùng `weekly_content_top_n`, nhưng heading không ghi Top 5/Top 10. Writer chỉ nhận source, medium, content, course, Lead, Won, Lost. `top_by_cvr` vẫn có trong full payload cho audit, không phải ranking final. CVR content là “CVR cohort hiện tại”. `(not set)`, missing UTM và Lead tay không gọi Content.

### 10.5. Khóa không ra Lead

- `recent_zero` → “Mới về 0 Lead gần đây”: 0 Lead T2–T6, đã từng có Lead, chưa thuộc history, và có prior demand.
- `history` → “Không Lead kéo dài”: chưa từng có Lead hoặc `days_no_lead > history_no_lead_days`.

History list toàn bộ, sort `days_no_lead DESC → course_name ASC`; mỗi Writer item chỉ có `course_name`, `days_no_lead`. Recent-zero sort days tăng dần rồi demand/name. Hai nhóm loại trừ nhau; không duplicate `courses/display_courses` trong `writer_payload`.

### 10.6. Tuần sau

Code tạo trước:

- `continue`: good, Most Improved có Lead tăng, top Lead content, top Won content; de-duplicate.
- `priority`: Action Now có broad Lead+Won decline hoặc cả Lead/Won current7 down.
- `restore_acquisition`: toàn bộ recent-zero.
- `goal_code=KEEP_RECOVER_STOP_DECLINE`.

Writer chỉ diễn đạt “Tiếp tục”, “Ưu tiên xử lý”, “Khôi phục acquisition” và mục tiêu. Không tạo KPI target, owner/deadline, root cause hoặc action ngoài payload.

### 10.7. Stale open

Stale open là Weekly-only technical signal, mặc định `enable_weekly_stale_open=false`. Nếu bật, chỉ dùng deal open và `stage_start_at`; không thay đổi Daily và không tạo Warning section.

---

## 11. Chủ Nhật

- Đúng một câu tiếng Việt, tối đa khoảng 40 từ.
- Vui, nhẹ, có động lực.
- Không KPI, course, warning, data health hoặc giao việc.
- Không thêm header/section.
- Không chạy BigQuery business query.
- Schedule hiện tại chưa gọi Sunday; xem §5.2.

---

## 12. Kiến trúc workflow v3.2

```text
Schedule / Manual → Config (schema_version=3.2) → Resolve Calendar → Router
  ├─ Daily queries → Build Daily Payload → Daily Writer
  ├─ Q3–Q6 Weekly → Build Weekly Payload
  │                    ├─ technical/audit fields
  │                    └─ compact writer_payload → Weekly Writer
  └─ Sunday Writer
              ↓
      Assemble theo mode → Final Output → Log full payload/output → Delivery
```

Weekly wiring giữ nguyên: Q3–Q6 → Build Weekly Payload → Weekly Brief Writer → Assemble Weekly. Assemble Weekly log toàn bộ top-level payload; AI chỉ nhận `writer_payload`. Daily/Sunday, credential, endpoint và delivery wiring không đổi.

---

## 13. Query/data contract

Tên D1/W1 là logical contract, không bắt buộc là node name.

### 13.1. Daily query set

#### D1 — Overall Funnel

| Thuộc tính | Contract |
|---|---|
| Input | `report_date`, current/previous 7 windows, stage lists. |
| Scope | Toàn bộ deal không rác. |
| Time | Lead/MQL/SQL theo `created_at`; Won/Lost/CVR theo `closed_at`. |
| Output | Yesterday Lead/Won; raw counts, avg/day, pct change; CVR/pp change; component directions; `summary_code`. |
| Cardinality | Đúng 1 row/object. |

Lost được query/log nhưng `show_in_daily=false`.

#### D2 — Focus Course Trend + No Lead

| Thuộc tính | Contract |
|---|---|
| Input | `report_day`, `report_date`, 7/30/90 windows, trend/sample/no-lead Config. |
| Scope | Mọi `dim_course.is_active=TRUE AND report_day=@report_day`. |
| Mapping | `selected_course` → `dim_course`, gồm alias. |
| Lead metrics | Raw count + per-day current7, prev7, prev30, prev90 theo `created_at`. |
| Won metrics | Raw count + per-day current7, prev7, prev30, prev90 theo `closed_at`. |
| No Lead | last lead date, days no lead, has-ever-lead, historical demand gate. |
| Code output | Six directions, low-volume flags, status, status reason, interpretation code, priority tuple fields. |
| Cardinality | Đúng một row/course trong scope, kể cả tất cả metric=0. |

D2 không đọc `deal_activities`, không tính pending và không tính stale open.

#### D3 — Daily Data Quality

| Input | `report_date`. |
| Scope | Lead tạo trong report_date, đã loại rác. |
| Output | total Lead, missing selected course, unmapped course, unmapped rate, top raw unmapped values, severity. |
| Use | Log/debug; một dòng alert ngắn nếu severe. |

Daily không cần Q2 Breakdown, Q3 UTM, Q4 No-Lead toàn active hoặc Q5 Warning toàn active như v2.1.

### 13.2. Weekly query set

#### W1 — Weekly Funnel + Course Performance

| Input | Current/previous T2–T6 windows và trend windows kết thúc tại T6. |
| Scope | Toàn business cho overall; toàn bộ active course cho course metrics. |
| Overall | Lead/MQL/Discovery/Need-fit/Won/Lost/CVR current vs previous week. |
| Course | Weekly totals/deltas; current7/prev7/30/90 Lead/Won trend; last Lead; historical baseline. |
| Output | Overall object + một row mỗi active course. |

#### W2 — Content Performance

| Input | T2–T6 current week, content sample/limit. |
| Cohort | Lead tạo trong tuần theo `created_at`. |
| Output | 5 UTM technical fields; distinct `n_leads`, `n_won`, `n_lost`, `n_closed`, cohort CVR, `is_untracked`; Code tạo `top_by_leads`, `top_by_won`, giữ `top_by_cvr` audit. |

#### W3 — Weekly Stale Open (conditional)

Chỉ tồn tại nếu quyết định §10.6 được duyệt:

- scope toàn active course;
- deal `open`;
- age theo `stage_start_at`;
- output count/course;
- không join `deal_activities`;
- Weekly-only.

Nếu không duyệt, bỏ query W3 và toàn bộ Config stale.

#### W4 — Weekly Data Quality

Scope T2–T6; output mapping quality và UTM untracked share. Không tạo section Data Health riêng.

### 13.3. Query invariants

- Không revenue.
- Không `SELECT *` trong production query.
- Không SQL do LLM sinh.
- Mọi date window lấy từ Resolve Calendar.
- Bắt đầu từ active course scope rồi `LEFT JOIN` fact để không mất course zero-volume.
- Mọi count deal/Lead dùng distinct deal ID.

---

## 14. Payload contract

### 14.1. Daily payload

```json
{
  "schema_version": "3.1",
  "report_mode": "daily",
  "run_id": "uuid",
  "run_date": "2026-08-24",
  "report_date": "2026-08-23",
  "report_day": 2,
  "weekday_label": "Thứ Hai",
  "daily_display_title": "📚 MARKETING ENTRY MONDAY",
  "focus_group_label": "MARKETING",
  "periods": {
    "curr7_start": "2026-08-17",
    "curr7_end": "2026-08-23",
    "prev7_start": "2026-08-10",
    "prev7_end": "2026-08-16",
    "prev30_start": "2026-07-18",
    "prev30_end": "2026-08-16",
    "prev90_start": "2026-05-19",
    "prev90_end": "2026-08-16"
  },
  "overall": {
    "leads_yesterday": 5,
    "won_yesterday": 0,
    "leads_avg7_curr": 13.0,
    "leads_avg7_prev": 13.43,
    "leads_pct_change": -3.2,
    "mql_avg7_curr": 10.0,
    "mql_avg7_prev": 11.57,
    "mql_pct_change": -13.6,
    "discovery_avg7_curr": 7.43,
    "discovery_avg7_prev": 9.14,
    "discovery_pct_change": -18.7,
    "needfit_avg7_curr": 4.14,
    "needfit_avg7_prev": 4.29,
    "needfit_pct_change": -3.3,
    "won_avg7_curr": 4.43,
    "won_avg7_prev": 3.71,
    "won_pct_change": 19.2,
    "lost_avg7_curr": 2.57,
    "lost_avg7_prev": 2.43,
    "show_lost_daily": false,
    "conversion_rate_curr": 47.7,
    "conversion_rate_prev": 47.3,
    "cvr_change_pp": 0.4,
    "lead_direction": "flat",
    "mql_direction": "down",
    "discovery_direction": "down",
    "needfit_direction": "flat",
    "won_direction": "up",
    "cvr_direction": "flat",
    "summary_code": "INPUT_MID_DOWN_OUTCOME_OK"
  },
  "focus_courses": [
    {
      "course_key": "marketing foundation",
      "course_name": "Marketing Foundation",
      "course_type": "Marketing",
      "lead_n_curr7": 11,
      "lead_n_prev7": 14,
      "lead_n_prev30": 47,
      "lead_n_prev90": 186,
      "lead_pd_curr7": 1.57,
      "lead_pd_prev7": 2.0,
      "lead_pd_prev30": 1.57,
      "lead_pd_prev90": 2.07,
      "lead_vs_prev7": "down",
      "lead_vs_prev30": "flat",
      "lead_vs_prev90": "down",
      "won_n_curr7": 5,
      "won_n_prev7": 10,
      "won_n_prev30": 26,
      "won_n_prev90": 99,
      "won_pd_curr7": 0.71,
      "won_pd_prev7": 1.43,
      "won_pd_prev30": 0.87,
      "won_pd_prev90": 1.1,
      "won_vs_prev7": "down",
      "won_vs_prev30": "down",
      "won_vs_prev90": "down",
      "last_lead_date": "2026-08-23",
      "days_no_lead": 0,
      "has_ever_had_lead": true,
      "baseline_lead_expected7": 13.4,
      "is_low_volume": false,
      "is_low_won_volume": false,
      "flag_no_lead": false,
      "lead_down_count": 2,
      "won_down_count": 3,
      "status": "red",
      "status_reason": ["LEAD_DOWN_7D", "LEAD_DOWN_90D", "WON_DOWN_ALL"],
      "interpretation_code": "LEAD_AND_WON_DOWN"
    }
  ],
  "priority_items": [
    {
      "rank": 1,
      "course_names": ["Marketing Foundation"],
      "status": "red",
      "reason_codes": ["LEAD_DOWN_7D", "WON_DOWN_ALL"],
      "interpretation_code": "LEAD_AND_WON_DOWN"
    }
  ],
  "data_health": {
    "total_leads": 5,
    "missing_course_count": 0,
    "unmapped_course_count": 0,
    "unmapped_rate_pct": 0,
    "is_severe": false,
    "alert_text_code": null
  },
  "writer_rules": {
    "priority_limit": 3,
    "show_data_health_alert": false
  }
}
```

Daily payload **không có** `pending_leads`, `flag_pending`, `stale_open_deals`, pipeline object hoặc revenue.

Writer không tự suy ra mũi tên từ số; mapping direction → icon nằm trong Writer rendering rule hoặc được Code trả thêm `display_icon`.

### 14.2. Weekly payload

Build Weekly Payload trả hai lớp, không lồng bản sao full payload trong `writer_payload`:

1. Full technical top-level phục vụ audit/log/debug: dates, raw overall, full leaderboard course objects, content rankings, warnings, no-lead technical objects, legacy priority và data health.
2. Compact `writer_payload`: contract duy nhất Weekly Brief Writer được đọc.

```json
{
  "schema_version": "3.2",
  "report_mode": "weekly",
  "week": {"label": "24/08–28/08", "previous_label": "17/08–21/08"},
  "overall": {
    "acquisition": {"lead": {"current": 54, "previous": 77, "change_pct": -29.9, "direction": "down", "display": "↓29.9%"}},
    "sales_funnel": {"discovery": {}, "need_fit": {}},
    "outcome": {"won": {}, "lost": {}, "cvr": {"current": 29.7, "change_pp": -14.4, "direction": "down", "display": "↓14.4 điểm %"}},
    "summary_code": "FUNNEL_BROAD_SLOWDOWN"
  },
  "course_performance": {"good": [], "watch": [], "action_now": []},
  "lead_sources": {
    "top_by_leads": [],
    "top_by_won": [],
    "tracking": {"untracked_leads": 0, "untracked_share_pct": 0},
    "insight_code": "TOP_SIGNALS"
  },
  "no_lead": {"recent_zero": [], "history_total": 0, "history": []},
  "next_week": {
    "continue": {"course_names": [], "content_names": [], "reason_code": "KEEP_POSITIVE_SIGNAL"},
    "priority": {"course_names": [], "reason_code": "BROAD_LEAD_WON_DECLINE"},
    "restore_acquisition": {"course_names": [], "reason_code": "RECENT_ZERO_LEAD"},
    "goal_code": "KEEP_RECOVER_STOP_DECLINE"
  },
  "writer_rules": {"no_root_cause": true, "no_revenue": true, "no_recalculation": true}
}
```

Writer không nhận raw Q3–Q6, full warnings, duplicated arrays hoặc full payload. User prompt bắt buộc:

```text
Payload Weekly đã tính sẵn:
{{ JSON.stringify($json.writer_payload) }}
```

---

## 15. Brief Writer contract

### 15.1. Giới hạn chung

Writer được in số/display/status/role/code/list có sẵn và diễn đạt ngắn. Writer không được tự tính, tự chọn arrow/status/group/ranking/priority, thêm course/content, root cause, revenue, KPI target, owner/deadline hoặc section rỗng. Không dùng `###`.

### 15.2. Daily Writer

Giữ contract v3.1 hiện tại; không đọc field Weekly.

### 15.3. Weekly Writer v3.2

- Chỉ nhận `JSON.stringify($json.writer_payload)`.
- Output đúng năm section.
- Render đúng `good/watch/action_now`; course một lần; bỏ subgroup rỗng.
- Render `top_by_leads`, `top_by_won` theo đúng thứ tự Code.
- Render tracking từ hai số có sẵn; `(not set)` không gọi Content.
- Render toàn bộ `recent_zero`, `history`.
- Render đúng `continue/priority/restore_acquisition/goal_code`.
- Không có Warning section; warning absorb vào classification/next-week.

### 15.4. Sunday Writer

Đúng một câu ≤40 từ; không KPI/course/warning/giao việc.

---

## 16. Config v3

### 16.1. Giữ và cần review

| Field | Default hiện tại/đề xuất | Dùng | Trạng thái |
|---|---:|---|---|
| `trend_direction_pct` | 10 | Arrow up/down/flat | 🔴 **[CẦN CHỐT]** |
| `warning_zero_lead_days` | 5 | Daily No Lead | 🔴 **[CẦN CHỐT]** |
| `min_base_volume` | 3 observations/equivalent count | Minimum sample cho direction/status/ranking; từng rule ghi rõ window | 🔴 **[CẦN CHỐT]** |
| `cvr_direction_pp` | 5pp | Overall CVR direction | 🔴 **[CẦN CHỐT]** |
| `weekly_min_content_leads` | 3 | Eligibility cho `top_by_won` và `top_by_cvr` audit | 🔴 **[CẦN CHỐT]** |
| `weekly_content_top_n` | 5 | Số content mỗi ranking | 🔴 **[CẦN CHỐT]** |
| `weekly_min_course_leads` | 3 | Leaderboard eligibility | 🔴 **[CẦN CHỐT]** |
| `weekly_min_course_closed` | 3 | Course CVR eligibility | 🔴 **[CẦN CHỐT]** |
| `history_no_lead_days` | 10 | Long no-lead condition `days > threshold` | 🔴 **[CẦN CHỐT]** |
| `unmapped_alert_min` | 3 | Data-health absolute gate | 🔴 **[CẦN CHỐT]** |
| `unmapped_alert_rate_pct` | 5 | Data-health rate gate | 🔴 **[CẦN CHỐT]** |
| `daily_priority_limit` | 3 | Daily priority | **ĐÃ CHỐT** |
| `weekly_priority_limit` | 3 | Weekly priority | **ĐÃ CHỐT** |

### 16.2. Weekly stale Config — conditional

Chỉ giữ nếu stale open Weekly được duyệt:

| Field | Default cũ | Trạng thái |
|---|---:|---|
| `warning_open_deal_days` | 14 | 🔴 **[CẦN CHỐT]** |
| `warning_open_deal_min` | 5 | 🔴 **[CẦN CHỐT]** |

Không dùng hai field này ở Daily.

### 16.3. Bỏ khỏi v3

| Field | Lý do |
|---|---|
| `rca_max_loops`, `rca_max_rows` | Không RCA. |
| `warning_pending_days`, `warning_pending_min_count` | Bỏ pending MVP. |
| `warning_drop_pct` | Course direction dùng `trend_direction_pct`; tránh hai threshold course trend mâu thuẫn. |
| `max_warning_rows` | Final Weekly không còn Warning section. |
| `max_weekly_no_lead_courses` | Nhóm mới về 0 Lead phải list đầy đủ. |
| `max_history_no_lead_courses` | MVP mặc định list đầy đủ; chỉ thêm limit sau khi Data Owner duyệt. |
| `top_course_per_bu` | Không Daily breakdown. |
| `top_utm_rows` | Không Daily UTM. |
| `focus_positive_pct`, `focus_negative_pct` | Thay bằng direction/status v3. |
| `kpi_normal_band_pct` | Thay bằng `trend_direction_pct`. |

Data Health severe đề xuất cần đạt đồng thời absolute và rate gate để lỗi nhỏ không làm phiền cả team.

---

## 17. Data Health và logging

### 17.1. Data Health log fields

- total Leads in scope;
- missing `selected_course` count;
- unmapped `selected_course` count/rate;
- top raw unmapped values + count;
- duplicate mapping key/alias nếu check được;
- empty `dim_course.course_key` count;
- Weekly UTM untracked count/share.

Không có `🧩 DATA HEALTH` section. Khi severe, thêm đúng một dòng ngắn trong Overall, ví dụ:

```text
⚠️ Độ tin cậy dữ liệu: 8/60 Lead chưa map được khóa (13.3%).
```

Raw mapping values chỉ log/debug, không đưa vào brief.

### 17.2. `brief_run_log`

Giữ bảng hiện có:

| Cột | Nội dung v3 |
|---|---|
| `run_id` | UUID xuyên suốt execution. |
| `report_date` | Daily D-1; Weekly ngày T6 kết thúc. |
| `sent_at` | Thời điểm final brief được tạo/gửi. |
| `query_results` | Full Build Payload để audit, gồm technical fields và compact `writer_payload`; Weekly Writer chỉ nhìn thấy `writer_payload`. |
| `agent_output` | Final brief được delivery. |
| `status` | `success` / `error`. |
| `error_message` | Lỗi đã sanitize, không secret/PII. |

`report_mode` chưa có cột riêng; giữ trong `query_results` để không đổi schema ở bước này.

**KHUYẾN NGHỊ:** log Build Payload cuối, không log toàn bộ raw query rows mặc định. Raw execution data dùng log kỹ thuật có retention giới hạn khi debug.

Không log RCA history vì RCA không còn.

---

## 18. Migration / Differences from v2.1

### 18.1. Remove

- Toàn bộ RCA và `🔍 AI ANALYZE`.
- Action Advisor và `🎯 SUGGESTED ACTION` dài.
- Daily Source/UTM.
- Daily Data Health section.
- Daily No Lead section riêng.
- Daily Warning section riêng.
- Daily Pipeline/Open/Stale query, payload và output.
- Pending cùng query `deal_activities` phục vụ pending.
- Daily Breakdown Q2 nếu không có consumer khác.
- Config obsolete ở §16.3.

### 18.2. Change

- Daily Overall từ bản rút gọn thành funnel ba tầng cố định.
- Daily title cố định theo report_day nhưng course scope vẫn động từ `dim_course`.
- Focus in cả Lead/Won current7 và ba baseline trên đúng hai dòng.
- Arrow direction do Code tạo với sample gate.
- Status chỉ dựa Lead/Won/No Lead/sample; không stale/pending.
- Priority tối đa ba và deterministic.
- Weekly Overall dùng funnel ba tầng, có Lost.
- Weekly đổi từ sáu thành năm section; warning absorb vào course groups.
- Course final dùng `good/watch/action_now`, vẫn giữ leaderboard role.
- Content final dùng `top_by_leads/top_by_won`; `top_by_cvr` chỉ audit.
- Writer No Lead dùng compact `recent_zero/history`, list đầy đủ.
- Build Weekly tạo full technical payload + compact `writer_payload`; AI chỉ nhận compact object.
- Build Payload tách Daily/Weekly.
- Weekly date lấy từ Resolve Calendar thay vì `CURRENT_DATE()` trong query.

### 18.3. Điểm implementation v2.1 không được mang sang

- `Resolve Day` hard-code test date.
- Cron thiếu Sunday.
- Weekly query dùng runtime date độc lập với Resolve Day.
- Build Payload daily v2.1 đọc `row.n` trong khi Q0 trả `deal_count`.
- Một Build Payload tham chiếu node branch chưa execute.
- Weekly Content dùng `COUNTIF` thay vì distinct deal ID.
- RCA/Action Advisor và query dư không còn consumer.

---

## 19. Output mẫu

> Toàn bộ số dưới đây là **minh họa**, không phải production data đã xác minh.

### 19.1. Daily mẫu

```text
☀️ DAILY BRIEF — THỨ HAI 24/08
📚 MARKETING ENTRY MONDAY
_Dữ liệu đến hết 23/08_

ℹ️ Lead/ngày & Won/ngày = TB 7 ngày gần nhất.
🟢↑ cao hơn | 🔴↓ thấp hơn | ⚪→ tương đương với baseline 7d / 30d / 90d.

📊 TOÀN CẢNH

Hôm qua: 5 Lead | 0 Won
Acquisition: 13 Lead/ngày (-3.2%) | 10 MQL/ngày (-13.6%)
Sales Funnel: 7.43 Discovery/ngày (-18.7%) | 4.14 Need-fit/ngày (-3.3%)
Outcome: 4.43 Won/ngày (+19.2%) | CVR 47.7% (+0.4đ%)

→ Đầu và giữa funnel đang chậm lại, nhưng Outcome 7 ngày hiện vẫn tốt hơn kỳ trước.

📚 FOCUS — MARKETING

🔴 Marketing Foundation
Lead/ngày: 1.57 | 🔴↓ 2.00 (7d) | ⚪→ 1.57 (30d) | 🔴↓ 2.07 (90d)
Won/ngày: 0.71 | 🔴↓ 1.43 (7d) | 🔴↓ 0.87 (30d) | 🔴↓ 1.10 (90d)
→ Lead và Won cùng yếu hơn tuần trước; Won cũng dưới xu hướng 30 và 90 ngày.

🟠 Management Trainee
Lead/ngày: 0.14 | 🔴↓ 0.43 (7d) | 🔴↓ 0.53 (30d) | 🔴↓ 0.39 (90d)
Won/ngày: 0.29 | 🟢↑ 0.14 (7d) | 🟢↑ 0.07 (30d) | 🟢↑ 0.09 (90d)
→ Lead đang yếu nhưng Won vẫn cao hơn cả ba baseline; tín hiệu hiện nghiêng về đầu vào.

🟠 Master Interview
Lead/ngày: 0.00 | 🔴↓ 0.14 (7d) | 🔴↓ 0.10 (30d) | 🔴↓ 0.12 (90d)
Won/ngày: 0.00 | ⚪→ 0.00 (7d) | 🔴↓ 0.03 (30d) | 🔴↓ 0.04 (90d)
No Lead: 13 ngày
→ Điểm đáng chú ý nhất là đầu vào sau chuỗi 13 ngày không phát sinh Lead.

⚪ Marketing Case
Lead/ngày: 0.00 | ⚪→ 0.00 (7d) | ⚪→ 0.03 (30d) | ⚪→ 0.02 (90d)
Won/ngày: 0.00 | ⚪→ 0.00 (7d) | ⚪→ 0.00 (30d) | ⚪→ 0.01 (90d)
→ Volume lịch sử thấp, chưa đủ dữ liệu để đánh giá xu hướng.

🎯 ƯU TIÊN HÔM NAY

1. Marketing Foundation + Case Mastery — Lead và Won cùng suy yếu rõ.
2. Master Interview — 13 ngày liên tiếp không có Lead.
3. Management Trainee — ưu tiên theo dõi đầu vào; Won hiện vẫn tốt.
```

### 19.2. Weekly mẫu

```text
☀️ **WEEKLY 5 MINUTES BRIEF — 24/08–28/08**

**📊 PERFORMANCE TUẦN**
**Tuần này vs Tuần trước (17/08–21/08)**
**Acquisition:** Lead 54 ↓29.9% | MQL 31 ↓49.2%
**Sales Funnel:** SQL Discovery 25 ↓43.2% | SQL Need-fit 17 ↓32%
**Outcome:** Won 27 →3.8% | Lost 64 ↑93.9% | CVR 29.7% ↓14.4 điểm %
→ Đầu và giữa funnel giảm; Won giữ nhịp nhưng Lost tăng và CVR suy yếu.

**🏆 PERFORMANCE THEO KHÓA**
🟢 **ĐANG TỐT**
**Management Trainee** — Mạnh nhất: 4 Lead | 2 Won | CVR 66.7%.

🟠 **CẦN THEO DÕI**
**Content Marketing** — Tăng tốt nhất: 8 Lead ↑100% | 1 Won | CVR 20%.

🔴 **HÀNH ĐỘNG NGAY**
**Flexible Combo 2** — Giảm mạnh nhất: 0 Lead ↓100% | 1 Won | chưa đủ mẫu CVR.

**📣 NGUỒN LEAD NỔI BẬT**
**Top nhiều Lead nhất:**
1. Facebook CPC · video · content-plan · Content Marketing — 4 Lead
**Top nhiều Won nhất:**
1. Facebook Group BC · tips_and_guide · Case Mastery — 3 Lead | 1 Won | 0 Lost
**Tracking:** 26 Lead không tracking, chiếm 48.1%.

**🚫 KHÓA KHÔNG RA LEAD**
**Mới về 0 Lead gần đây:** Flexible Combo 2 (7 ngày) | Professional AI Program (8 ngày).
**Không Lead kéo dài:** 2 khóa.
Business Intelligence (198 ngày) | Brand Growth (129 ngày).

**🎯 TUẦN SAU**
**Tiếp tục:** Management Trainee và content-plan.
**Ưu tiên xử lý:** các course broad Lead + Won decline trong payload.
**Khôi phục acquisition:** Flexible Combo 2 và Professional AI Program.
→ **Mục tiêu tuần tới:** giữ tín hiệu tăng, phục hồi nhóm mới mất Lead và kiểm tra nhóm suy giảm.
```

Tên/số chỉ minh họa format; production không hard-code.

---

## 20. Acceptance tests

### 20.1. Test Daily date/title/scope

- Run 24/08/2026 → `run_date=24/08`, `report_date=23/08`, `report_day=2`.
- Header ghi Thứ Hai 24/08; data note ghi 23/08.
- Title đúng `📚 MARKETING ENTRY MONDAY`.
- Scope lấy động đủ sáu khóa active T2 từ `dim_course`.
- Thay đổi fixture `report_day/is_active` làm scope đổi mà không sửa Writer/course list Code.

### 20.2. Test Daily Overall

- Luôn có Hôm qua + Acquisition + Sales Funnel + Outcome.
- Lead/MQL/Discovery/Need-fit theo `created_at`.
- Won/CVR theo `closed_at`.
- Lost có trong payload/log nhưng `show_lost_daily=false` và không in.
- Conclusion khớp `summary_code`; Writer không tự kết luận từ số.

### 20.3. Test comparison 7/30/90

- Mỗi course có đủ current7, prev7, prev30, prev90 cho Lead và Won.
- Mỗi KPI chỉ in một dòng.
- `up/down/flat` tính theo Config; Writer chỉ map icon.
- KPI có current và tổng history 90 ngày đều dưới `min_base_volume` → cả ba direction flat.
- Nếu không low-volume: baseline=0/current>0 → up; current=0/baseline>0 → down.

### 20.4. Test Daily status/low volume

- Red/Orange/Yellow/Normal khớp rule §8.4.
- Stale/open/pending không ảnh hưởng Daily status.
- Low-volume current=0 không tự thành red/orange.
- Low-volume vẫn xuất hiện và có `LOW_VOLUME` interpretation.

### 20.5. Test Daily No Lead

- No Lead đáng chú ý chỉ nằm trong Focus course block.
- Course ngoài Focus không xuất hiện.
- Historical demand gate ngăn false alarm cho course vốn ít Lead.
- Chưa từng có Lead không bị gán 999 ngày.

### 20.6. Test Daily priority

- Tối đa ba item; không owner/deadline.
- Ranking/grouping khớp tuple và code.
- Writer không tự thêm/gộp course.
- Không item giả khi không có đủ priority.

### 20.7. Test Saturday Overall/course/content

- Scope đủ active course; period đúng hai tuần T2–T6.
- Overall đủ ba tầng, Lost, CVR và precomputed display.
- Leaderboard deterministic chỉ làm role label; course không lặp.
- `good/watch/action_now` do Code tạo.
- `top_by_leads/top_by_won` đúng sort, tie-break, sample gate; `top_by_cvr` không render chính.

### 20.8. Test compact payload

- Writer dùng `JSON.stringify($json.writer_payload)`, không còn `JSON.stringify($json)`.
- Compact object không chứa raw Q3–Q6, warnings hoặc duplicated course arrays.
- Assemble Weekly vẫn log full technical payload.
- Writer input dưới khoảng 8k–10k tokens cho tuần mẫu.

### 20.9. Test Weekly No Lead

- `recent_zero/history` độc lập, không overlap.
- History list đầy đủ, sort days desc.
- Mỗi item chỉ `course_name/days_no_lead`.

### 20.10. Test continuity

- `continue/priority/restore_acquisition/goal_code` do Code tạo và de-duplicate.
- Writer không thêm đối tượng hoặc KPI target.
- Final output không có Warning section.

### 20.11. Test Sunday

- Schedule route được Chủ Nhật.
- Không business query.
- Đúng một câu ≤40 từ, không KPI/course/warning/giao việc.

### 20.12. Test Data Health

- Lỗi mapping nhỏ chỉ log.
- Vượt cả absolute/rate gate → đúng một dòng ngắn.
- Field names giữa query và Build Payload khớp; không lặp lỗi `n` vs `deal_count`.

### 20.13. Test Writer

- Không revenue/doanh thu.
- Không root cause/causal claim.
- Không tự tính hoặc chọn arrow/status/ranking/priority.
- Không section/bullet rỗng hoặc `###` thừa.
- Daily giữ contract hiện tại; Weekly đúng năm section.
- Mọi active Focus course xuất hiện đúng một lần.

### 20.14. Test query rules

- Mọi deal query có Trash filter.
- Không `interested_course`, pipeline-to-course inference hoặc cột cấm.
- Count distinct `deal_id`.
- Date windows từ Resolve Calendar.
- Active course zero-volume không bị mất do query bắt đầu từ fact.

---

## 21. Danh sách `[CẦN CHỐT]`

1. 🔴 **[CẦN CHỐT]** Lịch production 07:30 ICT cả bảy ngày và tự động gửi Sunday message.
2. 🔴 **[CẦN CHỐT]** `trend_direction_pct = 10%` cho `up/down/flat`.
3. 🔴 **[CẦN CHỐT]** `warning_zero_lead_days = 5`.
4. 🔴 **[CẦN CHỐT]** `min_base_volume = 3` observations/equivalent count cho các sample gate đã mô tả.
5. 🔴 **[CẦN CHỐT]** `cvr_direction_pp = 5pp`.
6. 🔴 **[CẦN CHỐT]** Bảng severity Daily `red/orange/yellow/normal` ở §8.4.
7. 🔴 **[CẦN CHỐT]** `weekly_min_content_leads = 3` và `weekly_content_top_n = 5`.
8. 🔴 **[CẦN CHỐT]** `weekly_min_course_leads = 3` và `weekly_min_course_closed = 3`.
9. 🔴 **[CẦN CHỐT]** `history_no_lead_days = 10`, với rule “số ngày > threshold”.
10. **ĐÃ CHỐT v3.2:** No Lead history list đầy đủ, không display limit.
11. **ĐÃ CHỐT v3.2:** Final Weekly không có Warning section; stale mặc định tắt.
12. 🔴 **[CẦN CHỐT]** Nếu giữ Weekly stale: `warning_open_deal_days = 14` và `warning_open_deal_min = 5`.
13. 🔴 **[CẦN CHỐT]** Data-health gate: `unmapped_alert_min = 3` và `unmapped_alert_rate_pct = 5`.

---

## 22. Trạng thái implementation

Workflow v3.2 đã được build trong `workflow/Daily-5-Minutes-Brief-v3.2.json`.

Trước production rollout:

1. import/execute trong n8n với credential hiện có;
2. chạy Q3–Q6 thật cho tuần 24/08/2026–28/08/2026;
3. đối chiếu output với acceptance tests §20;
4. review threshold còn đánh dấu `[CẦN CHỐT]`;
5. xác nhận delivery và `brief_run_log` không đổi.

Không thay database schema, credential, HTTP endpoint hoặc `dim_course` trong thay đổi v3.2 này.
