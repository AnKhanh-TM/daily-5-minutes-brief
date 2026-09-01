# RCA v2.1 — Thiết kế tối ưu token và bảo đảm luôn có output

> **Mục tiêu:** thay khối RCA vòng lặp hiện tại trong `workflow/Daily-5-Minutes-Brief-v2.json` bằng một luồng một lượt, không bắt LLM sao chép lại toàn bộ `state`, không tạo cycle trên canvas và luôn trả về một khối `🔍 AI ANALYZE` có cấu trúc rõ ràng.
>
> **Trạng thái triển khai:** đã tạo [`workflow/Daily-5-Minutes-Brief-v2.1.json`](workflow/Daily-5-Minutes-Brief-v2.1.json) từ JSON v2. File v2 gốc được giữ nguyên.

---

## 1. Vấn đề của RCA hiện tại

Luồng hiện tại:

```text
RCA Init → Planner → SQL Writer → Guardrail → BigQuery → Evaluator
    ▲                                                   │
    └──────────── Continue RCA? ← Normalize ────────────┘
```

Các nguyên nhân làm tốn token và khó ra output:

1. `RCA Planner` phải trả lại toàn bộ `state`, gồm `payload`, `brief_text`, `history` và kết quả các vòng trước.
2. `RCA SQL Writer` tiếp tục chép lại `state`, `hypothesis` và `rationale` trước khi thêm SQL.
3. Sau mỗi vòng, `history` chứa cả SQL và `result_rows`; input vòng sau ngày càng lớn.
4. Agent sau đọc lại dữ liệu được LLM trước sao chép, thay vì đọc trực tiếp node nguồn.
5. Cycle `Continue RCA? → RCA Planner` làm việc debug execution khó hơn và có thể khiến workflow không đến `RCA Finalizer` khi một node lỗi ngoài dự kiến.
6. Một lỗi JSON của Planner/SQL Writer có thể làm mất `payload` vì state đang được LLM giữ hộ.

**Nguyên tắc mới:** dữ liệu và state do Code node/n8n giữ; LLM chỉ tạo phần nội dung hẹp thuộc vai trò của nó.

---

## 2. Kiến trúc đề xuất — một hypothesis, một query, một kết luận

```text
[Agent 1 - Brief Writer]
          │
          ▼
[RCA Context Builder]          Code — rút gọn payload, không dùng LLM
          │
          ▼
[RCA Planner]                  LLM — chỉ tạo hypothesis
          │
          ▼
[Parse RCA Hypothesis]         Code — parse/validate JSON + fallback
          │
          ▼
[RCA SQL Writer]               LLM — đọc context + hypothesis qua node reference
          │
          ▼
[SQL Guardrail]                Code — parse SQL + kiểm tra an toàn
          │
          ▼
[Is SQL Valid?]
     ┌────┴─────┐
   true        false
     │           │
     ▼           ▼
[BigQuery]  [RCA Failure Output]
     │           │
     ▼           │
[Aggregate RCA Result]
     │
     ▼
[RCA Evaluator]                LLM — đọc trực tiếp hypothesis/query/result
     │
     ▼
[RCA Finalizer]                Code — chuẩn hóa output, luôn có fallback
     └───────────┬─────────────┘
                 ▼
      [Agent 3 - Action Advisor]
```

Không còn các node:

- `RCA Init`
- `Normalize RCA Evaluation`
- `Record Guardrail Failure`
- `Continue RCA?`
- cycle quay lại `RCA Planner`

Không có object `state` và không có `history` được truyền qua LLM.

**Lựa chọn node LLM:** để triển khai ít rủi ro nhất, có thể giữ loại node Agent hiện đang cài nhưng không gắn tool. Nếu instance có `Basic LLM Chain`, nên đổi Planner/SQL Writer/Evaluator sang Chain vì ba vai trò này chỉ cần một lần gọi model và không cần agent loop/tool-planning. Luồng dữ liệu và prompt trong tài liệu không thay đổi.

Đổi lại, v2.1 chỉ kiểm chứng một hypothesis ưu tiên cao nhất trong mỗi brief. Đây là chủ đích để bảo đảm thời gian chạy, chi phí và output; chỉ bổ sung hypothesis thứ hai sau khi bản một lượt đã chạy ổn và có số liệu cho thấy thật sự cần.

---

## 3. Luồng dữ liệu giữa các node

Mỗi Agent đọc trực tiếp node nguồn bằng expression của n8n:

| Node | Dữ liệu được đọc | Cách đọc |
|---|---|---|
| `RCA Planner` | Context đã rút gọn | Input `$json` từ `RCA Context Builder` |
| `RCA SQL Writer` | Context + hypothesis | `$('RCA Context Builder').first().json` và `$('Parse RCA Hypothesis').first().json` |
| `RCA Evaluator` | Context + hypothesis + SQL + query result | Tham chiếu trực tiếp bốn node trước |
| `RCA Finalizer` | Output Evaluator và các node nguồn | Code node reference, không phụ thuộc Evaluator chép lại input |
| `Action Advisor` | Brief + RCA chuẩn hóa + warnings | Tham chiếu `Agent 1`, `RCA Finalizer`, `Build Payload` |

Nhờ vậy, Planner chỉ sinh hypothesis; SQL Writer chỉ sinh SQL; Evaluator chỉ sinh kết luận.

---

## 4. Node `RCA Context Builder`

### 4.1. Mục đích

Không đưa toàn bộ `Build Payload` vào Planner. Chỉ giữ các tín hiệu cần để chọn một bất thường quan trọng:

- `report_mode`, `report_date`;
- KPI và thay đổi chính;
- tối đa 5 warning;
- khóa mạnh/yếu của weekly;
- tối đa 3 content theo lead và 3 content theo CVR;
- tổng lỗi data health;
- không đưa toàn bộ `weekly_performance`, `breakdown`, `utm_weekly`, raw Q5 hoặc SQL cũ.

### 4.2. Code đề xuất

```javascript
const payload = $('Build Payload').first().json;

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj?.[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

const dailyKpiKeys = [
  'leads_yesterday',
  'won_yesterday',
  'leads_avg7_curr',
  'leads_avg7_prev',
  'leads_pct_change',
  'won_avg7_curr',
  'won_avg7_prev',
  'won_pct_change',
  'mql_pct_change',
  'sql_discovery_pct_change',
  'sql_needfit_pct_change',
  'lost_pct_change',
  'conversion_rate_curr',
  'conversion_rate_prev',
  'cvr_change_pp',
];

const context = {
  report_mode: payload.report_mode,
  report_date: payload.report_date,
  kpi: pick(payload.kpi || {}, dailyKpiKeys),
  warnings: (payload.warnings || []).slice(0, 5),
  strongest_course: payload.strongest_course || null,
  weakest_course: payload.weakest_course || null,
  content_top_leads: (payload.content_top_leads || []).slice(0, 3),
  content_top_cvr: (payload.content_top_cvr || []).slice(0, 3),
  data_health: {
    unmapped_total: payload.data_health?.unmapped_total || 0,
    show_alert: Boolean(payload.data_health?.show_alert),
  },
};

const serialized = JSON.stringify(context);

if (serialized.length > 12000) {
  throw new Error(`RCA_CONTEXT_TOO_LARGE: ${serialized.length} characters`);
}

return [{ json: context }];
```

**Giới hạn đề xuất:** tối đa 12.000 ký tự, thường tương đương dưới khoảng 3.000 token đầu vào.

---

## 5. Node `RCA Planner` — chỉ tạo hypothesis

### 5.1. Input

```text
=Context đã rút gọn:
{{ JSON.stringify($json) }}
```

### 5.2. System prompt

```text
Bạn là RCA Planner của Tomorrow Marketers.

Nhiệm vụ duy nhất: chọn 1 bất thường quan trọng nhất trong context và tạo 1 giả thuyết có thể kiểm chứng bằng dữ liệu CRM.

Không viết SQL.
Không chép lại context.
Không trả payload, state, history hoặc brief.
Không kết luận nguyên nhân khi chưa query.
Không nhắc revenue/doanh thu.

Chỉ trả JSON thuần, không markdown:
{
  "hypothesis": "Một giả thuyết cụ thể, có đối tượng và chiều biến động",
  "evidence_needed": "Dữ liệu cần kiểm tra để ủng hộ hoặc bác bỏ",
  "priority_reason": "Vì sao đây là bất thường cần kiểm tra trước"
}
```

### 5.3. Output tối đa

- Tối đa 120 từ.
- Không có field ngoài ba field trên.
- Không có `state`.

---

## 6. Node `Parse RCA Hypothesis`

Node Code này giữ workflow hoạt động ngay cả khi Planner trả markdown hoặc JSON lỗi.

```javascript
function cleanJson(value) {
  let text = String(value || '').trim();
  const fence = String.fromCharCode(96).repeat(3);

  if (text.startsWith(fence)) {
    text = text.slice(3).replace(/^json/i, '').trim();
  }
  if (text.endsWith(fence)) {
    text = text.slice(0, -3).trim();
  }
  return text;
}

const raw = $json.output || $json.text || '';
let parsed;

try {
  parsed = JSON.parse(cleanJson(raw));
} catch (error) {
  parsed = {
    hypothesis: 'Chưa tạo được giả thuyết RCA hợp lệ',
    evidence_needed: 'Kiểm tra thủ công warning có mức ưu tiên cao nhất',
    priority_reason: `Planner trả JSON lỗi: ${error.message}`,
    planner_valid: false,
  };
}

return [{
  json: {
    hypothesis: String(parsed.hypothesis || '').slice(0, 500),
    evidence_needed: String(parsed.evidence_needed || '').slice(0, 500),
    priority_reason: String(parsed.priority_reason || '').slice(0, 500),
    planner_valid: parsed.planner_valid !== false && Boolean(parsed.hypothesis),
  },
}];
```

Nếu `planner_valid=false`, có thể đi thẳng tới `RCA Failure Output` thay vì gọi SQL Writer.

---

## 7. Node `RCA SQL Writer` — không sao chép input

### 7.1. Input bằng node reference

```text
=Context:
{{ JSON.stringify($('RCA Context Builder').first().json) }}

Hypothesis:
{{ JSON.stringify($('Parse RCA Hypothesis').first().json) }}
```

### 7.2. System prompt

```text
Bạn là BigQuery SQL Writer.

Nhiệm vụ duy nhất: viết 1 query read-only để kiểm chứng hypothesis.

Allowlist:
- tmdatabase.dm_base_crm.deals
- tmdatabase.dm_base_crm.stages
- tmdatabase.dm_base_crm.pipelines
- tmdatabase.dm_base_crm.deal_activities
- tmdatabase.dm_daily_brief.dim_course

Quy tắc:
- Query bắt đầu bằng SELECT hoặc WITH.
- Loại deal có failed_reason_id bắt đầu bằng Trash:.
- Nếu dùng deal_activities, aggregate theo deal_id trước khi JOIN.
- Cửa sổ thời gian tối đa 90 ngày.
- Không SELECT *.
- LIMIT tối đa 100.
- Không chép lại context hoặc hypothesis.

Chỉ trả JSON thuần:
{
  "sql": "WITH ... SELECT ... LIMIT 100",
  "expected_signal": "Kết quả nào sẽ ủng hộ hoặc bác bỏ hypothesis"
}
```

SQL Writer không trả `state`, `payload`, `history`, `hypothesis` hay `rationale`.

---

## 8. `SQL Guardrail`

Giữ guardrail hiện tại nhưng thay nguồn hypothesis bằng node reference:

```javascript
const hypothesis = $('Parse RCA Hypothesis').first().json;
```

Output tối thiểu:

```json
{
  "sql": "SELECT ... LIMIT 100",
  "sql_valid": true,
  "guardrail_reason": "",
  "expected_signal": "..."
}
```

Không đưa `state` vào output.

Nên giảm `rca_max_rows` từ `200` xuống `100`. Một kết luận RCA trong brief không cần đọc 200 dòng raw; SQL nên aggregate trước khi trả kết quả.

---

## 9. BigQuery và `Aggregate RCA Result`

### 9.1. BigQuery Execute RCA

```text
={{ $('SQL Guardrail').first().json.sql }}
```

Thiết lập:

- credential: cùng `Google BigQuery account 2` với daily query;
- `On Error = Continue Regular Output`;
- không dùng BigQuery Tool;
- query đã có `LIMIT ≤ 100`.

### 9.2. Aggregate RCA Result

```javascript
const rows = $input.all().map(item => item.json);

const hasError = rows.some(row =>
  row.error || row.error_message || row.message?.toLowerCase?.().includes('error')
);

return [{
  json: {
    status: hasError ? 'query_error' : 'ok',
    row_count: rows.length,
    rows: rows.slice(0, 100),
  },
}];
```

Node này chỉ gom result. Không gắn lại context/hypothesis vì Evaluator có thể đọc trực tiếp node tương ứng.

---

## 10. `RCA Evaluator` — đọc trực tiếp các node trước

### 10.1. Input

```text
=Context:
{{ JSON.stringify($('RCA Context Builder').first().json) }}

Hypothesis:
{{ JSON.stringify($('Parse RCA Hypothesis').first().json) }}

Expected signal:
{{ $('SQL Guardrail').first().json.expected_signal }}

Query result:
{{ JSON.stringify($('Aggregate RCA Result').first().json) }}
```

### 10.2. System prompt

```text
Bạn là RCA Evaluator.

Đánh giá hypothesis bằng query result được cung cấp.
Không chép lại context, SQL hoặc toàn bộ rows.
Không gọi tương quan là quan hệ nhân quả.
Không nhắc revenue/doanh thu.
Nếu query lỗi, không có dòng, mẫu quá nhỏ hoặc evidence không trực tiếp, phải trả insufficient_data hoặc not_supported.

Chỉ trả JSON thuần:
{
  "status": "supported | not_supported | insufficient_data",
  "finding": "Một câu kết luận ngắn",
  "evidence": [
    "Số liệu 1",
    "Số liệu 2"
  ],
  "confidence": "high | medium | low",
  "next_check": "Bước kiểm tra tiếp theo hoặc chuỗi rỗng"
}
```

Giới hạn:

- `finding`: tối đa 60 từ;
- `evidence`: tối đa 3 dòng;
- tổng output tối đa khoảng 220 từ.

---

## 11. Các `RCA Failure Output` — nhánh bảo đảm không bị mất output

Để không tham chiếu một node chưa được execute, dùng **ba Code node lỗi riêng**, cùng trả một output schema:

- `RCA Planner Failure`: nối từ nhánh `planner_valid=false`;
- `RCA SQL Failure`: nối từ nhánh `sql_valid=false`;
- `RCA Query Failure`: nối từ nhánh `Aggregate RCA Result.status='query_error'`.

Ví dụ `RCA SQL Failure`:

```javascript
const hypothesis = $('Parse RCA Hypothesis').first().json;
const guardrail = $json;

return [{
  json: {
    status: 'query_blocked',
    hypothesis: hypothesis.hypothesis,
    finding: 'Chưa đủ dữ liệu để xác định nguyên nhân.',
    evidence: [],
    confidence: 'low',
    next_check: guardrail.guardrail_reason || hypothesis.evidence_needed,
  },
}];
```

`RCA Planner Failure` dùng chính `$json` từ `Parse RCA Hypothesis` và đặt `status='insufficient_data'`. `RCA Query Failure` dùng `$json` từ Aggregate, đặt `status='query_error'` và đưa error message vào `next_check`. Cả ba node nối thẳng tới `RCA Finalizer`; tuyệt đối không dùng `.isExecuted` hoặc tham chiếu node thuộc nhánh chưa chạy.

---

## 12. `RCA Finalizer` — output cố định, dễ đọc

Finalizer parse output Evaluator; nếu parse lỗi thì tạo fallback. Output cho các node sau luôn cùng schema:

```json
{
  "status": "supported",
  "hypothesis": "Lead của khóa X giảm do tỷ trọng source Y giảm",
  "finding": "Dữ liệu ủng hộ một phần giả thuyết...",
  "evidence": [
    "Lead source Y giảm từ 18 xuống 7",
    "Tỷ trọng giảm từ 42% xuống 21%"
  ],
  "confidence": "medium",
  "next_check": "Kiểm tra trạng thái campaign Y"
}
```

Text hiển thị:

```text
🔍 AI ANALYZE
Giả thuyết: ...
Kết luận: ...
Bằng chứng:
- ...
- ...
Độ tin cậy: Trung bình
Cần kiểm tra tiếp: ...
```

Không dùng danh sách findings dài từ nhiều vòng. Một brief chỉ có một kết luận RCA ưu tiên cao nhất.

---

## 13. Action Advisor

Input đề xuất:

```text
=Brief:
{{ $('Agent 1 - Brief Writer').first().json.output || '' }}

RCA:
{{ JSON.stringify($('RCA Finalizer').first().json) }}

Warnings:
{{ JSON.stringify($('Build Payload').first().json.warnings || []) }}
```

Quy tắc:

- nếu `status=supported`: hành động trực tiếp theo finding;
- nếu `status=not_supported`: không hành động theo giả thuyết đã bị bác bỏ;
- nếu `status=insufficient_data/query_blocked/query_error`: đề xuất bước kiểm tra cụ thể;
- tối đa 3 hành động;
- không bịa owner nếu dữ liệu không chỉ ra; có thể dùng vai trò như `Marketing`, `Sales`, `Data`.

---

## 14. Ngân sách token đề xuất

| Node | Input mục tiêu | Output tối đa |
|---|---:|---:|
| RCA Planner | ≤ 3.000 token | ~150 token |
| RCA SQL Writer | ≤ 3.300 token | ~700 token, chủ yếu là SQL |
| RCA Evaluator | ≤ 4.000 token, gồm query rows đã aggregate | ~300 token |
| Tổng RCA | Khoảng 4.000–7.000 token tùy SQL | Không tăng theo vòng lặp |

Để giữ giới hạn:

1. Context chỉ chứa top warning/content cần thiết.
2. SQL phải aggregate trước khi trả row.
3. `LIMIT ≤ 100`.
4. Không truyền brief đầy đủ vào Planner/SQL Writer.
5. Không LLM nào được echo context hoặc output node khác.
6. Không có history/cycle.

---

## 15. Vì sao phương án này đáng tin cậy hơn

| Rủi ro hiện tại | Cách v2.1 xử lý |
|---|---|
| Planner chép lại state rất lớn | Planner chỉ trả 3 field nhỏ |
| State bị mất khi JSON lỗi | Context nằm ở Code node và được tham chiếu trực tiếp |
| History tăng sau mỗi vòng | Không có history, không có vòng lặp |
| Không đến Finalizer | Mọi nhánh lỗi đều có Failure Output |
| Output RCA dài, khó đọc | Schema cố định và một hypothesis ưu tiên |
| Query quá nhiều dòng | SQL aggregate + LIMIT 100 |
| Agent sau thiếu context | Đọc trực tiếp node nguồn bằng expression |
| Debug khó do cycle | Luồng tuyến tính, mỗi node chạy tối đa một lần |

---

## 16. Kế hoạch triển khai

1. Thêm `RCA Context Builder` sau `Agent 1 - Brief Writer`.
2. Sửa prompt Planner để bỏ hoàn toàn field `state`.
3. Thêm `Parse RCA Hypothesis` và nhánh kiểm tra `planner_valid`.
4. Sửa SQL Writer để đọc Context/Hypothesis bằng node reference và chỉ trả `sql`, `expected_signal`.
5. Sửa SQL Guardrail để không đọc/trả state; giảm limit xuống 100.
6. Gắn credential BigQuery cho `BigQuery Execute RCA` và bật `Continue Regular Output` khi lỗi.
7. Sửa Aggregate/Evaluator để dùng node reference.
8. Xóa cycle và bốn node state/loop không còn dùng.
9. Thêm Failure Output cho Planner/Guardrail/BigQuery.
10. Sửa Finalizer và Action Advisor theo schema mới.
11. Test bốn tình huống ở §17 trước khi thay JSON production.

---

## 17. Test bắt buộc

### Test 1 — Có warning và query có dữ liệu

Kỳ vọng:

- Planner trả đúng một hypothesis;
- SQL hợp lệ, chỉ chạy một lần;
- Evaluator trả `supported` hoặc `not_supported`;
- output có hypothesis, finding, evidence, confidence;
- Advisor đưa tối đa 3 hành động phù hợp.

### Test 2 — SQL bị guardrail chặn

Dùng SQL test có `DELETE` hoặc thiếu `LIMIT`.

Kỳ vọng:

- BigQuery không chạy;
- output vẫn xuất hiện với `status=query_blocked`;
- `next_check` chứa lý do guardrail;
- workflow vẫn đi tới Assemble Brief.

### Test 3 — BigQuery trả 0 dòng

Kỳ vọng:

- Evaluator trả `insufficient_data` hoặc `not_supported`;
- không bịa evidence;
- Advisor đề xuất bước kiểm tra tiếp.

### Test 4 — Planner hoặc Evaluator trả JSON lỗi

Kỳ vọng:

- Code parser tạo fallback;
- workflow không dừng;
- `🔍 AI ANALYZE` vẫn có dòng “Chưa đủ dữ liệu để xác định nguyên nhân”.

---

## 18. Tiêu chí hoàn thành

- Không còn chuỗi `"state": <chép nguyên input state>` trong bất kỳ prompt RCA nào.
- Không còn connection cycle quay về Planner.
- Mỗi execution RCA chạy tối đa một query BigQuery.
- Planner output không vượt 120 từ.
- SQL Writer output chỉ có `sql` và `expected_signal`.
- Evaluator output đúng schema cố định.
- Mọi nhánh lỗi đều đến được `RCA Finalizer` hoặc output tương đương.
- `Assemble Brief` luôn có khối `🔍 AI ANALYZE`, kể cả khi RCA không đủ dữ liệu.
- Tổng token RCA không tăng theo số vòng hoặc kích thước history.
