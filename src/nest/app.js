// Nest mode — Mill / Print nesting boards rendered into #panel-nest in the suite's
// native theme. Vanilla JS, mirroring src/qc/app.js: all inline on* handlers are
// namespaced under window.NEST so they never collide with the host app's globals.
// Read-only board backed by the v_nest_worklist view (see ./data.js).
//
// Visibility / layout (see prd/nest-mode.md):
//   * manager / executive / admin hold BOTH NEST_MILL + NEST_PRINT -> side-by-side
//     split, each board 3 tiles per row.
//   * nest_mill / nest_print hold ONE -> a single full-width board, 6 tiles per row.
//   * Priority (top-left highest, left->right then down): is_rush > is_hot > due asc.
//     The view supplies priority_rank (rush=0, hot=1, else=2); we tiebreak by due date.
//
// Mill/Print routing + the red-asterisk uncertainty flag are computed by the view
// (the canonical rule). `classifyMethod()` below is a FE fallback used only if a row
// ever arrives without a `method` — keep it in lockstep with the SQL classifier.
import * as Data from './data.js';
import { can, CAPABILITIES } from '../permissions.js';
import './styles.css';

// ── module state ────────────────────────────────────────────────────
const EMPTY_FILTERS = () => ({ hold: 'all', due: 'all', bu: 'all', material: 'all' });
const state = {
  cases: [],
  loaded: false,
  loading: false,
  error: null,
  filters: { mill: EMPTY_FILTERS(), print: EMPTY_FILTERS() },
  openCaseNum: null,   // case # whose detail modal is open, or null
};

// ── helpers ─────────────────────────────────────────────────────────
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function attr(s) { return esc(s).replace(/"/g, '&quot;'); }
function panel() { return document.getElementById('panel-nest'); }
function fmtDate(d) {
  if (!d) return '';
  const p = String(d).slice(0, 10).split('-');
  return p.length === 3 ? p[1] + '/' + p[2] + '/' + p[0] : d;
}
function fmtMoney(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Tech names are stored with a facility prefix ("OC-Ivan Hernandez"); strip it for display.
function techName(t) { return t ? String(t).replace(/^[A-Za-z]{2,3}-/, '') : ''; }
function caseByNum(n) { return state.cases.find(c => c.caseNumber === n) || null; }
// Today's date in Pacific as 'YYYY-MM-DD' (en-CA yields ISO order). The view computes
// doctor_due_date_only in the same zone, so string comparisons line up.
function pacificTodayStr() {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}
function addDaysStr(baseStr, n) {
  const d = new Date(baseStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// FE fallback classifier — mirrors the SQL rule in v_nest_worklist. Only used if a
// row is missing `method`; normally the view decides. Returns { method, uncertain }.
function classifyMethod(c) {
  const norm = `${c.product || ''} ${c.currentStep || ''}`.toLowerCase();
  const printStrong = /print/.test(norm) || /model/.test((c.currentStep || '').toLowerCase())
    || /try.?in|night ?guard|surgical guide|stackable/.test(norm);
  const millStrong = /zirconia|emax|disilicate|pressed|pfm|pfz|feldspath|veneer|inlay|onlay|monolithic|milled|\bmill\b|\bwax\b|\bbar\b|crown/.test(norm);
  let method;
  if (printStrong && !millStrong) method = 'print';
  else if (millStrong && !printStrong) method = 'mill';
  else method = /print|model/.test((c.currentStep || '').toLowerCase()) ? 'print' : 'mill';
  return { method, uncertain: printStrong === millStrong };
}

// ── filtering + sorting ─────────────────────────────────────────────
function applyFilters(list, f) {
  const today = pacificTodayStr();
  let horizon = null;
  if (f.due !== 'all') {
    const days = f.due === 'today' ? 0 : f.due === '3d' ? 3 : f.due === '1w' ? 7 : 14;
    horizon = addDaysStr(today, days);
  }
  const holdMin = f.hold === 'all' ? 0 : f.hold === '24' ? 1 : f.hold === '48' ? 2 : 3; // hours -> days
  return list.filter(c => {
    if (holdMin > 0 && !(c.isOnHold && c.holdDays >= holdMin)) return false;
    if (horizon && !(c.dueDate && c.dueDate <= horizon)) return false;
    if (f.bu !== 'all' && c.businessUnit !== f.bu) return false;
    if (f.material !== 'all' && c.material !== f.material) return false;
    return true;
  });
}
// Priority: rush > hot > due-soonest. priorityRank already encodes rush(0)/hot(1)/else(2).
function sortCases(list) {
  return list.slice().sort((a, b) => {
    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
    const ad = a.dueDate || '9999-12-31', bd = b.dueDate || '9999-12-31';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return String(a.caseNumber).localeCompare(String(b.caseNumber));
  });
}
function distinctBUs(list) {
  return Array.from(new Set(list.map(c => c.businessUnit).filter(Boolean))).sort();
}
function distinctMaterials(list) {
  return Array.from(new Set(list.map(c => c.material).filter(Boolean))).sort();
}
// Display labels for the case-level `Business Unit` field. The data has no literal
// "Crown & Bridge" value — standard crown/bridge (+ implant crown) work is bucketed
// as "Restorative" — so we relabel it for the filter. The premium anterior crowns
// are already a separate "High Esthetics" bucket. Filtering still compares the raw
// underlying value; only the label changes.
const BU_DISPLAY = { Restorative: 'Crown & Bridge' };
function buLabel(b) { return BU_DISPLAY[b] || b; }

// ── public entry ────────────────────────────────────────────────────
export function render() {
  if (!state.loaded && !state.loading) { load(); return; } // load() re-draws when done
  draw();
}
export function reload() {
  state.loaded = false;
  load();
}
async function load() {
  state.loading = true; state.error = null; draw();
  try {
    state.cases = await Data.loadNest();
    // Safety net: fill in method/uncertain if the view ever omits them.
    state.cases.forEach(c => {
      if (!c.method) { const r = classifyMethod(c); c.method = r.method; c.methodUncertain = r.uncertain; }
    });
    state.loaded = true;
    // Reopen the case modal the user had open before a reload, if it still exists.
    if (state.openCaseNum == null) {
      try {
        const saved = localStorage.getItem('nest_open_case');
        const hit = saved ? state.cases.find(c => String(c.caseNumber) === saved) : null;
        if (hit) state.openCaseNum = hit.caseNumber;
      } catch {}
    }
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
  if (state.error) body = `<div class="nest-error">Couldn't load the nest worklist — ${esc(state.error)}</div>`;
  else if (!state.loaded) body = `<div class="nest-loading">Loading nest worklist…</div>`;
  else body = boardsHtml();
  const open = state.loaded && state.openCaseNum ? caseByNum(state.openCaseNum) : null;
  // Keep the page from jumping to the top when the board re-renders (e.g. a manual refresh).
  const paint = () => { el.innerHTML = `<div class="nest-root">${topbarHtml()}${body}</div>${open ? modalHtml(open) : ''}`; };
  if (window.DraftGuard) window.DraftGuard.preserveScroll(paint, el);
  else paint();
}

function topbarHtml() {
  return `<div class="nest-topbar">
    <span class="nest-legend">
      <span class="nest-flag">*</span> routing needs review
      <span class="nest-badge rush">Rush</span>
      <span class="nest-badge hot">Hot</span>
      <span class="nest-badge hold">Hold</span>
    </span>
    <button type="button" class="nest-refresh" onclick="NEST.reload()" ${state.loading ? 'disabled' : ''}>↻ Refresh</button>
  </div>`;
}

function boardsHtml() {
  const showMill = can(CAPABILITIES.NEST_MILL);
  const showPrint = can(CAPABILITIES.NEST_PRINT);
  const both = showMill && showPrint;
  const cols = both ? 3 : 6; // tiles per row: 3 per half when split, 6 full-width
  const boards = [];
  if (showMill) boards.push(boardHtml('mill', 'Mill', cols));
  if (showPrint) boards.push(boardHtml('print', 'Print', cols));
  if (!boards.length) return `<div class="nest-norole">No nest board is available for your role.</div>`;
  return `<div class="nest-boards${both ? ' nest-split' : ''}">${boards.join('')}</div>`;
}

function boardHtml(side, label, cols) {
  const all = state.cases.filter(c => c.method === side);
  const f = state.filters[side];
  const list = sortCases(applyFilters(all, f));
  const tiles = list.length
    ? list.map(tileHtml).join('')
    : `<div class="nest-empty">No ${esc(label.toLowerCase())} cases match these filters.</div>`;
  return `<section class="nest-board" data-side="${side}">
    <div class="nest-board-head">
      <h2 class="nest-board-title">${esc(label)} <span class="nest-count">${list.length}</span></h2>
      ${filterBarHtml(side, f, distinctBUs(all), distinctMaterials(all))}
    </div>
    <div class="nest-grid" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${tiles}</div>
  </section>`;
}

function filterBarHtml(side, f, bus, materials) {
  const sel = (kind, value, options) =>
    `<select class="nest-filter" onchange="NEST.setFilter('${side}','${kind}',this.value)">` +
    options.map(([v, l]) => `<option value="${attr(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('') +
    `</select>`;
  const buOpts = bus.map(b => [b, buLabel(b)]).sort((a, b) => a[1].localeCompare(b[1]));
  const matOpts = materials.map(m => [m, m]); // already sorted; show real material names
  return `<div class="nest-filters">
    ${sel('hold', f.hold, [['all', 'Any hold time'], ['24', 'On hold ≥ 24h'], ['48', 'On hold ≥ 48h'], ['72', 'On hold ≥ 72h']])}
    ${sel('due', f.due, [['all', 'Any due date'], ['today', 'Due today'], ['3d', 'Due in 3 days'], ['1w', 'Due in 1 week'], ['2w', 'Due in 2 weeks']])}
    ${sel('bu', f.bu, [['all', 'All business units'], ...buOpts])}
    ${sel('material', f.material, [['all', 'All materials'], ...matOpts])}
  </div>`;
}

function tileHtml(c) {
  const panRaw = c.panNumber == null ? '' : String(c.panNumber).trim();
  const unassigned = panRaw === '' || panRaw === '0';
  const pan = unassigned ? 'Pan unassigned' : panRaw;
  const flag = c.methodUncertain
    ? '<span class="nest-flag" title="Mill/Print routing uncertain — please verify">*</span>' : '';
  const badges = [];
  if (c.isRush) badges.push('<span class="nest-badge rush">Rush</span>');
  if (c.isHot) badges.push('<span class="nest-badge hot">Hot</span>');
  if (c.isOnHold) badges.push(`<span class="nest-badge hold">Hold ${c.holdDays}d</span>`);
  const mod = c.isRush ? ' is-rush' : c.isHot ? ' is-hot' : '';
  return `<div class="nest-tile${mod}${unassigned ? ' pan-unassigned' : ''}" role="button" tabindex="0"
    onclick="NEST.openCase('${attr(c.caseNumber)}')"
    onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();NEST.openCase('${attr(c.caseNumber)}')}"
    title="${attr(c.currentStep + ' · ' + (c.product || ''))}">
    <div class="nest-tile-pan">${esc(pan)}${flag}</div>
    <div class="nest-tile-case">Case ${esc(c.caseNumber)}</div>
    <div class="nest-tile-due">${c.dueDate ? 'Due ' + fmtDate(c.dueDate) : 'No due date'}</div>
    ${badges.length ? `<div class="nest-tile-badges">${badges.join('')}</div>` : ''}
  </div>`;
}

// Case-detail modal opened by clicking a tile.
function modalHtml(c) {
  const panRaw = c.panNumber == null ? '' : String(c.panNumber).trim();
  const pan = (panRaw === '' || panRaw === '0') ? 'Pan unassigned' : panRaw;
  const flag = c.methodUncertain
    ? '<span class="nest-flag" title="Mill/Print routing uncertain — please verify">*</span>' : '';
  const badges = [];
  if (c.isRush) badges.push('<span class="nest-badge rush">Rush</span>');
  if (c.isHot) badges.push('<span class="nest-badge hot">Hot</span>');
  if (c.isOnHold) badges.push(`<span class="nest-badge hold">Hold ${c.holdDays}d</span>`);
  const row = (label, val) => `<div class="nest-modal-row"><span class="k">${esc(label)}</span><span class="v">${val}</span></div>`;
  const lastTech = c.lastTech
    ? `${esc(techName(c.lastTech))}${c.lastTechStep ? ` <span class="nest-modal-sub">· ${esc(c.lastTechStep)}${c.lastTechAt ? ' (' + fmtDate(c.lastTechAt) + ')' : ''}</span>` : ''}`
    : '<span class="nest-modal-muted">No completed step on record</span>';
  const days = c.daysInLab == null ? '—' : `${c.daysInLab} day${c.daysInLab === 1 ? '' : 's'}`;
  return `<div class="nest-modal-overlay" onclick="NEST.closeCase()">
    <div class="nest-modal" role="dialog" aria-modal="true" onclick="event.stopPropagation()">
      <button type="button" class="nest-modal-x" aria-label="Close" onclick="NEST.closeCase()">×</button>
      <div class="nest-modal-head">
        <div class="nest-modal-pan">${esc(pan)}${flag}</div>
        <div class="nest-modal-case">Case ${esc(c.caseNumber)} · ${esc(c.method === 'print' ? 'Print' : 'Mill')}</div>
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
        ${row('Current step', esc(c.currentStep || '—'))}
        ${c.isOnHold && c.holdReason ? row('Hold reason', esc(c.holdReason)) : ''}
        ${row('Business unit', esc(buLabel(c.businessUnit) || '—'))}
      </div>
    </div>
  </div>`;
}

// ── handlers (window.NEST) ──────────────────────────────────────────
function setFilter(side, kind, value) {
  if (!state.filters[side]) return;
  state.filters[side][kind] = value;
  draw();
}
function openCase(caseNum) {
  state.openCaseNum = caseNum;
  try { localStorage.setItem('nest_open_case', String(caseNum)); } catch {}   // reopen on reload
  draw();
}
function closeCase() {
  state.openCaseNum = null;
  try { localStorage.removeItem('nest_open_case'); } catch {}
  draw();
}

// Close the modal on Escape.
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.openCaseNum) { closeCase(); }
  });
}

const NEST = { render, reload, setFilter, openCase, closeCase };
if (typeof window !== 'undefined') window.NEST = NEST;
