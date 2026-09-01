# Kế hoạch: Root Cause Analysis dạng vòng lặp (thay cho BigQuery Tool)

> **Bối cảnh:** node `n8n-nodes-base.googleBigQueryTool` (gắn trực tiếp BigQuery làm tool cho AI Agent, như thiết kế ở `Daily-5-Minutes-Brief_v1.workflow.json`) **không tồn tại** trong n8n instance thực tế đang dùng — báo lỗi "Install this node to use it... This node is not currently installed". Cần kiến trúc khác cho khối 🔍 AI ANALYZE, không phụ thuộc node này.
>
> **Trạng thái cập nhật 2026-08-30:** đã build vào [`workflow/Daily-5-Minutes-Brief_v1.2_RCA.workflow.json`](workflow/Daily-5-Minutes-Brief_v1.2_RCA.workflow.json). Bản `v1.1_MVP` vẫn được giữ làm phương án không RCA.

---

## 1. Vì sao không dùng "AI Agent + Tool" như bản v1

Cách "đúng bài" nhất để giữ nguyên ý tưởng "1 agent tự nghĩ → tự query → tự đọc kết quả" là dùng AI Agent node (tool-calling) gắn 1 tool BigQuery. Nhưng:

- `googleBigQueryTool` không có sẵn (đã xác nhận qua lỗi).
- Phương án thay thế "tool tự chế" — dùng `@n8n/n8n-nodes-langchain.toolHttpRequest` gọi thẳng BigQuery REST API (`POST .../bigquery/v2/projects/tmdatabase/queries`) rồi gắn làm tool cho Agent — **vẫn chưa chắc chắn** node `toolHttpRequest` có trong bản n8n bạn đang dùng, và cách này còn phải tự lo refresh OAuth token trong header thay vì dùng credential BigQuery có sẵn của node BigQuery thường (phức tạp, thêm 1 điểm dễ vỡ).

→ Chọn hướng bạn đề xuất: build vòng lặp **thủ công** bằng node LLM thường + node BigQuery thường (không phải "tool") + node Code + node IF. Toàn bộ node type này chắc chắn có sẵn trong mọi bản n8n cơ bản, rủi ro import gần như bằng 0.

---

## 2. Kiến trúc đề xuất — 3 vai trò + vòng lặp

Đổi tên 3 vai trò để khỏi trùng với 3 AI Agent cấp ngoài (Agent 1 Brief Writer / Agent 2 Root Cause Analyst / Agent 3 Action Advisor) — coi đây là **cấu trúc con bên trong** vai trò "Agent 2 — Root Cause Analyst":

| Vai trò | Loại node | Việc làm |
|---|---|---|
| **RCA Planner** | LLM thường (Basic LLM Chain / OpenAI Chat, KHÔNG tool) | Đọc brief Agent 1 + `warnings` (Q5) + lịch sử các vòng trước. Ra 1 giả thuyết cụ thể cần kiểm chứng ở vòng này, mô tả bằng ngôn ngữ tự nhiên — **không phải SQL** |
| **RCA SQL Writer** | LLM thường | Nhận mô tả từ Planner + danh sách bảng/cột được phép (xem §3), viết ra **đúng 1 câu SQL SELECT** |
| **SQL Guardrail** | Code node (không LLM) | Kiểm tra câu SQL: bắt đầu bằng `SELECT` hoặc `WITH`, không chứa từ khóa ghi/xóa, không có nhiều statement/`SELECT *`, chỉ đọc bảng trong allowlist và có `LIMIT ≤ 200`. Fail → không chạy, đánh dấu lỗi |
| **BigQuery Execute** | Google BigQuery node thường (Execute Query) | Chạy câu SQL đã qua guardrail |
| **RCA Evaluator** | LLM thường | Đọc kết quả BigQuery vừa chạy + lịch sử. Trả JSON: `{ finding, continue, reason }` |
| **Loop Controller** | IF node | `continue = true` VÀ `iteration < max_loops` → quay lại **RCA Planner** (vòng mới). Ngược lại → thoát loop, gộp `history[].finding` thành text 🔍 AI ANALYZE |

```
RCA Planner → RCA SQL Writer → SQL Guardrail → BigQuery Execute → RCA Evaluator → Loop Controller (IF)
     ▲                                                                                    │
     └────────────────────────── continue=true & iteration<max_loops ─────────────────────┘
                                                                                            │ (else)
                                                                                            ▼
                                                                              Gộp history → 🔍 AI ANALYZE
```

n8n hỗ trợ vòng lặp kiểu này bằng cách nối thẳng output IF (nhánh true) ngược về node Planner — tạo 1 cycle trong đồ thị workflow, đây là pattern quen thuộc cho retry/loop trong n8n, không cần node đặc biệt nào khác.

---

## 3. Phạm vi bảng/cột được phép (giữ nguyên từ SPEC §9.2, không đổi)

```
deals (qua join dim_course inline, xem PLAN này không đổi logic chuẩn hoá — vẫn dùng course_key_norm/course_name_norm/course_type_norm như SPEC)
stages(stage_id, name, pipeline_id, order_nr)
pipelines(pipeline_id, name)
deal_activities(deal_id, user_id, type, created_at, ...) -- PHẢI aggregate theo deal_id trước khi JOIN
```

Khi phân tích deal LOST: đọc thêm `failed_content`, `failed_reason_id`. Không được nhắc Revenue/doanh thu trong kết luận (theo quyết định đã chốt).

---

## 4. Trạng thái mang theo qua mỗi vòng (accumulator)

n8n không có biến toàn cục giữa các lần chạy node trong loop — mọi state phải nằm trong chính item JSON, mỗi node đọc vào rồi truyền tiếp:

```json
{
  "iteration": 2,
  "max_loops": 3,
  "should_continue": true,
  "history": [
    {
      "hypothesis": "Digital Performance tut lead co the do campaign fb_dp_* bi tat ngan sach",
      "sql": "SELECT ...",
      "sql_valid": true,
      "result_rows": [ { "...": "..." } ],
      "finding": "Chua ket luan duoc vi ...",
      "continue": true,
      "reason": "Can kiem tra them stage_name de biet tac o dau"
    }
  ]
}
```

---

## 5. Điều kiện dừng vòng lặp (OR — bất kỳ điều kiện nào đúng là dừng)

1. `iteration >= max_loops` — chặn cứng an toàn, **đề xuất mặc định 3** theo gợi ý của bạn (đổi được ở `Config.thresholds.rca_max_loops`). Lưu ý: đây là giảm đáng kể so với "tối đa 12 query" ở thiết kế BigQuery Tool cũ — đổi lấy việc kiểm soát vòng lặp thủ công chắc chắn không chạy vô hạn.
2. `RCA Evaluator` trả `continue = false` (đã đủ dữ liệu kết luận).
3. **Đề xuất thêm:** `SQL Guardrail` fail 2 lần liên tiếp trong cùng 1 lần chạy brief → dừng loop, ghi nhận "chưa đủ dữ liệu để kết luận, cần kiểm tra thủ công" — tránh loop chạy hết `max_loops` một cách vô ích khi model liên tục viết SQL sai cú pháp/phạm vi.

---

## 6. Trạng thái triển khai

1. ✅ Prompt Planner / SQL Writer / Evaluator đã tách thành ba vai trò hẹp.
2. ✅ `SQL Guardrail` đã chặn query ghi/xóa, nhiều statement, bảng ngoài allowlist, `SELECT *` và `LIMIT > 200`.
3. ✅ Vòng lặp nối từ `Continue RCA?` về `RCA Planner`, tối đa 3 vòng; dừng sau 2 lỗi guardrail liên tiếp.
4. ✅ `rca_max_loops: 3` và `rca_max_rows: 200` đã thêm vào `Config`.
5. ✅ `RCA Finalizer` chỉ tổng hợp finding từ query hợp lệ thành khối 🔍 AI ANALYZE.
6. ✅ Agent 3 nhận root cause đã kiểm chứng để tạo tối đa 3 hành động.
7. ⏳ Cần import vào n8n, gắn credential BigQuery/OpenAI và chạy Manual Trigger để kiểm thử runtime thực tế.

---

## 7. Liên quan

- `Daily-5-Minutes-Brief_v1.workflow.json` — bản đầu, dùng kiến trúc AI Agent + BigQuery Tool, **đã xác nhận lỗi** (node không tồn tại) — không dùng nữa cho khối RCA.
- `Daily-5-Minutes-Brief_v1.1_MVP.workflow.json` — bản chạy được ngay, bỏ hẳn khối RCA, SQL sửa lại đúng schema thật (không phụ thuộc view `v_deal_enriched` chưa tồn tại).
- Khi kiến trúc ở file này được duyệt và build xong, dự kiến đặt tên `v1.2` (thêm khối RCA vào trên nền `v1.1_MVP`).
