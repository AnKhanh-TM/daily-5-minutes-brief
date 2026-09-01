const fs = require('fs');
const path = require('path');
const root = __dirname;
const workflowPath = path.join(root, 'workflow', 'Daily-5-Minutes-Brief-v3.2.json');
const previousPath = path.join(root, 'workflow', 'Daily-5-Minutes-Brief-v3.1.json');
const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const previous = JSON.parse(fs.readFileSync(previousPath, 'utf8'));
const node = (wf, name) => wf.nodes.find((item) => item.name === name);
const cfg = new Function(node(workflow, 'Config').parameters.jsCode)()[0].json;
const rd = {
  run_id: 'smoke-v3.2',
  run_date: '2026-08-29',
  report_date: '2026-08-28',
  report_date_display: '28/08',
  week_label: '24/08–28/08',
  previous_week_label: '17/08–21/08',
  periods: {
    week_curr_start: '2026-08-24', week_curr_end: '2026-08-28',
    week_prev_start: '2026-08-17', week_prev_end: '2026-08-21',
  },
};
const q3 = {
  leads_curr: 54, leads_prev: 77, leads_pct_change: -29.9,
  mql_curr: 31, mql_prev: 61, mql_pct_change: -49.2,
  discovery_curr: 25, discovery_prev: 44, discovery_pct_change: -43.2,
  needfit_curr: 17, needfit_prev: 25, needfit_pct_change: -32,
  won_curr: 27, won_prev: 26, won_pct_change: 3.8,
  lost_curr: 64, lost_prev: 33, lost_pct_change: 93.9,
  cvr_curr: 29.7, cvr_prev: 44.1, cvr_change_pp: -14.4,
};
function course(course_name, values = {}) {
  return {
    course_key: course_name.toLowerCase(), course_name, course_type: 'test',
    leads_this_week: 0, leads_last_week: 0, won_this_week: 0, lost_this_week: 0,
    won_last_week: 0, lost_last_week: 0,
    lead_n_curr7: 0, lead_n_prev7: 0, lead_n_prev30: 0, lead_n_prev90: 0,
    won_n_curr7: 0, won_n_prev7: 0, won_n_prev30: 0, won_n_prev90: 0,
    last_lead_date: '2026-08-28', days_no_lead: 0, has_ever_had_lead: true,
    stale_open_deals: 0, ...values,
  };
}
const q4 = [
  course('Management Trainee', {leads_this_week:4,leads_last_week:3,won_this_week:2,lost_this_week:1,won_last_week:1,lead_n_curr7:6,lead_n_prev7:4,lead_n_prev30:16,lead_n_prev90:40,won_n_curr7:2,won_n_prev7:1,won_n_prev30:4,won_n_prev90:8}),
  course('Content Marketing', {leads_this_week:8,leads_last_week:4,won_this_week:1,lost_this_week:4,won_last_week:2,lead_n_curr7:8,lead_n_prev7:4,lead_n_prev30:15,lead_n_prev90:30,won_n_curr7:1,won_n_prev7:2,won_n_prev30:8,won_n_prev90:20}),
  course('Case Mastery', {leads_this_week:8,leads_last_week:6,won_this_week:1,lost_this_week:6,won_last_week:2,lead_n_curr7:8,lead_n_prev7:6,lead_n_prev30:22,lead_n_prev90:60,won_n_curr7:1,won_n_prev7:2,won_n_prev30:8,won_n_prev90:20}),
  course('Flexible Combo 2', {leads_this_week:0,leads_last_week:4,won_this_week:1,won_last_week:1,lead_n_curr7:0,lead_n_prev7:4,lead_n_prev30:10,lead_n_prev90:55,won_n_curr7:1,won_n_prev7:1,won_n_prev30:5,won_n_prev90:20,last_lead_date:'2026-08-21',days_no_lead:7}),
  course('Analytics for Strategy', {lead_n_curr7:0,lead_n_prev7:2,lead_n_prev30:8,lead_n_prev90:20,won_n_curr7:0,won_n_prev7:1,won_n_prev30:5,won_n_prev90:12,last_lead_date:'2026-08-17',days_no_lead:11}),
  course('Generative AI', {leads_this_week:1,leads_last_week:5,lead_n_curr7:1,lead_n_prev7:5,lead_n_prev30:15,lead_n_prev90:45,won_n_curr7:0,won_n_prev7:1,won_n_prev30:5,won_n_prev90:12,last_lead_date:'2026-08-16',days_no_lead:12}),
  course('Professional AI Program', {leads_this_week:0,leads_last_week:2,lead_n_curr7:0,lead_n_prev7:2,lead_n_prev30:9,lead_n_prev90:60,won_n_curr7:0,won_n_prev7:1,won_n_prev30:5,won_n_prev90:12,last_lead_date:'2026-08-20',days_no_lead:8}),
  course('Transform Org with AI', {leads_this_week:0,leads_last_week:3,lead_n_curr7:0,lead_n_prev7:3,lead_n_prev30:10,lead_n_prev90:60,won_n_curr7:0,won_n_prev7:1,won_n_prev30:5,won_n_prev90:12,last_lead_date:'2026-08-18',days_no_lead:10}),
  course('Strategy Formulation', {leads_this_week:0,leads_last_week:2,lead_n_curr7:0,lead_n_prev7:2,lead_n_prev30:8,lead_n_prev90:60,last_lead_date:'2026-08-19',days_no_lead:9}),
];
[
  ['Business Intelligence',198],['Brand Growth',129],['Python',85],['Flexible Combo 3',57],
  ['Performance Marketing',50],['Marketing Foundation',45],['Data Analysis',42],['AI Marketing',36],
  ['Digital Foundation',18],['Excel',15],
].forEach(([name,days]) => q4.push(course(name,{last_lead_date:'2026-01-01',days_no_lead:days})));
const q5 = [
  {utm_source:'Facebook CPC',utm_medium:'video',utm_campaign:'x',utm_content:'content-plan',utm_product:'Content Marketing',n_leads:4,n_won:0,n_lost:0,n_closed:0,cohort_cvr_pct:null,is_untracked:false},
  {utm_source:'Facebook Group BC',utm_medium:'tips_and_guide',utm_campaign:'x',utm_content:'tips_and_guide',utm_product:'Case Mastery',n_leads:3,n_won:1,n_lost:0,n_closed:1,cohort_cvr_pct:100,is_untracked:false},
  {utm_source:'Facebook Fanpage TM',utm_medium:'ai-tutorial',utm_campaign:'x',utm_content:'ai-tutorial',utm_product:'AI Marketing',n_leads:2,n_won:0,n_lost:0,n_closed:0,cohort_cvr_pct:null,is_untracked:false},
  {utm_source:'IG Social',utm_medium:'link_in_bio',utm_campaign:'x',utm_content:'link_in_bio',utm_product:'(not set)',n_leads:2,n_won:0,n_lost:0,n_closed:0,cohort_cvr_pct:null,is_untracked:false},
  {utm_source:'Facebook CPC',utm_medium:'countdown',utm_campaign:'x',utm_content:'countdown',utm_product:'Data Analysis',n_leads:1,n_won:1,n_lost:0,n_closed:1,cohort_cvr_pct:100,is_untracked:false},
];
const q6 = [{mapping_status:'OK',selected_course_raw:null,issue_count:0,total_leads:54,untracked_leads:26}];
const data = {
  Config:[cfg], 'Resolve Calendar':[rd], 'Q3 Weekly Overall Funnel':[q3],
  'Q4 Weekly Course Performance':q4, 'Q5 Weekly Content Performance':q5,
  'Q6 Weekly Data Health':q6,
};
const $ = (name) => ({
  all: () => data[name].map((json) => ({json})),
  first: () => ({json:data[name][0]}),
});
const result = new Function('$', node(workflow, 'Build Weekly Payload').parameters.jsCode)($)[0].json;
const wp = result.writer_payload;
function assert(ok, message) { if (!ok) throw new Error(message); }
assert(wp.schema_version === '3.2', 'schema version');
assert(wp.overall.acquisition.lead.display === '↓29.9%', 'Lead display');
assert(wp.overall.outcome.won.display === '→3.8%', 'Won display');
assert(wp.overall.outcome.cvr.display === '↓14.4 điểm %', 'CVR display');
const names = (group) => wp.course_performance[group].map((x) => x.course_name);
assert(names('good').includes('Management Trainee'), 'Management Trainee good');
assert(names('watch').includes('Content Marketing') && names('watch').includes('Case Mastery'), 'watch examples');
for (const name of ['Flexible Combo 2','Analytics for Strategy','Generative AI','Professional AI Program','Transform Org with AI']) assert(names('action_now').includes(name), name + ' action');
assert(!names('action_now').includes('Strategy Formulation'), 'Strategy only recent-zero');
assert(wp.lead_sources.top_by_leads[0].content === 'content-plan', 'top Lead');
assert(wp.lead_sources.top_by_won.length === 1 && wp.lead_sources.top_by_won[0].content === 'tips_and_guide', 'top Won');
assert(JSON.stringify(wp.no_lead.recent_zero.map(x=>x.course_name)) === JSON.stringify(['Flexible Combo 2','Professional AI Program','Strategy Formulation','Transform Org with AI']), 'recent-zero order');
assert(wp.no_lead.history[0].course_name === 'Business Intelligence', 'history sort');
assert(!('warnings' in wp) && !('display_courses' in wp), 'compact payload');
assert(node(workflow,'Weekly Brief Writer').parameters.text.includes('$json.writer_payload'), 'Writer compact expression');
assert(!node(workflow,'Weekly Brief Writer').parameters.text.includes('JSON.stringify($json) }'), 'Writer full expression removed');
const unchangedParameters = ['Sunday Message Writer','OpenAI Model - Sunday','Assemble Sunday','Q0 Daily Data Health','Q1 Daily Overall Funnel','Build Daily Payload','Assemble Daily'];
for (const name of unchangedParameters) {
  assert(JSON.stringify(node(workflow,name).parameters) === JSON.stringify(node(previous,name).parameters), name + ' parameter regression');
}
// Q2 Daily Focus Trend and Daily Brief Writer already differ between the supplied v3.2
// working file and the v3.1 backup; this Weekly-only change does not mutate them.
assert(node(workflow,'Q2 Daily Focus Trend') && node(workflow,'Daily Brief Writer'), 'Daily nodes present');
const fullChars = JSON.stringify(result).length;
const writerChars = JSON.stringify(wp).length;
const output = {
  full_chars: fullChars, writer_chars: writerChars,
  full_tokens_approx: Math.ceil(fullChars/4), writer_tokens_approx: Math.ceil(writerChars/4),
  reduction_pct: Math.round((1-writerChars/fullChars)*1000)/10,
  groups: {good:names('good'),watch:names('watch'),action_now:names('action_now')},
  recent_zero: wp.no_lead.recent_zero,
  history_total: wp.no_lead.history_total,
  top_by_leads: wp.lead_sources.top_by_leads,
  top_by_won: wp.lead_sources.top_by_won,
  daily_sunday_nodes_unchanged: true,
};
console.log(JSON.stringify(output,null,2));
