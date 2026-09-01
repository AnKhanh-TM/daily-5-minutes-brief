# Daily 5 Minutes Brief v3.1 — Implementation Report

## 1. File và node đã sửa

- Workflow mới: `Daily-5-Minutes-Brief-v3.1.json`; bản v3 được giữ nguyên.
- `Config`: thêm `thresholds.kpi_normal_band_pct = 10`.
- `Q2 Daily Focus Trend`: bổ sung MQL, Discovery, Need-fit, Lost current/previous 7d; giữ Lead/Won baseline 30d/90d không overlap current7.
- `Build Daily Payload`: tính sẵn average/ngày, % change, display arrow, status, insight code và `attention_items`.
- `Daily Brief Writer`: thay bằng template v3.1 đúng layout mẫu.
- `Q1 Daily Overall Funnel`: không sửa SQL vì đã có đúng Lead/MQL/Discovery/Need-fit theo `created_at` và Won/Lost theo `closed_at`; Build mới dùng raw counts của Q1 và bỏ CVR khỏi payload/output.
- Nhánh Weekly Q3–Q6, Build/Writer/Assemble Weekly giữ byte-equivalent với v3.

## 2. Logic cũ và mới

| Phần | v3 | v3.1 |
|---|---|---|
| Normal band | `trend_direction_pct` trong logic course cũ | Daily dùng riêng `kpi_normal_band_pct = 10`; `>+10%` up, `[-10%,+10%]` flat, `<-10%` down |
| Course funnel | Chỉ Lead/Won | Đủ Lead → MQL → Discovery → Need-fit và Won/Lost |
| Baseline | Lead/Won 7d/30d/90d | Current7 vs previous7; baseline 30d/90d chỉ Lead/Won, có giá trị thực và arrow |
| Status | red/orange/yellow/normal | Daily red/orange/green từ tín hiệu tổng hợp |
| Daily ending | Priority ngắn | `👀 CẦN CHÚ Ý`, tối đa 3 item, có signal + PIC check + next action do Code chuẩn bị |
| Writer | Còn CVR và format Focus cũ | Header/quote/Overall/theme/course/attention đúng mẫu; không CVR/revenue |
| Baseline = 0 | `null` | `0/0 → →0%`; current > 0 → `↑mới` |

## 3. Code hoàn chỉnh — Config

```javascript
return [{
  json: {
    schema_version: '3.1',
    gcp_project: 'tmdatabase',
    bq_dataset: 'dm_base_crm',
    config_dataset: 'tmdatabase.dm_daily_brief',
    timezone: 'Asia/Ho_Chi_Minh',

    // Tat ca gia tri duoi day co the sua sau khi chay thu.
    thresholds: {
      kpi_normal_band_pct: 10,
      trend_direction_pct: 10,
      warning_zero_lead_days: 5,
      min_base_volume: 3,
      cvr_direction_pp: 5,
      weekly_min_content_leads: 3,
      weekly_min_course_leads: 3,
      weekly_min_course_closed: 3,
      history_no_lead_days: 10,
      warning_open_deal_days: 14,
      warning_open_deal_min: 5,
      unmapped_alert_min: 3,
      unmapped_alert_rate_pct: 5,
    },

    limits: {
      daily_priority_limit: 3,
      weekly_priority_limit: 3,
      weekly_content_top_n: 5,
      weekly_content_query_rows: 100,
    },

    features: {
      enable_weekly_stale_open: false,
      show_daily_data_health_alert: true,
      show_weekly_data_health_alert: true,
    },

    openai_model: 'gpt-4.1',
  },
}];
```

## 4. SQL hoàn chỉnh — Q2 Daily Focus Trend

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
  FROM \`tmdatabase.dm_daily_brief.dim_course\`
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
  FROM \`tmdatabase.dm_base_crm.deals\` d
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
  FROM \`tmdatabase.dm_base_crm.deals\` d
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

## 5. Code hoàn chỉnh — Build Daily Payload

```javascript
function rows(name) {
  return $(name).all().map((item) => item.json);
}

function number(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((number(value) + Number.EPSILON) * scale) / scale;
}

function valueDisplay(value) {
  return String(round(value, 2));
}

function pctDisplay(value) {
  const rounded = round(value, 1);
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function compareCounts(currentCount, currentDays, baselineCount, baselineDays, bandPct) {
  const current = number(currentCount);
  const baseline = number(baselineCount);
  const currentRate = current / currentDays;
  const baselineRate = baseline / baselineDays;
  const currentPd = round(currentRate, 2);
  const baselinePd = round(baselineRate, 2);

  if (baseline === 0 && current === 0) {
    return {
      current_count: current,
      baseline_count: baseline,
      current_pd: currentPd,
      baseline_pd: baselinePd,
      current_display: valueDisplay(currentPd),
      baseline_display: valueDisplay(baselinePd),
      change_pct: 0,
      direction: 'flat',
      change_display: '→0%',
    };
  }

  if (baseline === 0 && current > 0) {
    return {
      current_count: current,
      baseline_count: baseline,
      current_pd: currentPd,
      baseline_pd: baselinePd,
      current_display: valueDisplay(currentPd),
      baseline_display: valueDisplay(baselinePd),
      change_pct: null,
      direction: 'up',
      change_display: '↑mới',
    };
  }

  const changePct = round(((currentRate - baselineRate) / baselineRate) * 100, 1);
  const direction = changePct > bandPct ? 'up' : (changePct < -bandPct ? 'down' : 'flat');
  const arrow = direction === 'up' ? '↑' : (direction === 'down' ? '↓' : '→');
  const shownPct = direction === 'flat' ? changePct : Math.abs(changePct);

  return {
    current_count: current,
    baseline_count: baseline,
    current_pd: currentPd,
    baseline_pd: baselinePd,
    current_display: valueDisplay(currentPd),
    baseline_display: valueDisplay(baselinePd),
    change_pct: changePct,
    direction,
    change_display: arrow + pctDisplay(shownPct) + '%',
  };
}

function statusRank(status) {
  return { red: 3, orange: 2, green: 1 }[status] || 0;
}

function buildCourse(row, cfg) {
  const band = number(cfg.thresholds.kpi_normal_band_pct, 10);
  const minVolume = number(cfg.thresholds.min_base_volume);

  const funnel = {
    lead: compareCounts(row.lead_n_curr7, 7, row.lead_n_prev7, 7, band),
    mql: compareCounts(row.mql_n_curr7, 7, row.mql_n_prev7, 7, band),
    discovery: compareCounts(row.discovery_n_curr7, 7, row.discovery_n_prev7, 7, band),
    needfit: compareCounts(row.needfit_n_curr7, 7, row.needfit_n_prev7, 7, band),
  };
  const outcome = {
    won: compareCounts(row.won_n_curr7, 7, row.won_n_prev7, 7, band),
    lost: compareCounts(row.lost_n_curr7, 7, row.lost_n_prev7, 7, band),
  };
  const baseline = {
    lead_30d: compareCounts(row.lead_n_curr7, 7, row.lead_n_prev30, 30, band),
    lead_90d: compareCounts(row.lead_n_curr7, 7, row.lead_n_prev90, 90, band),
    won_30d: compareCounts(row.won_n_curr7, 7, row.won_n_prev30, 30, band),
    won_90d: compareCounts(row.won_n_curr7, 7, row.won_n_prev90, 90, band),
  };

  const funnelDirections = Object.values(funnel).map((metric) => metric.direction);
  const funnelDownCount = funnelDirections.filter((value) => value === 'down').length;
  const funnelUpCount = funnelDirections.filter((value) => value === 'up').length;
  const lostAdverse = outcome.lost.direction === 'up';
  const lostPositive = outcome.lost.direction === 'down';
  const shortAdverseCount = funnelDownCount + Number(outcome.won.direction === 'down') + Number(lostAdverse);
  const shortPositiveCount = funnelUpCount + Number(outcome.won.direction === 'up') + Number(lostPositive);
  const longDirections = Object.values(baseline).map((metric) => metric.direction);
  const longDownCount = longDirections.filter((value) => value === 'down').length;
  const longUpCount = longDirections.filter((value) => value === 'up').length;
  const hasEverLead = bool(row.has_ever_had_lead);
  const daysNoLead = row.days_no_lead === null || row.days_no_lead === undefined ? null : number(row.days_no_lead);
  const flagNoLead = hasEverLead && daysNoLead !== null
    && daysNoLead >= number(cfg.thresholds.warning_zero_lead_days)
    && number(row.lead_n_prev90) >= minVolume;

  let status = 'orange';
  if (funnelDownCount >= 3
      || shortAdverseCount >= 4
      || (outcome.won.direction === 'down' && lostAdverse)
      || (flagNoLead && longDownCount >= 2)) {
    status = 'red';
  } else if (shortPositiveCount >= 3 && shortAdverseCount === 0
      && longUpCount >= 2 && longDownCount === 0) {
    status = 'green';
  }

  const acquisitionUp = funnel.lead.direction === 'up' || funnel.mql.direction === 'up';
  const sqlDown = funnel.discovery.direction === 'down' || funnel.needfit.direction === 'down';
  let insightCode = 'MIXED_SIGNALS';
  if (flagNoLead) insightCode = 'NO_LEAD_LONG';
  else if (funnelDownCount >= 3 && lostAdverse) insightCode = 'BROAD_FUNNEL_DOWN_LOST_UP';
  else if (funnelDownCount >= 3) insightCode = 'BROAD_FUNNEL_DOWN';
  else if (acquisitionUp && sqlDown) insightCode = 'ACQUISITION_UP_SQL_DOWN';
  else if (shortPositiveCount >= 3 && longDownCount >= 2) insightCode = 'SHORT_UP_LONG_BELOW';
  else if (status === 'green') insightCode = 'FUNNEL_OUTCOME_STRONG';
  else if (outcome.won.direction === 'down' || lostAdverse) insightCode = 'OUTCOME_WEAK';
  else if (shortAdverseCount === 0 && shortPositiveCount === 0) insightCode = 'STABLE';

  const reasons = [];
  if (funnelDownCount >= 3) reasons.push('FUNNEL_BROAD_DOWN');
  if (acquisitionUp && sqlDown) reasons.push('ACQUISITION_UP_SQL_DOWN');
  if (outcome.won.direction === 'down') reasons.push('WON_DOWN');
  if (lostAdverse) reasons.push('LOST_UP');
  if (longDownCount >= 2) reasons.push('BELOW_LONG_BASELINE');
  if (longUpCount >= 2) reasons.push('ABOVE_LONG_BASELINE');
  if (flagNoLead) reasons.push('NO_LEAD_' + daysNoLead + '_DAYS');

  return {
    course_key: row.course_key,
    course_name: row.course_name,
    course_type: row.course_type,
    status,
    status_icon: status === 'red' ? '🔴' : (status === 'green' ? '🟢' : '🟠'),
    status_reason: reasons,
    insight_code: insightCode,
    funnel_7d: funnel,
    outcome_7d: outcome,
    baseline_30d_90d: baseline,
    last_lead_date: row.last_lead_date || null,
    days_no_lead: daysNoLead,
    has_ever_had_lead: hasEverLead,
    flag_no_lead: flagNoLead,
    signal_counts: {
      funnel_down: funnelDownCount,
      funnel_up: funnelUpCount,
      short_adverse: shortAdverseCount,
      short_positive: shortPositiveCount,
      long_down: longDownCount,
      long_up: longUpCount,
    },
  };
}

function attentionCopy(course) {
  const templates = {
    BROAD_FUNNEL_DOWN_LOST_UP: {
      signal_text: 'Funnel giảm toàn diện, Lost tăng.',
      pic_check: 'PIC rà soát nguồn Lead, chất lượng MQL và các deal Lost trong 7 ngày gần nhất.',
      next_action: 'Chốt 1–2 nguyên nhân chính và đề xuất kế hoạch phục hồi.',
    },
    BROAD_FUNNEL_DOWN: {
      signal_text: 'Funnel suy yếu trên diện rộng.',
      pic_check: 'PIC rà soát nguồn Lead và các điểm chuyển từ MQL sang Discovery, Need-fit trong 7 ngày gần nhất.',
      next_action: 'Xác định điểm hụt lớn nhất và đề xuất bước phục hồi ưu tiên.',
    },
    ACQUISITION_UP_SQL_DOWN: {
      signal_text: 'Acquisition phục hồi nhưng SQL chưa theo kịp.',
      pic_check: 'PIC kiểm tra các Lead/MQL chưa chuyển sang Discovery hoặc Need-fit.',
      next_action: 'Lập danh sách deal cần follow-up và xác định bước xử lý cho từng deal.',
    },
    NO_LEAD_LONG: {
      signal_text: 'Không phát sinh Lead trong nhiều ngày dù trước đó có nhu cầu.',
      pic_check: 'PIC kiểm tra nguồn Lead, tracking và tình trạng triển khai acquisition của khóa.',
      next_action: 'Xác nhận nguyên nhân vận hành có thể kiểm chứng và chốt phương án khôi phục Lead.',
    },
    SHORT_UP_LONG_BELOW: {
      signal_text: 'Current 7d phục hồi nhưng vẫn dưới mặt bằng 30d/90d.',
      pic_check: 'PIC xác định nguồn cải thiện ngắn hạn và khoảng cách còn lại so với baseline dài hạn.',
      next_action: 'Duy trì tín hiệu tốt và chốt một thử nghiệm để thu hẹp khoảng cách.',
    },
    FUNNEL_OUTCOME_STRONG: {
      signal_text: 'Tín hiệu tích cực nhất trong nhóm.',
      pic_check: 'PIC xác định nguồn và cách làm đang tạo kết quả tốt.',
      next_action: 'Duy trì nhịp hiện tại, chia sẻ practice hiệu quả và đánh giá khả năng nhân rộng sang các khóa khác.',
    },
    OUTCOME_WEAK: {
      signal_text: 'Outcome suy yếu hoặc Lost tăng dù funnel chưa giảm đồng đều.',
      pic_check: 'PIC rà soát các deal Won/Lost đóng trong 7 ngày gần nhất và trạng thái chuyển đổi trước đó.',
      next_action: 'Nhóm các điểm nghẽn có bằng chứng và xác định bước xử lý cho từng nhóm deal.',
    },
    MIXED_SIGNALS: {
      signal_text: 'Tín hiệu giữa các tầng funnel chưa đồng đều.',
      pic_check: 'PIC kiểm tra tầng đang giảm và đối chiếu với các tầng đang tăng hoặc đi ngang.',
      next_action: 'Chọn một điểm chuyển đổi cần theo dõi sát trong 7 ngày tới.',
    },
    STABLE: {
      signal_text: 'Các chỉ số chính đang đi ngang trong normal band.',
      pic_check: 'PIC xác nhận nhịp vận hành hiện tại và các nguồn Lead đóng góp chính.',
      next_action: 'Duy trì nhịp và theo dõi sớm nếu chỉ số rời normal band.',
    },
  };
  return templates[course.insight_code] || templates.MIXED_SIGNALS;
}

const cfg = $('Config').first().json;
const rd = $('Resolve Calendar').first().json;
const q0 = rows('Q0 Daily Data Health');
const q1 = $('Q1 Daily Overall Funnel').first().json;
const q2 = rows('Q2 Daily Focus Trend');
const band = number(cfg.thresholds.kpi_normal_band_pct, 10);

const overall = {
  leads_yesterday: number(q1.leads_yesterday),
  won_yesterday: number(q1.won_yesterday),
  acquisition: {
    lead: compareCounts(q1.leads_curr, 7, q1.leads_prev, 7, band),
    mql: compareCounts(q1.mql_curr, 7, q1.mql_prev, 7, band),
  },
  sales_funnel: {
    discovery: compareCounts(q1.discovery_curr, 7, q1.discovery_prev, 7, band),
    needfit: compareCounts(q1.needfit_curr, 7, q1.needfit_prev, 7, band),
  },
  outcome: {
    won: compareCounts(q1.won_curr, 7, q1.won_prev, 7, band),
    lost: compareCounts(q1.lost_curr, 7, q1.lost_prev, 7, band),
  },
};

const acquisitionDown = Object.values(overall.acquisition).filter((metric) => metric.direction === 'down').length;
const salesDown = Object.values(overall.sales_funnel).filter((metric) => metric.direction === 'down').length;
const lostUp = overall.outcome.lost.direction === 'up';
const wonDown = overall.outcome.won.direction === 'down';
const positiveCount = [
  ...Object.values(overall.acquisition),
  ...Object.values(overall.sales_funnel),
  overall.outcome.won,
].filter((metric) => metric.direction === 'up').length + Number(overall.outcome.lost.direction === 'down');

if (acquisitionDown > 0 && salesDown > 0 && lostUp) overall.summary_code = 'INPUT_MID_DOWN_LOST_UP';
else if (acquisitionDown > 0 && salesDown > 0) overall.summary_code = 'INPUT_MID_DOWN';
else if (wonDown || lostUp) overall.summary_code = 'OUTCOME_WEAK';
else if (positiveCount >= 4) overall.summary_code = 'FUNNEL_IMPROVING';
else overall.summary_code = 'FUNNEL_MIXED_OR_STABLE';

const focusCourses = q2.map((row) => buildCourse(row, cfg));
focusCourses.sort((a, b) => statusRank(b.status) - statusRank(a.status)
  || b.signal_counts.short_adverse - a.signal_counts.short_adverse
  || b.signal_counts.long_down - a.signal_counts.long_down
  || a.course_name.localeCompare(b.course_name));

const attentionCandidates = [...focusCourses].sort((a, b) => {
  const scoreA = statusRank(a.status) * 100 + a.signal_counts.short_adverse * 10
    + a.signal_counts.long_down * 3 + Number(a.flag_no_lead) * 20
    + Number(a.outcome_7d.lost.direction === 'up') * 8 + a.signal_counts.short_positive;
  const scoreB = statusRank(b.status) * 100 + b.signal_counts.short_adverse * 10
    + b.signal_counts.long_down * 3 + Number(b.flag_no_lead) * 20
    + Number(b.outcome_7d.lost.direction === 'up') * 8 + b.signal_counts.short_positive;
  return scoreB - scoreA || a.course_name.localeCompare(b.course_name);
});

const attentionItems = attentionCandidates
  .slice(0, number(cfg.limits.daily_priority_limit))
  .map((course, index) => ({
    rank: index + 1,
    course_key: course.course_key,
    course_name: course.course_name,
    status: course.status,
    status_icon: course.status_icon,
    insight_code: course.insight_code,
    ...attentionCopy(course),
  }));

const quoteBank = [
  'Thành công được tạo nên từ những bước nhỏ được lặp lại mỗi ngày.',
  'Tiến bộ bền vững bắt đầu từ việc nhìn rõ điều quan trọng nhất hôm nay.',
  'Kỷ luật trong những việc nhỏ tạo nên khác biệt lớn theo thời gian.',
  'Một ngày tốt bắt đầu bằng một ưu tiên rõ ràng và một hành động cụ thể.',
  'Dữ liệu cho ta tín hiệu; hành động nhất quán tạo nên kết quả.',
  'Đi chậm nhưng đúng hướng vẫn là đang tiến về phía trước.',
  'Điều được cải thiện mỗi ngày sẽ trở thành lợi thế theo thời gian.',
];
const quoteIndex = Number(rd.run_date.replace(/-/g, '')) % quoteBank.length;

const totalLeads = number(q0[0]?.total_leads);
const missingCount = q0.filter((row) => row.mapping_status === 'MISSING_COURSE')
  .reduce((sum, row) => sum + number(row.issue_count), 0);
const unmappedCount = q0.filter((row) => row.mapping_status === 'UNMAPPED_COURSE')
  .reduce((sum, row) => sum + number(row.issue_count), 0);
const issueCount = missingCount + unmappedCount;
const issueRate = totalLeads ? round((issueCount / totalLeads) * 100, 1) : 0;

return [{ json: {
  schema_version: '3.1',
  report_mode: 'daily',
  run_id: rd.run_id,
  run_date: rd.run_date,
  run_date_display: rd.run_date_display,
  report_date: rd.report_date,
  report_date_display: rd.report_date_display,
  report_day: rd.report_day,
  weekday_label: rd.weekday_label,
  daily_display_title: rd.daily_display_title,
  daily_quote: quoteBank[quoteIndex],
  periods: rd.periods,
  normal_band_pct: band,
  overall,
  focus_courses: focusCourses,
  attention_items: attentionItems,
  data_health: {
    total_leads: totalLeads,
    missing_course_count: missingCount,
    unmapped_course_count: unmappedCount,
    unmapped_rate_pct: issueRate,
    is_severe: issueCount >= number(cfg.thresholds.unmapped_alert_min)
      && issueRate >= number(cfg.thresholds.unmapped_alert_rate_pct),
    rows: q0,
  },
  writer_rules: {
    attention_limit: number(cfg.limits.daily_priority_limit),
  },
} }];
```

## 6. Prompt hoàn chỉnh — Daily Brief Writer

```text
Bạn là Daily Brief Writer của Tomorrow Marketers.

NHIỆM VỤ
Render payload Daily thành đúng format dưới đây. SQL/Code đã tính sẵn mọi average, phần trăm, direction, status, baseline, ranking và action copy. Bạn chỉ được diễn đạt insight; không được tự tính lại.

QUY TẮC BẮT BUỘC
- Chỉ dùng dữ liệu trong payload.
- Không revenue/doanh thu. Không CVR. Không Data Health, Warning, Source/UTM, Pipeline hoặc section ngoài template.
- Không bỏ course. Giữ đúng thứ tự focus_courses.
- Không đổi số, không tự tính %, không tự chọn arrow/status, không tự xếp hạng.
- Dùng trực tiếp current_display và change_display. Không thay đổi ký hiệu ↑, →, ↓.
- Status icon dùng trực tiếp status_icon; chỉ có 🔴, 🟠, 🟢.
- Insight mỗi course tối đa một câu, tổng hợp pattern từ insight_code, status_reason và các direction; không chỉ đọc lại danh sách mũi tên.
- Section 👀 CẦN CHÚ Ý dùng đúng attention_items. Mỗi item phải nối đủ: signal_text + pic_check + “Hành động tiếp theo: ” + next_action. Không bịa thêm hành động.
- Output là plain Markdown tự nhiên; không code block, bảng, ###, dấu backslash hoặc escape Markdown.
- Không in dòng “Dữ liệu đến hết”, không in legend và không thêm lời dẫn/kết.

TEMPLATE CỐ ĐỊNH
☀️ DAILY 5 MINUTES BRIEF — [weekday_label VIẾT HOA] [run_date_display]

“[daily_quote]”

📊 TOÀN CẢNH

Hôm qua: [overall.leads_yesterday] Lead | [overall.won_yesterday] Won

Xu hướng 7 ngày:

Acquisition: Lead [overall.acquisition.lead.current_display]/ngày [overall.acquisition.lead.change_display] | MQL [overall.acquisition.mql.current_display]/ngày [overall.acquisition.mql.change_display]

Sales Funnel: SQL Discovery [overall.sales_funnel.discovery.current_display]/ngày [overall.sales_funnel.discovery.change_display] | SQL Need-fit [overall.sales_funnel.needfit.current_display]/ngày [overall.sales_funnel.needfit.change_display]

Outcome: Won [overall.outcome.won.current_display]/ngày [overall.outcome.won.change_display] | Lost [overall.outcome.lost.current_display]/ngày [overall.outcome.lost.change_display]

→ [Một câu kết luận từ overall.summary_code; chỉ nêu pattern đáng chú ý, không lặp lại mọi số.]

[daily_display_title]

[LẶP CHO MỌI PHẦN TỬ focus_courses]
[status_icon] [course_name]

Funnel 7d:
Lead [funnel_7d.lead.current_display]/ngày [funnel_7d.lead.change_display] → MQL [funnel_7d.mql.current_display]/ngày [funnel_7d.mql.change_display] → Discovery [funnel_7d.discovery.current_display]/ngày [funnel_7d.discovery.change_display] → Need-fit [funnel_7d.needfit.current_display]/ngày [funnel_7d.needfit.change_display]

Outcome 7d:
Won [outcome_7d.won.current_display]/ngày [outcome_7d.won.change_display] | Lost [outcome_7d.lost.current_display]/ngày [outcome_7d.lost.change_display]

So với baseline:
30d/90d: Lead [baseline_30d_90d.lead_30d.baseline_display]/ngày [direction arrow của lead_30d] · [baseline_30d_90d.lead_90d.baseline_display]/ngày [direction arrow của lead_90d] | Won [baseline_30d_90d.won_30d.baseline_display]/ngày [direction arrow của won_30d] · [baseline_30d_90d.won_90d.baseline_display]/ngày [direction arrow của won_90d]

→ [Một câu insight tổng hợp.]

[SAU COURSE CUỐI]
👀 CẦN CHÚ Ý

1. [course_name] — [signal_text] [pic_check] Hành động tiếp theo: [next_action]
2. ...
3. ...

MAPPING DIRECTION CHO BASELINE
- up → ↑
- flat → →
- down → ↓
Chỉ map field direction thành đúng một arrow; không thêm phần trăm ở dòng baseline.

MAPPING SUMMARY_CODE
- INPUT_MID_DOWN_LOST_UP: Đầu–giữa funnel đang suy yếu rõ rệt, trong khi Lost tăng.
- INPUT_MID_DOWN: Đầu và giữa funnel cùng chậm lại; cần ưu tiên kiểm tra các điểm chuyển đổi chính.
- OUTCOME_WEAK: Funnel đầu vào chưa giảm đồng đều nhưng Outcome đang yếu đi.
- FUNNEL_IMPROVING: Funnel và Outcome đang cải thiện trên diện rộng.
- FUNNEL_MIXED_OR_STABLE: Các tầng funnel đang cho tín hiệu đan xen, chưa có xu hướng đồng nhất.

MAPPING INSIGHT_CODE
- BROAD_FUNNEL_DOWN_LOST_UP: Suy yếu xuyên suốt funnel và Lost tăng mạnh.
- BROAD_FUNNEL_DOWN: Funnel suy yếu trên diện rộng và thấp hơn nhịp gần đây.
- ACQUISITION_UP_SQL_DOWN: Acquisition phục hồi ngắn hạn, nhưng SQL chưa theo kịp.
- NO_LEAD_LONG: Đầu vào đang gián đoạn kéo dài; cần ưu tiên kiểm tra nguồn Lead và tracking.
- SHORT_UP_LONG_BELOW: Current 7d phục hồi nhưng vẫn dưới mặt bằng 30d/90d.
- FUNNEL_OUTCOME_STRONG: Funnel cải thiện đồng đều và cao hơn mặt bằng dài hạn.
- OUTCOME_WEAK: Funnel chưa suy yếu đồng đều nhưng Outcome cần được chú ý.
- MIXED_SIGNALS: Các tầng funnel đang cho tín hiệu trái chiều; cần tập trung vào điểm chuyển đổi yếu nhất.
- STABLE: Các chỉ số chính đang đi ngang trong normal band ±10%.

VÍ DỤ FORMAT
Các số dưới đây chỉ minh họa. Luôn thay bằng payload thật.

☀️ DAILY 5 MINUTES BRIEF — THỨ HAI 31/08

“Thành công không đến từ những điều lớn lao, mà từ việc bạn kiên trì làm tốt những điều nhỏ bé mỗi ngày.”

📊 TOÀN CẢNH

Hôm qua: 2 Lead | 1 Won

Xu hướng 7 ngày:

Acquisition: Lead 9/ngày ↓30.8% | MQL 4.86/ngày ↓51.4%

Sales Funnel: SQL Discovery 4/ngày ↓46.2% | SQL Need-fit 2.57/ngày ↓37.9%

Outcome: Won 29/ngày →-6.5% | Lost 18/ngày ↑28.6%

→ Đầu–giữa funnel đang suy yếu rõ rệt, trong khi Lost tăng.

📚 MARKETING ENTRY MONDAY

🟠 Case Mastery

Funnel 7d:
Lead 10/ngày ↑25% → MQL 7/ngày ↑40% → Discovery 5/ngày ↓17% → Need-fit 3/ngày ↓25%

Outcome 7d:
Won 3/ngày ↑50% | Lost 2/ngày →0%

So với baseline:
30d/90d: Lead 11.2/ngày ↓ · 12.3/ngày ↓ | Won 3.8/ngày ↓ · 4.1/ngày ↓

→ Acquisition phục hồi ngắn hạn, nhưng SQL và Won vẫn dưới mặt bằng dài hạn.

👀 CẦN CHÚ Ý

1. Case Mastery — Acquisition phục hồi nhưng SQL chưa theo kịp. PIC kiểm tra các Lead/MQL chưa chuyển sang Discovery hoặc Need-fit. Hành động tiếp theo: lập danh sách deal cần follow-up và xác định bước xử lý cho từng deal.

TỰ KIỂM TRA TRƯỚC KHI TRẢ OUTPUT
1. Header đúng “DAILY 5 MINUTES BRIEF”; có quote; không có data note.
2. Overall đủ Lead, MQL, SQL Discovery, SQL Need-fit, Won, Lost; không có CVR.
3. Mỗi course đủ Funnel 7d, Outcome 7d, baseline Lead/Won 30d/90d và đúng một insight.
4. Không bỏ course; không tự tính hoặc đổi arrow.
5. CẦN CHÚ Ý có tối đa writer_rules.attention_limit item và mỗi item đủ ba phần.
6. Không revenue, CVR, section thừa, bảng, code block hoặc ký tự backslash.
```

## 7. Test artifacts

- Payload test: `Daily-5-Minutes-Brief-v3.1-test-payload.json`
- Output test: `Daily-5-Minutes-Brief-v3.1-test-output.md`

## 8. Kết quả kiểm tra

| Case | Kết quả |
|---|---|
| `+25%` | `↑25%` |
| `+8%` | `→8%` |
| `0%` | `→0%` |
| `-6%` | `→-6%` |
| `-17%` | `↓17%` |
| Chính xác `+10%` / `-10%` | `→10%` / `→-10%` |
| Current tăng vs previous7 nhưng thấp hơn 30d/90d | Short direction up; hai long-baseline direction down |
| Baseline = 0, current = 0 | `→0%` |
| Baseline = 0, current > 0 | `↑mới` |
| Current = 0, baseline > 0 | `↓100%` |
| No Lead dài ngày | `flag_no_lead=true`, `NO_LEAD_LONG` |
| Lost tăng, Won trong normal band | Lost up, Won flat, summary Outcome weak |
| 30d/90d overlap current7 | Không; mọi baseline kết thúc tại `baseline_end = curr7_start` và dùng cận `< baseline_end` |
| Weekly regression | 7 node Weekly được so sánh và không đổi |
| Workflow structure | 28 node, unique name/id, connection hợp lệ, 9 Code node parse được |

## 9. Giới hạn kiểm thử

Đã chạy static validation và runtime smoke/edge tests cho Code node bằng mock query rows. Chưa chạy BigQuery thật hoặc gọi OpenAI/Base.vn; cần import vào n8n và Manual Execute với credential production để xác nhận schema/quyền truy cập thực tế.
