// Quality Control mode — a faithful port of qc-app_AOX's "Log Entry" page
// (Log QC Reject + Internal Remake), rendered into #panel-qc in the suite's
// native theme. Vanilla JS, mirroring src/caseflow/app.js: all inline on*
// handlers are namespaced under window.QCMODE so they never collide with the
// host app's globals. Writes the same Supabase tables as the qc-app (qc_logs,
// staged_cases) via ./data.js. See PRD_quality_control_mode.md.
import {
  REJECT_TYPES_BY_TEAM, DEFAULT_REJECT_TYPES, QC_REJECT_OPTIONS,
  DEPARTMENTS, TEAMS, TECHNICIANS_BY_TEAM, EXPERTS,
} from './constants.js';
import * as Data from './data.js';
import { can, CAPABILITIES } from '../permissions.js';
import './styles.css';

// Per-tab access. qc_tech sees only "QC Reject"; dept_lead sees only "Internal Remake";
// full-access roles (admin/manager/etc.) hold both caps and see both.
function canSeeTab(tab) {
  if (tab === 'qc') return can(CAPABILITIES.CASEFLOW_QC_REJECT);
  if (tab === 'ir') return can(CAPABILITIES.CASEFLOW_QC_REMAKE);
  return false;
}
// The first tab the current user is allowed to see (defaults to 'qc' if somehow neither).
function firstAllowedTab() {
  if (canSeeTab('qc')) return 'qc';
  if (canSeeTab('ir')) return 'ir';
  return 'qc';
}

// ── module state ────────────────────────────────────────────────────
const EMPTY_QC = { case_number: '', team: '', technician: '', qc_reject: 'ASAP(Same day)', reject_type: '', reject_details: '', ship_date: '' };
const EMPTY_IR = {
  case_number: '', department: '', logged_by: '',
  technician: '', issue_step: '',
  ship_date: '', dr_due_date: '',
  received_date: '', start_date: '', time_in_lab_days: null, total_invoice: null,
  description: '',
};

const state = {
  activeTab: 'qc',           // 'qc' | 'ir'
  // QC Reject
  step: 1,                   // 1 | 2 | 3
  qc: { ...EMPTY_QC },
  saving: false,
  drDueDate: '',
  staging: false,
  stagingDone: false,
  // Internal Remake
  ir: { ...EMPTY_IR },
  needsExpert: null,         // null | true | false
  irSaving: false,
  irDone: false,
  // Internal Remake case auto-lookup (populates ship/due/received/start/time-in-lab/invoice
  // + the "step where issue occurred" dropdown when the case number is entered).
  irSteps: [],               // [{ step, seq, start_date, finish_date, tech }]
  irLookupCase: '',          // the case number the current auto-fill came from
  irLookupLoading: false,
  irLookupStatus: '',        // '' | 'found' | 'notfound' | 'error'
  // Recent QC rejects table (QC Reject tab)
  recent: [],
  recentLoaded: false,
  // Recent internal remakes / MRB board (Internal Remake tab)
  recentMrb: [],
  recentMrbLoaded: false,
};

// ── helpers ─────────────────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function attr(s) { return esc(s).replace(/"/g, '&quot;'); }
function panel() { return document.getElementById('panel-qc'); }
let _toastT;
function toast(msg, kind) {
  const t = document.getElementById('toast'); if (!t) return;
  t.textContent = msg; t.className = 'toast shown ' + (kind || '');
  clearTimeout(_toastT); _toastT = setTimeout(() => t.classList.remove('shown'), 2800);
}
function fmtTs(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
}
function fmtDate(d) {
  if (!d) return '—';
  const p = String(d).slice(0, 10).split('-');
  return p.length === 3 ? p[1] + '/' + p[2] + '/' + p[0] : d;
}
function urgencyOpt(v) { return QC_REJECT_OPTIONS.find(o => o.value === v) || QC_REJECT_OPTIONS[1]; }
function optionList(arr, selected, placeholder) {
  return '<option value="">' + esc(placeholder) + '</option>' +
    arr.map(o => '<option value="' + attr(o) + '"' + (o === selected ? ' selected' : '') + '>' + esc(o) + '</option>').join('');
}

// ── public entry ────────────────────────────────────────────────────
export function renderQcMode() {
  // Land on a tab the user is allowed to see (e.g. dept_lead opens straight to Internal Remake).
  if (!canSeeTab(state.activeTab)) state.activeTab = firstAllowedTab();
  render();
  ensureRecentLoaded();
}

// Load whichever dashboard the active tab needs (lazily, once).
function ensureRecentLoaded() {
  if (state.activeTab === 'qc') { if (!state.recentLoaded) refreshRecent(); }
  else { if (!state.recentMrbLoaded) refreshMrb(); }
}

function render() {
  const el = panel(); if (!el) return;
  el.innerHTML =
    '<div class="qc-root" style="padding:18px 28px 40px">' +
      header() +
      '<div class="qc-body">' + (state.activeTab === 'qc' ? renderQcReject() : renderInternalRemake()) + '</div>' +
      recentTable() +
    '</div>';
  // Re-apply any in-progress form values the user had typed (survives reloads). The
  // synthetic input/change events keep state.f / state.ir in sync with the DOM.
  if (window.DraftGuard) window.DraftGuard.restore(el);
}

function header() {
  const tab = (key, label, sub) =>
    '<button class="qc-segtab' + (state.activeTab === key ? ' active' : '') + '" onclick="QCMODE.setTab(\'' + key + '\')">' +
      '<span class="qc-segtab-label">' + esc(label) + '</span>' +
      '<span class="qc-segtab-sub">' + esc(sub) + '</span>' +
    '</button>';
  // Only render the tab(s) this role may use. With a single visible tab the segmented control
  // collapses to one button (and the body always renders that allowed tab).
  const tabs = [];
  if (canSeeTab('qc')) tabs.push(tab('qc', 'QC Reject', 'ASAP · Repair · Remake'));
  if (canSeeTab('ir')) tabs.push(tab('ir', 'Internal Remake', 'Department leads'));
  return '<div class="qc-header">' +
    '<div class="qc-seg">' + tabs.join('') + '</div></div>';
}

// ── QC Reject (3-step) ──────────────────────────────────────────────
function renderQcReject() {
  if (state.step === 3) return qcStep3();
  const f = state.qc;
  const dots = [1, 2, 3].map(s => '<span class="qc-dot' + (state.step === s ? ' active' : (state.step > s ? ' done' : '')) + '"></span>').join('');
  let body = '';
  if (state.step === 1) {
    const techs = TECHNICIANS_BY_TEAM[f.team] || [];
    body =
      '<div class="cc-form-grid">' +
        '<div class="full"><label>Case Number <span class="req"></span></label>' +
          '<input id="qc-case" class="cc-input mono" type="text" placeholder="e.g. 2026-12345" value="' + attr(f.case_number) + '" oninput="QCMODE.setQc(\'case_number\', this.value)"></div>' +
        '<div><label>Department <span class="req"></span></label>' +
          '<select id="qc-team" class="cc-input" onchange="QCMODE.setTeam(this.value)">' + optionList(TEAMS, f.team, 'Select dept') + '</select></div>' +
        '<div><label>Technician <span class="req"></span></label>' +
          '<select id="qc-tech" class="cc-input"' + (f.team ? '' : ' disabled') + ' onchange="QCMODE.setQc(\'technician\', this.value)">' + optionList(techs, f.technician, f.team ? 'Select tech' : 'Select dept first') + '</select></div>' +
      '</div>';
  } else {
    const rejectTypes = REJECT_TYPES_BY_TEAM[f.team] || DEFAULT_REJECT_TYPES;
    const pills = QC_REJECT_OPTIONS.map(o => {
      const active = f.qc_reject === o.value;
      const st = active ? ('background:' + o.bg + ';color:' + o.color + ';box-shadow:0 0 0 2px ' + o.border) : '';
      return '<button class="qc-pill' + (active ? ' active' : '') + '" style="' + st + '" onclick="QCMODE.setQc(\'qc_reject\', \'' + attr(o.value) + '\')">' + esc(o.value) + '</button>';
    }).join('');
    body =
      '<div class="qc-summary"><strong>' + esc(f.case_number) + '</strong> · ' + esc(f.team) + ' · ' + esc(f.technician) + '</div>' +
      '<div class="cc-form-grid">' +
        '<div class="full"><label>Reject Urgency <span class="req"></span></label><div class="qc-pills">' + pills + '</div></div>' +
        '<div class="full"><label>Reject Type <span class="req"></span></label>' +
          '<select id="qc-rtype" class="cc-input" onchange="QCMODE.setQc(\'reject_type\', this.value)">' + optionList(rejectTypes, f.reject_type, 'Select reject type') + '</select></div>' +
        '<div class="full"><label>Details <span class="muted">(optional)</span></label>' +
          '<textarea id="qc-details" class="cc-input" rows="3" placeholder="Describe the issue…" oninput="QCMODE.setQc(\'reject_details\', this.value)">' + esc(f.reject_details) + '</textarea></div>' +
        '<div><label>Ship Date <span class="muted">(optional)</span></label>' +
          '<input id="qc-ship" class="cc-input" type="date" value="' + attr(f.ship_date) + '" oninput="QCMODE.setQc(\'ship_date\', this.value)"></div>' +
      '</div>';
  }

  const canNext = !!(f.case_number.trim() && f.team && f.technician);
  const canSubmit = canNext && !!f.reject_type;
  const footer = '<div class="qc-actions">' +
    (state.step === 2 ? '<button class="act" style="background:var(--slate)" onclick="QCMODE.setStep(1)">← Back</button>' : '') +
    (state.step === 1
      ? '<button class="act blue" ' + (canNext ? '' : 'disabled') + ' onclick="QCMODE.setStep(2)">Next →</button>'
      : '<button class="act blue" ' + (canSubmit && !state.saving ? '' : 'disabled') + ' onclick="QCMODE.submitQc()">' + (state.saving ? 'Saving…' : 'Submit ' + esc(f.qc_reject)) + '</button>') +
    '</div>';

  return '<div class="cc-form-card" style="max-width:none">' +
    '<div class="qc-dots">' + dots + '</div>' + body + footer + '</div>';
}

function qcStep3() {
  const f = state.qc;
  if (state.stagingDone) {
    return '<div class="cc-form-card" style="max-width:none;text-align:center">' +
      '<h3 style="margin:6px 0 8px;color:var(--blue)">Experts Notified</h3>' +
      '<p class="muted" style="margin:0 0 18px">Jeannette &amp; Ryan have been emailed about <strong>' + esc(f.case_number) + '</strong>.</p>' +
      '<button class="act blue" onclick="QCMODE.resetQc()">+ Log another case</button></div>';
  }
  return '<div class="cc-form-card" style="max-width:none">' +
    '<div style="text-align:center;margin-bottom:18px">' +
      '<h3 style="margin:0 0 4px">QC Reject Logged ✓</h3>' +
      '<p class="muted" style="margin:0"><strong>' + esc(f.case_number) + '</strong> · ' + esc(f.team) + ' · ' + esc(f.qc_reject) + '</p>' +
      '<p class="muted" style="margin:6px 0 0">Stage for Expert Review? (optional)</p>' +
    '</div>' +
    '<div class="cc-form-grid"><div class="full"><label>Doctor Due Date <span class="muted">(optional)</span></label>' +
      '<input id="qc-drdue" class="cc-input" type="date" value="' + attr(state.drDueDate) + '" oninput="QCMODE.setDrDue(this.value)"></div></div>' +
    '<p class="muted" style="text-align:center;font-size:12px;margin:10px 0 0">Jeannette Rubio &amp; Ryan Okon will both be notified</p>' +
    '<div class="qc-actions">' +
      '<button class="act" style="background:var(--slate)" onclick="QCMODE.resetQc()">Skip</button>' +
      '<button class="act blue" ' + (state.staging ? 'disabled' : '') + ' onclick="QCMODE.stage()">' + (state.staging ? 'Notifying…' : 'Notify Experts &amp; Stage') + '</button>' +
    '</div></div>';
}

// ── Internal Remake ─────────────────────────────────────────────────
function renderInternalRemake() {
  const f = state.ir;
  if (state.irDone) {
    const expert = state.needsExpert;
    return '<div class="cc-form-card" style="max-width:none;text-align:center">' +
      '<h3 style="margin:6px 0 6px">Internal Remake Logged</h3>' +
      '<p class="muted" style="margin:0 0 16px"><strong>' + esc(f.case_number) + '</strong> · ' + esc(f.department) + '</p>' +
      '<div class="qc-note ' + (expert ? 'qc-note-purple' : 'qc-note-green') + '">' +
        (expert
          ? '<strong>Action Required.</strong> Move the case to the <strong>Internal Remake — AOX Staging Rack</strong>. A Technical Expert will review it. Jeannette &amp; Ryan have been notified by email.'
          : '<strong>Next Step.</strong> Get the review from <strong>Final QC</strong>.') +
      '</div>' +
      '<button class="act blue" onclick="QCMODE.resetIr()" style="margin-top:16px">Log another internal remake</button></div>';
  }
  // The "step where issue occurred" is required only once the case's steps are loaded.
  const stepRequiredOk = state.irSteps.length === 0 || !!f.issue_step;
  const canSubmit = !!(f.case_number.trim() && f.department && f.logged_by.trim() && f.technician.trim() &&
    f.ship_date && f.dr_due_date && f.description.trim() && stepRequiredOk && state.needsExpert !== null);
  const yn = (val, label, sub) => {
    const a = state.needsExpert === val;
    return '<button class="qc-yn' + (a ? (val ? ' active-purple' : ' active-green') : '') + '" onclick="QCMODE.setNeedsExpert(' + val + ')">' +
      '<span class="qc-yn-label">' + label + '</span><span class="qc-yn-sub">' + sub + '</span></button>';
  };
  // Case-number lookup status line (auto-populate feedback).
  let lookupNote = '';
  if (state.irLookupLoading) lookupNote = '<div class="qc-lookup-note loading">Looking up case…</div>';
  else if (state.irLookupStatus === 'found') lookupNote = '<div class="qc-lookup-note ok">✓ Case found — dates, time in lab, invoice &amp; steps auto-filled below.</div>';
  else if (state.irLookupStatus === 'notfound') lookupNote = '<div class="qc-lookup-note warn">Case not found — enter the dates and step manually.</div>';
  else if (state.irLookupStatus === 'error') lookupNote = '<div class="qc-lookup-note warn">Couldn\'t load case details — enter manually.</div>';
  // "Step where issue occurred" options come from the case's Case Steps (workflow order).
  const stepPlaceholder = state.irLookupLoading ? 'Loading steps…'
    : (state.irSteps.length ? 'Select the step where the issue occurred' : 'Enter case number to load steps');
  const stepOptions = '<option value="">' + esc(stepPlaceholder) + '</option>' +
    state.irSteps.map(s => '<option value="' + attr(s.step) + '"' + (s.step === f.issue_step ? ' selected' : '') + '>' + esc(s.step) + '</option>').join('');
  // Read-only auto-populated displays.
  const tilStr = (f.time_in_lab_days == null) ? '' : (f.time_in_lab_days + ' day' + (f.time_in_lab_days === 1 ? '' : 's'));
  const invStr = (f.total_invoice == null) ? '' : ('$' + Number(f.total_invoice).toLocaleString('en-US', { maximumFractionDigits: 0 }));
  return '<div class="cc-form-card" style="max-width:none">' +
    '<div class="cc-form-grid">' +
      '<div class="full"><label>Case Number <span class="req"></span></label>' +
        '<input class="cc-input mono" data-draft="ir-casenum" type="text" placeholder="e.g. 2026-12345" value="' + attr(f.case_number) + '" oninput="QCMODE.setIr(\'case_number\', this.value)" onchange="QCMODE.lookupIrCase()">' + lookupNote + '</div>' +
      '<div><label>Department <span class="req"></span></label>' +
        '<select class="cc-input" onchange="QCMODE.setIr(\'department\', this.value)">' + optionList(DEPARTMENTS, f.department, 'Select dept') + '</select></div>' +
      '<div><label>Your Name <span class="req"></span></label>' +
        '<input class="cc-input" data-draft="ir-loggedby" type="text" placeholder="Your name" value="' + attr(f.logged_by) + '" oninput="QCMODE.setIr(\'logged_by\', this.value)"></div>' +
      '<div><label>Technician (worked on product) <span class="req"></span></label>' +
        '<input class="cc-input" data-draft="ir-tech" type="text" placeholder="Technician name" value="' + attr(f.technician) + '" oninput="QCMODE.setIr(\'technician\', this.value)"></div>' +
      '<div><label>Step where issue occurred' + (state.irSteps.length ? ' <span class="req"></span>' : '') + '</label>' +
        '<select class="cc-input"' + (state.irSteps.length ? '' : ' disabled') + ' onchange="QCMODE.setIr(\'issue_step\', this.value)">' + stepOptions + '</select></div>' +
      '<div><label>Ship Date <span class="req"></span></label>' +
        '<input class="cc-input" data-draft="ir-shipdate" type="date" value="' + attr(f.ship_date) + '" oninput="QCMODE.setIr(\'ship_date\', this.value)"></div>' +
      '<div><label>Doctor Due Date <span class="req"></span></label>' +
        '<input class="cc-input" data-draft="ir-drdue" type="date" value="' + attr(f.dr_due_date) + '" oninput="QCMODE.setIr(\'dr_due_date\', this.value)"></div>' +
      '<div><label>Received Date <span class="qc-auto">auto</span></label>' +
        '<input class="cc-input" type="date" value="' + attr(f.received_date) + '" readonly></div>' +
      '<div><label>Start Date <span class="qc-auto">auto</span></label>' +
        '<input class="cc-input" type="date" value="' + attr(f.start_date) + '" readonly></div>' +
      '<div><label>Time in Lab <span class="qc-auto">auto</span></label>' +
        '<input class="cc-input" type="text" value="' + attr(tilStr) + '" placeholder="—" readonly></div>' +
      '<div><label>Total Invoice <span class="qc-auto">auto</span></label>' +
        '<input class="cc-input" type="text" value="' + attr(invStr) + '" placeholder="—" readonly></div>' +
      '<div class="full"><label>Description of Issue <span class="req"></span></label>' +
        '<textarea class="cc-input" data-draft="ir-desc" rows="3" placeholder="Describe what went wrong and what needs to be fixed…" oninput="QCMODE.setIr(\'description\', this.value)">' + esc(f.description) + '</textarea></div>' +
      '<div class="full"><label>Need Technical Expert Assistance? <span class="req"></span></label>' +
        '<div class="qc-yn-grid">' + yn(true, 'Yes', 'Notify tech experts') + yn(false, 'No', 'No expert needed') + '</div></div>' +
    '</div>' +
    '<div class="qc-actions">' +
      '<button class="act blue" ' + (canSubmit && !state.irSaving ? '' : 'disabled') + ' onclick="QCMODE.submitIr()">' +
        (state.irSaving ? 'Notifying…' : (state.needsExpert === true ? 'Notify Experts' : 'Done')) + '</button>' +
    '</div></div>';
}

// ── Recent dashboard (tab-aware) ────────────────────────────────────
function recentTable() {
  return state.activeTab === 'qc' ? recentRejectsTable() : recentMrbTable();
}

function recentRejectsTable() {
  const rows = state.recent;
  let inner;
  if (!state.recentLoaded) inner = '<div class="loading">Loading recent rejects…</div>';
  else if (!rows.length) inner = '<div class="empty">No QC rejects logged yet.</div>';
  else {
    inner = '<table class="cc-table"><thead><tr>' +
      '<th>Case #</th><th>Dept</th><th>Technician</th><th>Urgency</th><th>Reject Type</th><th>Ship Date</th><th>Logged</th>' +
      '</tr></thead><tbody>' +
      rows.map(r => {
        const o = urgencyOpt(r.qc_reject);
        return '<tr>' +
          '<td class="case-id-cell">' + esc(r.case_number || '—') + '</td>' +
          '<td>' + esc(r.team || '—') + '</td>' +
          '<td>' + esc(r.technician || '—') + '</td>' +
          '<td><span class="cc-action-badge ' + o.slug + '">' + esc(r.qc_reject || '—') + '</span></td>' +
          '<td class="muted">' + esc(r.reject_type || '—') + '</td>' +
          '<td class="muted">' + fmtDate(r.ship_date) + '</td>' +
          '<td class="muted">' + fmtTs(r.time_stamp) + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
  }
  return '<div class="qc-recent"><div class="qc-recent-head">Recent QC Rejects</div>' + inner + '</div>';
}

function recentMrbTable() {
  const rows = state.recentMrb;
  let inner;
  if (!state.recentMrbLoaded) inner = '<div class="loading">Loading recent internal remakes…</div>';
  else if (!rows.length) inner = '<div class="empty">No internal remakes submitted yet.</div>';
  else {
    inner = '<table class="cc-table"><thead><tr>' +
      '<th>Case #</th><th>Dept</th><th>Submitted By</th><th>Expert?</th><th>Ship Date</th><th>Dr Due</th><th>Submitted</th>' +
      '</tr></thead><tbody>' +
      rows.map(r => {
        const badge = r.needs_expert
          ? '<span class="cc-action-badge qc-internal">Expert</span>'
          : '<span class="cc-action-badge qc-repair">Final QC</span>';
        return '<tr>' +
          '<td class="case-id-cell">' + esc(r.case_number || '—') + '</td>' +
          '<td>' + esc(r.team || '—') + '</td>' +
          '<td>' + esc(r.logged_by || '—') + '</td>' +
          '<td>' + badge + '</td>' +
          '<td class="muted">' + fmtDate(r.ship_date) + '</td>' +
          '<td class="muted">' + fmtDate(r.dr_due_date) + '</td>' +
          '<td class="muted">' + fmtTs(r.created_date) + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
  }
  return '<div class="qc-recent"><div class="qc-recent-head">Recent Internal Remakes</div>' + inner + '</div>';
}

async function refreshRecent() {
  try { state.recent = await Data.listQcLogs(100); }
  catch (e) { state.recent = []; toast('Could not load recent rejects', 'err'); }
  state.recentLoaded = true;
  render();
}

async function refreshMrb() {
  try { state.recentMrb = await Data.listMrb(100); }
  catch (e) { state.recentMrb = []; toast('Could not load internal remakes', 'err'); }
  state.recentMrbLoaded = true;
  render();
}

// ── handlers (window.QCMODE) ────────────────────────────────────────
function setTab(tab) { if (!canSeeTab(tab)) return; state.activeTab = tab; render(); ensureRecentLoaded(); }
function setStep(step) { state.step = step; render(); }
function setQc(k, v) {
  state.qc[k] = v;
  // The urgency pills re-paint on selection; free-text/select fields do not.
  if (k === 'qc_reject') render();
}
function setTeam(v) { state.qc.team = v; state.qc.technician = ''; state.qc.reject_type = ''; render(); }
function setDrDue(v) { state.drDueDate = v; }

async function submitQc() {
  const f = state.qc;
  if (!(f.case_number.trim() && f.team && f.technician && f.reject_type) || state.saving) return;
  state.saving = true; render();
  try {
    await Data.createQcLog({
      case_number: f.case_number.trim(),
      team: f.team,
      technician: f.technician,
      qc_reject: f.qc_reject,
      reject_type: f.reject_type,
      reject_details: f.reject_details || null,
      ship_date: f.ship_date || null,
      time_stamp: new Date().toISOString(),
    });
    state.step = 3;
    toast('QC reject logged', 'ok');
    if (window.DraftGuard) window.DraftGuard.clearMatching('qc-');   // logged — drop the saved reject draft
    refreshRecent();          // pull the new row into the table (also re-renders)
  } catch (e) {
    toast(e.message || 'Failed to save', 'err');
  } finally {
    state.saving = false; render();
  }
}

async function stage() {
  if (state.staging) return;
  const f = state.qc;
  state.staging = true; render();
  try {
    await Data.createStagedCase({
      case_number: f.case_number.trim(),
      dr_due_date: state.drDueDate || null,
      department: f.team,
      assigned_expert: null,
      assigned_expert_email: null,
    });
    EXPERTS.forEach(ex => Data.notifyExpertStaged({
      case_number: f.case_number.trim(),
      dr_due_date: state.drDueDate,
      department: f.team,
      assigned_expert: ex.name,
      assigned_expert_email: ex.email,
    }));
    state.stagingDone = true;
    toast('Staged for expert review', 'ok');
  } catch (e) {
    toast(e.message || 'Failed to stage', 'err');
  } finally {
    state.staging = false; render();
  }
}

function resetQc() {
  state.qc = { ...EMPTY_QC }; state.step = 1; state.drDueDate = '';
  state.stagingDone = false; state.staging = false; state.saving = false;
  if (window.DraftGuard) window.DraftGuard.clearMatching('qc-');   // fresh form — discard any saved draft
  render();
}

function setIr(k, v) { state.ir[k] = v; }
function setNeedsExpert(val) { state.needsExpert = val; render(); }

// Auto-populate the Internal Remake form from the case number (fired on change/blur of the case
// field). Fills ship/due/received/start/time-in-lab/invoice and loads the case's steps for the
// "step where issue occurred" dropdown. No-ops if the case is unchanged.
async function lookupIrCase() {
  const cn = (state.ir.case_number || '').trim();
  if (!cn) { state.irSteps = []; state.irLookupStatus = ''; state.irLookupCase = ''; render(); return; }
  if (cn === state.irLookupCase && state.irLookupStatus === 'found') return;  // already loaded
  state.irLookupLoading = true; state.irLookupStatus = ''; render();
  try {
    const res = await Data.lookupCaseForRemake(cn);
    if (res && res.found) {
      const f = state.ir;
      if (res.ship_date)   f.ship_date   = res.ship_date;
      if (res.dr_due_date) f.dr_due_date = res.dr_due_date;
      f.received_date    = res.received_date || '';
      f.start_date       = res.start_date || '';
      f.time_in_lab_days = (res.time_in_lab_days ?? null);
      f.total_invoice    = (res.total_invoice ?? null);
      f.issue_step       = '';                       // make them re-pick for the new case
      state.irSteps      = Array.isArray(res.steps) ? res.steps : [];
      state.irLookupStatus = 'found';
    } else {
      state.irSteps = [];
      state.irLookupStatus = 'notfound';
    }
    state.irLookupCase = cn;
  } catch (e) {
    state.irLookupStatus = 'error';
  } finally {
    state.irLookupLoading = false; render();
  }
}
async function submitIr() {
  const f = state.ir;
  const stepRequiredOk = state.irSteps.length === 0 || !!f.issue_step;
  const valid = f.case_number.trim() && f.department && f.logged_by.trim() && f.technician.trim() &&
    f.ship_date && f.dr_due_date && f.description.trim() && stepRequiredOk && state.needsExpert !== null;
  if (!valid || state.irSaving) return;
  state.irSaving = true; render();
  try {
    // Persist EVERY submission to the MRB board for visibility — both expert and
    // Final-QC routes (the one behavioral difference from qc-app_AOX).
    await Data.createMrbEntry({
      case_number: f.case_number.trim(),
      department: f.department,
      logged_by: f.logged_by.trim(),
      technician: f.technician.trim(),
      issue_step: f.issue_step || null,
      ship_date: f.ship_date,
      dr_due_date: f.dr_due_date,
      received_date: f.received_date || null,
      start_date: f.start_date || null,
      time_in_lab_days: (f.time_in_lab_days ?? null),
      total_invoice: (f.total_invoice ?? null),
      description: f.description.trim(),
      needs_expert: state.needsExpert,
    });
    // Expert route mirrors qc-app_AOX: notify the technical experts by email.
    // Final-QC route ("No") routes to Final QC — no email (see confirmation msg).
    if (state.needsExpert) {
      EXPERTS.forEach(ex => Data.notifyExpertStaged({
        case_number: f.case_number.trim(),
        dr_due_date: f.dr_due_date,
        ship_date: f.ship_date,
        department: f.department,
        issue_summary: f.description,
        staged_by: f.logged_by,
        assigned_expert: ex.name,
        assigned_expert_email: ex.email,
      }));
    }
    state.irDone = true;
    toast('Internal remake submitted', 'ok');
    if (window.DraftGuard) window.DraftGuard.clearMatching('ir-');   // submitted — drop the saved IR draft
    refreshMrb();          // pull the new row into the dashboard (also re-renders)
  } catch (e) {
    toast(e.message || 'Something went wrong', 'err');
  } finally {
    state.irSaving = false; render();
  }
}
function resetIr() {
  state.ir = { ...EMPTY_IR }; state.needsExpert = null; state.irDone = false; state.irSaving = false;
  state.irSteps = []; state.irLookupCase = ''; state.irLookupStatus = ''; state.irLookupLoading = false;
  if (window.DraftGuard) window.DraftGuard.clearMatching('ir-');   // fresh form — discard any saved draft
  render();
}

const QCMODE = {
  renderQcMode,
  setTab, setStep, setQc, setTeam, setDrDue, submitQc, stage, resetQc,
  setIr, setNeedsExpert, submitIr, resetIr, lookupIrCase,
};
if (typeof window !== 'undefined') window.QCMODE = QCMODE;
export default QCMODE;
