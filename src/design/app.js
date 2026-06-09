// Design Dept board — a Nest-style tile dashboard for cases currently in the design
// department (current step's Department 1 = 'Design'), rendered into #panel-designdept
// inside the Design Approvals (outreach) mode. Reuses the Nest board's CSS (.nest-*).
//
// Single board (no mill/print split). Priority (top-left highest): rush > hot > due.
// Filters: hold time, due date, step (consolidated), business unit, material. Clicking a
// tile opens the same case-detail modal. Backed by the v_design_worklist view (./data.js).
// All inline on* handlers are namespaced under window.DESIGN.
import * as Data from './data.js';
import '../nest/styles.css';

const EMPTY_FILTERS = () => ({ hold: 'all', due: 'all', step: 'all', bu: 'all', material: 'all' });
const state = {
  cases: [],
  loaded: false,
  loading: false,
  error: null,
  filters: EMPTY_FILTERS(),
  openCaseNum: null,
};

// ── helpers ─────────────────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function attr(s) { return esc(s).replace(/"/g, '&quot;'); }
function panel() { return document.getElementById('panel-designdept'); }
function fmtDate(d) {
  if (!d) return '';
  const p = String(d).slice(0, 10).split('-');
  return p.length === 3 ? p[1] + '/' + p[2] + '/' + p[0] : d;
}
function fmtMoney(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function techName(t) { return t ? String(t).replace(/^[A-Za-z]{2,3}-/, '') : ''; }
function caseByNum(n) { return state.cases.find(c => c.caseNumber === n) || null; }
function pacificTodayStr() {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}
function addDaysStr(baseStr, n) {
  const d = new Date(baseStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Display label for the case-level Business Unit (matches the Nest board's relabel).
const BU_DISPLAY = { Restorative: 'Crown & Bridge' };
function buLabel(b) { return BU_DISPLAY[b] || b; }
function distinct(list, key) { return Array.from(new Set(list.map(c => c[key]).filter(Boolean))).sort(); }

// ── filtering + sorting ─────────────────────────────────────────────
function applyFilters(list, f) {
  const today = pacificTodayStr();
  let horizon = null;
  if (f.due !== 'all') {
    const days = f.due === 'today' ? 0 : f.due === '3d' ? 3 : f.due === '1w' ? 7 : 14;
    horizon = addDaysStr(today, days);
  }
  const holdMin = (f.hold === 'all' || f.hold === 'none') ? 0 : f.hold === '24' ? 1 : f.hold === '48' ? 2 : 3;
  return list.filter(c => {
    if (f.hold === 'none' && c.isOnHold) return false;
    if (holdMin > 0 && !(c.isOnHold && c.holdDays >= holdMin)) return false;
    if (horizon && !(c.dueDate && c.dueDate <= horizon)) return false;
    if (f.step !== 'all' && c.stepConsolidated !== f.step) return false;
    if (f.bu !== 'all' && c.businessUnit !== f.bu) return false;
    if (f.material !== 'all' && c.material !== f.material) return false;
    return true;
  });
}
function sortCases(list) {
  return list.slice().sort((a, b) => {
    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
    const ad = a.dueDate || '9999-12-31', bd = b.dueDate || '9999-12-31';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return String(a.caseNumber).localeCompare(String(b.caseNumber));
  });
}

// ── public entry ────────────────────────────────────────────────────
export function render() {
  if (!state.loaded && !state.loading) { load(); return; }
  draw();
}
export function reload() {
  state.loaded = false;
  load();
}
async function load() {
  state.loading = true; state.error = null; draw();
  try {
    state.cases = await Data.loadDesign();
    state.loaded = true;
  } catch (e) {
    state.error = e && e.message ? e.message : String(e);
  } finally {
    state.loading = false; draw();
  }
}

// ── rendering ───────────────────────────────────────────────────────
function draw() {
  const el = panel(); if (!el) return;
  let body;
  if (state.error) body = `<div class="nest-error">Couldn't load the design worklist — ${esc(state.error)}</div>`;
  else if (!state.loaded) body = `<div class="nest-loading">Loading design worklist…</div>`;
  else body = boardHtml();
  const open = state.loaded && state.openCaseNum ? caseByNum(state.openCaseNum) : null;
  el.innerHTML = `<div class="nest-root">${topbarHtml()}${body}</div>${open ? modalHtml(open) : ''}`;
}

function topbarHtml() {
  return `<div class="nest-topbar">
    <span class="nest-legend">
      Cases in the design department
      <span class="nest-badge rush">Rush</span>
      <span class="nest-badge hot">Hot</span>
      <span class="nest-badge hold">Hold</span>
    </span>
    <button type="button" class="nest-refresh" onclick="DESIGN.reload()" ${state.loading ? 'disabled' : ''}>↻ Refresh</button>
  </div>`;
}

function boardHtml() {
  const all = state.cases;
  const f = state.filters;
  const list = sortCases(applyFilters(all, f));
  const tiles = list.length
    ? list.map(tileHtml).join('')
    : `<div class="nest-empty">No cases match these filters.</div>`;
  return `<section class="nest-board">
    <div class="nest-board-head">
      <h2 class="nest-board-title">Design Dept <span class="nest-count">${list.length}</span></h2>
      ${filterBarHtml(f, all)}
    </div>
    <div class="nest-grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">${tiles}</div>
  </section>`;
}

function filterBarHtml(f, all) {
  const sel = (kind, value, options) =>
    `<select class="nest-filter" onchange="DESIGN.setFilter('${kind}',this.value)">` +
    options.map(([v, l]) => `<option value="${attr(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('') +
    `</select>`;
  const stepOpts = distinct(all, 'stepConsolidated').map(s => [s, s]);
  const buOpts = distinct(all, 'businessUnit').map(b => [b, buLabel(b)]).sort((a, b) => a[1].localeCompare(b[1]));
  const matOpts = distinct(all, 'material').map(m => [m, m]);
  return `<div class="nest-filters">
    ${sel('hold', f.hold, [['all', 'Any hold time'], ['none', 'Not on hold'], ['24', 'On hold ≥ 24h'], ['48', 'On hold ≥ 48h'], ['72', 'On hold ≥ 72h']])}
    ${sel('due', f.due, [['all', 'Any due date'], ['today', 'Due today'], ['3d', 'Due in 3 days'], ['1w', 'Due in 1 week'], ['2w', 'Due in 2 weeks']])}
    ${sel('step', f.step, [['all', 'All design steps'], ...stepOpts])}
    ${sel('bu', f.bu, [['all', 'All business units'], ...buOpts])}
    ${sel('material', f.material, [['all', 'All materials'], ...matOpts])}
  </div>`;
}

function tileHtml(c) {
  const panRaw = c.panNumber == null ? '' : String(c.panNumber).trim();
  const unassigned = panRaw === '' || panRaw === '0';
  const pan = unassigned ? 'Pan unassigned' : panRaw;
  const badges = [];
  if (c.isRush) badges.push('<span class="nest-badge rush">Rush</span>');
  if (c.isHot) badges.push('<span class="nest-badge hot">Hot</span>');
  if (c.isOnHold) badges.push(`<span class="nest-badge hold">Hold ${c.holdDays}d</span>`);
  const mod = c.isRush ? ' is-rush' : c.isHot ? ' is-hot' : '';
  return `<div class="nest-tile${mod}${unassigned ? ' pan-unassigned' : ''}" role="button" tabindex="0"
    onclick="DESIGN.openCase('${attr(c.caseNumber)}')"
    onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();DESIGN.openCase('${attr(c.caseNumber)}')}"
    title="${attr(c.currentStep + ' · ' + (c.product || ''))}">
    <div class="nest-tile-pan">${esc(pan)}</div>
    <div class="nest-tile-case">Case ${esc(c.caseNumber)}</div>
    <div class="nest-tile-due">${c.dueDate ? 'Due ' + fmtDate(c.dueDate) : 'No due date'}</div>
    ${c.stepConsolidated ? `<div class="nest-tile-step">${esc(c.stepConsolidated)}</div>` : ''}
    ${badges.length ? `<div class="nest-tile-badges">${badges.join('')}</div>` : ''}
  </div>`;
}

function modalHtml(c) {
  const panRaw = c.panNumber == null ? '' : String(c.panNumber).trim();
  const pan = (panRaw === '' || panRaw === '0') ? 'Pan unassigned' : panRaw;
  const badges = [];
  if (c.isRush) badges.push('<span class="nest-badge rush">Rush</span>');
  if (c.isHot) badges.push('<span class="nest-badge hot">Hot</span>');
  if (c.isOnHold) badges.push(`<span class="nest-badge hold">Hold ${c.holdDays}d</span>`);
  const row = (label, val) => `<div class="nest-modal-row"><span class="k">${esc(label)}</span><span class="v">${val}</span></div>`;
  const lastTech = c.lastTech
    ? `${esc(techName(c.lastTech))}${c.lastTechStep ? ` <span class="nest-modal-sub">· ${esc(c.lastTechStep)}${c.lastTechAt ? ' (' + fmtDate(c.lastTechAt) + ')' : ''}</span>` : ''}`
    : '<span class="nest-modal-muted">No completed step on record</span>';
  const days = c.daysInLab == null ? '—' : `${c.daysInLab} day${c.daysInLab === 1 ? '' : 's'}`;
  const step = c.currentStep ? `${esc(c.currentStep)}${c.stepConsolidated ? ` <span class="nest-modal-sub">· ${esc(c.stepConsolidated)}</span>` : ''}` : '—';
  return `<div class="nest-modal-overlay" onclick="DESIGN.closeCase()">
    <div class="nest-modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()">
      <button type="button" class="nest-modal-x" aria-label="Close" onclick="DESIGN.closeCase()">×</button>
      <div class="nest-modal-head">
        <div class="nest-modal-pan">${esc(pan)}</div>
        <div class="nest-modal-case">Case ${esc(c.caseNumber)}${c.productLine ? ' · ' + esc(c.productLine) : ''}</div>
        ${badges.length ? `<div class="nest-tile-badges">${badges.join('')}</div>` : ''}
      </div>
      <div class="nest-modal-body">
        ${row('Product', esc(c.product || '—'))}
        ${row('Material', esc(c.material || '—'))}
        ${row('Doctor due date', c.dueDate ? fmtDate(c.dueDate) : '—')}
        ${row('Received date', c.receivedDate ? fmtDate(c.receivedDate) : '—')}
        ${row('Days at lab', days)}
        ${row('Invoice total', fmtMoney(c.invoiceTotal))}
        ${row('Last worked by', lastTech)}
        ${row('Current step', step)}
        ${c.isOnHold && c.holdReason ? row('Hold reason', esc(c.holdReason)) : ''}
        ${row('Business unit', esc(buLabel(c.businessUnit) || '—'))}
      </div>
    </div>
  </div>`;
}

// ── handlers (window.DESIGN) ────────────────────────────────────────
function setFilter(kind, value) {
  if (!(kind in state.filters)) return;
  state.filters[kind] = value;
  draw();
}
function openCase(caseNum) { state.openCaseNum = caseNum; draw(); }
function closeCase() { state.openCaseNum = null; draw(); }

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.openCaseNum) { state.openCaseNum = null; draw(); }
  });
}

const DESIGN = { render, reload, setFilter, openCase, closeCase };
if (typeof window !== 'undefined') window.DESIGN = DESIGN;
