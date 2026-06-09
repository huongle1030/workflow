// CaseFlow UI — a faithful port of caseflow_portal_v37.html's four team views
// (Data Entry, Case Review, Scanning, Design Team), wired to Supabase via
// ./data.js instead of the prototype's in-memory `cases` array, and to npm
// pdf-lib via ./export.js instead of the CDN global.
//
// All inline on* handlers in the rendered markup are namespaced under window.CF
// (exposed at the bottom) so they never collide with the host app's globals.
import {
  DESIGN_CL, SC, CAT_NAMES, BASIC_INFO_ITEMS, PRODUCT_ITEMS, SCAN_ITEMS,
  DESIGN_NEEDS_OPTS, ASP_DESIGN_REQ, ASP_SPEC_ITEMS, ASP_LFX_SCANS, ASP_NONLFX_SCANS,
  ASP_TIBASE_OPTS, ASP_SCANBODY_OPTS, ASP_SCREW_OPTS, TRI_SCAN_SECTIONS, OPTS,
  FIELD_MAP, TRI_ALL, RESET_MAP, stageN, DESIGN_STAGES, isSet,
} from './constants.js';
import { DCL_SCHEMAS } from './schemas.js';
import { getDcl, dclEsc, dclAttr, dclAutoPopulate, dclVisibility } from './dcl.js';
import { exportZip, buildAndDownloadZip, fillDesignPdf } from './export.js';
import * as Data from './data.js';
import { getCurrentUser, getCurrentEmployee } from '../auth.js';
import { renderCode39 } from '../barcode.js';
import './styles.css';

// Logged-in Microsoft account's display name — used to pre-fill the Data Entry "Tech name".
// Prefer the Azure/Microsoft display name from the session; fall back to the employees row name,
// then the email local-part.
function currentTechName() {
  const u = getCurrentUser();
  const fromMs = u?.user_metadata?.full_name || u?.user_metadata?.name;
  if (fromMs) return fromMs;
  const emp = getCurrentEmployee();
  if (emp?.name) return emp.name;
  return (u?.email || '').split('@')[0] || '';
}

// ── module state ────────────────────────────────────────────────────
let cases = [];
let loaded = false;
let selectedMode = null;     // which mode currently owns the open detail
let selectedCaseId = null;   // c.id of the open case (or null -> queue)
let qcSel = null, adjSel = null;
let rushState = false;       // New Case modal rush toggle

// mode -> { panel id, queue stages, queue title }
const MODES = {
  dataentry:  { panel: 'panel-dataentry',  title: 'Data Entry' },
  casereview: { panel: 'panel-casereview', stages: ['Review', 'Case Coordination'], title: 'Case Review' },
  scanning:   { panel: 'panel-scanning',   stages: ['Scanning'], title: 'Scanning' },
  // 'Complete' kept here (no Dashboard/All-Cases views ported) so finished cases
  // stay reachable for the ZIP download. Prototype showed them on the Dashboard.
  design:     { panel: 'panel-design',     stages: [...DESIGN_STAGES, 'Complete'], title: 'Design Team' },
};

// ── lookups / persistence helpers ───────────────────────────────────
function getC(id) { return cases.find(x => x.id === id); }
function getA(id) { const c = getC(id); if (!c.aox) c.aox = {}; return c.aox; }
function getR(id) { const c = getC(id); if (!c.aoxReview) c.aoxReview = {}; return c.aoxReview; }

const _saveTimers = new Map();
function cfSave(c) {
  if (!c || !c.uuid) return;
  clearTimeout(_saveTimers.get(c.uuid));
  _saveTimers.set(c.uuid, setTimeout(() => { Data.saveCase(c).catch(err => toast('Save failed: ' + err.message)); }, 500));
}
function cfEvent(c, text, by) {
  if (!c.timeline) c.timeline = [];
  c.timeline.push({ text, by: by || Data.currentUser(), at: new Date().toISOString() });
  cfSave(c); // events live in the case row (single-table) — persist with the case
}

// ── small helpers (ported) ──────────────────────────────────────────
function badge(s) { return `<span class="stage-badge ${SC[s] || 'badge-entry'}">${s}</span>`; }
function rushBadge(r) { return r ? '<span class="rush-badge"><i class="ti ti-bolt" style="font-size:10px"></i> Rush</span>' : '<span style="color:var(--color-text-tertiary);font-size:12px">—</span>'; }
function fmtDate(d) { if (!d) return '<span style="color:var(--color-text-tertiary);font-size:12px">—</span>'; const p = d.split('-'); return `<span style="font-size:12px">${p[1]}/${p[2]}/${p[0]}</span>`; }
function fmtTs(ts) { try { return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }
function deToday() { const d = new Date(); const p = n => ('0' + n).slice(-2); return p(d.getMonth() + 1) + '/' + p(d.getDate()) + '/' + d.getFullYear(); }
function tblRows(list, mode) { return list.map(c => `<div class="case-row" data-search="${esc((c.caseNum || '') + ' ' + (c.id || ''))}" onclick="CF.openCase('${mode}','${c.id}')" tabindex="0" role="button"><div class="td case-id">${c.caseNum || '—'}</div><div class="td"><span style="font-weight:500">${esc(c.patient)}</span></div><div class="td" style="font-size:12px;color:var(--color-text-secondary)">${esc(c.doctor)}</div><div class="td">${badge(c.stage)}</div><div class="td">${rushBadge(c.rush)}</div><div class="td">${fmtDate(c.shipDate)}</div><div class="td">${fmtDate(c.drDueDate)}</div></div>`).join(''); }
function tblWrap(list, mode) { return `<div class="cases-table"><div class="table-header"><div class="th">Case #</div><div class="th">Patient</div><div class="th">Doctor</div><div class="th">Stage</div><div class="th">Rush</div><div class="th">Ship Date</div><div class="th">Dr Due Date</div></div>${tblRows(list, mode)}</div>`; }
function emptyMsg(msg) { return `<div class="cf-empty"><i class="ti ti-check"></i>${msg}</div>`; }
// Soonest-to-ship first; cases without a ship date sink to the bottom.
function sortByShip(list) { return list.slice().sort((a, b) => { const av = a.shipDate || '', bv = b.shipDate || ''; if (av && bv) return av < bv ? -1 : (av > bv ? 1 : 0); if (av) return -1; if (bv) return 1; return 0; }); }
// Per-queue case-number search. Filters the rendered rows in place (no re-render →
// keeps input focus); matches case number or display id via the row's data-search.
function queueSearchBar() { return `<div class="cf-queue-search"><i class="ti ti-search"></i><input type="text" placeholder="Search case #…" oninput="CF.filterQueue(this)" aria-label="Search by case number" /></div>`; }
function filterQueue(inp) { const term = String(inp.value || '').trim().toLowerCase(); const root = inp.closest('.cf-root') || document; root.querySelectorAll('.case-row').forEach(row => { const hay = (row.getAttribute('data-search') || '').toLowerCase(); row.style.display = (!term || hay.indexOf(term) > -1) ? '' : 'none'; }); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function toast(msg) { const t = document.getElementById('cf-toast'); if (!t) return; document.getElementById('cf-toast-msg').textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2800); }

// ── mode render dispatch ────────────────────────────────────────────
function panelEl(mode) { return document.getElementById(MODES[mode].panel); }
function modeForStage(stage) { return Object.keys(MODES).find(m => (MODES[m].stages || ['Data Entry']).includes(stage)); }

export async function renderCaseFlowMode(mode) {
  if (!loaded) { await reload(); }
  renderMode(mode);
}

export async function reload() {
  try { cases = await Data.loadAll(); loaded = true; releaseOutsourcedToQc(); }
  catch (err) { toast('Load failed: ' + err.message); cases = []; }
}

function renderMode(mode) {
  const el = panelEl(mode); if (!el) return;
  const c = (selectedMode === mode && selectedCaseId) ? getC(selectedCaseId) : null;
  const pad = ' style="padding:18px 28px 28px"';
  if (c) { el.innerHTML = `<div class="cf-root"${pad}>${detailHeader(c, mode)}<div id="cf-detail">${renderCaseDetail(c)}</div></div>`; afterDetailRender(c); }
  else { el.innerHTML = `<div class="cf-root"${pad}>${renderQueue(mode)}</div>`; }
}

function detailHeader(c, mode) {
  return `<div class="cf-detail-head"><button class="btn btn-sm" onclick="CF.goBack('${mode}')"><i class="ti ti-arrow-left"></i> Back</button><span class="cf-breadcrumb">/ ${c.caseNum || 'New'} — ${esc(c.patient)}</span></div>`;
}

function renderQueue(mode) {
  if (mode === 'dataentry') return renderDataEntryQueue();
  if (mode === 'design') return renderDesignQueue();
  if (mode === 'casereview') return renderCaseReviewQueue();
  const stages = MODES[mode].stages;
  const list = sortByShip(cases.filter(c => stages.includes(c.stage)));
  return `<div style="margin-bottom:14px"><div style="font-size:16px;font-weight:600">${MODES[mode].title}</div></div>` + queueSearchBar() +
    (list.length ? tblWrap(list, mode) : emptyMsg('No cases pending'));
}

// ── Design routing helpers + outsource partners ─────────────────────
const OUTSOURCE_PARTNERS = { adite: 'Adite', heygears: 'HeyGears', cadora: 'Cadora' };
function designRouteOf(c) { return (c.aoxReview && c.aoxReview.designRoute) || null; }
function partnerOf(c) { return (c.aoxReview && c.aoxReview.outsourcePartner) || null; }

// ── Design Team queue (sub-tabs by phase + design routes) ───────────
// A routed case (Bar Design / VJig / Milling) stays at stage 'Design Check' and is
// bucketed by aoxReview.designRoute. Outsource cases are stage 'Outsourcing' and
// grouped by aoxReview.outsourcePartner. Milling sits last (after Complete).
let designTab = 'design';
const DESIGN_SUBTABS = [
  ['design', 'Design', c => c.stage === 'Design Check' && !designRouteOf(c)],
  ['bar', 'Bar Design', c => c.stage === 'Design Check' && designRouteOf(c) === 'bar'],
  ['vjig', 'Design VJig/Custom Tray', c => c.stage === 'Design Check' && designRouteOf(c) === 'vjig'],
  ['outsource', 'Outsource', c => c.stage === 'Outsourcing'],
  ['qc', 'QC', c => c.stage === 'QC'],
  ['rework', 'Rework', c => c.stage === 'QC Failed - Rework' || c.stage === 'QC Failed - Resend'],
  ['complete', 'Complete', c => c.stage === 'Complete'],
  ['milling', 'Milling', c => c.stage === 'Design Check' && designRouteOf(c) === 'milling'],
];
function renderOutsourceGroups(list) {
  if (!list.length) return emptyMsg('No cases here');
  let html = ''; const assigned = new Set();
  Object.keys(OUTSOURCE_PARTNERS).forEach((key, i) => {
    const g = list.filter(c => partnerOf(c) === key); g.forEach(c => assigned.add(c.id));
    html += `<div class="sec-label"${i === 0 ? ' style="margin-top:0"' : ''}>${OUTSOURCE_PARTNERS[key]} <span style="color:var(--color-text-tertiary)">(${g.length})</span></div>` + (g.length ? tblWrap(g, 'design') : emptyMsg('No cases for ' + OUTSOURCE_PARTNERS[key]));
  });
  const other = list.filter(c => !assigned.has(c.id));
  if (other.length) html += `<div class="sec-label">Unassigned <span style="color:var(--color-text-tertiary)">(${other.length})</span></div>` + tblWrap(other, 'design');
  return html;
}
function renderDesignQueue() {
  const tabs = DESIGN_SUBTABS.map(([k, label, pred]) => {
    const n = cases.filter(pred).length;
    return `<button class="de-tab${designTab === k ? ' active' : ''}" onclick="CF.setDesignTab('${k}')">${label}<span class="de-tab-count">${n}</span></button>`;
  }).join('');
  const active = DESIGN_SUBTABS.find(t => t[0] === designTab) || DESIGN_SUBTABS[0];
  const list = sortByShip(cases.filter(active[2]));
  const head = `<div style="font-size:16px;font-weight:600;margin-bottom:12px">Design Team</div>`;
  const body = designTab === 'outsource' ? renderOutsourceGroups(list)
    : designTab === 'qc' ? renderQcTab(list)
    : designTab === 'complete' ? renderCompleteTab(list)
    : (list.length ? tblWrap(list, 'design') : emptyMsg('No cases here'));
  return head + `<div class="de-tabs">${tabs}</div>` + queueSearchBar() + body;
}
function setDesignTab(t) { designTab = t; renderMode('design'); }
// QC tab: grouped by outsource partner (like the Outsource step) + a partner filter.
let qcPartnerFilter = 'all';
function setQcPartner(p) { qcPartnerFilter = p; renderMode('design'); }
function renderQcTab(list) {
  const opts = [['all', 'All'], ['adite', 'Adite'], ['heygears', 'HeyGears'], ['cadora', 'Cadora']];
  const filterBar = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap"><span class="sec-label" style="margin:0">Filter by partner</span>${opts.map(([k, label]) => `<button class="de-tab${qcPartnerFilter === k ? ' active' : ''}" onclick="CF.setQcPartner('${k}')">${label}</button>`).join('')}</div>`;
  let body;
  if (qcPartnerFilter === 'all') body = renderOutsourceGroups(list);
  else { const g = list.filter(c => partnerOf(c) === qcPartnerFilter); body = g.length ? tblWrap(g, 'design') : emptyMsg('No QC cases for ' + (OUTSOURCE_PARTNERS[qcPartnerFilter] || qcPartnerFilter)); }
  return filterBar + body;
}

// ── Complete tab (filter by completion date + outsource partner) ────
// "Completed (PST)" is derived from the QC-pass timeline event — the moment the
// "Confirm QC Pass — Mark Complete" button was pressed (advanceStage → cfEvent
// stamps a UTC instant). No new DB column: existing completed cases backfill
// from that same event; any case lacking it shows "—".
let completePartner = 'all';   // 'all' | 'adite' | 'heygears' | 'cadora'
let completeFrom = '';         // 'YYYY-MM-DD' (Pacific), inclusive lower bound
let completeTo = '';           // 'YYYY-MM-DD' (Pacific), inclusive upper bound
function completedAtIso(c) {
  const ev = (c.timeline || []).filter(e => e && /case complete/i.test(e.text || '')).pop();
  return ev && ev.at ? ev.at : null;
}
function fmtPstTs(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return '';
  const tz = { timeZone: 'America/Los_Angeles' };
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...tz });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, ...tz });
  return date + ' ' + time + ' PST';
}
function completedPacificDate(c) {
  const iso = completedAtIso(c); if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // YYYY-MM-DD for range compare
}
function partnerLabel(c) { const p = partnerOf(c); return p ? (OUTSOURCE_PARTNERS[p] || p) : '—'; }
// Most-recently-completed first; cases without a recorded completion sink to the bottom.
function sortByCompleted(list) {
  return list.slice().sort((a, b) => {
    const av = completedAtIso(a) || '', bv = completedAtIso(b) || '';
    if (av && bv) return av < bv ? 1 : (av > bv ? -1 : 0);
    if (av) return -1; if (bv) return 1; return 0;
  });
}
function applyCompleteFilters(list) {
  return list.filter(c => {
    if (completePartner !== 'all' && partnerOf(c) !== completePartner) return false;
    if (completeFrom || completeTo) {
      const cd = completedPacificDate(c);
      if (!cd) return false;                       // can't date-filter a case with no completion time
      if (completeFrom && cd < completeFrom) return false;
      if (completeTo && cd > completeTo) return false;
    }
    return true;
  });
}
function completeTblRows(list) {
  return list.map(c => {
    const ts = fmtPstTs(completedAtIso(c));
    return `<div class="case-row" data-search="${esc((c.caseNum || '') + ' ' + (c.id || ''))}" onclick="CF.openCase('design','${c.id}')" tabindex="0" role="button">`
      + `<div class="td case-id">${c.caseNum || '—'}</div>`
      + `<div class="td"><span style="font-weight:500">${esc(c.patient)}</span></div>`
      + `<div class="td" style="font-size:12px;color:var(--color-text-secondary)">${esc(c.doctor)}</div>`
      + `<div class="td" style="font-size:12px">${esc(partnerLabel(c))}</div>`
      + `<div class="td">${rushBadge(c.rush)}</div>`
      + `<div class="td">${fmtDate(c.shipDate)}</div>`
      + `<div class="td">${fmtDate(c.drDueDate)}</div>`
      + `<div class="td" style="font-size:12px">${ts ? esc(ts) : '<span style="color:var(--color-text-tertiary)">—</span>'}</div>`
      + `</div>`;
  }).join('');
}
function completeTblWrap(list) {
  return `<div class="cases-table cases-table-complete"><div class="table-header">`
    + `<div class="th">Case #</div><div class="th">Patient</div><div class="th">Doctor</div><div class="th">Partner</div><div class="th">Rush</div><div class="th">Ship Date</div><div class="th">Dr Due Date</div><div class="th">Completed (PST)</div>`
    + `</div>${completeTblRows(list)}</div>`;
}
function renderCompleteTab(list) {
  const filtered = sortByCompleted(applyCompleteFilters(list));
  const partners = [['all', 'All'], ['adite', 'Adite'], ['heygears', 'HeyGears'], ['cadora', 'Cadora']];
  const partnerBtns = partners.map(([k, label]) => `<button class="de-tab${completePartner === k ? ' active' : ''}" onclick="CF.setCompletePartner('${k}')">${esc(label)}</button>`).join('');
  const hasFilter = completeFrom || completeTo || completePartner !== 'all';
  const dateFrom = `<input type="date" class="cf-date-input"${completeFrom ? ` value="${esc(completeFrom)}"` : ''}${completeTo ? ` max="${esc(completeTo)}"` : ''} onchange="CF.setCompleteFrom(this.value)" aria-label="Completed on or after" />`;
  const dateTo = `<input type="date" class="cf-date-input"${completeTo ? ` value="${esc(completeTo)}"` : ''}${completeFrom ? ` min="${esc(completeFrom)}"` : ''} onchange="CF.setCompleteTo(this.value)" aria-label="Completed on or before" />`;
  const filterBar = `<div class="cf-complete-filters">`
    + `<div class="cf-cf-group"><span class="sec-label" style="margin:0">Date completed</span>${dateFrom}<span style="color:var(--color-text-tertiary);font-size:12px">to</span>${dateTo}</div>`
    + `<div class="cf-cf-group"><span class="sec-label" style="margin:0">Partner</span>${partnerBtns}</div>`
    + (hasFilter ? `<button class="btn btn-sm" onclick="CF.clearCompleteFilters()">Clear filters</button>` : '')
    + `</div>`;
  const body = filtered.length ? completeTblWrap(filtered) : emptyMsg('No completed cases match these filters');
  return filterBar + body;
}
function setCompletePartner(p) { completePartner = p; renderMode('design'); }
function setCompleteFrom(v) { completeFrom = v || ''; renderMode('design'); }
function setCompleteTo(v) { completeTo = v || ''; renderMode('design'); }
function clearCompleteFilters() { completePartner = 'all'; completeFrom = ''; completeTo = ''; renderMode('design'); }

// ── Data Entry queue (3 sub-tabs) ───────────────────────────────────
let deTab = 'main';
function renderDataEntryQueue() {
  const de = cases.filter(c => c.stage === 'Data Entry');
  const isReturned = c => !!(c.aox && c.aox.returnedFromReview);
  const returned = de.filter(isReturned);
  const main = de.filter(c => !c.deHold && !isReturned(c)), models = de.filter(c => c.deHold === 'models'), missing = de.filter(c => c.deHold === 'missing');
  const tabs = [['main', 'Data Entry', main.length], ['models', 'Waiting for physical models', models.length], ['missing', 'Waiting for missing information', missing.length], ['returned', 'Returned from Case Review for missing/incorrect information', returned.length]]
    .map(t => `<button class="de-tab${deTab === t[0] ? ' active' : ''}" onclick="CF.setDeTab('${t[0]}')">${t[1]}<span class="de-tab-count">${t[2]}</span></button>`).join('');
  const list = sortByShip(deTab === 'models' ? models : (deTab === 'missing' ? missing : (deTab === 'returned' ? returned : main)));
  const head = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><div style="font-size:16px;font-weight:600">Data Entry</div><button class="btn btn-primary btn-sm" onclick="CF.openNewCase()"><i class="ti ti-plus"></i> New Case</button></div>`;
  return head + `<div class="de-tabs">${tabs}</div>` + queueSearchBar() + (list.length ? tblWrap(list, 'dataentry') : emptyMsg('No cases here'));
}
function setDeTab(t) { deTab = t; renderMode('dataentry'); }

// ── Case Review queue (sub-tabs: main + design returns / holds / TA) ─
let crTab = 'main';
function crBucketOf(c) { return (c.aoxReview && c.aoxReview.crBucket) || null; }
function renderCaseReviewQueue() {
  const cr = cases.filter(c => c.stage === 'Review' || c.stage === 'Case Coordination');
  const designReturn = cr.filter(c => crBucketOf(c) === 'design_return');
  const holdMissing = cr.filter(c => crBucketOf(c) === 'hold_missing');
  const ta = cr.filter(c => crBucketOf(c) === 'ta');
  const main = cr.filter(c => !crBucketOf(c)); // plain Review + Case Coordination
  const tabs = [['main', 'Case Review', main.length], ['design_return', 'Cases sent back from Design', designReturn.length], ['hold_missing', 'Holds for missing information', holdMissing.length], ['ta', 'Technical advisor', ta.length]]
    .map(t => `<button class="de-tab${crTab === t[0] ? ' active' : ''}" onclick="CF.setCrTab('${t[0]}')">${t[1]}<span class="de-tab-count">${t[2]}</span></button>`).join('');
  const list = sortByShip(crTab === 'design_return' ? designReturn : (crTab === 'hold_missing' ? holdMissing : (crTab === 'ta' ? ta : main)));
  const head = `<div style="font-size:16px;font-weight:600;margin-bottom:12px">Case Review</div>`;
  return head + `<div class="de-tabs">${tabs}</div>` + queueSearchBar() + (list.length ? tblWrap(list, 'casereview') : emptyMsg('No cases here'));
}
function setCrTab(t) { crTab = t; renderMode('casereview'); }

// ── navigation ──────────────────────────────────────────────────────
function openCase(mode, id) {
  if (selectedMode && selectedMode !== mode) { const prev = selectedMode; selectedMode = null; renderMode(prev); }
  selectedMode = mode; selectedCaseId = id; qcSel = null; adjSel = null;
  renderMode(mode);
}
function goBack(mode) { selectedCaseId = null; renderMode(mode); }

// advanceStage: update stage, log event, persist, keep detail open (faithful).
function advanceStage(id, ns, log, by) {
  const c = getC(id); if (!c) return;
  c.stage = ns; cfEvent(c, log, by); cfSave(c);
  if (selectedMode) renderMode(selectedMode);
  toast(log);
}

// =====================================================================
// AOX Review checklist (Case Review) — ported
// =====================================================================
function buildAoxReviewChecklist(caseId) {
  const r = getR(caseId);
  const acct = r.acctType || null;
  function pfRow(group, idx, label) {
    const val = r[group] && r[group][idx];
    return `<div class="pf-row"><span class="pf-label">${label}</span><div class="pf-btns"><button class="pf-btn${val === 'pass' ? ' pass' : ''}" onclick="CF.setPF('${caseId}','${group}',${idx},'pass')">Pass</button><button class="pf-btn${val === 'fail' ? ' fail' : ''}" onclick="CF.setPF('${caseId}','${group}',${idx},'fail')">Fail</button></div></div>`;
  }
  function fileDrop(name, accept) {
    const key = name.replace(/[^a-zA-Z0-9]/g, '_');
    const acc = accept || '';
    const files = (r.aspFiles && r.aspFiles[key]) || [];
    const list = files.length ? `<div class="file-list">${files.map((f, fi) => `<div class="file-item"><i class="ti ti-file"></i><span class="file-name">${esc(f.name)}</span><span class="file-size">${f.size}</span><button class="btn btn-sm" style="margin-left:auto;padding:2px 7px" onclick="CF.aspRemoveFile('${caseId}','${key}',${fi})"><i class="ti ti-x"></i></button></div>`).join('')}</div>` : '';
    return `<div class="form-group" style="margin-bottom:10px"><label>${name}</label><div class="upload-zone" ondragover="CF.aspDragOver(event)" ondragleave="CF.aspDragLeave(event)" ondrop="CF.aspDrop(event,'${caseId}','${key}','${acc}')" onclick="CF.aspPick('${caseId}','${key}','${acc}')"><div class="upload-icon"><i class="ti ti-upload"></i></div><div class="upload-text">Drag files here or click to attach</div>${acc ? `<div class="upload-hint">Accepts ${acc} files</div>` : ''}</div>${list}</div>`;
  }
  function reviewSections() {
    return `
      <div class="aox-section">
        <div class="aox-section-title"><i class="ti ti-file-description" style="font-size:13px;color:#136AA3"></i> Rx and Work Ticket Review</div>
        <div class="aox-subsection"><div class="aox-subsection-title">Basic Info Check</div>${BASIC_INFO_ITEMS.map((lbl, i) => pfRow('basicInfo', i, lbl)).join('')}</div>
        <div class="aox-subsection"><div class="aox-subsection-title">Product &amp; Workflow Confirmation</div>${PRODUCT_ITEMS.map((lbl, i) => pfRow('productInfo', i, lbl)).join('')}</div>
        <div class="form-group" style="margin-top:12px"><label>Rx &amp; Work Ticket Notes</label><textarea id="rx-notes" placeholder="Add notes here..." onchange="CF.saveReviewNotes('${caseId}')">${esc(r.rxNotes || '')}</textarea></div>
      </div>
      <div class="aox-section">
        <div class="aox-section-title"><i class="ti ti-scan" style="font-size:13px;color:#6B5E2F"></i> Scan and Files</div>
        ${SCAN_ITEMS.map((lbl, i) => pfRow('scanItems', i, lbl)).join('')}
        <span class="sec-label">Attach scan files</span>
        ${TRI_SCAN_SECTIONS.map(n => fileDrop(n)).join('')}
        <div class="d-check-item${r.predesigned ? ' checked' : ''}" onclick="CF.togglePredesigned('${caseId}')" style="margin-top:6px"><input type="checkbox" ${r.predesigned ? 'checked' : ''}><label>Predesigned Case</label></div>
        ${r.predesigned ? `<div style="margin-top:10px">${fileDrop('Predesign CAD', '.cad,.stl')}</div>` : ''}
        <div class="form-group" style="margin-top:12px"><label>Scans / Files Notes</label><textarea id="scan-notes" placeholder="Add notes here..." onchange="CF.saveReviewNotes('${caseId}')">${esc(r.scanNotes || '')}</textarea></div>
      </div>
      <div class="aox-section">
        <div class="aox-section-title"><i class="ti ti-palette" style="font-size:13px;color:#0A2C42"></i> Design Needs</div>
        <span class="sec-label" style="margin-top:0">Select design type</span>
        <div class="design-needs-grid">${DESIGN_NEEDS_OPTS.map((lbl, i) => `<button class="dn-btn${r.designNeeds === i ? ' active' : ''}" onclick="CF.setDesignNeeds('${caseId}',${i})">${lbl}</button>`).join('')}</div>
        <span class="sec-label">Doctor Design Approval Needed?</span>
        <div class="yn-grid"><button class="yn-btn${r.drApproval === 'yes' ? ' active-yes' : ''}" onclick="CF.setDrApproval('${caseId}','yes')">Yes</button><button class="yn-btn${r.drApproval === 'no' ? ' active-no' : ''}" onclick="CF.setDrApproval('${caseId}','no')">No</button></div>
      </div>`;
  }
  let acctContent = '';
  if (acct === 'tri') acctContent = reviewSections();
  if (acct === 'asp') {
    const spec = r.aspSpec || {};
    const lfxYes = spec.lfx === 'yes', lfxNo = spec.lfx === 'no', ccDigYes = spec.ccDigital === 'yes';
    function archSubsection(archKey, title, opts, isTi) {
      const sel = r['asp' + archKey]; const loc = r['asp' + archKey + 'Loc'];
      const showLoc = isTi && (sel === 2 || sel === 3) && loc;
      return `<div class="aox-subsection"><div class="aox-subsection-title">${title}</div><div class="design-needs-grid" style="grid-template-columns:1fr 1fr">${opts.map((lbl, i) => `<button class="dn-btn${sel === i ? ' active' : ''}" onclick="CF.setAspArch('${caseId}','${archKey}',${i})">${lbl}</button>`).join('')}</div>${showLoc ? `<div class="info-pair" style="margin-top:8px;border:none;padding-bottom:0"><span class="info-key">Location(s)</span><span class="info-val">${esc(loc)}</span></div>` : ''}</div>`;
    }
    const specRow = (key, lbl) => `<div class="pf-row"><span class="pf-label">${lbl}</span><div class="pf-btns"><button class="pf-btn${spec[key] === 'yes' ? ' pass' : ''}" onclick="CF.setAspSpec('${caseId}','${key}','yes')">Yes</button><button class="pf-btn${spec[key] === 'no' ? ' fail' : ''}" onclick="CF.setAspSpec('${caseId}','${key}','no')">No</button></div></div>`;
    const rxSection = `
      <div class="aox-section">
        <div class="aox-section-title"><i class="ti ti-file-description" style="font-size:13px;color:#136AA3"></i> Rx and Work Ticket Review</div>
        <div class="aox-subsection"><div class="aox-subsection-title">Basic Info Check</div>${BASIC_INFO_ITEMS.map((lbl, i) => pfRow('basicInfo', i, lbl)).join('')}</div>
        <div class="aox-subsection"><div class="aox-subsection-title">Product &amp; Workflow Confirmation</div>${PRODUCT_ITEMS.map((lbl, i) => pfRow('productInfo', i, lbl)).join('')}</div>
        <div class="form-group" style="margin-top:12px"><label>Rx &amp; Work Ticket Notes</label><textarea id="rx-notes" placeholder="Add notes here..." onchange="CF.saveReviewNotes('${caseId}')">${esc(r.rxNotes || '')}</textarea></div>
      </div>`;
    const designReqSection = `
      <div class="aox-section">
        <div class="aox-section-title"><i class="ti ti-ruler-2" style="font-size:13px;color:#0A2C42"></i> Design Requirements</div>
        <div class="design-needs-grid" style="grid-template-columns:1fr 1fr 1fr">${ASP_DESIGN_REQ.map((lbl, i) => `<button class="dn-btn${r.aspDesignReq === i ? ' active' : ''}" onclick="CF.setAspDesignReq('${caseId}',${i})">${lbl}</button>`).join('')}</div>
        ${(r.aspDesignReq === 1 || r.aspDesignReq === 2) && r.aspMouldName ? `<div class="info-pair" style="margin-top:10px;border:none;padding-bottom:0"><span class="info-key">${r.aspDesignReq === 1 ? 'Tooth mould' : 'Mould name'}</span><span class="info-val">${esc(r.aspMouldName)}</span></div>` : ''}
      </div>`;
    const designSpecSection = `<div class="aox-section"><div class="aox-section-title"><i class="ti ti-adjustments" style="font-size:13px;color:#6B5E2F"></i> Design Specifics</div>${ASP_SPEC_ITEMS.map(it => specRow(it[0], it[1])).join('')}</div>`;
    let scanSection = '';
    if (lfxYes || lfxNo) {
      const scans = lfxYes ? ASP_LFX_SCANS.slice() : ASP_NONLFX_SCANS.slice();
      if (lfxNo && ccDigYes) scans.push('iCAM Data');
      scanSection = `<div class="aox-section"><div class="aox-section-title"><i class="ti ti-files" style="font-size:13px;color:#157031"></i> Required Scans and Files</div>${scans.map(n => fileDrop(n)).join('')}</div>`;
    }
    let verifiedSection = '', screwSection = '';
    if (lfxNo) {
      if (!ccDigYes) {
        const vm = r.aspVerifiedModel; let archSub = '';
        if (vm === 'tibase') archSub = archSubsection('TiUpper', 'Upper', ASP_TIBASE_OPTS, true) + archSubsection('TiLower', 'Lower', ASP_TIBASE_OPTS, true);
        else if (vm === 'scanbody') archSub = archSubsection('SbUpper', 'Upper', ASP_SCANBODY_OPTS, false) + archSubsection('SbLower', 'Lower', ASP_SCANBODY_OPTS, false);
        verifiedSection = `<div class="aox-section"><div class="aox-section-title"><i class="ti ti-checkup-list" style="font-size:13px;color:#136AA3"></i> Verified Model</div><div class="acct-type-grid" style="margin-bottom:${vm ? '12px' : '0'}"><button class="acct-btn${vm === 'tibase' ? ' active-asp' : ''}" onclick="CF.setAspVerifiedModel('${caseId}','tibase')">Ti Base</button><button class="acct-btn${vm === 'scanbody' ? ' active-asp' : ''}" onclick="CF.setAspVerifiedModel('${caseId}','scanbody')">Scan body</button></div>${archSub}</div>`;
      }
      const screwIdxs = ccDigYes ? [6, 7] : ASP_SCREW_OPTS.map((_, i) => i);
      screwSection = `<div class="aox-section"><div class="aox-section-title"><i class="ti ti-tool" style="font-size:13px;color:#8E6510"></i> Final Screws</div><div class="form-group" style="margin-bottom:12px"><label>Total number of screws</label><input type="text" id="asp-screw-count" value="${dclAttr(r.aspScrewCount || '')}" placeholder="e.g. 6" onchange="CF.setAspScrewCount('${caseId}',this.value)"></div><span class="sec-label" style="margin-top:0">Screw type</span>${screwIdxs.map(i => `<div class="opt-row${r.aspScrewType === i ? ' sel' : ''}" onclick="CF.setAspScrewType('${caseId}',${i})"><input type="radio" ${r.aspScrewType === i ? 'checked' : ''}><span class="opt-row-label">${ASP_SCREW_OPTS[i]}</span></div>`).join('')}</div>`;
    }
    acctContent = rxSection + designReqSection + designSpecSection + scanSection + verifiedSection + screwSection;
  }
  return `<div class="aox-checklist-panel" id="aox-review-cl-${caseId}"><div class="aox-cl-title"><i class="ti ti-clipboard-list" style="font-size:16px"></i> AoX Case Review Checklist</div><span class="sec-label" style="margin-top:0">Account type</span><div class="acct-type-grid"><button class="acct-btn${acct === 'tri' ? ' active-tri' : ''}" onclick="CF.setAcctType('${caseId}','tri')"><i class="ti ti-building-factory-2" style="font-size:14px;display:block;margin-bottom:3px"></i>TRI / Legacy Account</button><button class="acct-btn${acct === 'asp' ? ' active-asp' : ''}" onclick="CF.setAcctType('${caseId}','asp')"><i class="ti ti-building-hospital" style="font-size:14px;display:block;margin-bottom:3px"></i>ASPEN &amp; ClearChoice</button></div>${acctContent}</div>`;
}
function rebuildAoxReview(caseId) {
  const old = document.getElementById(`aox-review-cl-${caseId}`); if (!old) return;
  saveReviewNotes(caseId);
  const tmp = document.createElement('div'); tmp.innerHTML = buildAoxReviewChecklist(caseId);
  old.parentNode.replaceChild(tmp.firstElementChild, old);
  cfSave(getC(caseId));
}
function setAcctType(id, type) { const r = getR(id); r.acctType = r.acctType === type ? null : type; rebuildAoxReview(id); }
function setAspDesignReq(id, idx) { const r = getR(id); if (r.aspDesignReq === idx) { r.aspDesignReq = null; r.aspMouldName = ''; } else { r.aspDesignReq = idx; if (idx === 1) { const t = prompt('Enter the tooth mould to be used:', r.aspMouldName || ''); if (t !== null) r.aspMouldName = t.trim(); } else if (idx === 2) { const name = prompt('Enter Mould name:', r.aspMouldName || ''); if (name !== null) r.aspMouldName = name.trim(); } else { r.aspMouldName = ''; } } rebuildAoxReview(id); }
function setAspSpec(id, key, val) { const r = getR(id); if (!r.aspSpec) r.aspSpec = {}; r.aspSpec[key] = r.aspSpec[key] === val ? null : val; rebuildAoxReview(id); }
function setAspVerifiedModel(id, val) { const r = getR(id); r.aspVerifiedModel = r.aspVerifiedModel === val ? null : val; rebuildAoxReview(id); }
function setAspArch(id, arch, idx) { const r = getR(id); const k = 'asp' + arch; if (r[k] === idx) { r[k] = null; } else { r[k] = idx; if ((arch === 'TiUpper' || arch === 'TiLower') && (idx === 2 || idx === 3)) { const lbl = idx === 2 ? 'DESS ASC' : 'Other'; const loc = prompt('Enter location(s) for ' + lbl + ':', r[k + 'Loc'] || ''); if (loc !== null) r[k + 'Loc'] = loc.trim(); } } rebuildAoxReview(id); }
function setAspScrewType(id, idx) { const r = getR(id); r.aspScrewType = r.aspScrewType === idx ? null : idx; rebuildAoxReview(id); }
function setAspScrewCount(id, val) { getR(id).aspScrewCount = val; cfSave(getC(id)); }
function aspDragOver(ev) { ev.preventDefault(); ev.stopPropagation(); ev.currentTarget.classList.add('drag-over'); }
function aspDragLeave(ev) { ev.currentTarget.classList.remove('drag-over'); }
function acceptOk(name, accept) { if (!accept) return true; const exts = accept.split(',').map(s => s.trim().toLowerCase()).filter(Boolean); const lower = String(name || '').toLowerCase(); return exts.some(e => lower.endsWith(e)); }
function filterByAccept(files, accept) { if (!accept) return files; const ok = files.filter(f => acceptOk(f.name, accept)); if (ok.length < files.length) toast('Only ' + accept + ' files are accepted here'); return ok; }
async function aspDrop(ev, id, key, accept) { ev.preventDefault(); ev.stopPropagation(); ev.currentTarget.classList.remove('drag-over'); const fl = ev.dataTransfer && ev.dataTransfer.files; if (fl && fl.length) { const files = filterByAccept(Array.from(fl), accept); if (files.length) await uploadReviewFiles(id, key, files); } }
function aspPick(id, key, accept) { pickFiles(async files => { const ok = filterByAccept(files, accept); if (ok.length) await uploadReviewFiles(id, key, ok); }, accept); }
function togglePredesigned(id) { const r = getR(id); r.predesigned = !r.predesigned; rebuildAoxReview(id); }
async function uploadReviewFiles(id, key, files) {
  const c = getC(id); const r = getR(id); if (!r.aspFiles) r.aspFiles = {}; if (!r.aspFiles[key]) r.aspFiles[key] = [];
  for (const f of files) { try { const meta = await Data.uploadFile(c, 'review', f, key); r.aspFiles[key].push({ name: meta.name, size: meta.size, path: meta.path }); } catch (e) { toast('Upload failed: ' + e.message); } }
  rebuildAoxReview(id);
}
function aspRemoveFile(id, key, idx) { const r = getR(id); if (r.aspFiles && r.aspFiles[key]) { r.aspFiles[key].splice(idx, 1); rebuildAoxReview(id); } }
function setPF(id, group, idx, val) { const r = getR(id); if (!r[group]) r[group] = {}; r[group][idx] = r[group][idx] === val ? null : val; rebuildAoxReview(id); }
function setDesignNeeds(id, idx) { const r = getR(id); r.designNeeds = r.designNeeds === idx ? null : idx; rebuildAoxReview(id); }
function setDrApproval(id, val) { const r = getR(id); r.drApproval = r.drApproval === val ? null : val; rebuildAoxReview(id); }
function saveReviewNotes(id) {
  const r = getR(id);
  const rx = document.getElementById('rx-notes'); if (rx) r.rxNotes = rx.value;
  const sn = document.getElementById('scan-notes'); if (sn) r.scanNotes = sn.value;
  const sc = document.getElementById('asp-screw-count'); if (sc) r.aspScrewCount = sc.value;
  if (document.querySelector('.design-req-input')) saveDesignReqs(id);
  cfSave(getC(id));
}

// ── Doctor requirements editor (shared Review + Design) ─────────────
function renderDesignReqs(c) {
  const reqs = (c.designReqs && c.designReqs.length) ? c.designReqs : [''];
  c.designReqs = reqs;
  return reqs.map((val, i) => `<div style="display:flex;gap:6px;align-items:flex-start;margin-bottom:8px"><textarea class="design-req-input" data-idx="${i}" placeholder="Requirement ${i + 1}" style="min-height:46px" oninput="CF.saveDesignReqs('${c.id}')">${esc(val)}</textarea>${reqs.length > 1 ? `<button class="btn btn-sm btn-danger" style="padding:6px 8px" onclick="CF.removeDesignReq('${c.id}',${i})"><i class="ti ti-x"></i></button>` : ''}</div>`).join('');
}
function saveDesignReqs(id) { const c = getC(id); if (!c) return; const inputs = document.querySelectorAll('.design-req-input'); if (inputs.length) c.designReqs = Array.from(inputs).map(t => t.value); c.designNotes = (c.designReqs || []).filter(x => x.trim()).join(' • '); cfSave(c); }
function addDesignReq(id) { const c = getC(id); if (!c) return; saveDesignReqs(id); if (!c.designReqs) c.designReqs = []; c.designReqs.push(''); const el = document.getElementById('design-reqs-list'); if (el) el.innerHTML = renderDesignReqs(c); }
function removeDesignReq(id, idx) { const c = getC(id); if (!c) return; saveDesignReqs(id); c.designReqs.splice(idx, 1); if (!c.designReqs.length) c.designReqs = ['']; const el = document.getElementById('design-reqs-list'); if (el) el.innerHTML = renderDesignReqs(c); }
function doctorReqsPanel(c) {
  const reqs = (c.designReqs || []).filter(x => x && x.trim());
  if (!reqs.length) return '';
  const ack = `<div style="border-top:0.5px solid var(--color-border-tertiary);margin-top:10px;padding-top:10px"><div class="d-check-item${c.reqsAck ? ' checked' : ''}" onclick="CF.toggleReqsAck('${c.id}')"><input type="checkbox" ${c.reqsAck ? 'checked' : ''}><label>I have reviewed these doctor requirements</label></div>${c.reqsAck && c.reqsAckAt ? `<div style="font-size:11px;color:var(--color-text-tertiary);margin-top:6px;padding-left:2px"><i class="ti ti-user-check" style="font-size:12px"></i> Acknowledged by ${esc(c.reqsAckBy)} • ${fmtTs(c.reqsAckAt)}</div>` : ''}</div>`;
  return `<div class="panel"><div class="panel-title"><i class="ti ti-notes" style="color:#6B5E2F"></i> Doctor Requirements</div><div class="d-checklist">${reqs.map((req, i) => `<div class="d-check-item" style="cursor:default;align-items:flex-start"><span style="font-size:13px;line-height:1.45"><strong style="color:#6B5E2F">${i + 1}.</strong> ${esc(req)}</span></div>`).join('')}</div>${ack}</div>`;
}
function toggleReqsAck(id) { const c = getC(id); if (!c) return; c.reqsAck = !c.reqsAck; if (c.reqsAck) { c.reqsAckBy = Data.currentUser(); c.reqsAckAt = new Date().toISOString(); cfEvent(c, 'Doctor requirements acknowledged'); } else { cfEvent(c, 'Doctor requirements acknowledgment removed'); c.reqsAckBy = null; c.reqsAckAt = null; } cfSave(c); if (selectedMode) renderMode(selectedMode); }

// =====================================================================
// AOX Data-Entry checklist — ported
// =====================================================================
function optRows(arrKey, selIdx) { return OPTS[arrKey].map((txt, i) => `<div class="opt-row${selIdx === i ? ' sel' : ''}" data-aox-field="${arrKey}" data-aox-val="${i}"><input type="radio" ${selIdx === i ? 'checked' : ''}><span class="opt-row-label">${txt}</span></div>`).join(''); }
// Same as optRows but skips the given indices, keeping the original index as the
// stored value (so hiding an option doesn't shift/break other selections).
function optRowsExcept(arrKey, selIdx, exclude) { return OPTS[arrKey].map((txt, i) => (exclude || []).includes(i) ? '' : `<div class="opt-row${selIdx === i ? ' sel' : ''}" data-aox-field="${arrKey}" data-aox-val="${i}"><input type="radio" ${selIdx === i ? 'checked' : ''}><span class="opt-row-label">${txt}</span></div>`).join(''); }
// PMMA Options (Analog Milled mounted / No Mounting) — used by Aspen & SKD when
// PMMA is the chosen recipe material; `field` is the per-DSO state key.
function pmmaOptRows(field, sel) { return OPTS.PMMA_OPTS.map((txt, i) => `<div class="opt-row${sel === i ? ' sel' : ''}" data-aox-field="${field}" data-aox-val="${i}"><input type="radio" ${sel === i ? 'checked' : ''}><span class="opt-row-label">${txt}</span></div>`).join(''); }
function typeGrid(labels, selIdx, fieldKey) { return `<div class="type-grid">${labels.map((txt, i) => `<div class="opt-row${selIdx === i ? ' sel' : ''}" data-aox-field="${fieldKey}" data-aox-val="${i}"><input type="radio" ${selIdx === i ? 'checked' : ''}><span class="opt-row-label">${txt}</span></div>`).join('')}</div>`; }
function typeGrid3(labels, selIdx, fieldKey) { return `<div class="type-grid-3">${labels.map((txt, i) => `<div class="opt-row${selIdx === i ? ' sel' : ''}" data-aox-field="${fieldKey}" data-aox-val="${i}"><input type="radio" ${selIdx === i ? 'checked' : ''}><span class="opt-row-label">${txt}</span></div>`).join('')}</div>`; }
// CC add-ons: DAVINCI Finish (idx 0) and ClearChoice ICAM fee (idx 1) are
// independent checkboxes selectable alongside each other and any main option.
// Shown for both New and Continuation case types.
function ccAddons(a) {
  const items = OPTS.CC_NEW;
  const addon = (i, key) => `<div class="opt-row${a[key] ? ' sel' : ''}" data-aox-toggle="${key}"><input type="checkbox" ${a[key] ? 'checked' : ''}><span class="opt-row-label">${items[i]}</span></div>`;
  return `<span class="sec-label">Optional — Select Any</span>${addon(0, 'ccDavinci')}${addon(1, 'ccIcamFee')}`;
}
// CC New main options (idx 2+ of CC_NEW, single-select into ccOption) + add-ons.
function ccNewOptions(a) {
  const items = OPTS.CC_NEW;
  let html = ccAddons(a) + '<span class="sec-label">Select option</span>';
  for (let i = 2; i < items.length; i++) html += `<div class="opt-row${a.ccOption === i ? ' sel' : ''}" data-aox-field="CC_NEW" data-aox-val="${i}"><input type="radio" ${a.ccOption === i ? 'checked' : ''}><span class="opt-row-label">${items[i]}</span></div>`;
  return html;
}
function buildCCRecipe(a) { if (a.cat !== 'CC' || !isSet(a.ccType)) return ''; const isNew = a.ccType === 0, digSet = isSet(a.rcpDigital), noKey = isNew ? 'RCP_NO_NEW' : 'RCP_NO_CONT'; return `<div class="recipe-block"><div class="recipe-block-title"><i class="ti ti-chef-hat" style="font-size:14px"></i> Recipe Selection</div><span class="sec-label" style="margin-top:0">Digital Workflow?</span>${typeGrid(['Yes', 'No'], digSet ? a.rcpDigital : -1, 'rcpDigital')}${digSet && a.rcpDigital === 0 ? `<span class="sec-label">Select workflow</span>${optRows('RCP_DIG_YES', isSet(a.rcpOption) ? a.rcpOption : -1)}` : ''}${digSet && a.rcpDigital === 1 ? `<span class="sec-label">Select option</span>${optRows(noKey, isSet(a.rcpOption) ? a.rcpOption : -1)}` : ''}</div>`; }
function buildASPRecipe(a) { if (a.cat !== 'ASP') return ''; if (a.aspSub === 0 && isSet(a.aspType)) { if (a.aspFinal === 3) return ''; if (a.aspFinal === 2) { return `<div class="recipe-block"><div class="recipe-block-title"><i class="ti ti-chef-hat" style="font-size:14px"></i> Recipe Selection</div><span class="sec-label" style="margin-top:0">Verification Jig Type</span>${optRows('ASP_RCP_VJ', isSet(a.aspRcpVJ) ? a.aspRcpVJ : -1)}</div>`; } if (a.aspFinal === 1) { return `<div class="recipe-block"><div class="recipe-block-title"><i class="ti ti-chef-hat" style="font-size:14px"></i> Recipe Selection</div><span class="sec-label" style="margin-top:0">PMMA Options</span>${pmmaOptRows('aspRcpPmmaType', isSet(a.aspRcpPmmaType) ? a.aspRcpPmmaType : -1)}</div>`; } if (a.aspFinal === 0) { return `<div class="recipe-block"><div class="recipe-block-title"><i class="ti ti-chef-hat" style="font-size:14px"></i> Recipe Selection</div><span class="sec-label" style="margin-top:0">Zirconia Options</span>${optRows('ASP_RCP_ZIRC', isSet(a.aspRcpZirc) ? a.aspRcpZirc : -1)}</div>`; } const matSet = isSet(a.aspRcpMat); let inner = ''; if (matSet && a.aspRcpMat === 0) inner = `<span class="sec-label">Select option</span>${optRows('ASP_RCP_ZIRC', isSet(a.aspRcpZirc) ? a.aspRcpZirc : -1)}`; if (matSet && a.aspRcpMat === 1) { inner = `<span class="sec-label">PMMA Options</span>${pmmaOptRows('aspRcpPmmaType', isSet(a.aspRcpPmmaType) ? a.aspRcpPmmaType : -1)}`; } return `<div class="recipe-block"><div class="recipe-block-title"><i class="ti ti-chef-hat" style="font-size:14px"></i> Recipe Selection</div><span class="sec-label" style="margin-top:0">Material</span>${typeGrid(['Zirconia', 'PMMA'], matSet ? a.aspRcpMat : -1, 'aspRcpMat')}${inner}</div>`; } if (a.aspSub === 1 && isSet(a.aspType)) { return `<div class="recipe-block"><div class="recipe-block-title"><i class="ti ti-chef-hat" style="font-size:14px"></i> Recipe Selection</div><span class="sec-label" style="margin-top:0">Select option</span>${optRows('ASP_RCP_LFX', isSet(a.aspRcpLfx) ? a.aspRcpLfx : -1)}</div>`; } return ''; }
function buildSKDRecipe(a) { if (a.cat !== 'SKD' || !isSet(a.skdFinal)) return ''; if (a.skdFinal === 1) return ''; if (a.skdFinal === 0) { return `<div class="recipe-block"><div class="recipe-block-title"><i class="ti ti-chef-hat" style="font-size:14px"></i> Recipe Selection</div><span class="sec-label" style="margin-top:0">Verification Jig Type</span>${optRows('SKD_RCP_VJ', isSet(a.skdRcpVJ) ? a.skdRcpVJ : -1)}</div>`; } if (a.skdFinal === 3) { return `<div class="recipe-block"><div class="recipe-block-title"><i class="ti ti-chef-hat" style="font-size:14px"></i> Recipe Selection</div><span class="sec-label" style="margin-top:0">PMMA Options</span>${pmmaOptRows('skdRcpPmma', isSet(a.skdRcpPmma) ? a.skdRcpPmma : -1)}</div>`; } if (a.skdFinal === 4) { return `<div class="recipe-block"><div class="recipe-block-title"><i class="ti ti-chef-hat" style="font-size:14px"></i> Recipe Selection</div><span class="sec-label" style="margin-top:0">Zirconia Options</span>${optRows('SKD_RCP_ZIRC', isSet(a.skdRcpZirc) ? a.skdRcpZirc : -1)}</div>`; } const matSet = isSet(a.skdRcpMat); let inner = ''; if (matSet && a.skdRcpMat === 0) inner = `<span class="sec-label">Select option</span>${optRows('SKD_RCP_ZIRC', isSet(a.skdRcpZirc) ? a.skdRcpZirc : -1)}`; if (matSet && a.skdRcpMat === 1) inner = `<span class="sec-label">PMMA Options</span>${pmmaOptRows('skdRcpPmma', isSet(a.skdRcpPmma) ? a.skdRcpPmma : -1)}`; if (matSet && a.skdRcpMat === 2) inner = `<span class="sec-label">VJ type</span>${optRows('SKD_RCP_VJ', isSet(a.skdRcpVJ) ? a.skdRcpVJ : -1)}`; return `<div class="recipe-block"><div class="recipe-block-title"><i class="ti ti-chef-hat" style="font-size:14px"></i> Recipe Selection</div><span class="sec-label" style="margin-top:0">Select material / type</span><div class="type-grid-3">${['Zirconia', 'PMMA', 'Verification Jig'].map((txt, i) => `<div class="opt-row${a.skdRcpMat === i ? ' sel' : ''}" data-aox-field="skdRcpMat" data-aox-val="${i}"><input type="radio" ${a.skdRcpMat === i ? 'checked' : ''}><span class="opt-row-label">${txt}</span></div>`).join('')}</div>${inner}</div>`; }
function buildENGSection(a) { if (a.cat !== 'ENG') return ''; const finalSet = isSet(a.engFinal); const isSurgical = a.engFinal === 2; return `<div class="form-group" style="margin-top:8px;margin-bottom:12px"><label>Doctor name (Engle)</label><input type="text" class="aox-text" data-aox-field="engDoctor" value="${dclAttr(a.engDoctor || '')}" placeholder="Dr. First &amp; Last name"></div><span class="sec-label" style="margin-top:0">Select option</span>${optRows('ENG_FINAL', finalSet ? a.engFinal : -1)}${isSurgical ? `<span class="sec-label">Surgical add-on options</span>${optRows('ENG_SURGICAL', isSet(a.engSurgicalAddon) ? a.engSurgicalAddon : -1)}` : ''}${finalSet ? `<div class="eng-notice"><i class="ti ti-alert-triangle"></i><strong>Recipe/Date Selection — Always select date requested by dr and always use ENGEL Recipes</strong></div>` : ''}`; }
function buildTRISection(a) { if (a.cat !== 'TRI') return ''; const barSet = isSet(a.triBar), archSet = isSet(a.triArch), faTypeSet = isSet(a.triFaType), impTypeSet = isSet(a.triImpType), preSubSet = isSet(a.triPreSub), rcpArchSet = isSet(a.triRcpArch), rcpFaOptSet = isSet(a.triRcpFaOpt); const showRecipe = (archSet && a.triArch === 1 && isSet(a.triSingleOpt)) || (archSet && a.triArch === 0 && faTypeSet && ((a.triFaType === 0 && impTypeSet && isSet(a.triImpOpt)) || (a.triFaType === 1 && isSet(a.triContOpt)) || (a.triFaType === 2 && preSubSet && isSet(a.triPreOpt)))); let faTree = ''; if (archSet && a.triArch === 0) { faTree += `<span class="sec-label">Case type</span>${typeGrid3(['New Case', 'Continuation', 'Predesigned'], faTypeSet ? a.triFaType : -1, 'triFaType')}`; if (a.triFaType === 0) { faTree += `<span class="sec-label">Implant type</span>${typeGrid(['TRI Implants', 'NON TRI Implants'], impTypeSet ? a.triImpType : -1, 'triImpType')}`; if (impTypeSet) { const opts = a.triImpType === 0 ? 'TRI_IMPLANT_OPTS' : 'TRI_NON_IMPLANT_OPTS'; faTree += `<span class="sec-label">Select option</span>${optRows(opts, isSet(a.triImpOpt) ? a.triImpOpt : -1)}`; } } if (a.triFaType === 1) faTree += `<span class="sec-label">Select option</span>${optRows('TRI_CONT_OPTS', isSet(a.triContOpt) ? a.triContOpt : -1)}`; if (a.triFaType === 2) { faTree += `<span class="sec-label">Predesigned type</span>${typeGrid(['Predesigned-TRI', 'Predesigned-NON TRI'], preSubSet ? a.triPreSub : -1, 'triPreSub')}`; if (preSubSet) { const pOpts = a.triPreSub === 0 ? 'TRI_PRE_TRI_OPTS' : 'TRI_PRE_NONTRI_OPTS'; faTree += `<span class="sec-label">Select option</span>${optRows(pOpts, isSet(a.triPreOpt) ? a.triPreOpt : -1)}`; } } } let singleTree = ''; if (archSet && a.triArch === 1) singleTree = `<span class="sec-label">Select option</span>${optRows('TRI_SINGLE_OPTS', isSet(a.triSingleOpt) ? a.triSingleOpt : -1)}`; let recipeBlock = ''; if (showRecipe) { recipeBlock = `<div class="recipe-block"><div class="recipe-block-title"><i class="ti ti-chef-hat" style="font-size:14px"></i> Recipe Selection</div><span class="sec-label" style="margin-top:0">Select arch type</span>${typeGrid(['Full Arch', 'Single Unit'], rcpArchSet ? a.triRcpArch : -1, 'triRcpArch')}${rcpArchSet && a.triRcpArch === 0 ? `<span class="sec-label">Select recipe</span>${optRows('TRI_RCP_ARCH', rcpFaOptSet ? a.triRcpFaOpt : -1)}` : ''}${rcpArchSet && a.triRcpArch === 1 ? `<div class="opt-row sel" style="pointer-events:none;opacity:.85;margin-top:6px"><input type="radio" checked><span class="opt-row-label">TRI Platform</span></div>` : ''}</div>`; } return `<span class="sec-label" style="margin-top:0">Titanium bar add on?</span>${typeGrid(['Yes', 'No'], barSet ? a.triBar : -1, 'triBar')}${barSet !== false ? `<span class="sec-label">Arch type</span>${typeGrid(['Full Arch', 'Single Unit'], archSet ? a.triArch : -1, 'triArch')}` : ''}${faTree}${singleTree}${recipeBlock}`; }
function buildAox(caseId) {
  const a = getA(caseId); const c = getC(caseId);
  if (!a.date) a.date = deToday();
  // Pre-fill the tech name from the signed-in Microsoft account (only when empty, so a manually
  // entered/edited name is never overwritten).
  if (!a.tech) a.tech = currentTechName();
  const _ct = a.crm ? 1 : 0;
  if (a.cat === 'CC' && !isSet(a.ccType)) a.ccType = _ct;
  if (a.cat === 'SKD' && !isSet(a.skdType)) a.skdType = _ct;
  if (a.cat === 'ASP' && isSet(a.aspSub) && !isSet(a.aspType)) a.aspType = _ct;
  if (a.cat === 'TRI' && a.triArch === 0 && !isSet(a.triFaType)) a.triFaType = _ct;
  let catSub = '';
  if (a.cat === 'CC') { const ccTypeSet = isSet(a.ccType); catSub = `<span class="sec-label">Case type</span>${typeGrid(['New Case', 'Continuation'], isSet(a.ccType) ? a.ccType : -1, 'ccType')}${ccTypeSet ? (a.ccType === 0 ? ccNewOptions(a) : `${ccAddons(a)}<span class="sec-label">Select option</span>${optRows('CC_CONT', isSet(a.ccOption) ? a.ccOption : -1)}`) : ''}${buildCCRecipe(a)}`; }
  if (a.cat === 'ASP') { const aspSubSet = isSet(a.aspSub), aspTypeSet = isSet(a.aspType); catSub = `<span class="sec-label">Product type</span>${typeGrid(['Zirconia / PMMA', 'Locator Fixed (LFX)'], aspSubSet ? a.aspSub : -1, 'aspSub')}${a.aspSub === 0 ? `<span class="sec-label">Case type</span>${optRows('ASP_ZP_TYPE', aspTypeSet ? a.aspType : -1)}${aspTypeSet ? `<span class="sec-label">Select option</span>${optRowsExcept('ASP_ZP_FINAL', isSet(a.aspFinal) ? a.aspFinal : -1, [4])}` : ''}${buildASPRecipe(a)}` : ''}${a.aspSub === 1 ? `<span class="sec-label">Case type</span>${optRows('ASP_LFX_TYPE', aspTypeSet ? a.aspType : -1)}${aspTypeSet ? `<span class="sec-label">Select option</span>${optRows('ASP_LFX_FINAL', isSet(a.aspFinal) ? a.aspFinal : -1)}` : ''}${buildASPRecipe(a)}` : ''}`; }
  if (a.cat === 'SKD') { const skdTypeSet = isSet(a.skdType), skdFinalSet = isSet(a.skdFinal); catSub = `<span class="sec-label">Case type</span>${typeGrid(['New (add One Suite Smile PMMA code for charge)', 'Continuation'], skdTypeSet ? a.skdType : -1, 'skdType')}${skdTypeSet ? `<span class="sec-label">Select option</span>${optRowsExcept('SKD_FINAL', skdFinalSet ? a.skdFinal : -1, [2])}` : ''}${buildSKDRecipe(a)}`; }
  if (a.cat === 'ENG') catSub = buildENGSection(a);
  if (a.cat === 'TRI') catSub = buildTRISection(a);
  if (a.cat && !['CC', 'ASP', 'SKD', 'ENG', 'TRI'].includes(a.cat)) catSub = `<div class="alert alert-info" style="margin-top:8px;margin-bottom:0"><i class="ti ti-tools"></i> Selections for <strong>${CAT_NAMES[a.cat]}</strong> coming soon.</div>`;
  // Add-on case-number box, shown right under each selected add-on item.
  const addonCaseBox = (field, val) => `<div class="form-group" style="margin:6px 0 10px;padding-left:8px"><label>Add On Case Number</label><input type="text" class="aox-text" data-aox-field="${field}" value="${dclAttr(val || '')}" placeholder="Enter add-on case number"></div>`;
  // Denture / Night Guard — multi-select (a case can have both).
  const addonSub = a.addon ? `<div style="padding-left:4px;margin-top:6px">
      <div class="opt-row${a.addonDenture ? ' sel' : ''}" data-aox-toggle="addonDenture"><input type="checkbox" ${a.addonDenture ? 'checked' : ''}><span class="opt-row-label">${OPTS.ADDON[0]}</span></div>
      ${a.addonDenture ? addonCaseBox('addonDentureCase', a.addonDentureCase) : ''}
      <div class="opt-row${a.addonNightguard ? ' sel' : ''}" data-aox-toggle="addonNightguard"><input type="checkbox" ${a.addonNightguard ? 'checked' : ''}><span class="opt-row-label">${OPTS.ADDON[1]}</span></div>
      ${a.addonNightguard ? addonCaseBox('addonNightguardCase', a.addonNightguardCase) : ''}
    </div>` : '';
  // Manufacturing Jig / LFX Model — single-select (one or the other).
  const addonMfgSub = a.addonMfg ? `<div style="padding-left:4px;margin-top:6px">${['Manufacturing Jig', 'LFX Model'].map((txt, i) => `<div class="opt-row${a.addonMfgSel === i ? ' sel' : ''}" data-aox-field="addonMfgSel" data-aox-val="${i}"><input type="radio" ${a.addonMfgSel === i ? 'checked' : ''}><span class="opt-row-label">${txt}</span></div>${a.addonMfgSel === i ? addonCaseBox(i === 0 ? 'addonMfgJigCase' : 'addonLfxCase', i === 0 ? a.addonMfgJigCase : a.addonLfxCase) : ''}`).join('')}</div>` : '';
  return `<div class="panel" id="aox-panel" data-case-id="${caseId}">
    <div class="panel-title"><i class="ti ti-clipboard-check"></i> Data Entry AOX Checklist</div>
    <span class="sec-label" style="margin-top:0">Case details</span>
    <div class="form-row-3" style="margin-bottom:12px">
      <div class="form-group"><label>Date</label><input type="text" class="aox-text" data-aox-field="date" value="${dclAttr(a.date || '')}" placeholder="MM/DD/YYYY"></div>
      <div class="form-group"><label>Tech name</label><input type="text" class="aox-text" data-aox-field="tech" value="${dclAttr(a.tech || '')}" placeholder="Technician name"></div>
      <div class="form-group"><label>Arch / Tooth #</label><input type="text" class="aox-text" data-aox-field="arch" value="${dclAttr(a.arch || '')}" placeholder="e.g. #14, Upper"></div>
    </div>
    <div class="form-row" style="margin-bottom:12px">
      <div class="form-group"><label>Tooth shade</label><input type="text" class="aox-text" data-aox-field="toothShade" value="${dclAttr(a.toothShade || '')}" placeholder="e.g. A2, BL2"></div>
      <div class="form-group"><label>Gum shade</label><input type="text" class="aox-text" data-aox-field="gumShade" value="${dclAttr(a.gumShade || '')}" placeholder="e.g. Pink, Light"></div>
    </div>
    <div class="divider"></div>
    <span class="sec-label" style="margin-top:0">Case status</span>
    <div class="crm-row${a.crm ? ' on' : ''}" data-aox-toggle="crm"><input type="checkbox" ${a.crm ? 'checked' : ''}><label style="font-size:13px;font-weight:500;flex:1">Cont / Remake / Update?</label></div>
    ${a.crm ? `<div class="form-group" style="margin-top:8px;margin-bottom:4px"><label>Referenced case #</label><input type="text" class="aox-text" data-aox-field="refCase" value="${dclAttr(a.refCase || '')}" placeholder="Enter referenced case number"></div>` : ''}
    <div class="divider"></div>
    <span class="sec-label" style="margin-top:0">Case DSO</span>
    <div class="cat-grid">
      <button class="cat-btn${a.cat === 'CC' ? ' active-cc' : ''}" data-aox-cat="CC">Clear Choice</button>
      <button class="cat-btn${a.cat === 'ASP' ? ' active-asp' : ''}" data-aox-cat="ASP">Aspen</button>
      <button class="cat-btn${a.cat === 'SKD' ? ' active-skd' : ''}" data-aox-cat="SKD">SKDLA ACNT</button>
      <button class="cat-btn${a.cat === 'ENG' ? ' active-eng' : ''}" data-aox-cat="ENG">Engle Aesthetics</button>
      <button class="cat-btn${a.cat === 'TRI' ? ' active-tri' : ''}" data-aox-cat="TRI">TRI</button>
    </div>
    <div id="cat-sub">${catSub}</div>
    <div class="divider"></div>
    <div class="toggle-row${a.addon ? ' on' : ''}" data-aox-toggle="addon"><input type="checkbox" ${a.addon ? 'checked' : ''}><label>Add on Denture / Night Guard</label></div>
    <div id="addon-sub">${addonSub}</div>
    <div class="toggle-row${a.addonMfg ? ' on' : ''}" data-aox-toggle="addonMfg" style="margin-top:8px"><input type="checkbox" ${a.addonMfg ? 'checked' : ''}><label>Add on Manufacturing Jig / LFX Model</label></div>
    <div id="addon-mfg-sub">${addonMfgSub}</div>
    <div class="divider"></div>
    <div class="submit-block">
      <div class="submit-block-title"><i class="ti ti-flag-check" style="font-size:14px"></i> Finalize Case Details</div>
      <div class="form-row" style="margin-bottom:0">
        <div class="form-group"><label>Case number</label><input type="text" id="de-casenum" value="${dclAttr(c && c.caseNum ? c.caseNum : '')}" placeholder="e.g. 2024-0043"></div>
        <div class="form-group"><label>Ship date</label><input type="date" id="de-shipdate" value="${c && c.shipDate ? c.shipDate : ''}"></div>
      </div>
      <span class="sec-label">Pan</span>
      <div class="type-grid">
        <div class="opt-row${a.panType === 'milling' ? ' sel' : ''}" data-aox-pan="milling"><input type="radio" ${a.panType === 'milling' ? 'checked' : ''}><span class="opt-row-label">Pan generated at milling</span></div>
        <div class="opt-row${a.panType === 'number' ? ' sel' : ''}" data-aox-pan="number"><input type="radio" ${a.panType === 'number' ? 'checked' : ''}><span class="opt-row-label">Pan Number</span></div>
      </div>
      ${a.panType === 'number' ? `<div class="form-group" style="margin-top:8px"><label>Pan number</label><input type="text" id="de-pan-number" value="${dclAttr(a.panNumber || '')}" placeholder="Enter pan number"></div>` : ''}
    </div>
  </div>`;
}
function saveAoxText(caseId) { const panel = document.getElementById('aox-panel'); if (!panel || panel.dataset.caseId !== caseId) return; const a = getA(caseId); panel.querySelectorAll('.aox-text').forEach(el => { a[el.dataset.aoxField] = el.value; }); const pn = document.getElementById('de-pan-number'); if (pn) a.panNumber = pn.value; const c = getC(caseId); if (c) { const cn = document.getElementById('de-casenum'); if (cn) c.caseNum = cn.value; const sd = document.getElementById('de-shipdate'); if (sd) c.shipDate = sd.value; } }
function rebuildAox(caseId) { saveAoxText(caseId); const panel = document.getElementById('aox-panel'); if (!panel) return; const tmp = document.createElement('div'); tmp.innerHTML = buildAox(caseId); panel.parentNode.replaceChild(tmp.firstElementChild, panel); cfSave(getC(caseId)); }

// =====================================================================
// Design Checklist (DCL) — ported (buildDclItem + setters)
// =====================================================================
function saveDclTexts(id) { const c = getC(id); if (!c) return; const d = getDcl(c); document.querySelectorAll('.dcl-text').forEach(el => { d[el.dataset.dclkey] = el.value; }); }
function setDclType(id, t) { const c = getC(id); if (!c) return; saveDclTexts(id); c.dclType = c.dclType === t ? null : t; cfSave(c); if (selectedMode) renderMode(selectedMode); }
function toggleDcl(id, key) { const c = getC(id); if (!c) return; saveDclTexts(id); const d = getDcl(c); d[key] = !d[key]; cfSave(c); if (selectedMode) renderMode(selectedMode); }
function setDclVal(id, key, val) { const c = getC(id); if (!c) return; saveDclTexts(id); const d = getDcl(c); d[key] = (d[key] === val) ? null : val; cfSave(c); if (selectedMode) renderMode(selectedMode); }
function setDclText(id, key, val) { const c = getC(id); if (c) { getDcl(c)[key] = val; cfSave(c); } }
function buildDclItem(id, pre, si, ii, item, d) {
  const key = pre + '_' + si + '_' + ii; const t = item.type;
  if (t === 'head') return `<span class="sec-label">${dclEsc(item.l)}</span>`;
  if (t === 'note') return `<div class="pf-row"><span class="pf-label" style="color:var(--color-text-secondary)">${dclEsc(item.l)}</span></div>`;
  if (t === 'text') { const v = d['t:' + key] || ''; return `<div class="form-group" style="margin:6px 0"><label>${dclEsc(item.l)}</label><input type="text" class="dcl-text" data-dclkey="t:${key}" value="${dclAttr(v)}" onchange="CF.setDclText('${id}','t:${key}',this.value)"></div>`; }
  if (t === 'check') {
    if (item.always) return `<div class="pf-row"><span class="pf-label">${dclEsc(item.l)}</span><div class="pf-btns"><button class="pf-btn pass" style="opacity:.85;cursor:default"><i class="ti ti-check" style="font-size:12px"></i> Always</button></div></div>`;
    const on = !!d['k:' + key]; return `<div class="pf-row"><span class="pf-label">${dclEsc(item.l)}</span><div class="pf-btns"><button class="pf-btn${on ? ' pass' : ''}" onclick="CF.toggleDcl('${id}','k:${key}')">${on ? 'Selected' : 'Select'}</button></div></div>`;
  }
  if (t === 'yn') { const v = d['y:' + key]; return `<div class="pf-row"><span class="pf-label">${dclEsc(item.l)}</span><div class="pf-btns"><button class="pf-btn${v === 'y' ? ' pass' : ''}" onclick="CF.setDclVal('${id}','y:${key}','y')">Yes</button><button class="pf-btn${v === 'n' ? ' fail' : ''}" onclick="CF.setDclVal('${id}','y:${key}','n')">No</button></div></div>`; }
  if (t === 'choice') { const sel = d['c:' + key]; return `<div style="margin:8px 0"><span class="pf-label" style="display:block;margin-bottom:4px">${dclEsc(item.l)}</span><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:6px">${item.o.map((o, oi) => `<button class="dn-btn${sel === oi ? ' active' : ''}" onclick="CF.setDclVal('${id}','c:${key}',${oi})">${dclEsc(o)}</button>`).join('')}</div></div>`; }
  if (t === 'sites') { let rows = ''; for (let rr = 0; rr < item.n; rr++) { const sv = d['site:' + key + '_' + rr] || ''; const p = d['sitep:' + key + '_' + rr]; rows += `<div class="pf-row"><span class="pf-label" style="flex:0 0 56px">Site #</span><input type="text" class="dcl-text" data-dclkey="site:${key}_${rr}" value="${dclAttr(sv)}" onchange="CF.setDclText('${id}','site:${key}_${rr}',this.value)" style="flex:1;margin:0 8px;max-width:130px"><div class="pf-btns"><button class="pf-btn${p === 'P37' ? ' pass' : ''}" onclick="CF.setDclVal('${id}','sitep:${key}_${rr}','P37')">P37</button><button class="pf-btn${p === 'P45' ? ' pass' : ''}" onclick="CF.setDclVal('${id}','sitep:${key}_${rr}','P45')">P45</button></div></div>`; } return rows; }
  return '';
}
function designChecklistPanel(c) {
  dclAutoPopulate(c);
  const d = getDcl(c); const sel = c.dclType;
  const opt = (t, l) => `<div class="qc-opt${sel === t ? ' selected' : ''}" onclick="CF.setDclType('${c.id}','${t}')"><i class="ti ti-clipboard-list" style="font-size:20px"></i><div class="opt-title">${l}</div></div>`;
  const tabs = `<div class="qc-choice" style="grid-template-columns:1fr 1fr 1fr">${opt('CC', 'ClearChoice Checklist')}${opt('LFX', 'LFX Checklist')}${opt('TRI', 'TRI Checklist')}</div>`;
  let body = '';
  if (sel && DCL_SCHEMAS[sel]) {
    const vis = dclVisibility(sel, d);
    body = '<div style="margin-top:14px">' + DCL_SCHEMAS[sel].map((sec, si) => {
      if (sec.hide) return '';
      const items = sec.it.map((item, ii) => vis(item) ? buildDclItem(c.id, sel, si, ii, item, d) : '').join('');
      return `<div class="aox-section"><div class="aox-section-title">${dclEsc(sec.s)}</div>${items}</div>`;
    }).join('') + '</div><div class="alert alert-info" style="margin-top:10px"><i class="ti ti-info-circle"></i> The completed checklist is saved into the exported Case ZIP as a filled PDF (Design & QC columns left blank for sign-off).</div>';
  }
  return `<div class="panel"><div class="panel-title"><i class="ti ti-checklist"></i> Design Checklist</div>${tabs}${body}</div>`;
}

// ── review summary panel (Design Team) ──────────────────────────────
function reviewSummaryPanel(c) {
  const r = getR(c.id);
  if (!r || !r.acctType) return '';
  const acct = r.acctType;
  const pair = (k, v) => `<div class="info-pair"><span class="info-key">${k}</span><span class="info-val">${v}</span></div>`;
  const sect = (t, inner) => inner ? `<span class="sec-label">${t}</span><div class="info-row" style="margin-bottom:6px">${inner}</div>` : '';
  const yn = v => v === 'yes' ? `<span style="color:#157031;font-weight:600">Yes</span>` : (v === 'no' ? `<span style="color:#A0341A;font-weight:600">No</span>` : '—');
  const pf = v => v === 'pass' ? `<span style="color:#157031;font-weight:600">Pass</span>` : (v === 'fail' ? `<span style="color:#A0341A;font-weight:600">Fail</span>` : '—');
  const filesFor = name => { const key = name.replace(/[^a-zA-Z0-9]/g, '_'); const fl = (r.aspFiles && r.aspFiles[key]) || []; return fl.length ? fl.map(f => esc(f.name)).join(', ') : `<span style="color:var(--color-text-tertiary)">—</span>`; };
  let body = `<span class="sec-label" style="margin-top:0">Account type</span><div class="info-row" style="margin-bottom:6px">${pair('Account', acct === 'tri' ? 'TRI / Legacy Account' : 'ASPEN & ClearChoice')}</div>`;
  if (acct === 'tri') {
    let scan = '';
    SCAN_ITEMS.forEach((lbl, i) => { scan += pair(lbl, pf(r.scanItems && r.scanItems[i])); });
    TRI_SCAN_SECTIONS.forEach(n => { scan += pair(n, filesFor(n)); });
    if (r.scanNotes) scan += pair('Scan / files notes', esc(r.scanNotes));
    body += sect('Scan and Files', scan);
    let dn = '';
    if (r.designNeeds != null && r.designNeeds !== undefined) dn += pair('Design type', DESIGN_NEEDS_OPTS[r.designNeeds] || '—');
    if (r.drApproval === 'yes') dn += pair('Doctor design approval', 'Yes — Required');
    body += sect('Design Needs', dn);
  } else {
    let dr = '';
    if (r.aspDesignReq != null && r.aspDesignReq !== undefined) { dr += pair('Requirement', ASP_DESIGN_REQ[r.aspDesignReq] || '—'); if ((r.aspDesignReq === 1 || r.aspDesignReq === 2) && r.aspMouldName) dr += pair(r.aspDesignReq === 1 ? 'Tooth mould' : 'Mould name', esc(r.aspMouldName)); }
    body += sect('Design Requirements', dr);
    let ds = '';
    if (r.aspSpec) ASP_SPEC_ITEMS.forEach(it => { if (r.aspSpec[it[0]] === 'yes') ds += pair(it[1], 'Yes'); });
    body += sect('Design Specifics', ds);
    const lfx = r.aspSpec && r.aspSpec.lfx; const ccDig = r.aspSpec && r.aspSpec.ccDigital === 'yes';
    let sf = '';
    if (lfx === 'yes') ASP_LFX_SCANS.forEach(n => { sf += pair(n, filesFor(n)); });
    else if (lfx === 'no') { const list = ASP_NONLFX_SCANS.slice(); if (ccDig) list.push('iCAM Data'); list.forEach(n => { sf += pair(n, filesFor(n)); }); }
    body += sect('Required Scans and Files', sf);
    if (lfx === 'no' && !ccDig && r.aspVerifiedModel) {
      let vm = pair('Model type', r.aspVerifiedModel === 'tibase' ? 'Ti Base' : 'Scan body');
      const opts = r.aspVerifiedModel === 'tibase' ? ASP_TIBASE_OPTS : ASP_SCANBODY_OPTS; const pfx = r.aspVerifiedModel === 'tibase' ? 'Ti' : 'Sb';
      ['Upper', 'Lower'].forEach(side => { const sel = r['asp' + pfx + side]; if (sel != null && sel !== undefined) { let v = opts[sel]; const loc = r['asp' + pfx + side + 'Loc']; if (loc) v += ' (' + esc(loc) + ')'; vm += pair(side, v); } });
      body += sect('Verified Model', vm);
    }
    if (lfx === 'no') {
      let fx = '';
      if (r.aspScrewCount) fx += pair('Total screws', esc(r.aspScrewCount));
      if (r.aspScrewType != null && r.aspScrewType !== undefined) fx += pair('Screw type', ASP_SCREW_OPTS[r.aspScrewType] || '—');
      body += sect('Final Screws', fx);
    }
  }
  return `<div class="panel"><div class="panel-title"><i class="ti ti-clipboard-check" style="color:#136AA3"></i> Case Review Selections</div>${body}</div>`;
}

// Read-only history of the Outsourcing phase — shown once a case is at QC or later
// so the returned design file + outsource notes stay visible (not just the result).
function outsourceSummaryPanel(c) {
  const f = c.designFile; const notes = c.outsourceNotes;
  if (!f && !notes) return '';
  return `<div class="panel"><div class="panel-title"><i class="ti ti-send" style="color:#6B5E2F"></i> Outsourcing</div>
    ${f ? `<div class="file-list" style="margin-bottom:${notes ? '10px' : '0'}"><div class="file-item"><i class="ti ti-file"></i><span class="file-name">${esc(f.name)}</span><span class="file-size">${f.size}</span></div></div>` : '<div style="font-size:12px;color:var(--color-text-tertiary)">No returned design file recorded</div>'}
    ${notes ? `<div class="info-pair" style="border:none;padding-bottom:0"><span class="info-key">Outsource notes</span><span class="info-val" style="white-space:pre-wrap">${esc(notes)}</span></div>` : ''}
  </div>`;
}
// Read-only QC outcome + notes — shown once QC has been decided (case is in
// rework/resend or Complete).
function qcSummaryPanel(c) {
  const notes = c.qcNotes;
  let outcome = '';
  if (c.stage === 'Complete') outcome = '<span style="color:#157031;font-weight:600">Passed</span>';
  else if (c.stage === 'QC Failed - Rework') outcome = '<span style="color:#A0341A;font-weight:600">Failed — in-house rework</span>';
  else if (c.stage === 'QC Failed - Resend') outcome = '<span style="color:#A0341A;font-weight:600">Failed — resent to outsourcer</span>';
  if (!outcome && !notes) return '';
  return `<div class="panel"><div class="panel-title"><i class="ti ti-eye-check" style="color:#0A2C42"></i> QC Result</div>
    ${outcome ? `<div class="info-pair"><span class="info-key">Outcome</span><span class="info-val">${outcome}</span></div>` : ''}
    ${notes ? `<div class="info-pair" style="border:none;padding-bottom:0"><span class="info-key">QC notes</span><span class="info-val" style="white-space:pre-wrap">${esc(notes)}</span></div>` : ''}
  </div>`;
}
// Phase order within the Design Team lifecycle.
function designPhaseRank(stage) { return { 'Design Check': 0, 'Outsourcing': 1, 'QC': 2, 'QC Failed - Rework': 3, 'QC Failed - Resend': 3, 'Complete': 4 }[stage] ?? -1; }

// =====================================================================
// Case detail (stage-driven) — ported, returns an HTML string
// =====================================================================
// Case-number barcode panel — Code 39, scan-interchangeable with the ABS work
// ticket. Sits at the TOP of the right column (above the Design Checklist / step
// panel, whatever it is for the stage) in the Case Review, Scanning, and Design
// Team detail views — every sub-tab, any open case. The <svg> is painted in
// afterDetailRender() once it is in the DOM. See ../barcode.js.
const BARCODE_MODES = ['casereview', 'scanning', 'design'];
function barcodePanelHtml(c) {
  if (!BARCODE_MODES.includes(selectedMode) || !c.caseNum) return '';
  return `<div class="panel cf-barcode-panel"><div class="panel-title"><i class="ti ti-barcode"></i> Case Barcode</div>
    <div class="cf-barcode-wrap"><svg id="cf-barcode" aria-label="Case number barcode (Code 39)"></svg></div></div>`;
}

function renderCaseDetail(c) {
  const si = stageN(c.stage); const ps = ['Data Entry', 'Review', 'Design', 'Outsource', 'QC', 'Complete'];
  const prog = `<div class="progress-track" role="list">${ps.map((s, i) => `<div class="prog-step" role="listitem"><div class="prog-node"><div class="prog-circle${i < si ? ' done' : i === si ? ' active' : ''}">${i < si ? '<i class="ti ti-check" style="font-size:12px"></i>' : (i + 1)}</div><span class="prog-label${i === si ? ' active' : ''}">${s}</span></div>${i < ps.length - 1 ? `<div class="prog-connector${i < si ? ' done' : ''}"></div>` : ''}</div>`).join('')}${c.stage === 'Scanning' ? `<div style="margin-left:8px;padding:3px 10px;background:#F4F0E4;border-radius:10px;font-size:11px;color:#6B5E2F;font-weight:500;white-space:nowrap"><i class="ti ti-scan" style="font-size:11px;margin-right:4px"></i>Scanning</div>` : ''}</div>`;
  const tl = `<div class="timeline">${(c.timeline.length ? c.timeline : ['No activity yet']).map((t, i, arr) => { const o = (t && typeof t === 'object') ? t : null; const text = o ? o.text : t; const sub = o ? `${o.by} • ${fmtTs(o.at)}` : (i === 0 ? c.updated : 'Recently'); return `<div class="tl-item"><div class="tl-dot${i === arr.length - 1 && c.stage !== 'Complete' ? ' active' : ' done'}"><i class="ti ti-${i === arr.length - 1 && c.stage !== 'Complete' ? 'clock' : 'check'}" style="font-size:12px"></i></div><div class="tl-line"></div><div class="tl-content"><div class="tl-title">${esc(text)}</div><div class="tl-sub">${esc(sub)}</div></div></div>`; }).join('')}</div>`;
  // Open button is extension-aware: .stl -> 3Shape, .cad -> exocad (download so the
  // OS file-association launches the desktop app), everything else -> in-tab preview.
  const openBtn = (kind, i, f, key) => {
    if (!f.path) return '';
    const ext = fileExt(f.name);
    const label = ext === 'stl' ? 'Open in 3Shape' : (ext === 'cad' ? 'Open in exocad' : 'Preview');
    const icon = (ext === 'stl' || ext === 'cad') ? 'external-link' : 'eye';
    const args = kind === 'asp' ? `'${c.id}','asp',${i},'${key}'` : `'${c.id}','${kind}',${i}`;
    return `<button class="btn btn-sm" style="margin-left:auto;padding:2px 9px" onclick="event.stopPropagation();CF.previewFile(${args})"><i class="ti ti-${icon}"></i> ${label}</button>`;
  };
  const fileRow = (f, i, kind, icon) => `<div class="file-item"><i class="ti ti-${icon}"></i><span class="file-name">${esc(f.name)}</span><span class="file-size">${f.size}</span>${openBtn(kind, i, f)}</div>`;
  const aspFileRow = (f, key, i) => `<div class="file-item"><i class="ti ti-file"></i><span class="file-name">${esc(f.name)}</span><span class="file-size">${f.size}</span>${openBtn('asp', i, f, key)}</div>`;
  const fH = c.files.length ? c.files.map((f, i) => fileRow(f, i, 'entry', 'file')).join('') : '<span style="font-size:12px;color:var(--color-text-tertiary)">No files attached</span>';
  const rfH = c.reviewFiles.length ? c.reviewFiles.map((f, i) => fileRow(f, i, 'review', 'file')).join('') : '<span style="font-size:12px;color:var(--color-text-tertiary)">No files yet</span>';
  const sfH = c.scanFiles && c.scanFiles.length ? c.scanFiles.map((f, i) => fileRow(f, i, 'scan', 'scan')).join('') : '<span style="font-size:12px;color:var(--color-text-tertiary)">No scan files yet</span>';
  const a = getA(c.id); const r = getR(c.id);
  // Files the Case Review team added (extra design files + the AOX scan/CAD drop
  // boxes). Surfaced under "Entry files" in the Design tab so the design team sees
  // everything in one place. aspFiles is keyed by section -> [file].
  const isDesign = selectedMode === 'design';
  const crReviewRows = c.reviewFiles.map((f, i) => fileRow(f, i, 'review', 'file')).join('');
  const crAspRows = r.aspFiles ? Object.keys(r.aspFiles).map(key => (r.aspFiles[key] || []).map((f, i) => aspFileRow(f, key, i)).join('')).join('') : '';
  const caseReviewFilesHtml = crReviewRows + crAspRows;
  let sp = '', reviewInfoPanel = '', leftReviewSel = '';

  if (c.stage === 'Data Entry') {
    const returnBanner = a.returnedFromReview ? `<div class="panel"><div class="alert alert-warn" style="margin:0"><i class="ti ti-arrow-back-up"></i> <strong>Returned from Case Review</strong> — missing/incorrect information.${a.returnReason ? ` <span style="display:block;margin-top:6px">${esc(a.returnReason)}</span>` : ''}</div></div>` : '';
    sp = returnBanner + `<div class="panel"><div class="panel-title"><i class="ti ti-pencil"></i> Case Information</div>
      <div class="form-group" style="margin-bottom:12px"><label>Patient name</label><input type="text" value="${dclAttr(c.patient)}" id="de-patient"></div>
      <div class="form-group" style="margin-bottom:12px"><label>Doctor</label><input type="text" value="${dclAttr(c.doctor)}" id="de-doctor" placeholder="Dr. First &amp; Last name"></div>
      <div class="form-row"><div class="form-group"><label>Dr due date</label><input type="date" id="de-drdue" value="${c.drDueDate}"></div></div>
      <div class="rush-row${c.rush ? ' rush-active' : ''}" id="de-rush-row" onclick="CF.toggleDeRush('${c.id}')" style="margin-bottom:12px"><input type="checkbox" id="de-rush" ${c.rush ? 'checked' : ''}><label class="rush-label" for="de-rush">Rush?</label><span class="rush-hint">Mark if expedited handling needed</span></div>
      <div class="form-group"><label>Notes</label><textarea id="de-notes">${esc(c.notes)}</textarea></div>
    </div>
    ${buildAox(c.id)}
    <div class="panel"><div class="panel-title"><i class="ti ti-paperclip"></i> ABS Attachments</div>
      <div class="upload-zone" ondragover="CF.aspDragOver(event)" ondragleave="CF.aspDragLeave(event)" ondrop="CF.dropFiles(event,'entry')" onclick="CF.pick('entry')"><div class="upload-icon"><i class="ti ti-upload"></i></div><div class="upload-text">Drag files here or click to attach</div><div class="upload-hint">PDF, DOCX, ZIP, images</div></div>
      <div class="file-list">${fH}</div>
      <div class="actions-bar"><button class="btn btn-primary" onclick="CF.submitDataEntry('${c.id}')"><i class="ti ti-send"></i> Submit to Review</button><button class="btn" onclick="CF.holdDataEntry('${c.id}','models')"><i class="ti ti-package"></i> Submit and place on hold for physical models</button><button class="btn" onclick="CF.holdDataEntry('${c.id}','missing')"><i class="ti ti-alert-circle"></i> Submit and place on hold for missing information</button></div>
    </div>`;
  }

  if (c.stage === 'Review') {
    reviewInfoPanel = `<div class="panel"><div class="panel-title"><i class="ti ti-eye"></i> Submitted Data for Review</div>
    <div class="info-row">
      <div class="info-pair"><span class="info-key">Patient</span><span class="info-val">${esc(c.patient)}</span></div>
      <div class="info-pair"><span class="info-key">Case number</span><span class="info-val" style="font-family:var(--font-mono);font-size:12px">${c.caseNum || '—'}</span></div>
      <div class="info-pair"><span class="info-key">Doctor</span><span class="info-val">${esc(c.doctor)}</span></div>
      <div class="info-pair"><span class="info-key">Rush</span><span class="info-val">${c.rush ? '<span class="rush-badge"><i class="ti ti-bolt" style="font-size:10px"></i> Rush</span>' : 'No'}</span></div>
      <div class="info-pair"><span class="info-key">Ship date</span><span class="info-val">${c.shipDate || '—'}</span></div>
      <div class="info-pair"><span class="info-key">Dr due date</span><span class="info-val">${c.drDueDate || '—'}</span></div>
      ${a.arch ? `<div class="info-pair"><span class="info-key">Arch / Tooth #</span><span class="info-val">${esc(a.arch)}</span></div>` : ''}
      ${a.toothShade ? `<div class="info-pair"><span class="info-key">Tooth shade</span><span class="info-val">${esc(a.toothShade)}</span></div>` : ''}
      ${a.gumShade ? `<div class="info-pair"><span class="info-key">Gum shade</span><span class="info-val">${esc(a.gumShade)}</span></div>` : ''}
      ${a.tech ? `<div class="info-pair"><span class="info-key">Tech</span><span class="info-val">${esc(a.tech)}</span></div>` : ''}
      ${a.cat ? `<div class="info-pair"><span class="info-key">Case DSO</span><span class="info-val">${CAT_NAMES[a.cat] || a.cat}</span></div>` : ''}
      ${a.crm && a.refCase ? `<div class="info-pair"><span class="info-key">Cont / Remake / Update</span><span class="info-val">Ref case #${esc(a.refCase)}</span></div>` : ''}
    </div></div>`;
    const crBucket = (r && r.crBucket) || null;
    if (crBucket) {
    // Case in a Case-Review bucket: sent back from Design, on hold, or escalated to
    // the Technical Advisor. Shows DE + Case Review selections, every uploaded file,
    // a "Missing info" upload zone, a clarification note, and the routing buttons.
    const bucketLabel = crBucket === 'design_return' ? 'Sent back from Design' : (crBucket === 'hold_missing' ? 'On hold for missing information' : 'Escalated to Technical Advisor');
    const crReviewFilesHtml = c.reviewFiles.map((f, i) => fileRow(f, i, 'review', 'file')).join('')
      + (r.aspFiles ? Object.keys(r.aspFiles).filter(k => k !== 'missing_info').map(k => (r.aspFiles[k] || []).map((f, i) => aspFileRow(f, k, i)).join('')).join('') : '');
    const miFiles = (r.aspFiles && r.aspFiles.missing_info) || [];
    const miRow = (f, i) => `<div class="file-item"><i class="ti ti-file"></i><span class="file-name">${esc(f.name)}</span><span class="file-size">${f.size}</span>${f.path ? `<button class="btn btn-sm" style="margin-left:auto;padding:2px 9px" onclick="event.stopPropagation();CF.previewFile('${c.id}','asp',${i},'missing_info')"><i class="ti ti-eye"></i> Preview</button>` : ''}<button class="btn btn-sm btn-danger" style="padding:2px 7px;margin-left:${f.path ? '6px' : 'auto'}" onclick="CF.crMissingRemove('${c.id}',${i})"><i class="ti ti-x"></i></button></div>`;
    const miList = miFiles.length ? miFiles.map((f, i) => miRow(f, i)).join('') : '';
    sp = `<div class="panel"><div class="panel-title"><i class="ti ti-arrow-back-up" style="color:#8E6510"></i> ${bucketLabel}</div>
      ${r.designReturnReason ? `<div class="alert alert-warn" style="margin:0 0 10px"><i class="ti ti-info-circle"></i> <strong>Reason from Design:</strong> ${esc(r.designReturnReason)}</div>` : ''}
      ${crBucket === 'ta' && r.taNotes ? `<div class="alert alert-info" style="margin:0 0 10px"><i class="ti ti-user-up"></i> <strong>Notes for TA:</strong> ${esc(r.taNotes)}</div>` : ''}
      ${crBucket === 'hold_missing' ? `<div class="alert alert-warn" style="margin:0"><i class="ti ti-clock"></i> This case is on hold awaiting missing information.</div>` : ''}
    </div>
    ${reviewSummaryPanel(c)}
    ${doctorReqsPanel(c)}
    <div class="panel"><div class="panel-title"><i class="ti ti-files"></i> Files from Data Entry &amp; Case Review</div>
      <span class="sec-label" style="margin-top:0">Data Entry files</span><div class="file-list">${fH}</div>
      <span class="sec-label">Case Review files</span><div class="file-list">${crReviewFilesHtml || '<span style="font-size:12px;color:var(--color-text-tertiary)">None</span>'}</div>
    </div>
    <div class="panel"><div class="panel-title"><i class="ti ti-upload"></i> Missing info &amp; clarification</div>
      <div class="form-group" style="margin-bottom:14px"><label>Missing info</label><div class="upload-zone" ondragover="CF.aspDragOver(event)" ondragleave="CF.aspDragLeave(event)" ondrop="CF.crMissingDrop(event,'${c.id}')" onclick="CF.crMissingPick('${c.id}')"><div class="upload-icon"><i class="ti ti-upload"></i></div><div class="upload-text">Drag files here or click to attach</div></div><div class="file-list">${miList}</div></div>
      <div class="form-group" style="margin-bottom:14px"><label>Clarification / Notes</label><textarea id="cr-clarification" placeholder="Add clarification or notes..." onchange="CF.saveCrFields('${c.id}')">${esc(r.crClarification || '')}</textarea></div>
      <div class="actions-bar">
        <button class="btn btn-primary" onclick="CF.crSendToDesign('${c.id}')"><i class="ti ti-arrow-right"></i> Send back to design with new files/clarification</button>
        <button class="btn" onclick="CF.crHoldMissing('${c.id}')"><i class="ti ti-player-pause"></i> Place on hold for missing information</button>
        <button class="btn" onclick="CF.showTaNotes()"><i class="ti ti-user-up"></i> Escalate to TA</button>
        <button class="btn btn-scan" onclick="CF.crPassToScanning('${c.id}')"><i class="ti ti-scan"></i> Pass to Scanning team</button>
      </div>
      <div id="ta-notes-block" style="display:none;margin-top:12px">
        <div class="form-group"><label>Notes for TA</label><textarea id="cr-ta-notes" placeholder="Add notes for the Technical Advisor...">${esc(r.taNotes || '')}</textarea></div>
        <div class="actions-bar"><button class="btn btn-primary" onclick="CF.crEscalateTa('${c.id}')"><i class="ti ti-send"></i> Confirm — Escalate to TA</button></div>
      </div>
    </div>`;
    } else {
    sp = `<div class="panel"><div class="panel-title"><i class="ti ti-eye"></i> Case Review</div>
    <div class="alert alert-info"><i class="ti ti-info-circle"></i> Review the submitted data on the left, then complete the AOX checklist, add design notes, and route to Design or Scanning.</div></div>
    ${buildAoxReviewChecklist(c.id)}
    <div class="panel" style="margin-top:0">
    <div class="design-notes-block">
      <div class="design-notes-title"><i class="ti ti-notes" style="font-size:15px;color:#6B5E2F"></i> Doctor Requirement Notes</div>
      <div id="design-reqs-list">${renderDesignReqs(c)}</div>
      <button class="btn btn-sm" style="margin-top:8px" onclick="CF.addDesignReq('${c.id}')"><i class="ti ti-plus"></i> Add requirement</button>
    </div>
    <div class="form-group" style="margin-bottom:14px"><label>Add any extra files needed for design</label><div class="upload-zone" onclick="CF.pick('review')"><div class="upload-icon"><i class="ti ti-upload"></i></div><div class="upload-text">Attach reference files, assets</div></div><div class="file-list">${rfH}</div></div>
    <div class="actions-bar">
      <button class="btn btn-sm" onclick="CF.exportCaseReviewZip('${c.id}')"><i class="ti ti-folder-down"></i> Export Case Folder</button>
      <button class="btn btn-primary" onclick="CF.passToDesign('${c.id}')"><i class="ti ti-arrow-right"></i> Pass to Design</button>
      <button class="btn btn-scan" onclick="CF.passToScanning('${c.id}')"><i class="ti ti-scan"></i> Pass to Scanning</button>
      <button class="btn" onclick="CF.showCoordReason()"><i class="ti ti-player-pause"></i> Place on Hold &amp; Send to Case Coordination</button>
      <button class="btn" onclick="CF.showReturnReason()"><i class="ti ti-arrow-back-up"></i> Place on Hold &amp; Send Back to Data Entry for Missing Information</button>
    </div>
    <div id="coord-reason-block" style="display:none;margin-top:12px">
      <div class="form-group"><label>Reason for Sending to Case Coordination</label><textarea id="coord-reason" placeholder="Enter reason for sending to Case Coordination..."></textarea></div>
      <div class="actions-bar"><button class="btn btn-primary" onclick="CF.sendToCoordination('${c.id}')"><i class="ti ti-send"></i> Confirm — Place on Hold</button></div>
    </div>
    <div id="return-de-block" style="display:none;margin-top:12px">
      <div class="form-group"><label>Missing / Incorrect Information for Data Entry</label><textarea id="return-de-reason" placeholder="Describe what is missing or incorrect so Data Entry can correct it...">${esc((a && a.returnReason) || '')}</textarea></div>
      <div class="actions-bar"><button class="btn btn-primary" onclick="CF.sendBackToDataEntry('${c.id}')"><i class="ti ti-send"></i> Confirm — Send Back to Data Entry</button></div>
    </div></div>`;
    }
  }

  if (c.stage === 'Scanning') {
    sp = `<div class="panel"><div class="panel-title"><i class="ti ti-scan" style="color:#6B5E2F"></i> Scanning</div>
    <div class="alert alert-scan"><i class="ti ti-info-circle"></i> Upload scan files then pass to the Design team.</div>
    <div class="info-row" style="margin-bottom:14px">
      <div class="info-pair"><span class="info-key">Patient</span><span class="info-val">${esc(c.patient)}</span></div>
      <div class="info-pair"><span class="info-key">Case number</span><span class="info-val" style="font-family:var(--font-mono);font-size:12px">${c.caseNum || '—'}</span></div>
      <div class="info-pair"><span class="info-key">Doctor</span><span class="info-val">${esc(c.doctor)}</span></div>
      ${a.arch ? `<div class="info-pair"><span class="info-key">Arch / Tooth #</span><span class="info-val">${esc(a.arch)}</span></div>` : ''}
      ${a.toothShade ? `<div class="info-pair"><span class="info-key">Tooth shade</span><span class="info-val">${esc(a.toothShade)}</span></div>` : ''}
      ${c.designNotes ? `<div class="info-pair"><span class="info-key">Doctor requirements</span><span class="info-val" style="font-size:12px">${esc(c.designNotes)}</span></div>` : ''}
    </div>
    <div class="form-group" style="margin-bottom:14px"><label>Upload scan files</label><div class="upload-zone" onclick="CF.pick('scan')"><div class="upload-icon"><i class="ti ti-upload"></i></div><div class="upload-text">Upload scan files</div><div class="upload-hint">STL, DICOM, images, etc.</div></div><div class="file-list">${sfH}</div></div>
    <div class="actions-bar"><button class="btn btn-primary" onclick="CF.advanceStage('${c.id}','Design Check','Scan files uploaded — passed to Design team','Scanning Team')"><i class="ti ti-arrow-right"></i> Pass to Design Team</button></div></div>`;
  }

  // Design Check: the readiness checklist was removed. The Export ZIP + actions now
  // render in designActionsPanel(), appended AFTER the Design Checklist below.
  if (c.stage === 'Design Check') { sp = ''; }
  if (c.stage === 'Outsourcing') { const _partner = partnerOf(c); const _rel = r.qcReleaseAt; sp = `<div class="panel"><div class="panel-title"><i class="ti ti-send"></i> Outsourcer Management${_partner ? ` — ${OUTSOURCE_PARTNERS[_partner] || _partner}` : ''}</div><div class="alert alert-warn"><i class="ti ti-clock"></i> Case ZIP sent${_partner ? ` to ${OUTSOURCE_PARTNERS[_partner] || _partner}` : ''}. ${_rel ? `Held here until <strong>${fmtTs(_rel)}</strong>, then auto-released to QC.` : 'Upload returned design when ready.'}</div><div class="form-group" style="margin-bottom:14px"><label>Upload design from outsourcer</label><div class="upload-zone" onclick="CF.pick('design')"><div class="upload-icon"><i class="ti ti-upload"></i></div><div class="upload-text">Upload returned design file</div></div>${c.designFile ? `<div class="file-list"><div class="file-item"><i class="ti ti-file"></i><span class="file-name">${esc(c.designFile.name)}</span><span class="file-size">${c.designFile.size}</span></div></div>` : ''}</div><div class="form-group" style="margin-bottom:14px"><label>Outsource notes</label><textarea id="outsource-notes" placeholder="Outsourcer, ETA, issues, anything QC should know..." onchange="CF.saveOutsourceNotes('${c.id}')">${esc(c.outsourceNotes || '')}</textarea></div><div class="actions-bar">${c.designFile ? `<button class="btn btn-primary" onclick="CF.beginQc('${c.id}')"><i class="ti ti-eye-check"></i> Begin QC</button>` : `<button class="btn btn-primary" onclick="CF.markDesignReceived('${c.id}')"><i class="ti ti-eye-check"></i> Mark design file received</button>`}</div></div>`; }
  if (c.stage === 'QC') { sp = `<div class="panel"><div class="panel-title"><i class="ti ti-eye-check"></i> Quality Control</div><div class="alert alert-info"><i class="ti ti-info-circle"></i> Review the outsourcer's design.</div>${c.designFile ? `<div class="file-list" style="margin-bottom:14px"><div class="file-item"><i class="ti ti-file"></i><span class="file-name">${esc(c.designFile.name)}</span><span class="file-size">${c.designFile.size}</span></div></div>` : ''}
    <label style="font-size:12px;color:var(--color-text-secondary);font-weight:500;display:block;margin-bottom:8px">QC decision</label><div class="qc-choice"><div class="qc-opt" id="qc-pass" onclick="CF.selectQC('pass')"><i class="ti ti-circle-check" style="color:#1B8A3E"></i><div class="opt-title">Pass QC</div></div><div class="qc-opt" id="qc-fail" onclick="CF.selectQC('fail')"><i class="ti ti-circle-x" style="color:#A0341A"></i><div class="opt-title">Fail QC</div></div></div>
    <div id="fail-options" style="display:none;margin-top:12px"><label style="font-size:12px;color:var(--color-text-secondary);font-weight:500;display:block;margin-bottom:6px">Who will make adjustments?</label><div class="sub-choice"><div class="sub-opt" id="adj-self" onclick="CF.selectAdj('self')"><i class="ti ti-tool"></i><span>In-house</span></div><div class="sub-opt" id="adj-resend" onclick="CF.selectAdj('resend')"><i class="ti ti-refresh"></i><span>Resend</span></div></div></div>
    <div class="form-group" style="margin-top:12px"><label>QC notes</label><textarea id="qc-notes" placeholder="Describe issues or approvals..."></textarea></div>
    <div class="actions-bar" id="qc-actions"></div></div>`; }
  if (c.stage === 'QC Failed - Rework') { sp = `<div class="panel"><div class="panel-title"><i class="ti ti-tool"></i> In-House Rework</div><div class="alert alert-warn"><i class="ti ti-alert-triangle"></i> QC failed — in-house adjustment in progress.</div><div class="form-group" style="margin-bottom:14px"><label>Upload revised design</label><div class="upload-zone" onclick="CF.pick('design')"><div class="upload-icon"><i class="ti ti-upload"></i></div><div class="upload-text">Upload corrected design</div></div></div><div class="actions-bar"><button class="btn btn-primary" onclick="CF.advanceStage('${c.id}','Complete','In-house revision complete — case finalized','Design Team')"><i class="ti ti-check"></i> Mark Complete</button></div></div>`; }
  if (c.stage === 'QC Failed - Resend') { sp = `<div class="panel"><div class="panel-title"><i class="ti ti-refresh"></i> Resent to Outsourcer</div><div class="alert alert-warn"><i class="ti ti-clock"></i> Redesign sent. Upload new design when received.</div><div class="form-group" style="margin-bottom:14px"><label>Upload revised design</label><div class="upload-zone" onclick="CF.pick('design')"><div class="upload-icon"><i class="ti ti-upload"></i></div><div class="upload-text">Upload new design file</div></div></div><div class="actions-bar"><button class="btn btn-primary" onclick="CF.advanceStage('${c.id}','QC','Revised design received — back to QC','Design Team')"><i class="ti ti-eye-check"></i> Begin QC Review</button></div></div>`; }
  if (c.stage === 'Complete') { sp = `<div class="panel"><div class="alert alert-success"><i class="ti ti-circle-check"></i> This case has been completed and approved.</div><div class="actions-bar"><button class="btn" onclick="CF.exportZip('${c.id}')"><i class="ti ti-download"></i> Download Final ZIP</button></div></div>`; }
  if (c.stage === 'Case Coordination') { sp = `<div class="panel"><div class="panel-title"><i class="ti ti-player-pause" style="color:#8E6510"></i> On Hold — Case Coordination</div><div class="alert alert-warn"><i class="ti ti-clock"></i> This case is on hold and has been sent to Case Coordination.</div>${c.coordReason ? `<div class="info-pair" style="border:none;padding-top:0"><span class="info-key">Reason</span><span class="info-val">${esc(c.coordReason)}</span></div>` : ''}<div class="actions-bar"><button class="btn btn-primary" onclick="CF.advanceStage('${c.id}','Review','Returned from Case Coordination — back to review','Case Coordination')"><i class="ti ti-arrow-back-up"></i> Return to Review</button></div></div>`; }

  if (['Design Check', 'Outsourcing', 'QC', 'QC Failed - Rework', 'QC Failed - Resend', 'Complete'].includes(c.stage)) {
    // Read-only history: show the Outsourcing summary once past it (QC or later),
    // and the QC result once QC has been decided (rework/resend or Complete).
    const outsourceRO = designPhaseRank(c.stage) >= 2 ? outsourceSummaryPanel(c) : '';
    const qcRO = ['QC Failed - Rework', 'QC Failed - Resend', 'Complete'].includes(c.stage) ? qcSummaryPanel(c) : '';
    const designActions = c.stage === 'Design Check' ? designActionsPanel(c) : '';
    // Case Review Selections + Doctor Requirements move to the LEFT column (next to
    // the Design Checklist) so the design team can reference them while filling it out.
    leftReviewSel = reviewSummaryPanel(c) + doctorReqsPanel(c);
    sp = outsourceRO + qcRO + sp + designChecklistPanel(c) + designActions;
  }
  const genInfo = `<div class="panel"><div class="panel-title"><i class="ti ti-info-circle"></i> Case Info</div>
      <div class="info-row">
        <div class="info-pair"><span class="info-key">Case number</span><span class="info-val" style="font-family:var(--font-mono);font-size:12px">${c.caseNum || '—'}</span></div>
        <div class="info-pair"><span class="info-key">Patient</span><span class="info-val">${esc(c.patient)}</span></div>
        <div class="info-pair"><span class="info-key">Doctor</span><span class="info-val">${esc(c.doctor)}</span></div>
        <div class="info-pair"><span class="info-key">Rush</span><span class="info-val">${c.rush ? '<span class="rush-badge"><i class="ti ti-bolt" style="font-size:10px"></i> Rush</span>' : 'No'}</span></div>
        <div class="info-pair"><span class="info-key">Ship date</span><span class="info-val">${c.shipDate || '—'}</span></div>
        <div class="info-pair"><span class="info-key">Dr due date</span><span class="info-val">${c.drDueDate || '—'}</span></div>
        <div class="info-pair"><span class="info-key">Stage</span><span class="info-val">${badge(c.stage)}</span></div>
        ${c.designNotes ? `<div class="info-pair"><span class="info-key">Doctor requirements</span><span class="info-val" style="font-size:12px">${esc(c.designNotes)}</span></div>` : ''}
        ${r.designNeeds !== null && r.designNeeds !== undefined ? `<div class="info-pair"><span class="info-key">Design needs</span><span class="info-val">${DESIGN_NEEDS_OPTS[r.designNeeds] || ''}</span></div>` : ''}
        ${r.drApproval ? `<div class="info-pair"><span class="info-key">Dr approval</span><span class="info-val">${r.drApproval === 'yes' ? 'Yes — Required' : 'No — Not Required'}</span></div>` : ''}
      </div>
    </div>`;
  return `${prog}<div class="two-col" style="gap:16px;align-items:start"><div>
    ${c.stage === 'Review' ? reviewInfoPanel : genInfo}
    <div class="panel"><div class="panel-title"><i class="ti ti-clock"></i> Activity</div>${tl}</div>
    <div class="panel"><div class="panel-title"><i class="ti ti-file"></i> Entry files</div><div class="file-list">${fH}</div>${isDesign && caseReviewFilesHtml ? `<div class="sec-label" style="margin-top:12px">From Case Review (scans &amp; files)</div><div class="file-list">${caseReviewFilesHtml}</div>` : ''}</div>
    ${leftReviewSel}
    ${(!isDesign && c.reviewFiles.length) ? `<div class="panel"><div class="panel-title"><i class="ti ti-paperclip"></i> Design files</div><div class="file-list">${rfH}</div></div>` : ''}
    ${c.scanFiles && c.scanFiles.length ? `<div class="panel"><div class="panel-title"><i class="ti ti-scan" style="color:#6B5E2F"></i> Scan files</div><div class="file-list">${sfH}</div></div>` : ''}
  </div><div>${barcodePanelHtml(c)}${sp}</div></div>`;
}
function afterDetailRender(c) {
  qcSel = null; adjSel = null;
  // Paint the Code 39 barcode now that its <svg> is in the DOM. Hide the panel
  // (rather than throw) if JsBarcode can't encode the value, so a barcode hiccup
  // never blanks the case detail.
  const svg = document.getElementById('cf-barcode');
  if (svg && c.caseNum) {
    try { renderCode39(svg, c.caseNum); }
    catch (e) {
      const panel = svg.closest('.cf-barcode-panel');
      if (panel) panel.style.display = 'none';
    }
  }
}

// ── transitions / actions (ported) ──────────────────────────────────
function passToDesign(id) { saveReviewNotes(id); advanceStage(id, 'Design Check', 'Files reviewed — passed to Design team', 'Case Review Team'); }
function passToScanning(id) { saveReviewNotes(id); advanceStage(id, 'Scanning', 'Passed to Scanning team', 'Case Review Team'); }

// Case Review folder export: <case#>/ { scans/<review scan files>, Case Review
// Checklist.txt, design notes.txt, <data entry files> }. File bytes are pulled
// from Storage via signed URLs and packed into a single ZIP.
function caseReviewChecklistText(c) {
  const r = getR(c.id); const acct = r.acctType;
  const L = ['CASE REVIEW CHECKLIST', 'Case: ' + (c.caseNum || c.id), 'Patient: ' + (c.patient || '—'), 'Doctor: ' + (c.doctor || '—'), ''];
  L.push('Account type: ' + (acct === 'tri' ? 'TRI / Legacy Account' : acct === 'asp' ? 'ASPEN & ClearChoice' : '(not selected)'), '');
  const pf = v => v === 'pass' ? 'Pass' : (v === 'fail' ? 'Fail' : '—');
  if (acct === 'tri') {
    // Scan/file listings are omitted (those files ship in the scans/ folder); the
    // scan pass/fail review items are kept.
    L.push('SCAN REVIEW');
    SCAN_ITEMS.forEach((lbl, i) => L.push('  ' + lbl + ': ' + pf(r.scanItems && r.scanItems[i])));
    if (r.predesigned) L.push('  Predesigned Case: Yes');
    if (r.scanNotes) L.push('  Scan / files notes: ' + r.scanNotes);
    L.push('', 'DESIGN NEEDS');
    if (r.designNeeds != null && r.designNeeds !== undefined) L.push('  Design type: ' + (DESIGN_NEEDS_OPTS[r.designNeeds] || '—'));
    if (r.drApproval === 'yes') L.push('  Doctor design approval: Yes — Required');
  } else if (acct === 'asp') {
    L.push('DESIGN REQUIREMENTS');
    if (r.aspDesignReq != null && r.aspDesignReq !== undefined) { L.push('  Requirement: ' + (ASP_DESIGN_REQ[r.aspDesignReq] || '—')); if ((r.aspDesignReq === 1 || r.aspDesignReq === 2) && r.aspMouldName) L.push('  ' + (r.aspDesignReq === 1 ? 'Tooth mould' : 'Mould name') + ': ' + r.aspMouldName); }
    // Design Specifics — only items answered "Yes" are listed.
    const specYes = r.aspSpec ? ASP_SPEC_ITEMS.filter(it => r.aspSpec[it[0]] === 'yes') : [];
    if (specYes.length) { L.push('', 'DESIGN SPECIFICS'); specYes.forEach(it => L.push('  ' + it[1] + ': Yes')); }
    const lfx = r.aspSpec && r.aspSpec.lfx; const ccDig = r.aspSpec && r.aspSpec.ccDigital === 'yes';
    // (Required Scans and Files section intentionally omitted — those files ship in the scans/ folder.)
    if (lfx === 'no' && !ccDig && r.aspVerifiedModel) {
      L.push('', 'VERIFIED MODEL: ' + (r.aspVerifiedModel === 'tibase' ? 'Ti Base' : 'Scan body'));
      const opts = r.aspVerifiedModel === 'tibase' ? ASP_TIBASE_OPTS : ASP_SCANBODY_OPTS; const pfx = r.aspVerifiedModel === 'tibase' ? 'Ti' : 'Sb';
      ['Upper', 'Lower'].forEach(side => { const sel = r['asp' + pfx + side]; if (sel != null && sel !== undefined) { let v = opts[sel]; const loc = r['asp' + pfx + side + 'Loc']; if (loc) v += ' (' + loc + ')'; L.push('  ' + side + ': ' + v); } });
    }
    if (lfx === 'no') { L.push('', 'FINAL SCREWS'); if (r.aspScrewCount) L.push('  Total screws: ' + r.aspScrewCount); if (r.aspScrewType != null && r.aspScrewType !== undefined) L.push('  Screw type: ' + (ASP_SCREW_OPTS[r.aspScrewType] || '—')); }
  } else {
    L.push('(No account type selected — no review selections to export.)');
  }
  return L.join('\n') + '\n';
}
// Build the Case Review folder entries: scans/<review scan files>, Case Review
// Checklist.txt, design notes.txt, and the Data Entry files. Shared by the Case
// Review export and the Design export (which adds design-specific artifacts).
async function buildCaseReviewEntries(c, folder, opts) {
  const includeDataEntryFiles = !opts || opts.includeDataEntryFiles !== false;
  const r = getR(c.id);
  const zipSafe = s => String(s || 'file').replace(/[\\/]/g, '_');
  const entries = [];
  const addFile = async (name, path) => { if (!path) return; try { const url = await Data.fileUrl(path); entries.push({ name, url }); } catch (e) { entries.push({ name, url: null }); } };
  // scans/ — every Case Review scan/file upload except the design-return "missing info" box
  if (r.aspFiles) { for (const key of Object.keys(r.aspFiles)) { if (key === 'missing_info') continue; for (const f of (r.aspFiles[key] || [])) await addFile(`${folder}/scans/${zipSafe(f.name)}`, f.path); } }
  // Case Review Checklist (everything after the Rx & Work Ticket Review)
  entries.push({ name: `${folder}/Case Review Checklist.txt`, text: caseReviewChecklistText(c) });
  // design notes.txt — numbered doctor requirement notes
  const reqs = (c.designReqs || []).filter(x => x && x.trim());
  entries.push({ name: `${folder}/design notes.txt`, text: (reqs.length ? reqs.map((q, i) => `${i + 1}. ${q.trim()}`).join('\n') : '(no doctor requirement notes)') + '\n' });
  // data entry files (uploaded during Data Entry) — omitted from the Design export
  if (includeDataEntryFiles) { for (const f of (c.files || [])) await addFile(`${folder}/${zipSafe(f.name)}`, f.path); }
  return entries;
}
function caseFolderName(c) { return String(c.caseNum || c.id || 'case').replace(/[^a-zA-Z0-9._-]/g, '_'); }
async function exportCaseReviewZip(id) {
  const c = getC(id); if (!c) return;
  saveReviewNotes(id); // capture latest notes/selections before exporting
  const folder = caseFolderName(c);
  toast('Preparing ' + folder + '.zip…');
  await buildAndDownloadZip(folder + '.zip', await buildCaseReviewEntries(c, folder), toast);
}
// Design export — the full Case Review folder PLUS design-specific artifacts
// (filled design checklist PDF + a case summary).
async function exportDesignZip(id) {
  const c = getC(id); if (!c) return;
  saveDclTexts(id); // capture design checklist edits before exporting
  const folder = caseFolderName(c);
  const entries = await buildCaseReviewEntries(c, folder, { includeDataEntryFiles: false });
  try { const pdf = await fillDesignPdf(c); if (pdf) entries.push({ name: `${folder}/design_checklist_${c.dclType || 'NA'}_${folder}.pdf`, bytes: pdf }); } catch (e) {}
  toast('Preparing ' + folder + '.zip…');
  await buildAndDownloadZip(folder + '.zip', entries, toast);
}
function showCoordReason() { const b = document.getElementById('coord-reason-block'); if (b) b.style.display = 'block'; }
function sendToCoordination(id) { const c = getC(id); if (!c) return; saveReviewNotes(id); const ta = document.getElementById('coord-reason'); c.coordReason = ta ? ta.value.trim() : ''; advanceStage(id, 'Case Coordination', 'Placed on hold — sent to Case Coordination' + (c.coordReason ? ': ' + c.coordReason : ''), 'Case Review Team'); }
function showReturnReason() { const b = document.getElementById('return-de-block'); if (b) b.style.display = 'block'; }
function sendBackToDataEntry(id) {
  const c = getC(id); if (!c) return; saveReviewNotes(id);
  const ta = document.getElementById('return-de-reason'); const reason = ta ? ta.value.trim() : '';
  const a = getA(id); a.returnedFromReview = true; a.returnReason = reason;
  c.deHold = null; c.stage = 'Data Entry';
  cfEvent(c, 'Placed on hold — sent back to Data Entry for missing/incorrect information' + (reason ? ': ' + reason : ''), 'Case Review Team');
  cfSave(c);
  toast('Sent back to Data Entry for missing information');
  goBack('casereview'); // leaves the Case Review queue (now a Data Entry case)
}

// ── Design → Case Review return + the Case Review bucket actions ──────
function designActionsPanel(c) {
  const route = designRouteOf(c);
  if (route) {
    const label = route === 'bar' ? 'Bar Design' : (route === 'vjig' ? 'Design VJig/Custom Tray' : 'Milling');
    return `<div class="panel"><div class="panel-title"><i class="ti ti-route"></i> ${label}</div>
      <div class="alert alert-info" style="margin:0 0 10px"><i class="ti ti-info-circle"></i> This case has been sent to <strong>${label}</strong>.</div>
      <div class="actions-bar"><button class="btn btn-sm" onclick="CF.exportDesignZip('${c.id}')"><i class="ti ti-download"></i> Export Case ZIP</button><button class="btn" onclick="CF.clearDesignRoute('${c.id}')"><i class="ti ti-arrow-back-up"></i> Return to Design queue</button></div></div>`;
  }
  return `<div class="panel"><div class="panel-title"><i class="ti ti-send"></i> Design Actions</div>
    <div class="actions-bar">
      <button class="btn btn-sm btn-primary" onclick="CF.exportDesignZip('${c.id}');CF.showDesignRouting()"><i class="ti ti-download"></i> Export Case ZIP</button>
      <button class="btn" onclick="CF.showDesignReturn()"><i class="ti ti-arrow-back-up"></i> Send back to Case Review for missing information/clarification needed</button>
    </div>
    <div id="design-return-block" style="display:none;margin-top:12px">
      <div class="form-group"><label>Why are you sending this back to Case Review?</label><textarea id="design-return-reason" placeholder="Describe the missing information or clarification needed..."></textarea></div>
      <div class="actions-bar"><button class="btn btn-primary" onclick="CF.sendBackToCaseReview('${c.id}')"><i class="ti ti-send"></i> Confirm — Send back to Case Review</button></div>
    </div>
    <div id="design-routing-block" style="display:none;margin-top:12px">
      <span class="sec-label" style="margin-top:0">Route this case</span>
      <div class="actions-bar">
        <button class="btn btn-primary" onclick="CF.showOutsourcePartners()"><i class="ti ti-external-link"></i> Send to Outsource</button>
        <button class="btn" onclick="CF.routeDesign('${c.id}','bar')"><i class="ti ti-rectangle"></i> Send to Bar Design</button>
        <button class="btn" onclick="CF.routeDesign('${c.id}','vjig')"><i class="ti ti-dental"></i> Send to Design Verification Jig/Custom Tray</button>
        <button class="btn" onclick="CF.routeDesign('${c.id}','milling')"><i class="ti ti-tools"></i> Send to Milling</button>
      </div>
      <div id="outsource-partners" style="display:none;margin-top:10px">
        <span class="sec-label" style="margin-top:0">Choose outsource partner</span>
        <div class="actions-bar">
          <button class="btn" onclick="CF.sendToOutsource('${c.id}','adite')">Send to Adite</button>
          <button class="btn" onclick="CF.sendToOutsource('${c.id}','heygears')">Send to HeyGears</button>
          <button class="btn" onclick="CF.sendToOutsource('${c.id}','cadora')">Send to Cadora</button>
        </div>
      </div>
    </div></div>`;
}
function showDesignReturn() { const b = document.getElementById('design-return-block'); if (b) b.style.display = 'block'; }
function showDesignRouting() { const b = document.getElementById('design-routing-block'); if (b) b.style.display = 'block'; }
function showOutsourcePartners() { const b = document.getElementById('outsource-partners'); if (b) b.style.display = 'block'; }
function routeDesign(id, route) {
  const c = getC(id); if (!c) return;
  const r = getR(id); r.designRoute = route; r.outsourcePartner = null;
  const label = route === 'bar' ? 'Bar Design' : (route === 'vjig' ? 'Design VJig/Custom Tray' : 'Milling');
  cfEvent(c, 'Routed to ' + label, 'Design Team'); cfSave(c); // stage stays 'Design Check'
  toast('Sent to ' + label); goBack('design');
}
// Outsourced cases are held in the Outsource tab until 4:00am the following day,
// then auto-released to QC. Compute that release moment (local time).
function nextQcReleaseISO(fromISO) {
  const base = fromISO ? new Date(fromISO) : new Date();
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 4, 0, 0, 0).toISOString();
}
// Sweep: move any Outsourcing case whose 4am hold has elapsed into QC. Runs on
// load and on a timer (so it fires if the app is open at 4am), and is idempotent.
function releaseOutsourcedToQc() {
  if (!loaded) return 0;
  const now = Date.now(); let moved = 0;
  for (const c of cases) {
    if (c.stage !== 'Outsourcing') continue;
    const rel = c.aoxReview && c.aoxReview.qcReleaseAt;
    if (rel && now >= new Date(rel).getTime()) { c.stage = 'QC'; cfEvent(c, 'Auto-released to QC (overnight outsource hold elapsed)', 'System'); cfSave(c); moved++; }
  }
  if (moved && selectedMode === 'design' && !selectedCaseId) renderMode('design');
  return moved;
}
function sendToOutsource(id, partner) {
  const c = getC(id); if (!c) return;
  const r = getR(id); r.outsourcePartner = partner; r.designRoute = null;
  r.outsourcedAt = new Date().toISOString();
  r.qcReleaseAt = nextQcReleaseISO(r.outsourcedAt);
  c.stage = 'Outsourcing';
  cfEvent(c, 'Sent to outsource partner: ' + (OUTSOURCE_PARTNERS[partner] || partner) + ' — holds until ' + fmtTs(r.qcReleaseAt), 'Design Team'); cfSave(c);
  toast('Sent to ' + (OUTSOURCE_PARTNERS[partner] || partner)); goBack('design');
}
function clearDesignRoute(id) {
  const c = getC(id); if (!c) return; const r = getR(id); r.designRoute = null;
  cfEvent(c, 'Returned to Design queue', 'Design Team'); cfSave(c);
  toast('Returned to Design queue'); goBack('design');
}
function sendBackToCaseReview(id) {
  const c = getC(id); if (!c) return; saveDclTexts(id);
  const ta = document.getElementById('design-return-reason'); const reason = ta ? ta.value.trim() : '';
  const r = getR(id); r.crBucket = 'design_return'; r.designReturnReason = reason;
  c.stage = 'Review';
  cfEvent(c, 'Sent back to Case Review from Design — missing info/clarification needed' + (reason ? ': ' + reason : ''), 'Design Team');
  cfSave(c);
  toast('Sent back to Case Review');
  goBack('design');
}
// Missing-info uploads use a dedicated path (the editable review checklist isn't on
// screen in this view, so rebuildAoxReview would no-op — persist + re-render here).
function crMissingPick(id) { pickFiles(async files => { await uploadCrFiles(id, 'missing_info', files); }); }
async function crMissingDrop(ev, id) { ev.preventDefault(); ev.stopPropagation(); ev.currentTarget.classList.remove('drag-over'); const fl = ev.dataTransfer && ev.dataTransfer.files; if (fl && fl.length) await uploadCrFiles(id, 'missing_info', Array.from(fl)); }
async function uploadCrFiles(id, key, files) {
  const c = getC(id); const r = getR(id); if (!r.aspFiles) r.aspFiles = {}; if (!r.aspFiles[key]) r.aspFiles[key] = [];
  for (const f of files) { try { const meta = await Data.uploadFile(c, 'review', f, key); r.aspFiles[key].push({ name: meta.name, size: meta.size, path: meta.path }); } catch (e) { toast('Upload failed: ' + e.message); } }
  cfSave(c); if (selectedMode) renderMode(selectedMode); toast('File(s) attached');
}
function crMissingRemove(id, idx) { const r = getR(id); if (r.aspFiles && r.aspFiles.missing_info) { r.aspFiles.missing_info.splice(idx, 1); cfSave(getC(id)); if (selectedMode) renderMode(selectedMode); } }
function saveCrFields(id) { const r = getR(id); const cl = document.getElementById('cr-clarification'); if (cl) r.crClarification = cl.value; const tn = document.getElementById('cr-ta-notes'); if (tn) r.taNotes = tn.value; cfSave(getC(id)); }
function crSendToDesign(id) { const c = getC(id); if (!c) return; saveCrFields(id); const r = getR(id); r.crBucket = null; c.stage = 'Design Check'; cfEvent(c, 'Returned to Design with new files/clarification' + (r.crClarification ? ': ' + r.crClarification : ''), 'Case Review Team'); cfSave(c); toast('Sent back to Design'); goBack('casereview'); }
function crHoldMissing(id) { const c = getC(id); if (!c) return; saveCrFields(id); const r = getR(id); r.crBucket = 'hold_missing'; c.stage = 'Review'; cfEvent(c, 'Placed on hold for missing information', 'Case Review Team'); cfSave(c); toast('Placed on hold for missing information'); goBack('casereview'); }
function showTaNotes() { const b = document.getElementById('ta-notes-block'); if (b) b.style.display = 'block'; }
function crEscalateTa(id) { const c = getC(id); if (!c) return; saveCrFields(id); const r = getR(id); const ta = document.getElementById('cr-ta-notes'); r.taNotes = ta ? ta.value.trim() : (r.taNotes || ''); r.crBucket = 'ta'; c.stage = 'Review'; cfEvent(c, 'Escalated to Technical Advisor' + (r.taNotes ? ': ' + r.taNotes : ''), 'Case Review Team'); cfSave(c); toast('Escalated to Technical Advisor'); goBack('casereview'); }
function crPassToScanning(id) { const c = getC(id); if (!c) return; saveCrFields(id); const r = getR(id); r.crBucket = null; c.stage = 'Scanning'; cfEvent(c, 'Passed to Scanning team', 'Case Review Team'); cfSave(c); toast('Passed to Scanning'); goBack('casereview'); }
function fileExt(name) { const m = /\.([a-z0-9]+)$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
// .stl -> 3Shape, .cad -> exocad: download with the real filename so the Windows
// file-association opens it in the desktop CAD app. Everything else previews in a tab.
function openByType(name, url) {
  const ext = fileExt(name);
  if (ext === 'stl' || ext === 'cad') {
    const sep = url.indexOf('?') > -1 ? '&' : '?';
    const dl = url + sep + 'download=' + encodeURIComponent(name); // Supabase signed-URL attachment
    const a = document.createElement('a'); a.href = dl; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); setTimeout(() => { try { document.body.removeChild(a); } catch (e) {} }, 0);
    toast('Downloading ' + name + ' — opens in ' + (ext === 'stl' ? '3Shape' : 'exocad'));
    return;
  }
  window.open(url, '_blank', 'noopener');
}
async function previewFile(id, kind, idx, key) {
  const c = getC(id); if (!c) return;
  let f;
  if (kind === 'asp') { const r = getR(id); f = r.aspFiles && r.aspFiles[key] && r.aspFiles[key][idx]; }
  else { const arr = kind === 'review' ? c.reviewFiles : (kind === 'scan' ? c.scanFiles : c.files); f = arr && arr[idx]; }
  if (!f) return;
  if (!f.path) { toast('No stored file to open for this entry'); return; }
  try { const url = await Data.fileUrl(f.path); if (url) openByType(f.name, url); }
  catch (e) { toast('Open failed: ' + e.message); }
}
function selectQC(val) { qcSel = val; document.getElementById('qc-pass').className = 'qc-opt' + (val === 'pass' ? ' selected' : ''); document.getElementById('qc-fail').className = 'qc-opt' + (val === 'fail' ? ' selected-red' : ''); document.getElementById('fail-options').style.display = val === 'fail' ? 'block' : 'none'; if (val === 'pass') { adjSel = null; document.getElementById('qc-actions').innerHTML = `<button class="btn btn-primary" onclick="CF.submitQC()"><i class="ti ti-check"></i> Confirm QC Pass — Mark Complete</button>`; } else document.getElementById('qc-actions').innerHTML = ''; }
function selectAdj(val) { adjSel = val; document.getElementById('adj-self').className = 'sub-opt' + (val === 'self' ? ' selected' : ''); document.getElementById('adj-resend').className = 'sub-opt' + (val === 'resend' ? ' selected' : ''); document.getElementById('qc-actions').innerHTML = `<button class="btn btn-primary btn-danger" onclick="CF.submitQC()"><i class="ti ti-x"></i> ${val === 'self' ? 'Assign In-House Rework' : 'Resend to Outsourcer'}</button>`; }
function submitQC() { const c = getC(selectedCaseId); if (!c) return; const notesEl = document.getElementById('qc-notes'); if (notesEl) c.qcNotes = notesEl.value; if (qcSel === 'pass') advanceStage(c.id, 'Complete', 'QC passed — case complete', 'Design Team (QC)'); else if (adjSel === 'self') advanceStage(c.id, 'QC Failed - Rework', 'QC failed — in-house rework assigned', 'Design Team (QC)'); else if (adjSel === 'resend') advanceStage(c.id, 'QC Failed - Resend', 'QC failed — resent to outsourcer', 'Design Team (QC)'); }
function toggleCheck(id, idx) { const c = getC(id); if (!c) return; if (!c.checklistDone) c.checklistDone = []; const i = c.checklistDone.indexOf(idx); if (i > -1) c.checklistDone.splice(i, 1); else c.checklistDone.push(idx); cfSave(c); if (selectedMode) renderMode(selectedMode); }
function toggleDeRush(id) { const c = getC(id); if (!c) return; c.rush = !c.rush; const row = document.getElementById('de-rush-row'); const cb = document.getElementById('de-rush'); if (row) row.className = 'rush-row' + (c.rush ? ' rush-active' : ''); if (cb) cb.checked = c.rush; cfSave(c); }
function saveDeFields(id) { const c = getC(id); if (!c) return; saveAoxText(id); const g = k => document.getElementById(k); const p = g('de-patient'); if (p) c.patient = p.value; const dr = g('de-doctor'); if (dr) c.doctor = dr.value; const dd = g('de-drdue'); if (dd) c.drDueDate = dd.value; const nt = g('de-notes'); if (nt) c.notes = nt.value; const cn = g('de-casenum'); if (cn) c.caseNum = cn.value; const sd = g('de-shipdate'); if (sd) c.shipDate = sd.value; }
function submitDataEntry(id) { saveDeFields(id); const c = getC(id); if (c) { c.deHold = null; const a = getA(id); a.returnedFromReview = false; a.returnReason = ''; } advanceStage(id, 'Review', 'Data submitted and sent to review', 'Data Entry Team'); }
function holdDataEntry(id, type) { saveDeFields(id); const c = getC(id); if (!c) return; c.deHold = type; const msg = type === 'models' ? 'Placed on hold — waiting for physical models' : 'Placed on hold — waiting for missing information'; cfEvent(c, msg, 'Data Entry Team'); cfSave(c); if (selectedMode) renderMode(selectedMode); toast(msg); }
function saveOutsourceNotes(id) { const c = getC(id); if (!c) return; const el = document.getElementById('outsource-notes'); if (el) { c.outsourceNotes = el.value; cfSave(c); } }
function beginQc(id) { saveOutsourceNotes(id); advanceStage(id, 'QC', 'Design received — ready for QC', 'Design Team'); }
function markDesignReceived(id) { saveOutsourceNotes(id); advanceStage(id, 'QC', 'Design file received — ready for QC', 'Design Team'); }

// ── real file upload (replaces fakeUpload) ──────────────────────────
function pickFiles(cb, accept) { const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; if (accept) inp.accept = accept; inp.style.display = 'none'; document.body.appendChild(inp); inp.onchange = () => { const files = Array.from(inp.files || []); document.body.removeChild(inp); if (files.length) cb(files); }; inp.click(); }
async function uploadInto(c, kind, files) {
  for (const f of files) {
    try {
      const meta = await Data.uploadFile(c, kind === 'review' ? 'review' : (kind === 'scan' ? 'scan' : (kind === 'design' ? 'design' : 'entry')), f);
      if (kind === 'review') c.reviewFiles.push(meta);
      else if (kind === 'scan') { if (!c.scanFiles) c.scanFiles = []; c.scanFiles.push(meta); }
      else if (kind === 'design') c.designFile = meta;
      else c.files.push(meta);
    } catch (e) { toast('Upload failed: ' + e.message); }
  }
  cfSave(c); // file metadata lives in the case row (single-table) — persist it
  if (selectedMode) renderMode(selectedMode);
  toast('File(s) attached');
}
function pick(kind) { const c = getC(selectedCaseId); if (!c) return; pickFiles(async files => { await uploadInto(c, kind, files); }); }
// Drag-and-drop counterpart to pick() for the click-to-upload zones.
async function dropFiles(ev, kind) {
  ev.preventDefault(); ev.stopPropagation(); ev.currentTarget.classList.remove('drag-over');
  const c = getC(selectedCaseId); if (!c) return;
  const fl = ev.dataTransfer && ev.dataTransfer.files; const files = fl ? Array.from(fl) : [];
  if (files.length) await uploadInto(c, kind, files);
}

// ── New Case modal ──────────────────────────────────────────────────
function openNewCase() { document.getElementById('cf-new-case-modal').classList.add('open'); }
function closeModal() { document.getElementById('cf-new-case-modal').classList.remove('open'); }
function toggleRush() { rushState = !rushState; document.getElementById('cf-nc-rush').checked = rushState; document.getElementById('cf-rush-row').className = 'rush-row' + (rushState ? ' rush-active' : ''); }
async function createCase() {
  const patient = document.getElementById('cf-nc-patient').value.trim() || 'New Patient';
  const doctor = document.getElementById('cf-nc-doctor').value.trim() || '—';
  const drDueDate = document.getElementById('cf-nc-drdue').value;
  const rush = document.getElementById('cf-nc-rush').checked;
  const notes = document.getElementById('cf-nc-notes').value.trim();
  const caseId = Data.nextCaseId(cases);
  let c;
  try {
    c = await Data.insertCase({ case_id: caseId, patient, doctor, rush, dr_due_date: drDueDate || null, notes, stage: 'Data Entry' });
  } catch (e) { toast('Create failed: ' + e.message); return; }
  cases.unshift(c);
  c.timeline.push({ text: 'Case created', by: 'Data Entry Team', at: new Date().toISOString() });
  Data.saveCase(c).catch(() => {});
  closeModal(); rushState = false;
  ['cf-nc-patient', 'cf-nc-doctor', 'cf-nc-notes', 'cf-nc-drdue'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('cf-nc-rush').checked = false; document.getElementById('cf-rush-row').className = 'rush-row';
  toast(`Case created for ${patient}`);
  openCase('dataentry', c.id);
}

// =====================================================================
// init + window.CF export
// =====================================================================
let _aoxListenerAttached = false;
export function initCaseFlow() {
  if (_aoxListenerAttached) return;
  _aoxListenerAttached = true;
  // Check once a minute whether any outsourced case has passed its 4am hold so it
  // moves to QC even while the app stays open overnight.
  setInterval(releaseOutsourcedToQc, 60000);
  // Delegated AOX (Data Entry checklist) click handler — one global, matches the
  // prototype. Only one detail is ever open, so #aox-panel is unique.
  document.addEventListener('click', function (e) {
    const panel = e.target.closest && e.target.closest('#aox-panel'); if (!panel) return;
    const caseId = panel.dataset.caseId; const a = getA(caseId); saveAoxText(caseId);
    const catBtn = e.target.closest('[data-aox-cat]');
    if (catBtn) { const cat = catBtn.dataset.aoxCat; a.cat = a.cat === cat ? null : cat; ['ccType', 'ccOption', 'ccDavinci', 'ccIcamFee', 'rcpDigital', 'rcpOption', 'aspSub', 'aspType', 'aspFinal', 'aspRcpMat', 'aspRcpZirc', 'aspRcpPmmaType', 'aspRcpVJ', 'aspRcpLfx', 'skdType', 'skdFinal', 'skdRcpMat', 'skdRcpZirc', 'skdRcpVJ', 'engFinal', 'engSurgicalAddon', 'engDoctor', ...TRI_ALL].forEach(k => a[k] = null); rebuildAox(caseId); return; }
    const panBtn = e.target.closest('[data-aox-pan]');
    if (panBtn) { a.panType = panBtn.dataset.aoxPan; rebuildAox(caseId); return; }
    const optRow = e.target.closest('[data-aox-field][data-aox-val]');
    if (optRow) { const field = optRow.dataset.aoxField, val = parseInt(optRow.dataset.aoxVal, 10); const stateKey = FIELD_MAP[field] || field; (RESET_MAP[stateKey] || []).forEach(k => a[k] = null); a[stateKey] = val; rebuildAox(caseId); return; }
    const tog = e.target.closest('[data-aox-toggle]');
    if (tog) { const t = tog.dataset.aoxToggle; a[t] = !a[t]; if (t === 'addon' && !a[t]) { a.addonDenture = false; a.addonNightguard = false; } if (t === 'addonMfg' && !a[t]) a.addonMfgSel = null; rebuildAox(caseId); }
  });
}

const CF = {
  openCase, goBack, setDeTab, setDesignTab, setCrTab, advanceStage, filterQueue,
  saveOutsourceNotes, beginQc,
  // review checklist
  setAcctType, setAspDesignReq, setAspSpec, setAspVerifiedModel, setAspArch, setAspScrewType, setAspScrewCount,
  aspDragOver, aspDragLeave, aspDrop, aspPick, aspRemoveFile, setPF, setDesignNeeds, setDrApproval, saveReviewNotes, togglePredesigned,
  // doctor reqs
  saveDesignReqs, addDesignReq, removeDesignReq, toggleReqsAck,
  // review transitions
  passToDesign, passToScanning, showCoordReason, sendToCoordination, showReturnReason, sendBackToDataEntry,
  exportCaseReviewZip,
  // design → case review return + case review bucket actions
  showDesignReturn, sendBackToCaseReview, crMissingPick, crMissingDrop, crMissingRemove, saveCrFields,
  crSendToDesign, crHoldMissing, showTaNotes, crEscalateTa, crPassToScanning,
  // design routing (outsource partners / bar / vjig / milling)
  showDesignRouting, showOutsourcePartners, routeDesign, sendToOutsource, clearDesignRoute, exportDesignZip, setQcPartner,
  // complete tab filters
  setCompletePartner, setCompleteFrom, setCompleteTo, clearCompleteFilters,
  // file preview (signed URL)
  previewFile,
  // design checklist
  setDclType, toggleDcl, setDclVal, setDclText,
  // QC + design
  selectQC, selectAdj, submitQC, toggleCheck, markDesignReceived,
  exportZip: (id) => { const c = getC(id); if (c) exportZip(c, toast); },
  // data entry
  toggleDeRush, submitDataEntry, holdDataEntry, pick, dropFiles,
  // new case
  openNewCase, closeModal, toggleRush, createCase,
  // expose for host wiring
  reload, renderCaseFlowMode,
};
if (typeof window !== 'undefined') window.CF = CF;
export default CF;
