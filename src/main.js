// =====================================================================
// Auth (Microsoft SSO via Supabase) — gates the entire app boot
// =====================================================================
import './auth.css';
import { initAuth, getCurrentEmployee, signOut as authSignOut, getAccessToken } from './auth.js';
import { can, CAPABILITIES } from './permissions.js';

// =====================================================================
// Configuration
// =====================================================================
const PROJECT_ID = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? '';
const MCP_SQL = 'mcp__8dd16a38-98a9-4842-82ed-37fbae8919ae__execute_sql';
const REVIEWER = import.meta.env.VITE_REVIEWER ?? 'coordinator@skdla';

// Identity of the Microsoft (SSO) account currently signed in. Used to stamp
// submissions/reviews with the real login account alongside any name the user
// typed/selected — so borrowed-account use is traceable.
function loginIdentity() {
  const e = getCurrentEmployee() || {};
  const name = e.name || e.email || 'Unknown';
  const email = e.email || null;
  return { name, email };
}
const SUPABASE_DEFAULT_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_DEFAULT_KEY = import.meta.env.VITE_SUPABASE_KEY ?? '';
const ANTHROPIC_DEFAULT_KEY = import.meta.env.VITE_ANTHROPIC_KEY ?? '';

const REASON_LABEL = {
  design_approval: 'Design Approval',
  design_modification: 'Design Modification',
  missing_info: 'Missing Info',
  waiting_on_parts: 'Waiting on Parts',
  reschedule_check: 'Reschedule Check',
};

let state = { outbound: [], inbound: [], audit: [] };
let auditWindowDays = parseInt(localStorage.getItem('skdla_audit_window') || '7', 10);
// Tracks accounts we've already kicked off summary generation for in this
// session, so the lazy backfill never fires twice for the same account.
const prefSummaryAttempted = new Set();
let prefSummaryBackfillRunning = false;
let lastResponse = null;

function setAuditWindow(days) {
  auditWindowDays = parseInt(days, 10) || 7;
  localStorage.setItem('skdla_audit_window', String(auditWindowDays));
  const sel = document.getElementById('audit-window');
  if (sel) sel.value = String(auditWindowDays);
  loadAudit();
}

// Detect environment: Cowork sidebar vs standalone file
const inCowork = typeof window.cowork !== 'undefined' && typeof window.cowork.callMcpTool === 'function';
document.getElementById('diag-mode').textContent = inCowork ? 'Cowork MCP' : 'Direct REST';

function getConfig() {
  return {
    url:       localStorage.getItem('skdla_sb_url') || SUPABASE_DEFAULT_URL,
    key:       localStorage.getItem('skdla_sb_key') || SUPABASE_DEFAULT_KEY,
    anthropic: localStorage.getItem('skdla_anthropic_key') || ANTHROPIC_DEFAULT_KEY
  };
}
function saveConfigVals(url, key, anthropic) {
  localStorage.setItem('skdla_sb_url', url);
  localStorage.setItem('skdla_sb_key', key);
  if (anthropic !== undefined) localStorage.setItem('skdla_anthropic_key', anthropic);
}

// =====================================================================
// Data layer ·supports both Cowork MCP and direct REST
// =====================================================================
function parseMcpResult(raw) {
  if (Array.isArray(raw)) return raw;
  let s = raw;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.content)) {
      const t = raw.content.find(c => c.type === 'text');
      if (t) s = t.text;
    } else if (raw.result !== undefined) {
      s = typeof raw.result === 'string' ? raw.result : JSON.stringify(raw.result);
    } else {
      s = JSON.stringify(raw);
    }
  }
  if (typeof s !== 'string') return [];
  const m = s.match(/<untrusted-data[^>]*>([\s\S]*?)<\/untrusted-data/);
  if (m) { try { return JSON.parse(m[1].trim()); } catch (e) {} }
  const arr = s.match(/\[\s*[\{\[][\s\S]*[\}\]]\s*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch (e) {} }
  try { return JSON.parse(s.trim()); } catch (e) { return []; }
}

async function runMcpSql(query) {
  try {
    const raw = await window.cowork.callMcpTool(MCP_SQL, { project_id: PROJECT_ID, query });
    lastResponse = raw; updateDiag();
    return parseMcpResult(raw);
  } catch (err) {
    lastResponse = { _error: String(err && (err.message || err)) };
    updateDiag();
    toast('Supabase error: ' + (err.message || err), 'err');
    return [];
  }
}

async function restGet(path) {
  const cfg = getConfig();
  if (!cfg.key) { needsConfig(); return []; }
  try {
    const resp = await fetch(cfg.url + path, {
      headers: {
        'apikey': cfg.key,
        'Authorization': 'Bearer ' + cfg.key,
        'Accept': 'application/json'
      }
    });
    if (!resp.ok) {
      const text = await resp.text();
      lastResponse = { _error: 'HTTP ' + resp.status + ': ' + text };
      updateDiag();
      toast('Supabase error: HTTP ' + resp.status, 'err');
      setStatus(false);
      return [];
    }
    const data = await resp.json();
    lastResponse = data;
    updateDiag();
    setStatus(true);
    return Array.isArray(data) ? data : [data];
  } catch (err) {
    lastResponse = { _error: String(err && (err.message || err)) };
    updateDiag();
    toast('Network error: ' + (err.message || err), 'err');
    setStatus(false);
    return [];
  }
}

async function restRpc(fnName, args) {
  const cfg = getConfig();
  if (!cfg.key) { needsConfig(); return null; }
  try {
    const resp = await fetch(cfg.url + '/rest/v1/rpc/' + fnName, {
      method: 'POST',
      headers: {
        'apikey': cfg.key,
        'Authorization': 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(args || {})
    });
    if (!resp.ok) {
      const text = await resp.text();
      lastResponse = { _error: 'HTTP ' + resp.status + ': ' + text };
      updateDiag();
      toast('RPC error: ' + text.slice(0, 200), 'err');
      throw new Error(text);
    }
    const data = await resp.json();
    lastResponse = data; updateDiag();
    return data;
  } catch (err) {
    if (!lastResponse || !lastResponse._error) {
      lastResponse = { _error: String(err && (err.message || err)) };
      updateDiag();
    }
    throw err;
  }
}

// Unified query layer
async function queryView(viewName) {
  if (inCowork) {
    return runMcpSql('SELECT * FROM ' + viewName + ' LIMIT 100');
  }
  return restGet('/rest/v1/' + viewName + '?select=*&limit=100');
}

async function callRpc(fnName, args) {
  if (inCowork) {
    // Build named-arg SQL: SELECT fn(p_arg1 => '...', p_arg2 => ...)
    const argStr = Object.entries(args || {}).map(([k, v]) => {
      if (v === null || v === undefined) return k + ' => NULL';
      if (typeof v === 'number') return k + ' => ' + v;
      let val = String(v).replace(/'/g, "''");
      if (k === 'p_attempt_id' || k === 'p_reply_id') {
        return k + " => '" + val + "'::uuid";
      }
      return k + " => '" + val + "'";
    }).join(', ');
    return runMcpSql('SELECT ' + fnName + '(' + argStr + ')');
  }
  return restRpc(fnName, args);
}

// =====================================================================
// UI helpers
// =====================================================================
let toastT;
function toast(msg, kind) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast shown ' + (kind || '');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('shown'), 2800);
}

function toggleDiag() { document.getElementById('diag').classList.toggle('shown'); }
function updateDiag() {
  const pre = document.getElementById('diag-content');
  try {
    pre.textContent = typeof lastResponse === 'string'
      ? lastResponse
      : JSON.stringify(lastResponse, null, 2);
  } catch (e) { pre.textContent = String(lastResponse); }
}
function setStatus(ok) {
  document.getElementById('status-dot').className = 'dot' + (ok ? '' : ' err');
}

function openConfig() {
  const cfg = getConfig();
  document.getElementById('cfg-url').value = cfg.url;
  document.getElementById('cfg-key').value = cfg.key;
  document.getElementById('cfg-anthropic').value = cfg.anthropic;
  document.getElementById('configModal').classList.remove('hidden');
}
function closeConfig() { document.getElementById('configModal').classList.add('hidden'); }
function needsConfig() {
  if (inCowork) return;
  openConfig();
  toast('Configure your Supabase service role key to continue', 'err');
}
function saveConfig() {
  const url       = document.getElementById('cfg-url').value.trim().replace(/\/$/, '');
  const key       = document.getElementById('cfg-key').value.trim();
  const anthropic = document.getElementById('cfg-anthropic').value.trim();
  if (!url || !key) { toast('Supabase URL and service key are required', 'err'); return; }
  saveConfigVals(url, key, anthropic);
  closeConfig();
  toast('Configuration saved', 'ok');
  loadAll();
}

// =====================================================================
// Loaders
// =====================================================================
// Track which cards a coordinator is actively looking at so an auto-refresh
// doesn't blow that context away. Captured per `data-id` to survive a full
// re-render of the list.
function captureUiContext() {
  const ctx = {
    scrollY: window.scrollY,
    expanded: Array.from(document.querySelectorAll('.item.expanded')).map(el => el.dataset.id),
    editsOpen: Array.from(document.querySelectorAll('.edit-form.shown')).map(el => el.id.replace(/^edit-/, '')),
    activeEl: document.activeElement && document.activeElement.id ? document.activeElement.id : null,
  };
  return ctx;
}

function restoreUiContext(ctx) {
  if (!ctx) return;
  // Re-expand cards
  for (const id of ctx.expanded || []) {
    const el = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
    if (el) el.classList.add('expanded');
  }
  // Re-open any edit forms that were open
  for (const id of ctx.editsOpen || []) {
    const ef = document.getElementById('edit-' + id);
    if (ef) ef.classList.add('shown');
  }
  // Restore focus on the input the coordinator was typing into (e.g., search bar)
  if (ctx.activeEl) {
    const el = document.getElementById(ctx.activeEl);
    if (el && typeof el.focus === 'function') {
      // Keep the cursor position if it's a text field
      const sel = (el.selectionStart !== undefined) ? { s: el.selectionStart, e: el.selectionEnd } : null;
      el.focus({ preventScroll: true });
      if (sel && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(sel.s, sel.e); } catch {}
      }
    }
  }
  // Restore scroll last so the layout settles first
  window.scrollTo({ top: ctx.scrollY, behavior: 'instant' in window ? 'instant' : 'auto' });
}

async function loadAll() {
  const ctx = captureUiContext();
  document.getElementById('lastUpdated').textContent = 'Refreshing…';
  await Promise.all([loadOutbound(), loadInbound(), loadAudit(), loadReschedule(), loadReady(), loadEditLog(), loadFeedback()]);
  const now = new Date();
  document.getElementById('lastUpdated').textContent =
    'Updated ' + now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // Apply restoration on the next paint so the new DOM exists
  requestAnimationFrame(() => restoreUiContext(ctx));
}

// ----- Edit Log -----
let editLogRows = [];
async function loadEditLog() {
  if (inCowork) {
    editLogRows = await runMcpSql('SELECT * FROM v_attempt_edits LIMIT 500') || [];
  } else {
    editLogRows = await restGet('/rest/v1/v_attempt_edits?select=*&order=edited_at.desc&limit=500') || [];
  }
  document.getElementById('badge-editlog').textContent = editLogRows.length;
  renderEditLog();
}

function htmlToText(html) {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
}

function renderEditLog() {
  const root = document.getElementById('list-editlog');
  if (!editLogRows.length) {
    root.innerHTML = '<div class="empty"><strong>No edits recorded yet.</strong><br/>When a coordinator clicks "Edit Then Send" on a draft, the before and after will appear here.</div>';
    return;
  }
  root.innerHTML = editLogRows.map(r => {
    const beforeText = htmlToText(r.original_body_html).slice(0, 600);
    const afterText  = htmlToText(r.edited_body_html).slice(0, 600);
    const delta = r.body_char_delta || 0;
    const deltaStr = (delta >= 0 ? '+' : '') + delta + ' chars';
    return `
    <div class="edit-card">
      <div class="edit-card-head">
        <div>
          <span class="pan">${esc(r.pan_number || '-')}</span>
          <span class="case-sub" style="margin-left: 8px;">Case ${esc(r.case_number || '-')}</span>
          ${r.reason ? '<span class="reason-chip ' + esc(r.reason) + '" style="margin-left: 10px;">' + esc(r.reason.replace(/_/g,' ')) + '</span>' : ''}
        </div>
        <div class="edit-meta">
          <div>${esc(r.edited_by || '-')}</div>
          <div>${esc(new Date(r.edited_at).toLocaleString())}</div>
          <div style="color: var(--slate); font-size: 11px;">${deltaStr}</div>
        </div>
      </div>
      ${r.subject_changed ? `
        <div class="edit-row">
          <div class="edit-row-label">Subject</div>
          <div class="edit-diff">
            <div class="edit-before"><span class="edit-tag">before</span>${esc(r.original_subject || '')}</div>
            <div class="edit-after"><span class="edit-tag">after</span>${esc(r.edited_subject || '')}</div>
          </div>
        </div>
      ` : ''}
      ${r.body_changed ? `
        <div class="edit-row">
          <div class="edit-row-label">Body (text preview)</div>
          <div class="edit-diff">
            <div class="edit-before"><span class="edit-tag">before</span>${esc(beforeText)}${beforeText.length === 600 ? '…' : ''}</div>
            <div class="edit-after"><span class="edit-tag">after</span>${esc(afterText)}${afterText.length === 600 ? '…' : ''}</div>
          </div>
        </div>
      ` : ''}
      ${r.edit_note ? `<div class="edit-note"><strong>Coordinator note:</strong> ${esc(r.edit_note)}</div>` : ''}
    </div>`;
  }).join('');
}

// ----- Feedback -----
let feedbackRows = [];
async function loadFeedback() {
  if (inCowork) {
    feedbackRows = await runMcpSql('SELECT * FROM coordinator_feedback ORDER BY submitted_at DESC LIMIT 200') || [];
  } else {
    feedbackRows = await restGet('/rest/v1/coordinator_feedback?select=*&order=submitted_at.desc&limit=200') || [];
  }
  renderFeedback();
}

function renderFeedback() {
  const root = document.getElementById('list-feedback');
  if (!feedbackRows.length) {
    root.innerHTML = '<div class="empty">No feedback submitted yet.</div>';
    return;
  }
  root.innerHTML = feedbackRows.map(r => {
    const cat = r.category || 'Other';
    return `
    <div class="feedback-card ${r.resolved ? 'resolved' : ''}">
      <div class="feedback-head">
        <span class="feedback-cat">${esc(cat)}</span>
        <span class="feedback-meta">${esc(r.submitted_by || 'Anonymous')} · ${esc(new Date(r.submitted_at).toLocaleString())}${r.case_number ? ' · Case ' + esc(r.case_number) : ''}</span>
        ${r.resolved ? '<span class="feedback-status">Resolved</span>' : '<span class="feedback-status open">Open</span>'}
      </div>
      <div class="feedback-body">${esc(r.message)}</div>
      ${r.resolution_note ? `<div class="feedback-resolution"><strong>Resolution:</strong> ${esc(r.resolution_note)}</div>` : ''}
    </div>`;
  }).join('');
}

async function submitFeedback() {
  const message = document.getElementById('fb-message').value.trim();
  const category = document.getElementById('fb-category').value;
  const caseNum = document.getElementById('fb-case').value.trim() || null;
  const by = document.getElementById('fb-by').value.trim() || null;
  if (!message) { toast('Please write a message', 'err'); return; }
  try {
    const me = loginIdentity();
    if (inCowork) {
      const q = v => v ? "'" + String(v).replace(/'/g, "''") + "'" : 'NULL';
      await runMcpSql(
        "INSERT INTO coordinator_feedback (submitted_by, category, message, case_number, login_name, login_email) " +
        "VALUES (" + q(by) + ", " + q(category) + ", " + q(message) + ", " + q(caseNum) + ", " + q(me.name) + ", " + q(me.email) + ")"
      );
    } else {
      const cfg = getConfig();
      await fetch(cfg.url + '/rest/v1/coordinator_feedback', {
        method: 'POST',
        headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ submitted_by: by, category, message, case_number: caseNum, login_name: me.name, login_email: me.email }),
      });
    }
    toast('Thanks! Feedback submitted.', 'ok');
    document.getElementById('fb-message').value = '';
    document.getElementById('fb-case').value = '';
    await loadFeedback();
  } catch (e) {
    toast('Could not submit: ' + (e.message || e), 'err');
  }
}

let readyRows = [];
async function loadReady() {
  // Bypass the default 100-row queryView cap — show up to 1000 eligible cases.
  if (inCowork) {
    readyRows = await runMcpSql('SELECT * FROM v_aox_design_approval_due ORDER BY waiting_since DESC LIMIT 1000') || [];
  } else {
    readyRows = await restGet('/rest/v1/v_aox_design_approval_due?select=*&order=waiting_since.desc&limit=1000') || [];
  }
  document.getElementById('badge-ready').textContent = readyRows.length;
  renderReady();
}

function renderReady() {
  const root = document.getElementById('list-ready');
  if (!readyRows.length) {
    root.innerHTML = '<div class="empty"><strong>No AoX cases are currently waiting on doctor approval.</strong><br/>Cases scanned into "Doctor Design Approval - Full Arch" will appear here.</div>';
    return;
  }
  // Quick set of case_numbers already in the open queue (with drafts)
  const inQueue = new Set((state.outbound || []).map(r => r.case_number));
  // Group by practice for at-a-glance reading
  const sorted = readyRows.slice().sort((a, b) => {
    const da = new Date(a.waiting_since).getTime();
    const db = new Date(b.waiting_since).getTime();
    return db - da;
  });

  const fmtDay = (s) => s ? new Date(s).toLocaleDateString('en-US', {month:'numeric', day:'numeric'}) : '–';
  const daysAgo = (s) => {
    if (!s) return 0;
    return Math.max(0, Math.floor((Date.now() - new Date(s).getTime()) / 86400_000));
  };

  const header = `
    <table class="ready-table">
      <thead>
        <tr>
          <th>Pan</th>
          <th>Case</th>
          <th>Patient</th>
          <th>Practice</th>
          <th>Doctor email</th>
          <th>Waiting</th>
          <th>Dr due</th>
          <th>In queue?</th>
        </tr>
      </thead>
      <tbody>`;
  const rows = sorted.map(r => {
    const inq = inQueue.has(r.case_number);
    const days = daysAgo(r.waiting_since);
    const late = r.doctor_due_date && new Date(r.doctor_due_date) < new Date();
    return `<tr class="${inq ? '' : 'not-queued'}">
      <td><span class="pan">${esc(r.pan_number || '-')}</span></td>
      <td><span class="case-sub">${esc(r.case_number)}</span></td>
      <td>${esc(r.patient_name || '-')}</td>
      <td>${esc(r.practice_name || '-')}</td>
      <td>${esc(r.dr_email || '-')}</td>
      <td>${days}d (${fmtDay(r.waiting_since)})</td>
      <td class="${late ? 'late' : ''}">${fmtDay(r.doctor_due_date)}${late ? ' ⚠' : ''}</td>
      <td>${inq ? '<span style="color: var(--green); font-weight: 600;">In queue</span>' : '<span style="color: var(--gold); font-weight: 600;">Pending pickup</span>'}</td>
    </tr>`;
  }).join('');
  root.innerHTML = header + rows + '</tbody></table>';
}

let reschedRows = [];
async function loadReschedule() {
  let rows;
  if (inCowork) {
    rows = await runMcpSql('SELECT * FROM v_cases_needing_reschedule LIMIT 1000') || [];
  } else {
    rows = await restGet('/rest/v1/v_cases_needing_reschedule?select=*&limit=1000') || [];
  }
  reschedRows = rows;
  document.getElementById('badge-resched').textContent = reschedRows.length;
  renderReschedule();
}

const RESCHED_FILTER_OPTIONS = [
  { value: '',              label: 'All' },
  { value: 'pre_approval',  label: 'Pre-approval (doctor hasn\'t replied)' },
  { value: 'late_approval', label: 'Late approval (doctor approved late)' },
];
const reschedFilter = { bucket: '' };

function toggleReschedFilterDd(ev) {
  if (ev) ev.stopPropagation();
  document.getElementById('resched-filter-dd')?.classList.toggle('open');
}
function closeReschedFilterDd() {
  document.getElementById('resched-filter-dd')?.classList.remove('open');
}
function setReschedFilter(bucket) {
  reschedFilter.bucket = bucket;
  const dd = document.getElementById('resched-filter-dd');
  if (dd) dd.classList.toggle('has-value', !!bucket);
  closeReschedFilterDd();
  renderReschedule();
}

function renderReschedule() {
  const summary = document.getElementById('resched-summary');
  const list = document.getElementById('resched-list');
  if (!reschedRows.length) {
    summary.innerHTML = '<strong style="color:var(--green);font-size:18px;">0</strong> cases need rescheduling. Every open case can still meet its due date if approved today.';
    list.innerHTML = '';
    return;
  }

  // Refresh the bucket-filter dropdown with live counts
  const counts = {
    '':              reschedRows.length,
    pre_approval:    reschedRows.filter(r => r.bucket === 'pre_approval').length,
    late_approval:   reschedRows.filter(r => r.bucket === 'late_approval').length,
  };
  const current = reschedFilter.bucket || '';
  const labelEl    = document.getElementById('resched-filter-label');
  const btnCountEl = document.getElementById('resched-filter-count');
  const menuEl     = document.getElementById('resched-filter-menu');
  if (labelEl && btnCountEl && menuEl) {
    const currentOpt = RESCHED_FILTER_OPTIONS.find(o => o.value === current) || RESCHED_FILTER_OPTIONS[0];
    labelEl.textContent = currentOpt.label;
    const c = counts[current] ?? reschedRows.length;
    btnCountEl.textContent = c;
    btnCountEl.classList.toggle('zero', c === 0);
    menuEl.innerHTML = RESCHED_FILTER_OPTIONS.map(o => {
      const n = counts[o.value] ?? 0;
      const sel = o.value === current ? ' selected' : '';
      const zero = n === 0 ? ' zero' : '';
      return `<div class="custom-dd-option${sel}" role="option" data-value="${esc(o.value)}" onclick="setReschedFilter('${o.value}')">
        <span>${esc(o.label)}</span>
        <span class="chip-count${zero}">${n}</span>
      </div>`;
    }).join('');
  }

  const filteredRows = current ? reschedRows.filter(r => r.bucket === current) : reschedRows;

  summary.innerHTML = '<strong>' + reschedRows.length + '</strong> cases ' +
    'need rescheduling. <span style="color:var(--slate);">Pre-approval: ' + counts.pre_approval +
    ' · Late approval: ' + counts.late_approval + '</span>';

  if (!filteredRows.length) {
    list.innerHTML = '<div class="empty"><strong>No cases match this filter.</strong></div>';
    return;
  }

  const header = `
    <thead><tr>
      <th>Pan / Case</th><th>Bucket</th><th>Doctor / Practice</th><th>Patient</th>
      <th>Original Due</th><th>Earliest Arrival</th>
      <th style="text-align:right;">Days Late</th>
      <th style="text-align:right;">Action</th>
    </tr></thead>`;

  const body = filteredRows.map(r => {
    const dueDate    = r.doctor_due_date ? new Date(r.doctor_due_date + 'T12:00:00').toLocaleDateString() : '-';
    const arrival    = r.earliest_arrival_date
      ? new Date(r.earliest_arrival_date + 'T12:00:00').toLocaleDateString()
      : (r.earliest_ship_date ? new Date(r.earliest_ship_date + 'T12:00:00').toLocaleDateString() : '-');
    const daysClass  = r.days_late >= 14 ? 'severe' : 'warning';
    const bucketChip = r.bucket === 'late_approval'
      ? '<span class="bucket-chip late">⚠ Late approval</span>'
      : '<span class="bucket-chip pre">Pre-approval</span>';
    return `
      <tr>
        <td>
          <div class="pan-cell">${esc(r.pan_number || '-')}</div>
          <div class="case-cell">Case ${esc(r.case_number)}</div>
        </td>
        <td>${bucketChip}</td>
        <td>
          <div>${esc(r.dr_last_name || '-')}</div>
          <div style="font-size:11px;color:var(--slate);">${esc(r.practice_name || '')}</div>
        </td>
        <td>${esc(r.patient_name || '-')}</td>
        <td>${esc(dueDate)}</td>
        <td>${esc(arrival)}</td>
        <td style="text-align:right;"><span class="days-cell ${daysClass}">${r.days_late}d</span></td>
        <td style="text-align:right;">
          <button class="resched-action-btn" onclick="queueRescheduleCheck('${esc(r.case_number)}')" title="Draft an email asking the doctor if the new arrival date works">Send reschedule email</button>
        </td>
      </tr>`;
  }).join('');

  list.innerHTML = '<table class="resched-table">' + header + '<tbody>' + body + '</tbody></table>';
}

// Coordinator clicks "Send reschedule email" in the Reschedule tab.
// Composes a pending_approval attempt using the reschedule_check template
// and routes it through the normal review-and-send flow.
async function queueRescheduleCheck(caseNumber) {
  if (!confirm('Draft a reschedule check email for case ' + caseNumber + '?\n\nThe draft will appear in Pending Outbound for your review before sending.')) return;
  try {
    await callRpc('queue_reschedule_check', { p_case_number: caseNumber });
    toast('Draft created — open Pending Outbound to review', 'ok');
    const outboundTab = document.querySelector('#tabs-outreach .tab[data-tab="outbound"]');
    if (outboundTab) outboundTab.click();
    await loadAll();
  } catch (e) {
    toast('Could not draft: ' + (e?.message || e), 'err');
  }
}

function exportReschedule() {
  if (!reschedRows.length) { toast('Nothing to export', 'err'); return; }
  const headers = ['Pan Number','Case Number','Doctor','Practice','Patient','Doctor Due Date','Earliest Ship','Days Late','Hold Reason'];
  const rows = reschedRows.map(r => [
    r.pan_number || '',
    r.case_number,
    r.dr_last_name || '',
    r.practice_name || '',
    r.patient_name || '',
    r.doctor_due_date || '',
    r.earliest_ship_date || '',
    r.days_late,
    r.hold_reason || '',
  ]);
  const csv = [headers, ...rows].map(row =>
    row.map(v => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')
  ).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'reschedule_list_' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  toast('Downloaded reschedule list', 'ok');
}

async function loadOutbound() {
  // Bypass the default 100-row queryView cap. The view already has its own
  // ORDER BY att.created_at, so we just need the full result set.
  let rows;
  if (inCowork) {
    rows = await runMcpSql('SELECT * FROM v_pending_outbound LIMIT 2000') || [];
  } else {
    rows = await restGet('/rest/v1/v_pending_outbound?select=*&limit=2000') || [];
  }
  state.outbound = rows;
  document.getElementById('badge-out').textContent = rows.length;
  document.getElementById('stat-out').textContent = rows.length;
  renderOutbound();
}

async function loadInbound() {
  // Bypass the default 100-row queryView cap so coordinators see every reply,
  // not just the first 100. Up to 2000 in case of bursty days.
  let rows;
  if (inCowork) {
    rows = await runMcpSql('SELECT * FROM v_pending_inbound ORDER BY received_at DESC LIMIT 2000') || [];
  } else {
    rows = await restGet('/rest/v1/v_pending_inbound?select=*&order=received_at.desc&limit=2000') || [];
  }
  state.inbound = rows;
  document.getElementById('badge-in').textContent = rows.length;
  document.getElementById('stat-in').textContent = rows.length;
  renderInbound();
}

async function loadAudit() {
  // Calculate the cutoff date for the current window
  const days = auditWindowDays;
  const cutoff = new Date(Date.now() - days * 86400_000);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  let rows;
  if (inCowork) {
    rows = await runMcpSql(
      "SELECT TO_CHAR(day, 'YYYY-MM-DD') AS day, approved, edited, rejected, total_reviewed " +
      "FROM v_review_audit WHERE day >= '" + cutoffISO + "' ORDER BY day DESC"
    );
  } else {
    rows = await restGet('/rest/v1/v_review_audit?day=gte.' + cutoffISO + '&order=day.desc&limit=200');
  }

  state.audit = rows;
  const tot      = rows.reduce((a, r) => a + (r.total_reviewed || 0), 0);
  const approved = rows.reduce((a, r) => a + (r.approved || 0), 0);
  const edited   = rows.reduce((a, r) => a + (r.edited || 0), 0);
  const label = days === 1 ? '24h' : days + 'd';
  document.getElementById('stat-app').textContent  = approved;
  document.getElementById('stat-edit').textContent = tot ? Math.round(100 * edited / tot) + '%' : '–';
  document.getElementById('stat-app-label').textContent  = 'Approved ' + label;
  document.getElementById('stat-edit-label').textContent = 'Edit Rate ' + label;
  renderAudit();
}

// =====================================================================
// Renderers
// =====================================================================
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Wrap any bare exocad webview URLs in <a> tags so the link is clickable in
// the preview even when the email template pasted it as plain text.
// Also strips the in-body "View Design in exocad WebView" button — the
// "Direct link" line and the actions-row "View in Exocad" button cover the
// same job, so the in-body version is redundant noise.
const EXOCAD_URL_RE = /https?:\/\/webview\.exocad\.com\/v\/[A-Za-z0-9_\-/?=&%.+:#]+/g;
const EXOCAD_BTN_TEXT_RE = /view\s+design\s+in\s+exocad(\s+webview)?/i;
// Boilerplate sentence to strip from every outbound body.
const STRIP_LINE_RE = /please\s+refer\s+to\s+your\s+original\s+rx\s+submission\s+for\s+the\s+full\s+list\s+of\s+instructions\.?/i;
function linkifyExocad(html) {
  if (!html) return html;
  const container = document.createElement('div');
  container.innerHTML = html;

  // Remove the "Please refer to your original RX submission..." boilerplate line.
  // Drop the whole element when it only holds that sentence, otherwise just the text.
  for (const el of Array.from(container.querySelectorAll('p, div, li, span'))) {
    if (STRIP_LINE_RE.test(el.textContent || '')) {
      const stripped = (el.textContent || '').replace(STRIP_LINE_RE, '').trim();
      if (!stripped && !el.querySelector('a, img, button')) {
        el.remove();
      } else {
        el.innerHTML = el.innerHTML.replace(STRIP_LINE_RE, '');
      }
    }
  }

  // Remove the in-body styled button(s) that link to exocad.
  // Targets any <a> whose visible text matches "View Design in exocad[ WebView]".
  for (const a of Array.from(container.querySelectorAll('a'))) {
    if (EXOCAD_BTN_TEXT_RE.test((a.textContent || '').trim())) {
      // Drop the wrapping <p>/<div> only if it has no other useful content.
      const parent = a.parentElement;
      a.remove();
      if (parent && parent !== container
          && !parent.querySelector('a, img, button')
          && !(parent.textContent || '').trim()) {
        parent.remove();
      }
    }
  }

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentNode && node.parentNode.closest && node.parentNode.closest('a')) {
        return NodeFilter.FILTER_REJECT;
      }
      return EXOCAD_URL_RE.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);
  for (const t of targets) {
    const frag = document.createDocumentFragment();
    const txt = t.nodeValue;
    let last = 0;
    txt.replace(EXOCAD_URL_RE, (url, idx) => {
      if (idx > last) frag.appendChild(document.createTextNode(txt.slice(last, idx)));
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.color = '#1882C7';
      a.style.fontWeight = '600';
      a.textContent = url;
      frag.appendChild(a);
      last = idx + url.length;
    });
    if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
    t.parentNode.replaceChild(frag, t);
  }
  return container.innerHTML;
}

// Build the email body for the outbound preview:
//   1. Run linkifyExocad (strips the redundant "View Design in exocad
//      WebView" styled button and wraps bare URLs in <a>).
//   2. If the case has an exocad_viewer_url but the template body never
//      mentions any exocad URL, inject a "Direct link: <url>" paragraph
//      right after the sentence "please respond with approval or specific
//      modification requests." so every card consistently shows the link
//      in the same spot in the email body. Falls back to prepending if
//      that sentence isn't found.
const DIRECT_LINK_ANCHOR_RE = /please\s+respond\s+with\s+approval\s+or\s+specific\s+modification\s+requests/i;
function buildOutboundBody(rawHtml, exocadUrl) {
  const cleaned = linkifyExocad(rawHtml || '');
  if (!exocadUrl || !/^https?:\/\//i.test(exocadUrl)) return cleaned;
  EXOCAD_URL_RE.lastIndex = 0;
  if (EXOCAD_URL_RE.test(cleaned)) {
    EXOCAD_URL_RE.lastIndex = 0;
    return cleaned;
  }

  const linkHtml =
    '<p style="margin: 0 0 10px;">' +
      '<span style="font-size:11px; color:#6B7785;">Direct link:</span> ' +
      '<a href="' + esc(exocadUrl) + '" target="_blank" rel="noopener" style="color:#1882C7; word-break:break-all;">' +
        esc(exocadUrl) +
      '</a>' +
    '</p>';

  // Try to insert right after the "please respond..." paragraph
  const container = document.createElement('div');
  container.innerHTML = cleaned;
  let anchor = null;
  const candidates = container.querySelectorAll('p, div, li');
  for (const el of candidates) {
    if (DIRECT_LINK_ANCHOR_RE.test(el.textContent || '')) {
      anchor = el;
      break;
    }
  }
  if (anchor) {
    const tmp = document.createElement('div');
    tmp.innerHTML = linkHtml;
    const linkNode = tmp.firstElementChild;
    anchor.parentNode.insertBefore(linkNode, anchor.nextSibling);
    return container.innerHTML;
  }
  // Fallback: prepend if the anchor sentence is missing
  return linkHtml + cleaned;
}

// Sort + filter state for Pending Outbound
const outboundFilter = { sort: 'revenue_desc', revenue: '', partner: '', search: '' };
function setOutboundSort(value) { outboundFilter.sort = value; renderOutbound(); }
// Outbound filter options shared by the custom dropdown
const OUTBOUND_FILTER_OPTIONS = [
  { value: '',        label: 'All drafts' },
  { value: 'haslink', label: 'Has link (sendable)' },
  { value: 'nolink',  label: 'No link yet' },
  { value: 'overdue', label: 'Overdue only' },
  { value: 'high',    label: '$5k+' },
  { value: 'mid',     label: '$2k–5k' },
  { value: 'low',     label: 'Under $2k' },
];
// Revenue tiers are hidden from roles without the `outbound.revenue` capability
// (design_approver). Returns the filter options that role may actually use.
const REVENUE_FILTER_VALUES = ['high', 'mid', 'low'];
function visibleOutboundFilterOptions() {
  if (can(CAPABILITIES.OUTBOUND_REVENUE)) return OUTBOUND_FILTER_OPTIONS;
  return OUTBOUND_FILTER_OPTIONS.filter(o => !REVENUE_FILTER_VALUES.includes(o.value));
}

function setOutboundRevenue(value) {
  outboundFilter.revenue = value;
  const dd = document.getElementById('outbound-filter-dd');
  if (dd) dd.classList.toggle('has-value', !!value);
  closeFilterDd();
  renderOutbound();
}

function toggleFilterDd(ev) {
  if (ev) ev.stopPropagation();
  const dd = document.getElementById('outbound-filter-dd');
  if (!dd) return;
  dd.classList.toggle('open');
}
function closeFilterDd() {
  document.getElementById('outbound-filter-dd')?.classList.remove('open');
}
function setOutboundPartner(value) {
  outboundFilter.partner = value;
  const dd = document.getElementById('outbound-partner-dd');
  if (dd) dd.classList.toggle('has-value', !!value);
  closePartnerDd();
  renderOutbound();
}

function togglePartnerDd(ev) {
  if (ev) ev.stopPropagation();
  document.getElementById('outbound-partner-dd')?.classList.toggle('open');
}
function closePartnerDd() {
  document.getElementById('outbound-partner-dd')?.classList.remove('open');
}

// ---------- Global search bar (filters the currently-active panel) ----------
const globalSearch = { value: '' };

function onGlobalSearch(value) {
  globalSearch.value = (value || '').trim().toLowerCase();
  const wrap = document.getElementById('global-search-wrap');
  if (wrap) wrap.classList.toggle('has-text', !!globalSearch.value);
  // Apply to whichever tab is open
  const activeTab = document.querySelector('#tabs-outreach .tab.active')?.dataset.tab;
  if (activeTab === 'outbound') {
    outboundFilter.search = globalSearch.value;
    renderOutbound();
  } else if (activeTab === 'inbound') {
    // Mirror into the dedicated inbound search box if it exists
    const inboundBox = document.getElementById('inbound-search');
    if (inboundBox) inboundBox.value = value;
    if (typeof setInboundFilter === 'function') setInboundFilter('search', value);
  } else if (activeTab === 'ready') {
    if (typeof renderReady === 'function') renderReady();
  } else if (activeTab === 'reschedule') {
    if (typeof renderReschedule === 'function') renderReschedule();
  }
}

function clearGlobalSearch() {
  const input = document.getElementById('global-search');
  if (input) input.value = '';
  onGlobalSearch('');
}

function updateGlobalSearchScope() {
  const hint = document.getElementById('global-search-scope');
  const input = document.getElementById('global-search');
  const searchRow = document.getElementById('global-search-row');
  if (!hint || !input || !searchRow) return;
  const activeTab = document.querySelector('#tabs-outreach .tab.active')?.dataset.tab;
  const labelMap = {
    outbound: 'Pending Outbound',
    inbound: 'Pending Replies',
    ready: 'Ready for Approval',
    reschedule: 'Reschedule',
  };
  // Tabs without a meaningful global search: hide just the search bar
  // (the KPI strip above still shows on every tab)
  const hideOn = ['submit', 'lookup', 'audit', 'editlog', 'feedback'];
  if (hideOn.includes(activeTab)) {
    searchRow.style.display = 'none';
    return;
  }
  searchRow.style.display = '';
  hint.textContent = labelMap[activeTab] || 'All cases';
  // Clear cross-tab state when switching tabs to avoid stale filtering
  if (activeTab === 'outbound') {
    input.value = outboundFilter.search || '';
  } else if (activeTab === 'inbound') {
    const inboundBox = document.getElementById('inbound-search');
    input.value = inboundBox ? inboundBox.value : '';
  } else {
    input.value = '';
    globalSearch.value = '';
  }
  document.getElementById('global-search-wrap').classList.toggle('has-text', !!input.value);
}

function matchesSearch(needle, haystack) {
  if (!needle) return true;
  return (haystack || '').toLowerCase().includes(needle);
}

function populatePartnerDropdown() {
  const rows = state.outbound || [];
  const labelEl    = document.getElementById('outbound-partner-label');
  const btnCountEl = document.getElementById('outbound-partner-count');
  const menuEl     = document.getElementById('outbound-partner-menu');
  if (!labelEl || !btnCountEl || !menuEl) return;

  const counts = { '': rows.length };
  for (const r of rows) {
    const p = r.strategic_partner;
    if (!p) continue;
    counts[p] = (counts[p] || 0) + 1;
  }
  const partners = Object.keys(counts).filter(k => k !== '').sort((a, b) => a.localeCompare(b));
  const current = outboundFilter.partner || '';

  labelEl.textContent = current || 'All partners';
  const btnCount = counts[current] ?? rows.length;
  btnCountEl.textContent = btnCount;
  btnCountEl.classList.toggle('zero', btnCount === 0);

  const items = [{ value: '', label: 'All partners' }]
    .concat(partners.map(p => ({ value: p, label: p })));
  menuEl.innerHTML = items.map(o => {
    const c = counts[o.value] ?? 0;
    const sel = o.value === current ? ' selected' : '';
    const zero = c === 0 ? ' zero' : '';
    const safeValue = (o.value || '').replace(/'/g, "\\'");
    return `<div class="custom-dd-option${sel}" role="option" data-value="${esc(o.value)}" onclick="setOutboundPartner('${safeValue}')">
      <span>${esc(o.label)}</span>
      <span class="chip-count${zero}">${c}</span>
    </div>`;
  }).join('');
}

function sortedFilteredOutbound() {
  let rows = (state.outbound || []).slice();
  // Apply filters
  if (outboundFilter.revenue === 'high') rows = rows.filter(r => Number(r.case_revenue || 0) >= 5000);
  else if (outboundFilter.revenue === 'mid')  rows = rows.filter(r => { const n = Number(r.case_revenue || 0); return n >= 2000 && n < 5000; });
  else if (outboundFilter.revenue === 'low')  rows = rows.filter(r => Number(r.case_revenue || 0) < 2000);
  else if (outboundFilter.revenue === 'overdue') rows = rows.filter(r => r.will_miss_due_date);
  else if (outboundFilter.revenue === 'nolink')  rows = rows.filter(r => !(r.exocad_viewer_url && /^https?:\/\//i.test(r.exocad_viewer_url)));
  else if (outboundFilter.revenue === 'haslink') rows = rows.filter(r =>  (r.exocad_viewer_url && /^https?:\/\//i.test(r.exocad_viewer_url)));
  if (outboundFilter.partner) rows = rows.filter(r => (r.strategic_partner || '') === outboundFilter.partner);
  // Apply global text search
  if (outboundFilter.search) {
    const q = outboundFilter.search;
    rows = rows.filter(r => {
      const hay = [
        r.case_number, r.case_no, r.patient_name, r.practice_name,
        r.doctor_email, r.dr_first_name, r.dr_last_name, r.subject,
        r.pan, r.strategic_partner
      ].filter(Boolean).join(' ');
      return matchesSearch(q, hay);
    });
  }
  // Apply sort
  const ts = (s) => s ? new Date(s).getTime() : 0;
  switch (outboundFilter.sort) {
    case 'newest':       rows.sort((a, b) => ts(b.proposed_at) - ts(a.proposed_at)); break;
    case 'revenue_desc': rows.sort((a, b) => Number(b.case_revenue || 0) - Number(a.case_revenue || 0)); break;
    case 'revenue_asc':  rows.sort((a, b) => Number(a.case_revenue || 0) - Number(b.case_revenue || 0)); break;
    case 'due_soonest':  rows.sort((a, b) => ts(a.doctor_due_date || '2099-01-01') - ts(b.doctor_due_date || '2099-01-01')); break;
    case 'due_latest':   rows.sort((a, b) => (Number(b.days_late_if_approved_now || -9999)) - (Number(a.days_late_if_approved_now || -9999))); break;
    case 'oldest':
    default:             rows.sort((a, b) => ts(a.proposed_at) - ts(b.proposed_at)); break;
  }
  return rows;
}

function renderOutbound() {
  const root = document.getElementById('list-outbound');
  const countEl = document.getElementById('outbound-count');
  if (!state.outbound.length) {
    const hadError = lastResponse && lastResponse._error;
    let msg;
    if (hadError) {
      msg = "<strong>Couldn't reach Supabase.</strong><br/>" + esc(lastResponse._error) +
            "<br/><br/>Click <strong>Config</strong> (top right) to set your URL and service role key, or <strong>Diag</strong> to see the raw response.";
    } else {
      msg = "<strong>Pending outbound queue is empty.</strong><br/>Drafts awaiting your review will appear here.";
    }
    root.innerHTML = '<div class="empty">' + msg + '</div>';
    if (countEl) countEl.textContent = '';
    return;
  }
  populatePartnerDropdown();
  // Refresh the custom Filter dropdown — button label + bubble counts on each option
  const all = state.outbound || [];
  const hasLink = (r) => !!(r.exocad_viewer_url && /^https?:\/\//i.test(r.exocad_viewer_url));
  const counts = {
    '':        all.length,
    haslink:   all.filter(hasLink).length,
    nolink:    all.filter(r => !hasLink(r)).length,
    overdue:   all.filter(r => r.will_miss_due_date).length,
    high:      all.filter(r => Number(r.case_revenue || 0) >= 5000).length,
    mid:       all.filter(r => { const n = Number(r.case_revenue || 0); return n >= 2000 && n < 5000; }).length,
    low:       all.filter(r => Number(r.case_revenue || 0) < 2000).length,
  };
  const current = outboundFilter.revenue || '';
  // Button label + bubble
  const btnLabelEl = document.getElementById('outbound-filter-label');
  const btnCountEl = document.getElementById('outbound-filter-count');
  const filterOptions = visibleOutboundFilterOptions();
  const currentOpt = filterOptions.find(o => o.value === current) || filterOptions[0];
  if (btnLabelEl) btnLabelEl.textContent = currentOpt.label;
  if (btnCountEl) {
    const c = counts[currentOpt.value] ?? 0;
    btnCountEl.textContent = c;
    btnCountEl.classList.toggle('zero', c === 0);
  }
  // Menu items
  const menuEl = document.getElementById('outbound-filter-menu');
  if (menuEl) {
    menuEl.innerHTML = filterOptions.map(o => {
      const c = counts[o.value] ?? 0;
      const sel = o.value === current ? ' selected' : '';
      const zero = c === 0 ? ' zero' : '';
      return `<div class="custom-dd-option${sel}" role="option" data-value="${o.value}" onclick="setOutboundRevenue('${o.value}')">
        <span>${o.label}</span>
        <span class="chip-count${zero}">${c}</span>
      </div>`;
    }).join('');
  }
  const filtered = sortedFilteredOutbound();
  if (countEl) {
    const filterActive = outboundFilter.revenue !== '' || outboundFilter.partner !== '';
    countEl.textContent = filterActive
      ? `Showing ${filtered.length} of ${state.outbound.length}`
      : `${state.outbound.length} total`;
  }
  if (!filtered.length) {
    root.innerHTML = '<div class="empty"><strong>No drafts match this filter.</strong><br/>Click All to clear.</div>';
    return;
  }
  root.innerHTML = filtered.map(r => {
    const reasonChip = '<span class="reason-chip ' + r.reason + '">' + (REASON_LABEL[r.reason] || r.reason) + '</span>';
    // Revenue chip: high $5k+, mid $2k-$5k, neutral under $2k. Hide if $0.
    const rev = Number(r.case_revenue || 0);
    const revClass = rev >= 5000 ? 'high' : rev >= 2000 ? 'mid' : '';
    const revStr = rev > 0 ? '$' + rev.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
    const revenueChip = (can(CAPABILITIES.OUTBOUND_REVENUE) && revStr)
      ? '<span class="revenue-chip ' + revClass + '">' + revStr + '</span>' : '';
    // Strategic partner chip — colored by partner family for fast recognition
    const sp = r.strategic_partner || '';
    let spClass = '';
    if (/clearchoice/i.test(sp)) spClass = 'clearchoice';
    else if (/aspen/i.test(sp)) spClass = 'aspen';
    else if (/tri/i.test(sp)) spClass = 'tri';
    else if (/incisive/i.test(sp)) spClass = 'incisive';
    else if (/heartland|mb2|western|legacy/i.test(sp)) spClass = 'other';
    const partnerChip = sp ? '<span class="partner-chip ' + spClass + '">' + esc(sp) + '</span>' : '';
    const who = esc(r.dr_pref || 'Dr.') + ' ' + esc(r.dr_last_name || '') + ' · ' + esc(r.practice_name || '');
    let activityChip = '';
    if (r.recent_doctor_reply) {
      activityChip = '<span class="activity-chip reply">⚠ Doctor replied ' + (r.days_since_last_activity ?? '?') + 'd ago</span>';
    } else if ((r.notes_14d || 0) > 0) {
      activityChip = '<span class="activity-chip note">Recent note · ' + r.notes_14d + ' in 14d</span>';
    } else if ((r.sends_14d || 0) > 0) {
      activityChip = '<span class="activity-chip send">Previous email · ' + r.sends_14d + ' sent in 14d</span>';
    }
    const missChip = r.will_miss_due_date
      ? '<span class="activity-chip miss">⚠ Will miss due date · ' + r.days_late_if_approved_now + 'd late</span>'
      : '';
    // Exocad link presence — gate sends if missing
    const hasExocadLink = !!(r.exocad_viewer_url && /^https?:\/\//i.test(r.exocad_viewer_url));
    const noLinkChip = hasExocadLink
      ? ''
      : '<span class="activity-chip nolink">⚠ No exocad link yet</span>';
    return `
    <div class="item reason-${r.reason}" data-id="${r.attempt_id}">
      <div class="item-head" onclick="toggleItem('${r.attempt_id}')">
        <div>
          <span class="case-id-block">
            <span class="pan">${esc(r.pan_number || '-')}</span>
            <span class="case-sub">Case ${esc(r.case_number)}</span>
          </span>
          ${revenueChip}
          ${partnerChip}
          ${activityChip}
          ${missChip}
          ${noLinkChip}
          <div class="who">${who} → <strong>${esc(r.to_email)}</strong></div>
          <div class="subject">${esc(r.subject)}</div>
        </div>
        <div class="meta">
          <div class="stamp attempt-${r.attempt_number}">Attempt ${r.attempt_number}</div>
          <div>Proposed ${fmtDate(r.proposed_at)}</div>
          ${r.patient_name ? '<div>' + esc(r.patient_name) + '</div>' : ''}
          <div class="meta-reason">${reasonChip}</div>
        </div>
      </div>
      <div class="item-body">
        <div class="outbound-detail-row ${r.account_preferences ? '' : 'no-prefs'}">
          <div class="preview">
            <div class="preview-subject">${esc(r.subject)}</div>
            ${buildOutboundBody(r.body_html, r.exocad_viewer_url)}
          </div>
          ${r.account_preferences || r.prefs_summary_headline ? `
            <div class="prefs-banner">
              <div class="label">Account Preferences ${r.prefs_auto ? '(auto)' : '(curated)'}</div>
              ${r.prefs_summary_headline ? `
                <div class="summary-headline">${esc(r.prefs_summary_headline)}</div>
                ${r.prefs_summary_detail ? `<div class="summary-detail">${esc(r.prefs_summary_detail)}</div>` : ''}
                ${r.account_preferences ? '<hr class="summary-divider" />' : ''}
              ` : (r.account_preferences ? `
                <div class="summary-placeholder">Summarizing in the background…</div>
                <hr class="summary-divider" />
              ` : '')}
              ${r.account_preferences ? `<div class="text">${esc(r.account_preferences)}</div>` : ''}
            </div>
          ` : ''}
        </div>
        ${hasExocadLink ? '' : `
          <div class="link-gate">
            <div class="link-gate-title">⚠ This draft can't be sent yet — no exocad viewer link on file for case ${esc(r.case_number)}.</div>
            <div class="link-gate-sub">The link sync agent didn't find a webview URL in this case's folder. Paste one below to unblock the send, or wait for the next sync if the design team is still uploading.</div>
            <div class="link-gate-row">
              <input type="text" id="exocad-input-${r.attempt_id}" placeholder="https://webview.exocad.com/v/..." autocomplete="off" />
              <button class="act approve" onclick="saveExocadLink('${esc(r.case_number)}', document.getElementById('exocad-input-${r.attempt_id}').value)">Save link</button>
            </div>
          </div>
        `}
        <div class="actions">
          ${hasExocadLink ? `<button class="act view-exocad" onclick="window.open('${esc(r.exocad_viewer_url)}', '_blank', 'noopener')">View in Exocad</button>` : ''}
          <button class="act approve" onclick="approve('${r.attempt_id}')" ${hasExocadLink ? '' : 'disabled title="Add the exocad viewer link first"'}>Approve &amp; Send</button>
          <button class="act edit" onclick="showEdit('${r.attempt_id}')" ${hasExocadLink ? '' : 'disabled title="Add the exocad viewer link first"'}>Edit Then Send</button>
          <button class="act reject" onclick="reject('${r.attempt_id}')">Reject</button>
          <button class="act ghost" onclick="resummarize('${r.attempt_id}', '${esc(r.case_number)}')">Auto Resummarize</button>
        </div>
        <div class="edit-form" id="edit-${r.attempt_id}">
          <label>Subject</label>
          <input type="text" id="subject-${r.attempt_id}" value="${esc(r.subject)}" />
          <label>Body</label>
          <div class="editor-toolbar">
            <button type="button" onmousedown="event.preventDefault();document.execCommand('bold')"><strong>B</strong></button>
            <button type="button" onmousedown="event.preventDefault();document.execCommand('italic')"><em>I</em></button>
            <button type="button" onmousedown="event.preventDefault();document.execCommand('underline')"><u>U</u></button>
            <span class="sep"></span>
            <button type="button" onmousedown="event.preventDefault();document.execCommand('insertUnorderedList')">• List</button>
            <button type="button" onmousedown="event.preventDefault();document.execCommand('formatBlock',false,'p')">¶ Paragraph</button>
            <span class="sep"></span>
            <button type="button" onmousedown="event.preventDefault();const u=prompt('Link URL:');if(u)document.execCommand('createLink',false,u)">Link</button>
            <button type="button" onmousedown="event.preventDefault();document.execCommand('removeFormat')">Clear</button>
          </div>
          <div id="body-${r.attempt_id}" class="email-body-editor" contenteditable="true">${buildOutboundBody(r.body_html, r.exocad_viewer_url)}</div>
          <label>Reason for edit (optional)</label>
          <input type="text" id="note-${r.attempt_id}" placeholder="e.g. tighter copy, doctor prefers first name" />
          <div class="actions">
            <button class="act approve" onclick="saveEdit('${r.attempt_id}')">Save &amp; Send</button>
            <button class="act slate" onclick="hideEdit('${r.attempt_id}')">Cancel</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  // Kick off the lazy summary backfill in the background. Safe to call on
  // every render; it dedupes per-account-per-session internally.
  lazyBackfillPrefSummaries();
}

// Looks at the currently-rendered outbound rows. For any that have full
// preference text but no per-reason summary yet, generates one in the
// background (one Anthropic call per account, max once per session). Once
// all pending generations finish, refreshes the outbound view a single
// time so the new headlines appear without the user clicking anything.
async function lazyBackfillPrefSummaries() {
  if (prefSummaryBackfillRunning) return;
  // AI now routes through the /api/anthropic proxy (server holds the key), so
  // there's no client-side key to gate on; callAnthropic handles auth/errors.
  const targets = [];
  const seen = new Set();
  for (const r of (state.outbound || [])) {
    if (!r.account_number) continue;
    if (!r.account_preferences) continue;
    if (r.prefs_summary_headline) continue;
    if (prefSummaryAttempted.has(r.account_number)) continue;
    if (seen.has(r.account_number)) continue;
    seen.add(r.account_number);
    targets.push(r.account_number);
  }
  if (!targets.length) return;
  prefSummaryBackfillRunning = true;
  for (const acct of targets) prefSummaryAttempted.add(acct);
  try {
    // Run sequentially to be polite to the API; volumes are small (<20 accounts).
    for (const acct of targets) {
      try { await generatePrefSummaries(acct, { silent: true }); } catch (e) {}
    }
    // Refresh the outbound view once so the new headlines appear in place.
    try { await loadOutbound(); } catch (e) {}
  } finally {
    prefSummaryBackfillRunning = false;
  }
}

// Decode HTML entities (&nbsp;, &lt;, &gt;, &amp;, etc.) by round-tripping
// through a detached DOM element. Done once per reply, not per render.
function decodeHtmlEntities(s) {
  if (!s) return '';
  const txt = document.createElement('textarea');
  txt.innerHTML = s;
  return txt.value;
}

// Strip the quoted prior email from a reply body so coordinators only see the
// new text the doctor actually typed. Same patterns as the classifier uses
// server-side. Also reflows runs-on text into readable paragraphs because the
// Graph plain-text extractor often loses paragraph breaks.
function splitReplyAndQuote(text) {
  if (!text) return { reply: '', quote: '' };
  // Decode &nbsp; and friends first; reflow runs against decoded text.
  let decoded = decodeHtmlEntities(text)
    // Treat &nbsp;-derived spaces and tabs as regular spaces
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n');

  const markers = [
    /(^|\n)\s*From:\s+[^\n]+@/i,
    /(^|\n)\s*-{3,}\s*Original Message\s*-{3,}/i,
    /(^|\n)\s*On\s+.{1,100}\bwrote:/i,
    /(^|\n)\s*Sent:\s+\w+,\s+\w+\s+\d+/i,
    /(^|\n)\s*_{15,}/,
    /(^|\n)\s*>\s/,
    /Reply above this line/i,
    /(^|\n)\s*CAUTION:\s*Message is from EXTERNAL SENDER/i,
  ];
  let cutAt = decoded.length;
  for (const m of markers) {
    const idx = decoded.search(m);
    if (idx !== -1 && idx < cutAt) cutAt = idx;
  }
  const replyRaw = decoded.slice(0, cutAt).trim();
  const quote = decoded.slice(cutAt).trim();
  const reply = prettifyReplyText(replyRaw.length > 0 ? replyRaw : decoded.trim());
  return {
    reply,
    quote: replyRaw.length > 0 ? quote : '',
  };
}

// Re-flow a single line of plain text into readable paragraphs by inserting
// line breaks at boundaries Outlook/Graph swallowed. Idempotent: if the text
// already has plenty of line breaks, this leaves it mostly alone.
function prettifyReplyText(text) {
  if (!text) return '';
  // Words that take a trailing period but should NEVER trigger a paragraph break
  const ABBREV = new Set([
    'dr', 'drs', 'mr', 'mrs', 'ms', 'sr', 'jr', 'inc', 'ltd', 'co',
    'st', 'ave', 'blvd', 'tel', 'fax', 'no', 'vs', 'pp', 'pg',
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l',
    'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  ]);

  let s = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/_{10,}.*$/s, '')   // Strip ASCII underscore divider + everything after
    .trim();

  // Greeting line — first sentence usually ends with a comma + name
  s = s.replace(/^(Hi|Hello|Hey|Dear)\b([^,\n]{0,80}),\s*/i, '$1$2,\n\n');

  // Pull common sign-offs onto their own paragraph (handle only the FIRST hit
  // to avoid replacing twice in nested replies)
  const SIGNOFFS = [
    /\bBest regards,\s*/i, /\bKind regards,\s*/i, /\bRegards,\s*/i,
    /\bThank you,\s*/i,   /\bThanks,\s*/i,        /\bSincerely,\s*/i,
  ];
  for (const re of SIGNOFFS) {
    const m = s.match(re);
    if (m) {
      const phrase = m[0].replace(/\s+$/, '');
      s = s.replace(re, `\n\n${phrase}\n`);
      break;
    }
  }

  // Sentence-boundary breaks: "<word>. " + capital letter starts a new paragraph,
  // BUT skip honorifics/initials. Walk character-by-character so we keep context.
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out.push(ch);
    if ((ch === '.' || ch === '!' || ch === '?') && s[i + 1] === ' ') {
      // Find the word ending at position i (lowercased, sans punctuation)
      let j = i - 1;
      while (j >= 0 && /[A-Za-z]/.test(s[j])) j--;
      const word = s.slice(j + 1, i).toLowerCase();
      const next = s[i + 2];
      if (next && /[A-Z]/.test(next) && /[a-z]/.test(s[i + 3] || '') && !ABBREV.has(word)) {
        out.push('\n\n');
        i++; // skip the original space; next char will be the new sentence
      }
    }
  }
  s = out.join('');

  // Bullet-style: keep " - foo" / " * foo" on its own line
  s = s.replace(/\s+([-•*])\s+/g, '\n$1 ');

  // Collapse runs of blank lines
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// Filter state for Pending Replies (persists for the session).
// `status` filters on AI classification; `caseLink` filters on case linkage.
// The two columns combine as an AND.
const inboundFilter = { search: '', status: '', caseLink: '' };

// ---------- Hidden senders blocklist (persisted in localStorage) ----------
const HIDDEN_SENDERS_KEY = 'skdla_hidden_senders';
function loadHiddenSenders() {
  try {
    const raw = localStorage.getItem(HIDDEN_SENDERS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(s => String(s).toLowerCase().trim()).filter(Boolean) : [];
  } catch { return []; }
}
function saveHiddenSenders(list) {
  try { localStorage.setItem(HIDDEN_SENDERS_KEY, JSON.stringify(list)); } catch {}
}
let hiddenSenders = loadHiddenSenders();

function isSenderHidden(email) {
  if (!email) return false;
  const e = email.toLowerCase().trim();
  for (const rule of hiddenSenders) {
    if (rule.startsWith('@')) {
      if (e.endsWith(rule)) return true;
    } else if (e === rule) {
      return true;
    }
  }
  return false;
}

function toggleHiddenSenders(ev) {
  if (ev) ev.stopPropagation();
  const wrap = document.getElementById('hidden-senders-wrap');
  wrap.classList.toggle('open');
  if (wrap.classList.contains('open')) renderHiddenSendersList();
}

function closeHiddenSenders() {
  document.getElementById('hidden-senders-wrap')?.classList.remove('open');
}

function addHiddenSender(maybeEmail) {
  const input = document.getElementById('hsp-input');
  let val = (maybeEmail || (input ? input.value : '')).toLowerCase().trim();
  if (!val) return;
  // Accept "domain.com" too — treat it as "@domain.com"
  if (!val.includes('@') && val.includes('.')) val = '@' + val;
  if (!hiddenSenders.includes(val)) {
    hiddenSenders.push(val);
    saveHiddenSenders(hiddenSenders);
  }
  if (input) input.value = '';
  renderHiddenSendersList();
  renderInbound();
}

function removeHiddenSender(rule) {
  hiddenSenders = hiddenSenders.filter(r => r !== rule);
  saveHiddenSenders(hiddenSenders);
  renderHiddenSendersList();
  renderInbound();
}

function renderHiddenSendersList() {
  const list = document.getElementById('hsp-list');
  const count = document.getElementById('hidden-senders-count');
  const wrap = document.getElementById('hidden-senders-wrap');
  if (count) count.textContent = hiddenSenders.length;
  if (wrap) wrap.classList.toggle('has-blocked', hiddenSenders.length > 0);
  if (!list) return;
  if (!hiddenSenders.length) {
    list.innerHTML = '<div class="hsp-empty">No senders hidden yet.</div>';
    return;
  }
  list.innerHTML = hiddenSenders.map(rule => `
    <div class="hsp-item">
      <span class="email">${esc(rule)}</span>
      <button class="remove" onclick="removeHiddenSender('${esc(rule)}')" aria-label="Remove">×</button>
    </div>
  `).join('');
}

// Friendly display labels for AI classifications — used by both the Status
// dropdown and the per-reply chip so wording stays consistent.
const AI_CLASS_LABELS = {
  approved:                    'Approved',
  approved_with_mods:          'Approved + Modifications',
  modification:                'Modification',
  pricing_or_product_question: 'Pricing/Product Questions',
  other:                       'Other',
  unclear:                     'Unclear',
};
function aiClassLabel(v) { return AI_CLASS_LABELS[v] || v || 'Unclear'; }

// Status column — filters by AI classification.
const INBOUND_STATUS_OPTIONS = [
  { value: '',                              label: 'All' },
  { value: 'approved',                      label: AI_CLASS_LABELS.approved },
  { value: 'approved_with_mods',            label: AI_CLASS_LABELS.approved_with_mods },
  { value: 'modification',                  label: AI_CLASS_LABELS.modification },
  { value: 'pricing_or_product_question',   label: AI_CLASS_LABELS.pricing_or_product_question },
  { value: 'other',                         label: AI_CLASS_LABELS.other },
  { value: 'unclear',                       label: AI_CLASS_LABELS.unclear },
];

// Case Number column — filters by case linkage. Combines with Status as an AND.
const INBOUND_CASE_OPTIONS = [
  { value: '',             label: 'All' },
  { value: 'needs_lookup', label: 'Needs case lookup' },
  { value: 'linked_only',  label: 'Linked cases only' },
];

function setInboundFilter(key, value) {
  inboundFilter[key] = value;
  if (key === 'status') {
    const dd = document.getElementById('inbound-status-dd');
    if (dd) dd.classList.toggle('has-value', !!value);
    closeInboundStatusDd();
  }
  if (key === 'caseLink') {
    const dd = document.getElementById('inbound-case-dd');
    if (dd) dd.classList.toggle('has-value', !!value);
    closeInboundCaseDd();
  }
  if (key === 'search') {
    const clearBtn = document.getElementById('inbound-search-clear');
    if (clearBtn) clearBtn.style.display = value ? 'inline-flex' : 'none';
  }
  renderInbound();
}

function toggleInboundStatusDd(ev) {
  if (ev) ev.stopPropagation();
  closeInboundCaseDd();
  document.getElementById('inbound-status-dd')?.classList.toggle('open');
}
function closeInboundStatusDd() {
  document.getElementById('inbound-status-dd')?.classList.remove('open');
}
function toggleInboundCaseDd(ev) {
  if (ev) ev.stopPropagation();
  closeInboundStatusDd();
  document.getElementById('inbound-case-dd')?.classList.toggle('open');
}
function closeInboundCaseDd() {
  document.getElementById('inbound-case-dd')?.classList.remove('open');
}

function clearInboundSearch() {
  const input = document.getElementById('inbound-search');
  if (input) input.value = '';
  setInboundFilter('search', '');
}

function filteredInbound() {
  const q = (inboundFilter.search || '').trim().toLowerCase();
  const status = inboundFilter.status;
  const caseLink = inboundFilter.caseLink;
  return (state.inbound || []).filter(r => {
    if (isSenderHidden(r.from_email)) return false;
    // Case Number column
    if (caseLink === 'linked_only'  && !r.case_number) return false;
    if (caseLink === 'needs_lookup' &&  r.case_number) return false;
    // Status column (AI classification) — combines with case column as AND
    if (status && (r.ai_classification || 'unclear') !== status) return false;
    if (!q) return true;
    const hay = [
      r.case_number, r.from_email, r.practice_name, r.subject,
      r.body_text, r.ai_summary, r.ai_classification, r.patient_name,
    ].map(v => (v || '').toString().toLowerCase()).join('  ');
    return hay.includes(q);
  });
}

// Helpers describing each column's predicate, so counts can honor the AND.
function inboundMatchesCase(r, caseLink) {
  if (caseLink === 'linked_only')  return !!r.case_number;
  if (caseLink === 'needs_lookup') return !r.case_number;
  return true;
}
function inboundMatchesStatus(r, status) {
  if (!status) return true;
  return (r.ai_classification || 'unclear') === status;
}

// Render one custom dropdown (label + button count + option list with counts).
function renderInboundDd(ids, options, currentValue, key, countFn) {
  const labelEl    = document.getElementById(ids.label);
  const btnCountEl = document.getElementById(ids.count);
  const menuEl     = document.getElementById(ids.menu);
  if (!labelEl || !btnCountEl || !menuEl) return;

  const currentOpt = options.find(o => o.value === currentValue) || options[0];
  labelEl.textContent = currentOpt.label;
  const btnCount = countFn(currentOpt.value);
  btnCountEl.textContent = btnCount;
  btnCountEl.classList.toggle('zero', btnCount === 0);

  menuEl.innerHTML = options.map(o => {
    const c = countFn(o.value);
    const sel = o.value === currentValue ? ' selected' : '';
    const zero = c === 0 ? ' zero' : '';
    return `<div class="custom-dd-option${sel}" role="option" data-value="${esc(o.value)}" onclick="setInboundFilter('${key}', '${o.value}')">
      <span>${esc(o.label)}</span>
      <span class="chip-count${zero}">${c}</span>
    </div>`;
  }).join('');
}

function updateInboundChipCounts() {
  // Hidden-sender filtering is part of the user's expected view, so apply it
  // before counting (otherwise the visible list count and the chip count drift).
  const rows = (state.inbound || []).filter(r => !isSenderHidden(r.from_email));
  const status   = inboundFilter.status || '';
  const caseLink = inboundFilter.caseLink || '';

  // Status counts honor the active Case filter (and vice versa) so the numbers
  // reflect the AND the user actually gets.
  const statusCount = (val) =>
    rows.filter(r => inboundMatchesCase(r, caseLink) && inboundMatchesStatus(r, val)).length;
  const caseCount = (val) =>
    rows.filter(r => inboundMatchesStatus(r, status) && inboundMatchesCase(r, val)).length;

  renderInboundDd(
    { label: 'inbound-status-label', count: 'inbound-status-count', menu: 'inbound-status-menu' },
    INBOUND_STATUS_OPTIONS, status, 'status', statusCount);
  renderInboundDd(
    { label: 'inbound-case-label', count: 'inbound-case-count', menu: 'inbound-case-menu' },
    INBOUND_CASE_OPTIONS, caseLink, 'caseLink', caseCount);
}

function renderInbound() {
  const root = document.getElementById('list-inbound');
  const countEl = document.getElementById('inbound-count');
  const totalRaw = (state.inbound || []).length;
  updateInboundChipCounts();

  if (!totalRaw) {
    const hadError = lastResponse && lastResponse._error;
    root.innerHTML = '<div class="empty">' + (hadError
      ? "<strong>Couldn't reach Supabase.</strong>"
      : "<strong>No replies awaiting classification.</strong><br/>Inbound doctor replies show up here with an auto-suggested decision.") + '</div>';
    if (countEl) countEl.textContent = '';
    return;
  }

  const filtered = filteredInbound();
  if (countEl) {
    const filterActive = !!(inboundFilter.search || inboundFilter.status || inboundFilter.caseLink);
    countEl.textContent = filterActive
      ? `Showing ${filtered.length} of ${totalRaw}`
      : `${totalRaw} total`;
  }
  if (!filtered.length) {
    root.innerHTML = '<div class="empty"><strong>No replies match your filter.</strong><br/>Try a different search term or click All.</div>';
    return;
  }

  root.innerHTML = filtered.map(r => {
    const conf = Number(r.ai_confidence || 0);
    const pct = Math.round(conf * 100);
    const confClass = conf >= 0.85 ? '' : (conf >= 0.7 ? 'med' : 'low');
    const isUnmatched = !r.case_number;
    const matchChip = isUnmatched
      ? '<span class="case nolink-case">⚠ Needs case lookup</span>'
      : `<span class="case">Case ${esc(r.case_number)}</span>`;
    const lowConfMatch = r.match_method && Number(r.match_confidence || 1) < 0.7;
    const lowConfChip = lowConfMatch
      ? `<span class="match-chip low" title="Auto-matched via ${esc(r.match_method)}">⚠ Low-confidence match</span>`
      : '';
    const escalationChip = r.needs_escalation
      ? `<span class="match-chip escalate" title="Looks time-sensitive — consider escalating to the account manager for a phone call">⚡ Time-sensitive — phone call</span>`
      : '';
    return `
    <div class="item reason-${r.reason || 'design_approval'} ${isUnmatched ? 'unmatched' : ''}" data-id="${r.reply_id}">
      <div class="item-head" onclick="toggleItem('${r.reply_id}')">
        <div>
          ${matchChip}
          <span class="ai-chip ${r.ai_classification}">${esc(aiClassLabel(r.ai_classification))}</span>
          ${lowConfChip}
          ${escalationChip}
          <div class="who">From <strong>${esc(r.from_email)}</strong> · ${esc(r.practice_name || '')}</div>
          <div class="subject">${esc(r.subject)}</div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:6px;">
            <div class="conf-bar"><div class="fill ${confClass}" style="width:${pct}%"></div></div>
            <span style="font-size:11px;color:var(--slate);">${pct}% confidence</span>
          </div>
        </div>
        <div class="meta">
          <div>Received ${fmtDate(r.received_at)}</div>
          ${r.patient_name ? '<div>' + esc(r.patient_name) + '</div>' : ''}
          <button class="hide-sender-btn" onclick="event.stopPropagation(); addHiddenSender('${esc(r.from_email)}');" title="Hide ${esc(r.from_email)} from Pending Replies">Hide sender</button>
        </div>
      </div>
      <div class="item-body">
        <div style="margin-bottom:10px;font-size:12px;color:var(--slate);"><strong>Summary:</strong> ${esc(r.ai_summary || '')}</div>
        ${(() => {
          const split = splitReplyAndQuote(r.body_text);
          const hasQuote = split.quote && split.quote.length > 20;
          return `
            <div class="reply-text">${esc(split.reply || '(no body)')}</div>
            ${hasQuote ? `
              <button class="reply-thread-toggle" onclick="this.nextElementSibling.classList.toggle('shown'); this.textContent = this.nextElementSibling.classList.contains('shown') ? 'Hide quoted email' : 'Show quoted email';">Show quoted email</button>
              <div class="reply-thread">${esc(split.quote)}</div>
            ` : ''}
          `;
        })()}
        ${isUnmatched ? `
          <div class="link-gate">
            <div class="link-gate-title">⚠ No case linked to this reply yet</div>
            <div class="link-gate-sub">Our matcher couldn't link this email to a case automatically. If you know which case it's about, paste the case number below. If this isn't about any case in our system (general inquiry, wrong inbox, vendor noise), click <strong>No matching case</strong> to triage it out.</div>
            <div class="link-gate-row">
              <input type="text" id="link-input-${r.reply_id}" placeholder="2026-XXXXX" autocomplete="off" />
              <button class="act approve" onclick="manuallyLinkReply('${r.reply_id}', document.getElementById('link-input-${r.reply_id}').value)">Link to case</button>
              <button class="act slate" onclick="markReplyNoCase('${r.reply_id}')" title="Remove this reply from the queue — no matching case exists in our system">No matching case</button>
            </div>
          </div>
        ` : ''}
        <div class="actions" style="margin-top:14px;">
          <button class="act approve" onclick="classifyReply('${r.reply_id}', 'approved')" ${isUnmatched ? 'disabled title="Link this reply to a case first"' : ''}>Approved</button>
          <button class="act blue" onclick="classifyReply('${r.reply_id}', 'approved_with_mods')" ${isUnmatched ? 'disabled title="Link this reply to a case first"' : ''}>Approved + Mods</button>
          <button class="act edit" onclick="classifyReply('${r.reply_id}', 'modification')" ${isUnmatched ? 'disabled title="Link this reply to a case first"' : ''}>Modification</button>
          <button class="act" style="background: var(--gold);" onclick="classifyReply('${r.reply_id}', 'pricing_or_product_question')" ${isUnmatched ? 'disabled title="Link this reply to a case first"' : ''}>Pricing / Product Q</button>
          <button class="act" style="background: var(--red);" onclick="escalateForCall('${r.reply_id}')" ${isUnmatched ? 'disabled title="Link this reply to a case first"' : ''} title="Escalate to the account manager for a phone call (time-sensitive scheduling/delivery)">Escalate (Call)</button>
          <button class="act slate" onclick="classifyReply('${r.reply_id}', 'other')">Other</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderAudit() {
  const root = document.getElementById('list-audit');
  if (!state.audit.length) {
    root.innerHTML = '<div class="empty"><strong>No reviews yet.</strong><br/>Once you start approving / editing / rejecting items, daily totals will appear here.</div>';
    return;
  }
  const header = `
    <div class="audit-row" style="background:var(--navy);color:white;">
      <div class="col-label" style="color:rgba(255,255,255,.85);">Day</div>
      <div class="col-label" style="color:rgba(255,255,255,.85);">Approved</div>
      <div class="col-label" style="color:rgba(255,255,255,.85);">Edited</div>
      <div class="col-label" style="color:rgba(255,255,255,.85);">Rejected</div>
      <div class="col-label" style="color:rgba(255,255,255,.85);">Total</div>
    </div>`;
  const rows = state.audit.map(r => {
    const dayStr = r.day ? new Date(r.day).toLocaleDateString() : '';
    return `
      <div class="audit-row">
        <div class="col-val" style="font-size:13px;color:var(--charcoal);font-weight:600;">${esc(dayStr)}</div>
        <div class="col-val" style="color:var(--green);">${r.approved || 0}</div>
        <div class="col-val" style="color:var(--gold);">${r.edited || 0}</div>
        <div class="col-val" style="color:var(--red);">${r.rejected || 0}</div>
        <div class="col-val">${r.total_reviewed || 0}</div>
      </div>`;
  }).join('');
  root.innerHTML = header + rows;
}

// =====================================================================
// Item interactions
// =====================================================================
function toggleItem(id) {
  const el = document.querySelector(`.item[data-id="${id}"]`);
  if (el) el.classList.toggle('expanded');
}
function showEdit(id) { document.getElementById('edit-' + id).classList.add('shown'); }
function hideEdit(id) { document.getElementById('edit-' + id).classList.remove('shown'); }

async function approve(id) {
  if (!confirm('Approve and queue this email for sending?')) return;
  try {
    await callRpc('approve_attempt', { p_attempt_id: id, p_reviewer: (loginIdentity().email || loginIdentity().name), p_note: null });
    toast('Approved ·will send on next tick', 'ok');
    await loadAll();
  } catch (e) {}
}

// Manually attach an exocad viewer link to a case. Used when the sync agent
// hasn't picked it up yet (folder not on share, no Link.txt, etc.). Upserts
// into case_exocad_links so the next compose run includes the button.
async function saveExocadLink(caseNumber, rawUrl) {
  const url = (rawUrl || '').trim();
  if (!/^https?:\/\/webview\.exocad\.com\/v\//i.test(url)) {
    alert('Please paste a valid exocad webview URL (starts with https://webview.exocad.com/v/...)');
    return;
  }
  try {
    const cfg = getConfig();
    const headers = {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal,resolution=merge-duplicates',
    };
    const nowIso = new Date().toISOString();
    const res = await fetch(cfg.url.replace(/\/+$/,'') + '/rest/v1/case_exocad_links?on_conflict=case_number', {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        case_number: caseNumber,
        viewer_url: url,
        folder_path: null,
        file_kind: 'manual',
        last_seen_at: nowIso,
        updated_at: nowIso,
      }]),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error('Upsert failed: ' + res.status + ' ' + txt);
    }
    // Also re-render the pending draft for this case so the new link button shows up
    await callRpc('recompose_pending_for_case', { p_case_number: caseNumber }).catch(() => {});
    toast('Link saved · draft refreshed', 'ok');
    await loadAll();
  } catch (e) {
    alert('Could not save link: ' + e.message);
  }
}
async function reject(id) {
  const note = prompt('Reject reason (optional):', '');
  if (note === null) return;
  try {
    await callRpc('reject_attempt', { p_attempt_id: id, p_reviewer: (loginIdentity().email || loginIdentity().name), p_note: note || null });
    toast('Rejected ·case will be retried tomorrow', 'ok');
    await loadAll();
  } catch (e) {}
}
async function saveEdit(id) {
  const subject = document.getElementById('subject-' + id).value;
  // contenteditable div ·innerHTML preserves bullets, bold, links, etc.
  const body    = document.getElementById('body-' + id).innerHTML;
  const note    = document.getElementById('note-' + id).value;
  try {
    await callRpc('edit_and_approve_attempt', {
      p_attempt_id: id, p_reviewer: (loginIdentity().email || loginIdentity().name),
      p_subject: subject, p_body_html: body,
      p_note: note || null
    });
    toast('Edited and queued', 'ok');
    await loadAll();
  } catch (e) {}
}
async function classifyReply(id, decision) {
  if (!confirm('Mark this reply as "' + decision + '"? This will close the case if approved.')) return;
  try {
    await callRpc('confirm_reply', { p_reply_id: id, p_decision: decision, p_coordinator_id: REVIEWER });
    toast('Reply marked as ' + decision, 'ok');
    await loadAll();
  } catch (e) {}
}

// Manually link an unmatched reply to a case number that the coordinator
// recognized. Calls the manually_link_reply RPC server-side which validates
// the case # exists in the queue and stamps match_method='manual'.
async function manuallyLinkReply(replyId, rawCaseNumber) {
  const caseNumber = (rawCaseNumber || '').trim();
  if (!/^\d{4}-\d{4,6}$/.test(caseNumber)) {
    alert('Enter a case number in the format 2026-XXXXX');
    return;
  }
  try {
    await callRpc('manually_link_reply', {
      p_reply_id: replyId,
      p_case_number: caseNumber,
      p_coordinator_id: REVIEWER,
    });
    toast('Linked to case ' + caseNumber, 'ok');
    await loadAll();
  } catch (e) {
    alert('Could not link: ' + (e?.message || e));
  }
}

// Escalate a time-sensitive reply to the account manager. The doctor's
// message is forwarded to the AM with case context, and the queue is flagged
// 'escalated_am' so it drops out of Pending Replies.
async function escalateForCall(replyId) {
  if (!confirm('Escalate to the account manager for a phone call?\n\nThis will email the AM with the doctor\'s message + case context and mark this reply as handled.')) return;
  try {
    await callRpc('escalate_reply_for_call', {
      p_reply_id: replyId,
      p_coordinator_id: REVIEWER,
    });
    toast('Escalated to AM — they\'ll get an email on the next tick', 'ok');
    await loadAll();
  } catch (e) {
    alert('Could not escalate: ' + (e?.message || e));
  }
}

// Triage: mark a reply as having no matching case in our system.
// Drops it out of Pending Replies. Used for general inquiries, wrong-inbox
// emails, and patients not in our DB.
async function markReplyNoCase(replyId) {
  if (!confirm('Mark this reply as "no matching case" and remove it from the queue?\n\nUse this for general inquiries, vendor emails, or doctor questions about patients not in our system.')) return;
  try {
    await callRpc('mark_reply_no_case', {
      p_reply_id: replyId,
      p_coordinator_id: REVIEWER,
    });
    toast('Triaged — removed from queue', 'ok');
    await loadAll();
  } catch (e) {
    alert('Could not triage: ' + (e?.message || e));
  }
}

// =====================================================================
// AI Re-summarize ·call Anthropic from the browser, refresh email
// =====================================================================
function stripDashes(s) { return (s || '').replace(/–/g, '-').replace(/—/g, '-'); }

async function callAnthropic(prompt, maxTokens) {
  // Calls our own serverless proxy (/api/anthropic) rather than Anthropic
  // directly, so the API key stays server-side and never reaches the browser.
  // The proxy verifies the caller's Supabase session before using the key.
  const token = await getAccessToken();
  if (!token) {
    toast('Please sign in again to use AI features.', 'err');
    throw new Error('Not authenticated');
  }
  // Abort if the proxy/upstream hangs, so the UI never spins forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res;
  try {
    res = await fetch('/api/anthropic', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ prompt, maxTokens: maxTokens || 1000 }),
      signal: ctrl.signal
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('AI request timed out after 60s. Please try again.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  // Read the body exactly once — a Response stream can't be re-read. Parsing
  // JSON out of the text avoids the "body stream already read" error that
  // masked the real failure on the error path.
  const raw = await res.text();
  let j = {};
  try { j = raw ? JSON.parse(raw) : {}; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const detail = j.error || raw || res.statusText || '';
    throw new Error('Service ' + res.status + ': ' + String(detail).slice(0, 200));
  }
  return j.text || j.content?.[0]?.text || '';
}

function parseJsonish(s) {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function fetchSynonyms() {
  try {
    if (inCowork) {
      return (await runMcpSql("SELECT synonym, canonical_product, needs_verification FROM product_synonyms")) || [];
    }
    return (await restGet('/rest/v1/product_synonyms?select=synonym,canonical_product,needs_verification')) || [];
  } catch (e) { return []; }
}

function synonymsBlock(rows) {
  if (!rows || !rows.length) return '';
  return '\n\nKnown ambiguous terms (if any of these appear in the RX, flag them inline with a note like " (verify: <canonical>)"):\n' +
    rows.map(r => `- "${r.synonym}" → ${r.canonical_product}${r.needs_verification ? ' [needs verification]' : ''}`).join('\n');
}

const RX_PROMPT = (raw, syns) => `You are summarizing a dental lab RX (prescription) note for a doctor outreach email.

Raw RX note:
"""
${raw.slice(0, 6000)}
"""${synonymsBlock(syns)}

Return ONLY strict JSON with two fields:
{
  "issue_summary_short": "...",
  "bullets_html": "..."
}

issue_summary_short: One short phrase describing what the RX is for (max 80 chars, plain text).

bullets_html: Clean HTML <ul style="margin:0;padding-left:18px;line-height:1.55;font-size:13px;color:#1F2937;"><li>...</li>...</ul>. Use <strong> for labels like "Implant system:", "Materials:", "Arches:". 5-10 bullets. Use ASCII hyphen "-" only, never en-dash or em-dash. If the RX uses an informal synonym from the list above, keep the doctor's word but add a verify hint in parentheses.`;

const MISSING_PROMPT = (raw, syns) => `You are summarizing an internal lab note about what's missing on a case, to send to the doctor.

Raw note:
"""
${raw.slice(0, 6000)}
"""${synonymsBlock(syns)}

Return ONLY strict JSON with two fields:
{
  "issue_summary_short": "...",
  "bullets_html": "..."
}

issue_summary_short: short phrase (max 80 chars) - becomes "Action Needed for [Patient]: [your phrase]".
bullets_html: <p><strong>What we need:</strong></p><ul style="margin:0;padding-left:18px;line-height:1.55;font-size:13px;color:#1F2937;"><li>...</li>...</ul>. 2-4 doctor-friendly bullets (drop internal initials, dates, "we recommend" → "please"). Use ASCII hyphen "-" only.`;

async function resummarize(attemptId, caseNumber) {
  if (!confirm('Regenerate the summary for case ' + caseNumber + '? This rewrites the email body.')) return;
  toast('Resummarizing…', 'ok');

  try {
    // 1) Get raw text from Case Notes
    let raw;
    if (inCowork) {
      raw = (await runMcpSql(
        "SELECT * FROM get_case_raw_for_summary('" + caseNumber.replace(/'/g, "''") + "')"
      ))[0];
      // Postgres returns the JSONB inline ·unwrap if nested
      raw = raw?.get_case_raw_for_summary || raw;
    } else {
      raw = await restRpc('get_case_raw_for_summary', { p_case_number: caseNumber });
    }

    if (!raw || (!raw.rx_raw && !raw.missing_raw)) {
      toast('No RX or missing-info text in Case Notes for this case', 'err');
      return;
    }

    // Fetch synonyms once, pass to both prompts
    const syns = await fetchSynonyms();

    // 2) Summarize whichever raw exists; upsert
    if (raw.rx_raw) {
      const out = await callAnthropic(RX_PROMPT(raw.rx_raw, syns), 1200);
      const parsed = parseJsonish(out);
      if (parsed?.issue_summary_short && parsed?.bullets_html) {
        const row = {
          case_number: caseNumber,
          raw_text: String(raw.rx_raw).slice(0, 50000),
          bullets_html: stripDashes(parsed.bullets_html),
          issue_summary_short: stripDashes(parsed.issue_summary_short).slice(0, 200),
          ai_model: 'claude-haiku-4-5-20251001',
          ai_summary: stripDashes(parsed.issue_summary_short).slice(0, 200)
        };
        if (inCowork) {
          await runMcpSql(
            "INSERT INTO case_rx_summaries (case_number, raw_text, bullets_html, issue_summary_short, ai_model, ai_summary) " +
            "VALUES ('" + row.case_number.replace(/'/g, "''") + "', " +
            "'" + row.raw_text.replace(/'/g, "''") + "', " +
            "'" + row.bullets_html.replace(/'/g, "''") + "', " +
            "'" + row.issue_summary_short.replace(/'/g, "''") + "', " +
            "'" + row.ai_model + "', " +
            "'" + row.ai_summary.replace(/'/g, "''") + "') " +
            "ON CONFLICT (case_number) DO UPDATE SET " +
            "bullets_html=EXCLUDED.bullets_html, " +
            "issue_summary_short=EXCLUDED.issue_summary_short, " +
            "ai_model=EXCLUDED.ai_model, ai_summary=EXCLUDED.ai_summary, " +
            "generated_at=now()"
          );
        } else {
          const cfg = getConfig();
          await fetch(cfg.url + '/rest/v1/case_rx_summaries?on_conflict=case_number', {
            method: 'POST',
            headers: {
              'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates,return=minimal'
            },
            body: JSON.stringify([row])
          });
        }
      }
    }

    if (raw.missing_raw) {
      const out = await callAnthropic(MISSING_PROMPT(raw.missing_raw, syns), 800);
      const parsed = parseJsonish(out);
      if (parsed?.issue_summary_short && parsed?.bullets_html) {
        const row = {
          case_number: caseNumber,
          raw_text: String(raw.missing_raw).slice(0, 50000),
          bullets_html: stripDashes(parsed.bullets_html),
          issue_summary_short: stripDashes(parsed.issue_summary_short).slice(0, 200),
          ai_model: 'claude-haiku-4-5-20251001',
          ai_summary: stripDashes(parsed.issue_summary_short).slice(0, 200)
        };
        if (inCowork) {
          await runMcpSql(
            "INSERT INTO case_missing_info_summaries (case_number, raw_text, bullets_html, issue_summary_short, ai_model, ai_summary) " +
            "VALUES ('" + row.case_number.replace(/'/g, "''") + "', " +
            "'" + row.raw_text.replace(/'/g, "''") + "', " +
            "'" + row.bullets_html.replace(/'/g, "''") + "', " +
            "'" + row.issue_summary_short.replace(/'/g, "''") + "', " +
            "'" + row.ai_model + "', " +
            "'" + row.ai_summary.replace(/'/g, "''") + "') " +
            "ON CONFLICT (case_number) DO UPDATE SET " +
            "bullets_html=EXCLUDED.bullets_html, " +
            "issue_summary_short=EXCLUDED.issue_summary_short, " +
            "ai_model=EXCLUDED.ai_model, ai_summary=EXCLUDED.ai_summary, " +
            "generated_at=now()"
          );
        } else {
          const cfg = getConfig();
          await fetch(cfg.url + '/rest/v1/case_missing_info_summaries?on_conflict=case_number', {
            method: 'POST',
            headers: {
              'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates,return=minimal'
            },
            body: JSON.stringify([row])
          });
        }
      }
    }

    // 3) Recompose the email so the new bullets render
    await callRpc('recompose_pending_attempt', { p_attempt_id: attemptId });
    toast('Email regenerated', 'ok');
    await loadOutbound();
  } catch (e) {
    toast('Resummarize failed: ' + (e.message || e), 'err');
  }
}

// =====================================================================
// App switcher dropdown
// =====================================================================
function toggleAppSwitcher(e) {
  e.stopPropagation();
  document.getElementById('brand-switcher').classList.toggle('open');
}
document.addEventListener('click', (e) => {
  const brand = document.getElementById('brand-switcher');
  if (brand && !brand.contains(e.target)) brand.classList.remove('open');
  const settings = document.getElementById('settings-menu');
  if (settings && !settings.contains(e.target)) settings.classList.remove('open');
  const hidden = document.getElementById('hidden-senders-wrap');
  if (hidden && !hidden.contains(e.target)) hidden.classList.remove('open');
  const filterDd = document.getElementById('outbound-filter-dd');
  if (filterDd && !filterDd.contains(e.target)) filterDd.classList.remove('open');
  const partnerDd = document.getElementById('outbound-partner-dd');
  if (partnerDd && !partnerDd.contains(e.target)) partnerDd.classList.remove('open');
  const inboundStatusDd = document.getElementById('inbound-status-dd');
  if (inboundStatusDd && !inboundStatusDd.contains(e.target)) inboundStatusDd.classList.remove('open');
  const inboundCaseDd = document.getElementById('inbound-case-dd');
  if (inboundCaseDd && !inboundCaseDd.contains(e.target)) inboundCaseDd.classList.remove('open');
  const reschedDd = document.getElementById('resched-filter-dd');
  if (reschedDd && !reschedDd.contains(e.target)) reschedDd.classList.remove('open');
});

// =====================================================================
// Settings gear dropdown (Diag + Config live in here now)
// =====================================================================
function toggleSettings(e) {
  if (e) e.stopPropagation();
  document.getElementById('settings-menu').classList.toggle('open');
}
function closeSettings() {
  document.getElementById('settings-menu').classList.remove('open');
}

// =====================================================================
// Mode switching: Outreach <-> Case Coordination
// =====================================================================
let currentMode = localStorage.getItem('skdla_mode') || 'outreach';

const OUTREACH_PANELS = ['outbound','ready','inbound','audit','lookup','submit','reschedule','editlog','feedback'];
const CC_PANELS       = ['cc-dashboard','cc-newlog','cc-history','cc-tracker','cc-coordinators','cc-prefs'];

function switchMode(mode) {
  currentMode = mode;
  localStorage.setItem('skdla_mode', mode);

  document.getElementById('tabs-outreach').classList.toggle('hidden', mode !== 'outreach');
  document.getElementById('tabs-cc').classList.toggle('hidden', mode !== 'cc');

  // Hide all panels then show the default for the current mode
  [...OUTREACH_PANELS, ...CC_PANELS].forEach(p =>
    document.getElementById('panel-' + p).classList.add('hidden'));

  document.querySelectorAll('#tabs-outreach .tab, #tabs-cc .tab').forEach(t => t.classList.remove('active'));

  if (mode === 'outreach') {
    // Default to the markup's "outbound" tab, but fall back to the first tab
    // this role is actually allowed to see (e.g. case_entry lands on Submit).
    const first = firstPermittedOutreachTab();
    document.getElementById('panel-' + first).classList.remove('hidden');
    document.querySelector(`#tabs-outreach .tab[data-tab="${first}"]`)?.classList.add('active');
    runTabSideEffects(first);
    document.querySelector('.brand-text .sub').textContent = 'Spectrum Killian · Coordinator Inbox';
    document.getElementById('check-outreach').style.display = 'inline';
    document.getElementById('check-cc').style.display = 'none';
    document.querySelector('.brand-text .name').textContent = 'Design Approvals';
  } else {
    document.getElementById('panel-cc-dashboard').classList.remove('hidden');
    document.querySelector('#tabs-cc .tab[data-cc-tab="dashboard"]').classList.add('active');
    document.querySelector('.brand-text .sub').textContent = 'Case Coordination · Workflow + Logs';
    document.getElementById('check-outreach').style.display = 'none';
    document.getElementById('check-cc').style.display = 'inline';
    document.querySelector('.brand-text .name').textContent = 'Case Coordination';
    ensureCcDataLoaded();
  }
  // The KPI strip + search bar are scoped to the outreach app
  const kpiStrip = document.getElementById('kpi-strip');
  const searchRow = document.getElementById('global-search-row');
  // KPI strip is also gated by the `metrics` capability (hidden for
  // design_approver / case_entry even within the outreach app).
  if (kpiStrip)  kpiStrip.style.display  = (mode === 'outreach' && can(CAPABILITIES.METRICS)) ? '' : 'none';
  if (searchRow) searchRow.style.display = (mode === 'outreach') ? '' : 'none';
  if (mode === 'outreach' && typeof updateGlobalSearchScope === 'function') updateGlobalSearchScope();
}

// =====================================================================
// Role-based access control (Design Approvals / outreach app only)
// =====================================================================
// Maps each #tabs-outreach tab (data-tab) to its capability key. Tabs not
// listed here (e.g. "feedback") are never gated — visible to all approved users.
const TAB_CAP = {
  submit:     CAPABILITIES.TAB_SUBMIT,
  outbound:   CAPABILITIES.TAB_OUTBOUND,
  inbound:    CAPABILITIES.TAB_INBOUND,
  ready:      CAPABILITIES.TAB_READY,
  reschedule: CAPABILITIES.TAB_RESCHEDULE,
  lookup:     CAPABILITIES.TAB_LOOKUP,
  audit:      CAPABILITIES.TAB_AUDIT,
  editlog:    CAPABILITIES.TAB_EDITLOG,
};

// True if the current role may see this outreach tab. Ungated tabs (no entry
// in TAB_CAP, e.g. feedback) are always allowed.
function isOutreachTabPermitted(which) {
  const cap = TAB_CAP[which];
  return cap ? can(cap) : true;
}

// First permitted outreach tab in DOM order — used as the landing tab for roles
// whose default ("outbound") is hidden (e.g. case_entry lands on Submit).
function firstPermittedOutreachTab() {
  const tabs = document.querySelectorAll('#tabs-outreach .tab');
  for (const t of tabs) {
    if (isOutreachTabPermitted(t.dataset.tab)) return t.dataset.tab;
  }
  return 'submit'; // every role has Submit, but fall back defensively
}

// Per-tab work that must run when a tab becomes active.
function runTabSideEffects(which) {
  // Re-render the Ready tab on open so the "In queue?" column reflects any
  // drafts the cron has composed since the last refresh.
  if (which === 'ready') renderReady();
  if (which === 'editlog') loadEditLog();
  if (which === 'feedback') loadFeedback();
  if (typeof updateGlobalSearchScope === 'function') updateGlobalSearchScope();
}

// Hide every tab/control the current role isn't allowed to see, then make sure
// the active tab is one they can actually open. Called once after sign-in
// approval (boot) — see initAuth callback.
function applyPermissions() {
  // 1) Hide non-permitted outreach tabs (the `hidden` class is the pattern
  //    already used elsewhere on tabs/panels).
  document.querySelectorAll('#tabs-outreach .tab').forEach(tab => {
    tab.classList.toggle('hidden', !isOutreachTabPermitted(tab.dataset.tab));
  });

  // 2) Metrics: KPI strip + the appbar "Metrics" button.
  const allowMetrics = can(CAPABILITIES.METRICS);
  const kpiStrip = document.getElementById('kpi-strip');
  if (kpiStrip && !allowMetrics) kpiStrip.style.display = 'none';
  document.getElementById('metrics-btn')?.classList.toggle('hidden', !allowMetrics);
  document.getElementById('metrics-sep')?.classList.toggle('hidden', !allowMetrics);

  // 3) Pending Outbound revenue features (chip/sort/filter).
  applyOutboundRevenuePermission();

  // 4) If the currently-active outreach tab isn't permitted, land on the first
  //    one that is.
  const active = document.querySelector('#tabs-outreach .tab.active')?.dataset.tab;
  if (currentMode === 'outreach' && (!active || !isOutreachTabPermitted(active))) {
    activateOutreachTab(firstPermittedOutreachTab());
  }
}

// Activate an outreach tab programmatically (same effect as a click), used by
// switchMode/applyPermissions. Ignores tabs the role can't open.
function activateOutreachTab(which) {
  if (!isOutreachTabPermitted(which)) return;
  document.querySelectorAll('#tabs-outreach .tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`#tabs-outreach .tab[data-tab="${which}"]`)?.classList.add('active');
  OUTREACH_PANELS.forEach(p => {
    document.getElementById('panel-' + p).classList.toggle('hidden', p !== which);
  });
  runTabSideEffects(which);
}

// Strip revenue chip/sort/filter for roles without `outbound.revenue`
// (design_approver). Idempotent: safe to call more than once.
function applyOutboundRevenuePermission() {
  if (can(CAPABILITIES.OUTBOUND_REVENUE)) return;
  // Remove the two revenue sort <option>s and switch off a revenue default.
  const sortSel = document.getElementById('outbound-sort');
  if (sortSel) {
    sortSel.querySelectorAll('option[value="revenue_desc"], option[value="revenue_asc"]')
      .forEach(o => o.remove());
    if (outboundFilter.sort === 'revenue_desc' || outboundFilter.sort === 'revenue_asc') {
      outboundFilter.sort = 'oldest';
    }
    sortSel.value = outboundFilter.sort;
  }
  // Clear any revenue filter tier that may have been selected.
  if (['high', 'mid', 'low'].includes(outboundFilter.revenue)) outboundFilter.revenue = '';
}

// =====================================================================
// Tab switching
// =====================================================================
document.querySelectorAll('#tabs-outreach .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const which = tab.dataset.tab;
    // Guard: ignore clicks on tabs this role isn't allowed to open (covers any
    // stale DOM / keyboard path that reaches a hidden tab).
    if (!isOutreachTabPermitted(which)) return;
    document.querySelectorAll('#tabs-outreach .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    OUTREACH_PANELS.forEach(p => {
      document.getElementById('panel-' + p).classList.toggle('hidden', p !== which);
    });
    runTabSideEffects(which);
  });
});
document.querySelectorAll('#tabs-cc .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#tabs-cc .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const which = 'cc-' + tab.dataset.ccTab;
    CC_PANELS.forEach(p => {
      document.getElementById('panel-' + p).classList.toggle('hidden', p !== which);
    });
  });
});

// =====================================================================
// Submit Request ·intake form for case review / case entry team
// =====================================================================
async function submitRequest() {
  const caseNum = document.getElementById('req-case').value.trim();
  const reason  = document.querySelector('input[name="req-reason"]:checked').value;
  const summary = document.getElementById('req-summary').value.trim();
  const details = document.getElementById('req-details').value.trim();
  const priority = document.querySelector('input[name="req-priority"]:checked').value;
  const resultEl = document.getElementById('req-result');
  const btn = document.getElementById('req-submit');

  if (!caseNum || !summary) {
    resultEl.innerHTML = '<div class="empty" style="padding:14px;color:var(--red);"><strong>Case number and issue summary are required.</strong></div>';
    return;
  }
  if (reason !== 'design_approval' && !details) {
    resultEl.innerHTML = '<div class="empty" style="padding:14px;color:var(--red);"><strong>Details are required for ' + reason + ' requests.</strong></div>';
    return;
  }

  btn.disabled = true;
  resultEl.innerHTML = '<div class="loading">Submitting request and composing draft…</div>';

  try {
    const me = loginIdentity();
    await callRpc('submit_outreach_request', {
      p_case_number: caseNum,
      p_reason: reason,
      p_requested_by: me.name,
      p_issue_summary: summary,
      p_details: details || null,
      p_priority: priority,
      p_login_name: me.name,
      p_login_email: me.email
    });
    resultEl.innerHTML =
      '<div style="background:var(--green-soft);border:1px solid var(--green);color:var(--green);' +
      'padding:14px 18px;border-radius:6px;">' +
      '<strong>Request submitted.</strong> The bot has drafted the email. ' +
      'Check the <strong>Pending Outbound</strong> tab ·a coordinator will review and approve before sending.' +
      '</div>';
    // Reset form fields
    document.getElementById('req-case').value = '';
    document.getElementById('req-summary').value = '';
    document.getElementById('req-details').value = '';
    await loadOutbound();
  } catch (err) {
    resultEl.innerHTML =
      '<div style="background:var(--red-soft);border:1px solid var(--red);color:var(--red);' +
      'padding:14px 18px;border-radius:6px;">' +
      '<strong>Submission failed.</strong> ' + esc(err.message || err) +
      '<br/><br/>Most common cause: case number doesn\'t exist in Cases yet. Double-check the number.' +
      '</div>';
  } finally {
    btn.disabled = false;
  }
}

// =====================================================================
// Case Lookup ·timeline of all communications for a case
// =====================================================================
// Cached state for the most recently looked-up case so the AI-summary and
// Print buttons don't have to refetch.
const caseLookupState = { caseNumber: null, rows: [], caseInfo: null, summary: '' };

// Incremental case-number search. As the coordinator types, we query
// matching case_number prefixes from "Cases" and render a clickable list.
// On exact-match (or click), we hand off to lookupCase() for the timeline.
let _caseLookupDebounce = null;
function onCaseLookupInput(value) {
  const v = (value || '').trim();
  const box = document.getElementById('lookup-suggestions');
  const result = document.getElementById('lookup-result');
  if (_caseLookupDebounce) clearTimeout(_caseLookupDebounce);
  if (!v) {
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
    if (result) result.innerHTML = '';
    return;
  }
  _caseLookupDebounce = setTimeout(() => fetchCaseSuggestions(v), 220);
}

async function fetchCaseSuggestions(prefix) {
  const box = document.getElementById('lookup-suggestions');
  if (!box) return;
  box.style.display = 'block';
  box.innerHTML = '<div class="lookup-suggest-loading">Searching…</div>';

  let rows;
  try {
    if (inCowork) {
      const safe = prefix.replace(/'/g, "''");
      rows = await runMcpSql(
        `SELECT c."Case Number" AS case_number,
                NULLIF(TRIM(BOTH FROM (c."Patient First Name" || ' ') || c."Patient Last Name"), '') AS patient_name,
                a."Last Name" AS dr_last_name,
                a."Practice Name" AS practice_name,
                c."Current Step" AS current_step
         FROM "Cases" c
         LEFT JOIN "Accounts" a ON a."Account Number" = c."Account Number"
         WHERE c."Case Number" ILIKE '${safe}%'
         ORDER BY c."Case Number" DESC
         LIMIT 25`
      );
    } else {
      rows = await restGet('/rest/v1/v_case_basics?case_number=ilike.' +
        encodeURIComponent(prefix + '%') +
        '&order=case_number.desc&limit=25');
    }
  } catch (e) {
    box.innerHTML = '<div class="lookup-suggest-error">Search failed: ' + esc(String(e?.message || e)) + '</div>';
    return;
  }

  if (!rows || rows.length === 0) {
    box.innerHTML = '<div class="lookup-suggest-empty">No cases start with <strong>' + esc(prefix) + '</strong>.</div>';
    return;
  }

  // If exactly one match, render the timeline immediately
  if (rows.length === 1) {
    box.style.display = 'none';
    const input = document.getElementById('lookup-input');
    if (input) input.value = rows[0].case_number;
    lookupCase();
    return;
  }

  // Multiple matches → render clickable list
  box.innerHTML =
    '<div class="lookup-suggest-head">' + rows.length + ' matches — click one to open</div>' +
    rows.map(r => `
      <div class="lookup-suggest-row" onclick="pickCaseSuggestion('${esc(r.case_number)}')">
        <span class="ls-case">${esc(r.case_number)}</span>
        <span class="ls-patient">${esc(r.patient_name || '—')}</span>
        <span class="ls-dr">${esc(r.dr_last_name || '')}${r.practice_name ? ' · ' + esc(r.practice_name) : ''}</span>
        <span class="ls-step">${esc(r.current_step || '')}</span>
      </div>`).join('');
}

function pickCaseSuggestion(caseNumber) {
  const input = document.getElementById('lookup-input');
  if (input) input.value = caseNumber;
  const box = document.getElementById('lookup-suggestions');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  lookupCase();
}

async function lookupCase() {
  const cn = document.getElementById('lookup-input').value.trim();
  if (!cn) { toast('Enter a case number', 'err'); return; }
  document.getElementById('lookup-result').innerHTML = '<div class="loading">Loading timeline…</div>';

  let rows, caseInfo;
  if (inCowork) {
    rows = await runMcpSql(
      "SELECT event_id, case_number, event_time, event_type, status, direction, " +
      "attempt_number, counterparty, subject, body, reason, actor, sub_status, note " +
      "FROM v_case_comms_timeline WHERE case_number = '" + cn.replace(/'/g, "''") + "' " +
      "ORDER BY event_time DESC LIMIT 200"
    );
    const meta = await runMcpSql(
      `SELECT c."Case Number" AS case_number,
              NULLIF(TRIM(BOTH FROM (c."Patient First Name" || ' ') || c."Patient Last Name"), '') AS patient_name,
              c."Doctor Due Date" AS doctor_due_date,
              c."Current Step" AS current_step,
              c."Case Status" AS case_status,
              c."Hold Reason" AS hold_reason,
              c."Pan Number" AS pan_number,
              a."Last Name" AS dr_last_name,
              a."Practice Name" AS practice_name,
              a."Primary Email" AS dr_email,
              a."Account Manager" AS account_manager
       FROM "Cases" c
       LEFT JOIN "Accounts" a ON a."Account Number" = c."Account Number"
       WHERE c."Case Number" = '` + cn.replace(/'/g, "''") + "' LIMIT 1"
    );
    caseInfo = (meta && meta[0]) || null;
  } else {
    rows = await restGet('/rest/v1/v_case_comms_timeline?case_number=eq.' +
      encodeURIComponent(cn) + '&order=event_time.desc&limit=200');
    try {
      const meta = await restGet('/rest/v1/v_case_basics?case_number=eq.' + encodeURIComponent(cn) + '&limit=1');
      caseInfo = (meta && meta[0]) || null;
    } catch { caseInfo = null; }
  }

  caseLookupState.caseNumber = cn;
  caseLookupState.rows = rows || [];
  caseLookupState.caseInfo = caseInfo;
  caseLookupState.summary = '';

  if (!rows || rows.length === 0) {
    document.getElementById('lookup-result').innerHTML =
      '<div class="empty"><strong>No events for case ' + esc(cn) + '.</strong><br/>Check the case number, or this case may have no Case Notes / attempts / replies yet.</div>';
    return;
  }

  // Header summary
  const counts = { outbound: 0, inbound: 0, internal: 0 };
  let firstSeen = null, lastSeen = null;
  for (const r of rows) {
    counts[r.direction] = (counts[r.direction] || 0) + 1;
    const t = r.event_time ? new Date(r.event_time) : null;
    if (t) {
      if (!firstSeen || t < firstSeen) firstSeen = t;
      if (!lastSeen || t > lastSeen) lastSeen = t;
    }
  }

  // Case info bar — pulls from caseInfo if we got it, falls back to "–"
  const ci = caseInfo || {};
  const dueDate = ci.doctor_due_date ? new Date(ci.doctor_due_date + 'T12:00:00').toLocaleDateString() : '–';
  const caseInfoBar = `
    <div class="lookup-case-info">
      <div><div class="ci-label">Patient</div><div class="ci-value">${esc(ci.patient_name || '–')}</div></div>
      <div><div class="ci-label">Doctor</div><div class="ci-value">${esc(ci.dr_last_name || '–')}</div></div>
      <div><div class="ci-label">Practice</div><div class="ci-value">${esc(ci.practice_name || '–')}</div></div>
      <div><div class="ci-label">Current Step</div><div class="ci-value">${esc(ci.current_step || '–')}</div></div>
      <div><div class="ci-label">Doctor Due</div><div class="ci-value">${esc(dueDate)}</div></div>
      <div><div class="ci-label">Case Status</div><div class="ci-value">${esc(ci.case_status || '–')}</div></div>
    </div>`;

  const header = `
    <div class="lookup-header">
      <div><div class="label">Case</div><div class="value">${esc(cn)}</div></div>
      <div><div class="label">Outbound</div><div class="value">${counts.outbound || 0}</div></div>
      <div><div class="label">Inbound</div><div class="value">${counts.inbound || 0}</div></div>
      <div><div class="label">First / Last</div><div class="value" style="font-size:11px;">${firstSeen ? firstSeen.toLocaleDateString([], {timeZone:'America/Los_Angeles'}) : '–'} → ${lastSeen ? lastSeen.toLocaleDateString([], {timeZone:'America/Los_Angeles'}) : '–'}</div></div>
      <div class="lookup-actions">
        <button class="act blue" onclick="generateCaseSummary()" id="case-summary-btn">Generate AI Summary</button>
        <button class="act approve" onclick="printCaseLookup()">Print PDF</button>
      </div>
    </div>
    ${caseInfoBar}
    <div id="case-summary-box" class="case-summary-box" style="display:none;">
      <div class="case-summary-label">AI Summary</div>
      <div id="case-summary-text"></div>
    </div>`;

  const events = rows.map(r => {
    const t = r.event_time ? new Date(r.event_time) : null;
    const timeStr = t ? t.toLocaleDateString([], {timeZone:'America/Los_Angeles'}) + ' ' + t.toLocaleTimeString([], {timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit'}) + ' PT' : '';
    const typeLabel = (r.event_type || '').replace(/_/g, ' ');
    const statusClass = (r.status || '').replace(/\s+/g, '_').toLowerCase();
    const statusChip = r.status
      ? '<span class="tl-status-chip ' + statusClass + '">' + esc(r.status) + '</span>'
      : '';
    const subject = r.subject ? '<div class="subject">' + esc(r.subject) + '</div>' : '';
    const body = r.body
      ? '<div class="body" onclick="this.classList.toggle(\'expanded\')">' +
        (r.event_type === 'case_note' ? esc(r.body).replace(/\n/g, '<br>') : esc(r.body).replace(/\n/g, '<br>')) +
        '</div>'
      : '';
    return `
      <div class="tl-event ${r.direction || 'internal'} ${statusClass}">
        <div class="tl-event-head">
          <span><span class="type">${esc(typeLabel)}</span> ${statusChip}</span>
          <span class="time">${esc(timeStr)}</span>
        </div>
        ${r.counterparty ? '<div class="actor">' + (r.direction === 'inbound' ? 'From' : 'To') + ': ' + esc(r.counterparty) + '</div>' : ''}
        ${r.actor && r.actor !== r.counterparty ? '<div class="actor">Actor: ' + esc(r.actor) + '</div>' : ''}
        ${subject}
        ${body}
        ${r.note ? '<div style="font-size:11px;color:var(--slate);margin-top:6px;"><em>' + esc(r.note) + '</em></div>' : ''}
      </div>`;
  }).join('');

  document.getElementById('lookup-result').innerHTML =
    header + '<div class="timeline">' + events + '</div>';
}

// Build a plain-text transcript of the case's communications for AI input
function _caseTimelineToText(rows) {
  // Oldest first reads more naturally for the summarizer
  const ordered = (rows || []).slice().sort((a, b) =>
    new Date(a.event_time || 0) - new Date(b.event_time || 0));
  return ordered.map(r => {
    const t = r.event_time ? new Date(r.event_time).toLocaleString([], {timeZone:'America/Los_Angeles'}) + ' PT' : '';
    const who = r.counterparty || r.actor || '';
    const dir = r.direction === 'outbound' ? 'WE SENT' : r.direction === 'inbound' ? 'THEY SAID' : 'INTERNAL';
    const subj = r.subject ? ' — ' + r.subject : '';
    const body = (r.body || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
    return `[${t}] ${dir} (${(r.event_type || '').replace(/_/g, ' ')}) ${who}${subj}\n${body}`;
  }).join('\n\n');
}

async function generateCaseSummary() {
  const rows = caseLookupState.rows || [];
  if (!rows.length) { toast('Look up a case first', 'err'); return; }
  const btn = document.getElementById('case-summary-btn');
  const box = document.getElementById('case-summary-box');
  const txt = document.getElementById('case-summary-text');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
  try {
    const transcript = _caseTimelineToText(rows);
    const ci = caseLookupState.caseInfo || {};
    const prompt = `You are summarizing the complete communication history for a dental lab case.

Case: ${caseLookupState.caseNumber || ''}
Patient: ${ci.patient_name || ''}
Doctor: ${ci.dr_last_name || ''} (${ci.practice_name || ''})
Current step: ${ci.current_step || ''}
Doctor due date: ${ci.doctor_due_date || ''}

Write a 4-6 sentence narrative summary that a coordinator could use to get up to speed in 30 seconds. Cover:
- What the case is about (in plain language)
- Key decisions / status changes
- Most recent outbound + inbound communication
- Any open action items or blockers
- Whether the case is on track for the due date

Be specific. Plain text, no bullet points, no markdown.

Communication history (oldest first):
"""
${transcript.slice(0, 14000)}
"""

Summary:`;
    const out = await callAnthropic(prompt, 500);
    caseLookupState.summary = (out || '').trim();
    if (txt) txt.textContent = caseLookupState.summary;
    if (box) box.style.display = 'block';
  } catch (e) {
    toast('Could not generate summary: ' + (e?.message || e), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Regenerate Summary'; }
  }
}

function printCaseLookup() {
  const rows = caseLookupState.rows || [];
  if (!rows.length) { toast('Look up a case first', 'err'); return; }
  const cn  = caseLookupState.caseNumber || '';
  const ci  = caseLookupState.caseInfo || {};
  const sum = caseLookupState.summary || '';
  const dueDate = ci.doctor_due_date
    ? new Date(ci.doctor_due_date + 'T12:00:00').toLocaleDateString()
    : '–';

  const ordered = rows.slice().sort((a, b) =>
    new Date(a.event_time || 0) - new Date(b.event_time || 0));

  const eventsHtml = ordered.map(r => {
    const t   = r.event_time ? new Date(r.event_time) : null;
    const stamp = t ? t.toLocaleDateString([], {timeZone:'America/Los_Angeles'}) + ' ' + t.toLocaleTimeString([], {timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit'}) + ' PT' : '';
    const dirLabel = r.direction === 'outbound' ? 'Outbound' :
                     r.direction === 'inbound'  ? 'Inbound'  : 'Internal';
    const who = r.counterparty || r.actor || '';
    const typeLabel = (r.event_type || '').replace(/_/g, ' ');
    return `
      <div class="cnp-event">
        <div class="cnp-event-head">
          <span class="cnp-event-type">${esc(dirLabel)} · ${esc(typeLabel)}</span>
          <span class="cnp-event-time">${esc(stamp)}</span>
        </div>
        ${who ? `<div class="cnp-event-who">${esc(r.direction === 'inbound' ? 'From: ' : 'To: ')}${esc(who)}</div>` : ''}
        ${r.subject ? `<div class="cnp-event-subj">${esc(r.subject)}</div>` : ''}
        ${r.body ? `<div class="cnp-event-body">${esc(r.body)}</div>` : ''}
        ${r.note ? `<div class="cnp-event-note"><em>${esc(r.note)}</em></div>` : ''}
      </div>`;
  }).join('');

  const target = document.getElementById('call-notes-print');
  target.innerHTML = `
    <div class="cnp-header">
      <div class="cnp-brand">Spectrum Killian<small>Case Communication Record</small></div>
      <div class="cnp-date">${esc(new Date().toLocaleString())}</div>
    </div>
    <h2>Case ${esc(cn)}</h2>
    <div class="cnp-meta">
      <div><strong>Patient:</strong> ${esc(ci.patient_name || '–')}</div>
      <div><strong>Doctor:</strong> ${esc(ci.dr_last_name || '–')}</div>
      <div><strong>Practice:</strong> ${esc(ci.practice_name || '–')}</div>
      <div><strong>Current Step:</strong> ${esc(ci.current_step || '–')}</div>
      <div><strong>Doctor Due Date:</strong> ${esc(dueDate)}</div>
      <div><strong>Case Status:</strong> ${esc(ci.case_status || '–')}</div>
      ${ci.account_manager ? '<div><strong>Account Manager:</strong> ' + esc(ci.account_manager) + '</div>' : ''}
      ${ci.pan_number ? '<div><strong>PAN:</strong> ' + esc(ci.pan_number) + '</div>' : ''}
    </div>
    ${sum ? `
      <div class="cnp-section-label">AI Summary</div>
      <div class="cnp-summary">${esc(sum)}</div>
    ` : ''}
    <div class="cnp-section-label">Communication Timeline (${ordered.length} events, oldest first)</div>
    ${eventsHtml}
    <div class="cnp-footer">
      Spectrum Killian Dental Lab Alliance · Printed ${new Date().toLocaleString()}
    </div>
  `;
  setTimeout(() => window.print(), 80);
}

// Enter key triggers lookup
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement &&
      document.activeElement.id === 'lookup-input') {
    lookupCase();
  }
});

// =====================================================================
// Boot
// =====================================================================
// =====================================================================
// Case Coordination data + renderers
// =====================================================================
const ACTION_TYPES = [
  "Dr Approved","Initial Approval","Design Changes","Re-Design Approval",
  "Incoming Case Review","Reminder","Rescheduled Step Dates: Night Guard",
  "Rescheduled Step Dates","Provided New Delivery Date","Internal Remake",
  "Review Request Form","STL File","Case Released from Hold","1st Approved",
  "Cases Received from Design","Design Errors","Steps Not Scanned","Escape",
  "Dr Approvals Sent",
];

let ccData = { cases: [], logs: [], coordinators: [] };
let caseTab = 'today';
let ccLoaded = false;
let trackerSubTab = 'tracker';

const HOLD_DURATIONS = ['', '24 hr', '48 hr', '72 hr', '1 week'];

const TRASH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="3 6 5 6 21 6"></polyline>' +
  '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>' +
  '<path d="M10 11v6M14 11v6"></path>' +
  '<path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>' +
  '</svg>';

function pacificDate(off = 0) {
  const d = new Date();
  d.setDate(d.getDate() + off);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

async function ensureCcDataLoaded() {
  if (ccLoaded) return;
  await reloadCcData();
}

async function reloadCcData() {
  let [cases, logs, coords, prefs] = [null, null, null, null];
  if (inCowork) {
    cases  = await runMcpSql('SELECT * FROM "Case"        ORDER BY updated_date DESC NULLS LAST LIMIT 500');
    logs   = await runMcpSql('SELECT * FROM "CaseLog"     ORDER BY log_date DESC NULLS LAST, created_date DESC NULLS LAST LIMIT 5000');
    coords = await runMcpSql('SELECT * FROM "Coordinator" ORDER BY name LIMIT 200');
    prefs  = await runMcpSql('SELECT * FROM v_account_preferences ORDER BY practice_name LIMIT 2000');
  } else {
    cases  = await restGet('/rest/v1/Case?select=*&order=updated_date.desc.nullslast&limit=500');
    logs   = await restGet('/rest/v1/CaseLog?select=*&order=log_date.desc.nullslast,created_date.desc.nullslast&limit=5000');
    coords = await restGet('/rest/v1/Coordinator?select=*&order=name&limit=200');
    prefs  = await restGet('/rest/v1/v_account_preferences?select=*&order=practice_name&limit=2000');
  }
  ccData.cases = cases || [];
  ccData.logs  = logs  || [];
  ccData.coordinators = coords || [];
  ccData.preferences = prefs || [];
  ccLoaded = true;
  populateCcFilters();
  renderDashboard();
  renderHistory();
  renderTracker();
  renderCoordinators();
  renderPrefsList();
  populateNewLogForm();
}

function populateCcFilters() {
  const coordNames = [...new Set(ccData.logs.map(l => l.coordinator).filter(Boolean))].sort();

  const coordSel = document.getElementById('cc-filter-coord');
  coordSel.innerHTML = '<option value="all">All Coordinators</option>' +
    coordNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');

  const histAction = document.getElementById('hist-action');
  histAction.innerHTML = '<option value="all">All Actions</option>' +
    ACTION_TYPES.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');

  const stages = [...new Set(ccData.cases.map(c => c.current_stage).filter(Boolean))].sort();
  const stageSel = document.getElementById('track-stage');
  stageSel.innerHTML = '<option value="all">All Stages</option>' +
    stages.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
}

function populateNewLogForm() {
  const actSel = document.getElementById('log-action-type');
  actSel.innerHTML = '<option value="">Select action type</option>' +
    ACTION_TYPES.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');

  const coordOpts = '<option value="">Select coordinator</option>' +
    ccData.coordinators.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  document.getElementById('log-coordinator').innerHTML = coordOpts;

  const stages = [...new Set(ccData.cases.map(c => c.current_stage).filter(Boolean))].sort();
  const stageOpts = '<option value="">Select stage</option>' +
    stages.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  document.getElementById('log-stage').innerHTML = stageOpts;

  document.getElementById('log-date').value = pacificDate();

  // Case Tracker — Add/Update Case form
  const trCoord = document.getElementById('track-form-coord');
  if (trCoord) trCoord.innerHTML = coordOpts;
  const trStage = document.getElementById('track-form-stage');
  if (trStage) trStage.innerHTML = stageOpts;
  const trDate = document.getElementById('track-form-date');
  if (trDate && !trDate.value) trDate.value = pacificDate();
}

function getFilteredLogs() {
  const coord = document.getElementById('cc-filter-coord').value;
  const from  = document.getElementById('cc-filter-from').value;
  const to    = document.getElementById('cc-filter-to').value;
  return ccData.logs.filter(l => {
    const d = l.log_date || (l.created_date || '').split('T')[0];
    if (coord !== 'all' && l.coordinator !== coord) return false;
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  });
}

function renderDashboard() {
  if (!ccLoaded) return;
  const filtered = getFilteredLogs();
  const today = pacificDate(), yesterday = pacificDate(-1);
  const targetDate = caseTab === 'today' ? today : yesterday;

  // "Today" = the action's log_date (the business date the coordinator
  // assigned). log_date is a plain date column, so this is timezone-proof.
  // Avoid created_date here: it's a UTC timestamp and comparing its UTC date
  // against a Pacific "today" miscounts rows created in the evening Pacific.
  const todayLogs = filtered.filter(l => l.log_date === today);

  const actionCounts = {};
  filtered.forEach(l => { actionCounts[l.action_type] = (actionCounts[l.action_type] || 0) + 1; });
  const topAction = Object.entries(actionCounts).sort((a,b) => b[1]-a[1])[0]?.[0] || '-';

  document.getElementById('cc-stat-total').textContent  = filtered.length;
  document.getElementById('cc-stat-today').textContent  = todayLogs.length;
  document.getElementById('cc-stat-top').textContent    = topAction;

  document.getElementById('cc-tab-today').classList.toggle('cc-pill-active', caseTab === 'today');
  document.getElementById('cc-tab-yesterday').classList.toggle('cc-pill-active', caseTab === 'yesterday');

  const targetCases = ccData.cases.filter(c => c.stage_updated_date === targetDate);
  const byStage = {};
  targetCases.forEach(c => {
    if (!byStage[c.current_stage]) byStage[c.current_stage] = [];
    byStage[c.current_stage].push(c);
  });

  const board = document.getElementById('cc-status-board');
  if (Object.keys(byStage).length === 0) {
    board.innerHTML = '<div class="empty">No cases for ' + targetDate + '.</div>';
  } else {
    board.innerHTML = '<div class="cc-status-grid">' +
      Object.entries(byStage).sort((a,b) => b[1].length - a[1].length).map(([stage, list]) => {
        const slug = stage.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const cells = list.slice(0, 4).map(c => {
          const pname = c.patient_name || '';
          const holdBadge = c.hold_duration ? '<span style="background:#4ADE80;color:#14532d;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:800;margin-left:6px;">' + esc(c.hold_duration) + '</span>' : '';
        return '<div class="case-row">' +
            '<span class="cnum">' + esc(c.case_id) + '</span>' +
            holdBadge +
            (pname ? ' <span class="pname">·' + esc(pname) + '</span>' : '') +
            '<div class="meta">' + esc(c.coordinator || '-') + ' · ' + esc((c.stage_updated_date || '').slice(5).replace('-','/')) + '</div>' +
        '</div>';
        }).join('');
        const more = list.length > 4 ? '<div class="meta" style="margin-top:4px;font-size:11px;color:var(--slate);">+' + (list.length - 4) + ' more</div>' : '';
        return '<div class="cc-status-cell cc-stage-' + slug + '"><div class="head"><div class="stage">' + esc(stage) + '</div><div class="count">' + list.length + '</div></div>' + cells + more + '</div>';
      }).join('') + '</div>';
  }

  const recent = document.getElementById('cc-recent-logs');
  recent.innerHTML = renderLogTable(filtered.slice(0, 15));
}

function setCaseTab(tab) { caseTab = tab; renderDashboard(); }

// Parse a date/timestamp and return { date, time } strings in Pacific time.
// Accepts both ISO ("2026-05-28T22:13:15.065+00:00") and the looser Postgres
// form ("2026-05-28 22:13:15.065+00"), as well as plain date strings.
// `time` is '' for date-only inputs.
function formatPstParts(value, opts) {
  if (!value) return { date: '', time: '' };
  const includeYear = !opts || opts.year !== false;
  let s = String(value).trim();
  const hasTime = /[T ]\d{1,2}:/.test(s);
  if (hasTime) {
    s = s.replace(/([+-]\d{2})$/, '$1:00').replace(' ', 'T');
  } else {
    s = s + 'T12:00:00';
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return { date: '', time: '' };
  const base = {
    month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles',
    ...(includeYear ? { year: 'numeric' } : {}),
  };
  const date = d.toLocaleDateString('en-US', base);
  const time = hasTime
    ? d.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: 'America/Los_Angeles',
      })
    : '';
  return { date, time };
}

function renderLogTable(logs) {
  if (!logs.length) return '<div class="empty">No log entries.</div>';
  return '<table class="cc-table">' +
    '<colgroup>' +
      '<col style="width:13%">' +    // Case ID
      '<col style="width:17%">' +    // Action (slightly smaller)
      '<col style="width:15%">' +    // Coordinator (slightly smaller)
      '<col style="width:22%">' +    // Date (expanded to fit time)
      '<col style="width:28%">' +    // Notes (expanded)
      '<col style="width:5%">' +     // Delete button
    '</colgroup>' +
    '<thead><tr><th>Case ID</th><th>Action</th><th>Coordinator</th><th>Date</th><th>Notes</th><th></th></tr></thead><tbody>' +
    logs.map(l => {
      // Prefer the timestamp (has time); fall back to log_date (date only).
      const parts = formatPstParts(l.created_date || l.log_date);
      const dateCell = parts.time
        ? esc(parts.date) + '<span style="display:inline-block; width:14px;"></span>' + esc(parts.time)
        : esc(parts.date);
      const slug = (l.action_type || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const delBtn = l.id != null
        ? '<button class="cc-trash-btn" title="Delete log entry" onclick="deleteLogEntry(\'' + esc(String(l.id)) + '\', \'' + esc(l.case_id || '') + '\')">' + TRASH_ICON + '</button>'
        : '';
      return '<tr><td class="case-id-cell">' + esc(l.case_id || '') + '</td>' +
        '<td><span class="cc-action-badge ' + slug + '">' + esc(l.action_type || '') + '</span></td>' +
        '<td>' + esc(l.coordinator || '-') + '</td>' +
        '<td class="muted">' + dateCell + '</td>' +
        '<td class="muted">' + (esc((l.notes||'').slice(0,80)) || '-') + '</td>' +
        '<td style="text-align:right;">' + delBtn + '</td></tr>';
    }).join('') +
    '</tbody></table>';
}

async function deleteLogEntry(id, caseId) {
  if (!confirm('Delete log entry for ' + (caseId || '?') + '?')) return;
  try {
    if (inCowork) {
      await runMcpSql("DELETE FROM \"CaseLog\" WHERE id = '" + String(id).replace(/'/g,"''") + "'");
    } else {
      const cfg = getConfig();
      const res = await fetch(cfg.url + '/rest/v1/CaseLog?id=eq.' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { apikey: cfg.key, Authorization: 'Bearer '+cfg.key },
      });
      if (!res.ok) throw new Error(await res.text());
    }
    toast('Log entry deleted', 'ok');
    await reloadCcData();
  } catch (e) { toast('Delete failed: ' + (e.message || e), 'err'); }
}

function renderHistory() {
  if (!ccLoaded) return;
  const search = document.getElementById('hist-search').value.toLowerCase();
  const action = document.getElementById('hist-action').value;
  const filtered = ccData.logs.filter(l => {
    if (search && !((l.case_id||'').toLowerCase().includes(search) ||
                    (l.coordinator||'').toLowerCase().includes(search))) return false;
    if (action !== 'all' && l.action_type !== action) return false;
    return true;
  });
  document.getElementById('cc-history-list').innerHTML =
    '<div style="font-size:11px;color:var(--slate);margin-bottom:8px;">Showing ' + filtered.length + ' of ' + ccData.logs.length + '</div>' +
    renderLogTable(filtered.slice(0, 200));
}

function exportFPY() {
  const fpyIds = new Set(ccData.cases.filter(c => c.dr_approval_count === 1).map(c => c.case_id));
  if (!fpyIds.size) { toast('No first pass yield cases found', 'err'); return; }
  const rows = ccData.logs.filter(l => fpyIds.has(l.case_id));
  const csv = ['Case ID,Action,Coordinator,Date,Notes',
    ...rows.map(l => [l.case_id, l.action_type, l.coordinator || '',
                      l.log_date || (l.created_date||'').split('T')[0] || '',
                      (l.notes||'').replace(/"/g,'""')]
                .map(v => '"' + String(v) + '"').join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'first-pass-yield-' + pacificDate() + '.csv';
  a.click();
  toast('Downloaded FPY export', 'ok');
}

// Render a single case as a card row with inline stage/hold dropdowns + delete.
function renderCaseCard(c, allStages) {
  const patientLabel = (c.patient_name || '').trim();
  const wfSlug = (c.workflow_type || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const holdBadge = c.hold_duration
    ? '<span class="hold-badge">' + esc(c.hold_duration) + '</span>'
    : '';
  const wfBadge = c.workflow_type
    ? '<span class="wf-badge ' + wfSlug + '">' + esc(c.workflow_type) + '</span>'
    : '';
  // Prefer the timestamp on Case (has time); fall back to stage_updated_date (date only).
  const dtParts = formatPstParts(c.updated_date || c.stage_updated_date, { year: false });
  const dateNice = dtParts.time ? dtParts.date + ' · ' + dtParts.time : dtParts.date;
  const stageOpts = allStages.map(s =>
    '<option value="' + esc(s) + '"' + (s === c.current_stage ? ' selected' : '') + '>' + esc(s) + '</option>'
  ).join('');
  const holdOpts = HOLD_DURATIONS.map(h =>
    '<option value="' + esc(h) + '"' + (h === (c.hold_duration || '') ? ' selected' : '') + '>' +
      (h === '' ? '— Hold —' : esc(h)) + '</option>'
  ).join('');
  const caseIdEsc = esc(c.case_id);
  return '<div class="cc-case-card">' +
    '<div class="info">' +
      '<div class="row1">' +
        '<span class="cnum">' + caseIdEsc + '</span>' +
        (patientLabel ? '<span class="sep">·</span><span class="pname">' + esc(patientLabel) + '</span>' : '') +
        wfBadge + holdBadge +
      '</div>' +
      '<div class="meta">' + esc(c.coordinator || '-') + ' · ' + esc(dateNice || '-') + '</div>' +
    '</div>' +
    '<div class="controls">' +
      '<select class="cc-inline-select" onchange="updateCaseInlineStage(\'' + caseIdEsc + '\', this.value)">' +
        stageOpts +
      '</select>' +
      '<select class="cc-inline-select" onchange="updateCaseHoldDuration(\'' + caseIdEsc + '\', this.value)">' +
        holdOpts +
      '</select>' +
      '<button class="cc-trash-btn" title="Delete case" onclick="deleteCaseFromTracker(\'' + caseIdEsc + '\')">' + TRASH_ICON + '</button>' +
    '</div>' +
  '</div>';
}

function renderCaseCardList(cases) {
  if (!cases.length) return '<div class="empty">No cases yet.</div>';
  const allStages = [...new Set(ccData.cases.map(c => c.current_stage).filter(Boolean))].sort();
  return cases.map(c => renderCaseCard(c, allStages)).join('');
}

function sortCases(cases, mode) {
  const arr = cases.slice();
  if (mode === 'updated_asc') {
    arr.sort((a, b) => (a.updated_date || '').localeCompare(b.updated_date || ''));
  } else if (mode === 'case_id_asc') {
    arr.sort((a, b) => (a.case_id || '').localeCompare(b.case_id || ''));
  } else {
    // default 'updated_desc': most recently updated first, nulls last
    arr.sort((a, b) => {
      const av = a.updated_date || '', bv = b.updated_date || '';
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      return bv.localeCompare(av);
    });
  }
  return arr;
}

function renderTracker() {
  if (!ccLoaded) return;
  const wfEl = document.getElementById('track-workflow');
  const stEl = document.getElementById('track-stage');
  const sortEl = document.getElementById('track-sort');
  const wf = wfEl ? wfEl.value : 'all';
  const st = stEl ? stEl.value : 'all';
  const sortMode = sortEl ? sortEl.value : 'updated_desc';
  const filtered = ccData.cases.filter(c => {
    if (wf !== 'all' && c.workflow_type !== wf) return false;
    if (st !== 'all' && c.current_stage !== st) return false;
    return true;
  });
  const sorted = sortCases(filtered, sortMode);
  const countEl = document.getElementById('track-count');
  if (countEl) countEl.textContent = sorted.length + ' case' + (sorted.length === 1 ? '' : 's');

  const list = document.getElementById('cc-tracker-list');
  if (list) {
    list.innerHTML = sorted.length
      ? renderCaseCardList(sorted.slice(0, 200))
      : '<div class="empty">No cases match filters.</div>';
  }

  // Live tracker section under New Log form — always most-recently-updated first
  const newlog = document.getElementById('cc-newlog-tracker');
  if (newlog) {
    newlog.innerHTML = renderCaseCardList(sortCases(ccData.cases, 'updated_desc').slice(0, 20));
  }
}

function setTrackerSubTab(tab) {
  trackerSubTab = tab;
  document.getElementById('cc-subtab-tracker').classList.toggle('active', tab === 'tracker');
  document.getElementById('cc-subtab-diagram').classList.toggle('active', tab === 'diagram');
  document.getElementById('cc-tracker-panel').classList.toggle('hidden', tab !== 'tracker');
  document.getElementById('cc-diagram-panel').classList.toggle('hidden', tab !== 'diagram');
}

async function addCaseToTracker() {
  const caseId   = document.getElementById('track-case-id').value.trim();
  const patient  = document.getElementById('track-patient').value.trim();
  const workflow = document.getElementById('track-form-workflow').value;
  const stage    = document.getElementById('track-form-stage').value;
  const coord    = document.getElementById('track-form-coord').value;
  const dt       = document.getElementById('track-form-date').value;
  const notes    = document.getElementById('track-form-notes').value.trim();
  if (!caseId || !workflow || !stage) {
    toast('Case ID, workflow, and stage are required', 'err'); return;
  }
  try {
    await upsertCase({
      case_id: caseId,
      patient_name: patient || undefined,
      workflow_type: workflow,
      current_stage: stage,
      coordinator: coord || undefined,
      stage_updated_date: dt || pacificDate(),
      notes: notes || undefined,
    });
    toast('Case saved', 'ok');
    document.getElementById('track-case-id').value = '';
    document.getElementById('track-patient').value = '';
    document.getElementById('track-form-notes').value = '';
    await reloadCcData();
  } catch (e) {
    toast('Save failed: ' + (e.message || e), 'err');
  }
}

async function updateCaseInlineStage(caseId, newStage) {
  try {
    await upsertCase({
      case_id: caseId,
      current_stage: newStage,
      stage_updated_date: pacificDate(),
    });
    toast('Stage updated', 'ok');
    await reloadCcData();
  } catch (e) { toast('Update failed: ' + (e.message || e), 'err'); }
}

async function updateCaseHoldDuration(caseId, newDuration) {
  try {
    if (inCowork) {
      await runMcpSql('UPDATE "Case" SET hold_duration = ' + sqlVal(newDuration || null) +
        " WHERE case_id = '" + caseId.replace(/'/g,"''") + "'");
    } else {
      const cfg = getConfig();
      const res = await fetch(cfg.url + '/rest/v1/Case?case_id=eq.' + encodeURIComponent(caseId), {
        method: 'PATCH',
        headers: {
          apikey: cfg.key, Authorization: 'Bearer '+cfg.key,
          'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify({ hold_duration: newDuration || null }),
      });
      if (!res.ok) throw new Error(await res.text());
    }
    toast('Hold updated', 'ok');
    await reloadCcData();
  } catch (e) { toast('Update failed: ' + (e.message || e), 'err'); }
}

async function deleteCaseFromTracker(caseId) {
  if (!confirm('Delete case ' + caseId + ' from tracker?')) return;
  try {
    if (inCowork) {
      await runMcpSql("DELETE FROM \"Case\" WHERE case_id = '" + caseId.replace(/'/g,"''") + "'");
    } else {
      const cfg = getConfig();
      const res = await fetch(cfg.url + '/rest/v1/Case?case_id=eq.' + encodeURIComponent(caseId), {
        method: 'DELETE',
        headers: { apikey: cfg.key, Authorization: 'Bearer '+cfg.key },
      });
      if (!res.ok) throw new Error(await res.text());
    }
    toast('Case deleted', 'ok');
    await reloadCcData();
  } catch (e) { toast('Delete failed: ' + (e.message || e), 'err'); }
}

function renderCoordinators() {
  if (!ccLoaded) return;
  const list = document.getElementById('cc-coord-list');
  if (!ccData.coordinators.length) {
    list.innerHTML = '<div class="empty">No coordinators yet.</div>';
    return;
  }
  list.innerHTML = ccData.coordinators.map(c =>
    '<div class="cc-coord-row"><span class="nm">' + esc(c.name) + '</span>' +
    '<button class="cc-del" onclick="removeCoord(\'' + esc(c.id) + '\', \'' + esc(c.name) + '\')">Remove</button></div>'
  ).join('');
}

function sqlVal(v) {
  return (v == null || v === '') ? 'NULL' : "'" + String(v).replace(/'/g,"''") + "'";
}

// Generate a 24-char lowercase hex id to match the existing format on
// "Case"/"CaseLog"/"Coordinator" (those tables have text id columns without
// a DB default, so the client has to supply one on INSERT).
function genId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// Upsert a row into the "Case" table keyed by case_id. PK is "id" (text) and
// case_id has no unique constraint, so we look up an existing row in memory
// then either PATCH by id (update) or POST a fresh row with a generated id.
// Only non-empty fields are written so callers can't blank out other columns.
async function upsertCase(fields) {
  if (!fields || !fields.case_id) return;
  const f = { ...fields, updated_date: fields.updated_date || pacificDate() };
  const body = {};
  Object.keys(f).forEach(k => {
    if (f[k] !== undefined && f[k] !== '' && f[k] !== null) body[k] = f[k];
  });
  if (!Object.keys(body).length) return;

  const existing = (ccData.cases || []).find(c => c.case_id === fields.case_id);

  if (existing && existing.id) {
    const update = { ...body };
    delete update.case_id;
    if (!Object.keys(update).length) return;
    if (inCowork) {
      const setClause = Object.keys(update).map(c => '"' + c + '" = ' + sqlVal(update[c])).join(', ');
      await runMcpSql('UPDATE "Case" SET ' + setClause + ' WHERE id = ' + sqlVal(existing.id));
    } else {
      const cfg = getConfig();
      const res = await fetch(cfg.url + '/rest/v1/Case?id=eq.' + encodeURIComponent(existing.id), {
        method: 'PATCH',
        headers: {
          apikey: cfg.key, Authorization: 'Bearer '+cfg.key,
          'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify(update),
      });
      if (!res.ok) throw new Error(await res.text());
    }
  } else {
    body.id = genId();
    if (inCowork) {
      const cols = Object.keys(body);
      const colList = cols.map(c => '"' + c + '"').join(', ');
      const valList = cols.map(c => sqlVal(body[c])).join(', ');
      await runMcpSql('INSERT INTO "Case" (' + colList + ') VALUES (' + valList + ')');
    } else {
      const cfg = getConfig();
      const res = await fetch(cfg.url + '/rest/v1/Case', {
        method: 'POST',
        headers: {
          apikey: cfg.key, Authorization: 'Bearer '+cfg.key,
          'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify([body]),
      });
      if (!res.ok) throw new Error(await res.text());
    }
  }
}

async function submitLog() {
  const caseId   = document.getElementById('log-case-id').value.trim();
  const action   = document.getElementById('log-action-type').value;
  const coord    = document.getElementById('log-coordinator').value;
  const dt       = document.getElementById('log-date').value;
  const notes    = document.getElementById('log-notes').value.trim();
  const patient  = document.getElementById('log-patient').value.trim();
  const workflow = document.getElementById('log-workflow').value;
  const stage    = document.getElementById('log-stage').value;
  if (!caseId || !action) { toast('Case ID and action are required', 'err'); return; }
  const me = loginIdentity();
  const row = {
    id: genId(),
    case_id: caseId, action_type: action,
    coordinator: coord || null, log_date: dt || pacificDate(),
    notes: notes || null,
    created_by: me.name, created_by_id: me.email,
  };
  try {
    if (inCowork) {
      const q = v => v ? "'" + String(v).replace(/'/g, "''") + "'" : 'NULL';
      await runMcpSql("INSERT INTO \"CaseLog\" (id, case_id, action_type, coordinator, log_date, notes, created_by, created_by_id, created_date) VALUES (" +
        "'" + row.id + "', " +
        "'" + caseId.replace(/'/g,"''") + "', " +
        "'" + action.replace(/'/g,"''") + "', " +
        (coord ? "'" + coord.replace(/'/g,"''") + "'" : 'NULL') + ", " +
        (dt    ? "'" + dt + "'" : 'NULL') + ", " +
        (notes ? "'" + notes.replace(/'/g,"''") + "'" : 'NULL') + ", " +
        q(me.name) + ", " + q(me.email) + ", now())");
    } else {
      const cfg = getConfig();
      const res = await fetch(cfg.url + '/rest/v1/CaseLog', {
        method: 'POST',
        headers: { apikey: cfg.key, Authorization: 'Bearer '+cfg.key, 'Content-Type':'application/json' },
        body: JSON.stringify([row]),
      });
      if (!res.ok) throw new Error(await res.text());
    }
    await upsertCase({
      case_id: caseId,
      patient_name: patient || undefined,
      workflow_type: workflow || undefined,
      current_stage: stage || undefined,
      coordinator: coord || undefined,
      stage_updated_date: dt || pacificDate(),
    });
    toast('Log saved', 'ok');
    document.getElementById('log-case-id').value = '';
    document.getElementById('log-notes').value   = '';
    document.getElementById('log-patient').value = '';
    await reloadCcData();
  } catch (e) {
    toast('Save failed: ' + (e.message || e), 'err');
  }
}

async function addCoordinator() {
  const nm = document.getElementById('coord-name').value.trim();
  if (!nm) return;
  if (ccData.coordinators.some(c => c.name.toLowerCase() === nm.toLowerCase())) {
    toast('Coordinator already exists', 'err'); return;
  }
  const newId = genId();
  try {
    if (inCowork) {
      await runMcpSql("INSERT INTO \"Coordinator\" (id, name, created_date) VALUES ('" +
        newId + "', '" + nm.replace(/'/g,"''") + "', now())");
    } else {
      const cfg = getConfig();
      const res = await fetch(cfg.url + '/rest/v1/Coordinator', {
        method: 'POST',
        headers: {
          apikey: cfg.key, Authorization: 'Bearer '+cfg.key,
          'Content-Type': 'application/json', Prefer: 'return=minimal',
        },
        body: JSON.stringify([{ id: newId, name: nm }]),
      });
      if (!res.ok) throw new Error(await res.text());
    }
    document.getElementById('coord-name').value = '';
    toast('Coordinator added', 'ok');
    await reloadCcData();
  } catch (e) { toast('Failed: ' + (e.message || e), 'err'); }
}

// ----- Preferences -----
let selectedPrefAcct = null;

function renderPrefsList() {
  const list = document.getElementById('prefs-list');
  const q = (document.getElementById('prefs-search').value || '').toLowerCase();
  const filtered = (ccData.preferences || []).filter(p => {
    if (!q) return true;
    return (p.practice_name || '').toLowerCase().includes(q) ||
           (p.account_number || '').toLowerCase().includes(q) ||
           (p.account_label || '').toLowerCase().includes(q);
  });
  document.getElementById('prefs-count').textContent =
    filtered.length + ' of ' + (ccData.preferences || []).length;
  if (!filtered.length) { list.innerHTML = '<div class="empty">No accounts.</div>'; return; }
  list.innerHTML = filtered.slice(0, 200).map(p => {
    const active = p.account_number === selectedPrefAcct ? 'border-color: var(--blue); background: #F0F7FB;' : '';
    return '<div onclick="selectPrefAcct(\'' + esc(p.account_number) + '\')" ' +
      'style="background:white; border:1px solid var(--slate-light); border-radius:10px; ' +
      'padding:10px 14px; margin-bottom:6px; cursor:pointer; ' + active + '">' +
      '<div style="font-weight:700; color:var(--navy); font-size:13px;">' + esc(p.practice_name || '-') + '</div>' +
      '<div style="font-family:Consolas,monospace; font-size:11px; color:var(--slate);">' +
        esc(p.account_number) + (p.derived_from_accounts ? ' · <span style="color:var(--gold);">auto</span>' : ' · <span style="color:var(--green);">curated</span>') +
      '</div></div>';
  }).join('');
  if (!selectedPrefAcct && filtered.length) selectPrefAcct(filtered[0].account_number);
}

function selectPrefAcct(acctNum) {
  selectedPrefAcct = acctNum;
  renderPrefsList();
  const p = (ccData.preferences || []).find(x => x.account_number === acctNum);
  const ed = document.getElementById('prefs-editor');
  if (!p) { ed.innerHTML = '<div class="empty">Select an account.</div>'; return; }

  const flagBanner = p.derived_from_accounts
    ? '<div style="background:#FEF3C7; border:1px solid #FDE68A; color:#92400E; padding:10px 14px; border-radius:8px; margin-bottom:14px; font-size:13px;">' +
      '<strong>Auto-backfilled from existing Accounts data.</strong> Edit these to mark as curated.</div>'
    : '<div style="background:#D1FAE5; border:1px solid #A7F3D0; color:#065F46; padding:10px 14px; border-radius:8px; margin-bottom:14px; font-size:13px;">' +
      '<strong>Curated by a human.</strong> Last updated ' + esc(p.updated_at || '-') + ' by ' + esc(p.updated_by || '-') + '.</div>';

  const aiBadge = p.ai_extracted_at
    ? '<span style="background:#E0F2FE;color:var(--blue);padding:2px 8px;border-radius:10px;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;margin-left:8px;">Auto-extracted</span>'
    : '';

  ed.innerHTML =
    '<div class="cc-form-card" style="max-width:none;">' +
      '<div style="font-size:11px; font-weight:800; color:var(--slate); letter-spacing:2px; text-transform:uppercase; margin-bottom:4px;">' + esc(p.account_number) + '</div>' +
      '<div style="font-family:Georgia,serif; font-size:22px; font-weight:bold; color:var(--navy); margin-bottom:14px;">' + esc(p.practice_name || '-') + aiBadge + '</div>' +
      flagBanner +
      '<div class="cc-form-grid">' +
        '<div><label>Preferred Tooth Library</label><input id="pe-lib" class="cc-input" value="' + esc(p.preferred_tooth_library || '') + '" placeholder="e.g. Phonares S81" /></div>' +
        '<div><label>Preferred Shade</label><input id="pe-shade" class="cc-input" value="' + esc(p.preferred_shade || '') + '" placeholder="e.g. BL3" /></div>' +
        '<div><label>Preferred Implant System</label><input id="pe-implant" class="cc-input" value="' + esc(p.preferred_implant_system || '') + '" placeholder="e.g. Neodent, Straumann" /></div>' +
        '<div><label>CC Emails on Outreach</label><input id="pe-cc" class="cc-input" value="' + esc(p.cc_emails || '') + '" placeholder="comma-separated" /></div>' +
        '<div class="full"><label>Bite Preferences</label><input id="pe-bite" class="cc-input" value="' + esc(p.bite_preferences || '') + '" placeholder="e.g. Maintain existing OB/OJ" /></div>' +
        '<div class="full"><label>Design Notes / Other Preferences</label>' +
          '<textarea id="pe-notes" rows="8" class="cc-input" style="font-family:inherit;">' + esc(p.design_notes || '') + '</textarea></div>' +
      '</div>' +
      '<div style="display:flex; gap:10px; margin-top:18px; flex-wrap:wrap;">' +
        '<button onclick="savePrefs(\'' + esc(p.account_number) + '\')" class="cc-btn-primary" style="margin-top:0;">Save Preferences</button>' +
        '<button onclick="extractPrefsWithAI(\'' + esc(p.account_number) + '\')" class="cc-btn-primary" style="margin-top:0;background:#9A7B2E;">Auto-extract</button>' +
        (p.derived_from_accounts ? '<button onclick="bulkExtractPrefs()" class="cc-btn-primary" style="margin-top:0;background:var(--slate);">Bulk: Extract All Auto Rows</button>' : '') +
      '</div>' +
      (p.raw_case_entry_pref || p.raw_dr_pref ? (
        '<details style="margin-top:18px;"><summary style="cursor:pointer; color:var(--slate); font-size:12px;">Raw original data (from Accounts)</summary>' +
        (p.raw_case_entry_pref ? '<div style="margin-top:10px;"><div style="font-size:10px; font-weight:800; color:var(--slate); letter-spacing:1.5px; text-transform:uppercase; margin-bottom:4px;">Case Entry Pref</div><pre style="background:#F8FAFC; padding:10px; border-radius:6px; font-size:12px; white-space:pre-wrap;">' + esc(p.raw_case_entry_pref) + '</pre></div>' : '') +
        (p.raw_dr_pref ? '<div style="margin-top:10px;"><div style="font-size:10px; font-weight:800; color:var(--slate); letter-spacing:1.5px; text-transform:uppercase; margin-bottom:4px;">Dr Pref</div><pre style="background:#F8FAFC; padding:10px; border-radius:6px; font-size:12px; white-space:pre-wrap;">' + esc(p.raw_dr_pref) + '</pre></div>' : '') +
        '</details>'
      ) : '') +
    '</div>';
}

async function savePrefs(acctNum) {
  const row = {
    account_number: acctNum,
    preferred_tooth_library:  document.getElementById('pe-lib').value.trim() || null,
    preferred_shade:          document.getElementById('pe-shade').value.trim() || null,
    preferred_implant_system: document.getElementById('pe-implant').value.trim() || null,
    cc_emails:                document.getElementById('pe-cc').value.trim() || null,
    bite_preferences:         document.getElementById('pe-bite').value.trim() || null,
    design_notes:             document.getElementById('pe-notes').value.trim() || null,
    derived_from_accounts:    false,
    updated_by:               'coordinator@skdla',
    updated_at:               new Date().toISOString(),
  };
  try {
    if (inCowork) {
      const q = v => v ? "'" + String(v).replace(/'/g, "''") + "'" : 'NULL';
      await runMcpSql(
        "UPDATE account_preferences SET " +
        "preferred_tooth_library="  + q(row.preferred_tooth_library) + ", " +
        "preferred_shade="          + q(row.preferred_shade) + ", " +
        "preferred_implant_system=" + q(row.preferred_implant_system) + ", " +
        "cc_emails="                + q(row.cc_emails) + ", " +
        "bite_preferences="         + q(row.bite_preferences) + ", " +
        "design_notes="             + q(row.design_notes) + ", " +
        "derived_from_accounts=FALSE, updated_by='" + row.updated_by + "', updated_at=now() " +
        "WHERE account_number='" + acctNum.replace(/'/g, "''") + "'"
      );
    } else {
      const cfg = getConfig();
      await fetch(cfg.url + '/rest/v1/account_preferences?account_number=eq.' + encodeURIComponent(acctNum), {
        method: 'PATCH',
        headers: { apikey: cfg.key, Authorization: 'Bearer '+cfg.key, 'Content-Type':'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      });
    }
    toast('Preferences saved', 'ok');
    await reloadCcData();
    // Refresh per-reason summaries so the yellow panel reflects the new prefs
    generatePrefSummaries(acctNum, { silent: true }).catch(() => {});
  } catch (e) { toast('Save failed: ' + (e.message || e), 'err'); }
}

// ----- AI extraction for preferences -----
const PREFS_PROMPT = (raw) => `You are extracting structured doctor/account preferences from a free-text note used by a dental lab.

Raw preference text:
"""
${String(raw).slice(0, 6000)}
"""

Extract whatever is clearly stated. Return ONLY strict JSON:
{
  "preferred_tooth_library": "Phonares S81 or null",
  "preferred_shade": "BL3 or null",
  "preferred_implant_system": "Neodent or Blue Sky Bio or null",
  "bite_preferences": "short phrase or null",
  "cc_emails": "comma-separated emails to CC on outreach, or null",
  "design_notes": "remaining content (rules, special handling, terminology, anything that doesn't fit above) condensed"
}

Rules:
- Use null if not present. Do not invent values.
- For cc_emails: only extract emails clearly meant for ongoing CC on this account.
- For design_notes: preserve all special handling rules, terminology mappings, contact preferences. Condense but keep the substance.
- ASCII hyphen only.`;

async function extractPrefsWithAI(acctNum) {
  const cfg = getConfig();
  const p = (ccData.preferences || []).find(x => x.account_number === acctNum);
  if (!p) return;
  const raw = (p.raw_case_entry_pref || '') + (p.raw_dr_pref ? '\n\n--- Dr Pref ---\n' + p.raw_dr_pref : '');
  if (!raw.trim()) { toast('No raw preference text to extract from', 'err'); return; }
  toast('Extracting…', 'ok');
  try {
    const out = await callAnthropic(PREFS_PROMPT(raw), 800);
    const parsed = parseJsonish(out);
    if (!parsed) { toast('Could not parse extraction response', 'err'); return; }
    const q = v => v ? "'" + String(v).replace(/'/g, "''") + "'" : 'NULL';
    const stripped = {
      lib:    stripDashes(parsed.preferred_tooth_library  || '') || null,
      shade:  stripDashes(parsed.preferred_shade           || '') || null,
      impl:   stripDashes(parsed.preferred_implant_system  || '') || null,
      bite:   stripDashes(parsed.bite_preferences          || '') || null,
      cc:     stripDashes(parsed.cc_emails                 || '') || null,
      notes:  stripDashes(parsed.design_notes              || '') || null,
    };
    if (inCowork) {
      await runMcpSql(
        "UPDATE account_preferences SET " +
        "preferred_tooth_library=" + q(stripped.lib) + ", " +
        "preferred_shade="         + q(stripped.shade) + ", " +
        "preferred_implant_system="+ q(stripped.impl) + ", " +
        "bite_preferences="        + q(stripped.bite) + ", " +
        "cc_emails="               + q(stripped.cc) + ", " +
        "design_notes="            + q(stripped.notes) + ", " +
        "ai_extracted_at=now(), updated_at=now() " +
        "WHERE account_number='" + acctNum.replace(/'/g, "''") + "'"
      );
    } else {
      await fetch(cfg.url + '/rest/v1/account_preferences?account_number=eq.' + encodeURIComponent(acctNum), {
        method: 'PATCH',
        headers: { apikey: cfg.key, Authorization: 'Bearer '+cfg.key, 'Content-Type':'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          preferred_tooth_library:  stripped.lib,
          preferred_shade:          stripped.shade,
          preferred_implant_system: stripped.impl,
          bite_preferences:         stripped.bite,
          cc_emails:                stripped.cc,
          design_notes:             stripped.notes,
          ai_extracted_at:          new Date().toISOString(),
          updated_at:               new Date().toISOString(),
        }),
      });
    }
    toast('Extracted ' + Object.values(stripped).filter(v => v).length + ' fields', 'ok');
    await reloadCcData();
    // Refresh per-reason summaries now that the structured fields changed
    generatePrefSummaries(acctNum).catch(() => {});
  } catch (e) {
    toast('Extract failed: ' + (e.message || e), 'err');
  }
}

// ----- Per-reason preference summaries (one call, four reasons) -----
const SUMMARY_PROMPT = (p) => `You are condensing a single doctor's preferences into one-line headlines for a dental lab coordinator. The coordinator is reviewing a draft email being sent to this doctor and needs to know, at a glance, which of the doctor's preferences are relevant for THIS email's reason.

Doctor's structured preferences:
- Tooth library: ${p.preferred_tooth_library || 'not set'}
- Shade: ${p.preferred_shade || 'not set'}
- Implant system: ${p.preferred_implant_system || 'not set'}
- Bite preferences: ${p.bite_preferences || 'not set'}
- CC emails on outreach: ${p.cc_emails || 'not set'}
- Free-text notes: ${(p.design_notes || 'none').slice(0, 2000)}

Generate four short summaries, one per email reason. Each is a JSON object with two keys: "headline" (6 to 10 words, plain phrase, no period, the single most important preference for that reason) and "detail" (one short sentence, up to 18 words, supporting context the coordinator should glance at).

The four reasons are:
- design_approval: doctor is approving or rejecting a finished design
- design_modification: doctor is requesting a change to a design already shown
- missing_info: doctor needs to send us more info before we can proceed
- waiting_on_parts: we are waiting on physical parts from the doctor

Return ONLY strict JSON in this exact shape:
{
  "design_approval":     { "headline": "...", "detail": "..." },
  "design_modification": { "headline": "...", "detail": "..." },
  "missing_info":        { "headline": "...", "detail": "..." },
  "waiting_on_parts":    { "headline": "...", "detail": "..." }
}

Rules:
- If a preference is irrelevant for a reason, leave it out of that reason's headline. Pick what matters.
- If you have nothing useful to say for a given reason, set headline to "No specific preferences on file" and detail to "Use standard workflow.".
- ASCII hyphen only. No em or en dashes.
- No marketing language. Plain coordinator-speak.`;

async function fetchPrefRow(acctNum) {
  const cfg = getConfig();
  const cols = 'account_number,preferred_tooth_library,preferred_shade,preferred_implant_system,bite_preferences,cc_emails,design_notes';
  if (inCowork) {
    const rows = await runMcpSql(
      "SELECT " + cols + " FROM account_preferences WHERE account_number='" +
      acctNum.replace(/'/g, "''") + "' LIMIT 1"
    );
    return (rows && rows[0]) || null;
  }
  const rows = await restGet('/rest/v1/account_preferences?select=' + cols +
    '&account_number=eq.' + encodeURIComponent(acctNum) + '&limit=1');
  return (rows && rows[0]) || null;
}

async function generatePrefSummaries(acctNum, opts) {
  opts = opts || {};
  const cfg = getConfig();
  // Prefer cached prefs (from CC mode); otherwise fetch the row directly so
  // the lazy backfill works even if the user has never opened the CC tab.
  let p = (ccData.preferences || []).find(x => x.account_number === acctNum);
  if (!p) {
    try { p = await fetchPrefRow(acctNum); } catch (e) { p = null; }
  }
  if (!p) return;
  // Skip if there's literally nothing to summarize
  const hasAnything = p.preferred_tooth_library || p.preferred_shade || p.preferred_implant_system ||
                      p.bite_preferences || p.cc_emails || (p.design_notes && p.design_notes.trim());
  if (!hasAnything) return;
  try {
    const out = await callAnthropic(SUMMARY_PROMPT(p), 700);
    const parsed = parseJsonish(out);
    if (!parsed) return;
    // Sanitize: only keep our four known reasons, only headline + detail strings
    const REASONS = ['design_approval','design_modification','missing_info','waiting_on_parts'];
    const clean = {};
    for (const r of REASONS) {
      const v = parsed[r];
      if (v && typeof v === 'object') {
        clean[r] = {
          headline: stripDashes(String(v.headline || '')).slice(0, 140),
          detail:   stripDashes(String(v.detail   || '')).slice(0, 240),
        };
      }
    }
    const json = JSON.stringify(clean).replace(/'/g, "''");
    if (inCowork) {
      await runMcpSql(
        "UPDATE account_preferences SET pref_summaries='" + json +
        "'::jsonb, updated_at=now() WHERE account_number='" + acctNum.replace(/'/g, "''") + "'"
      );
    } else {
      await fetch(cfg.url + '/rest/v1/account_preferences?account_number=eq.' + encodeURIComponent(acctNum), {
        method: 'PATCH',
        headers: { apikey: cfg.key, Authorization: 'Bearer '+cfg.key, 'Content-Type':'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ pref_summaries: clean, updated_at: new Date().toISOString() }),
      });
    }
    if (!opts.silent) toast('Preference summaries refreshed', 'ok');
  } catch (e) {
    if (!opts.silent) toast('Summary refresh failed: ' + (e.message || e), 'err');
  }
}

async function bulkExtractPrefs() {
  // Only auto-backfilled rows that haven't been processed yet AND have raw text
  const targets = (ccData.preferences || []).filter(p =>
    p.derived_from_accounts && !p.ai_extracted_at &&
    ((p.raw_case_entry_pref && p.raw_case_entry_pref.trim()) || (p.raw_dr_pref && p.raw_dr_pref.trim()))
  );
  if (!targets.length) { toast('Nothing to extract', 'ok'); return; }
  const cost = (targets.length * 0.003).toFixed(2);
  if (!confirm('Extract structured fields for ' + targets.length + ' accounts? Estimated cost: about $' + cost + '.')) return;

  let done = 0, failed = 0;
  toast('Extracting 0 of ' + targets.length + '…', 'ok');
  for (const p of targets) {
    try { await extractPrefsWithAI(p.account_number); done++; }
    catch { failed++; }
    if (done % 5 === 0) toast('Extracted ' + done + ' of ' + targets.length + '…', 'ok');
  }
  toast('Done ·' + done + ' extracted' + (failed ? ', ' + failed + ' failed' : ''), 'ok');
}

async function removeCoord(id, name) {
  if (!confirm('Remove ' + name + '?')) return;
  try {
    if (inCowork) {
      await runMcpSql("DELETE FROM \"Coordinator\" WHERE id = '" + id + "'");
    } else {
      const cfg = getConfig();
      await fetch(cfg.url + "/rest/v1/Coordinator?id=eq." + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { apikey: cfg.key, Authorization: 'Bearer '+cfg.key },
      });
    }
    toast('Removed', 'ok');
    await reloadCcData();
  } catch (e) { toast('Failed: ' + (e.message || e), 'err'); }
}

// =====================================================================
// Product tour
// =====================================================================
const TOUR_STEPS = [
  // Welcome
  { title: "Welcome", body: "This is your Coordinator Inbox.", placement: 'center' },
  { title: "Two modes", body: "<strong>Outreach</strong> handles doctor emails. <strong>Case Coordination</strong> tracks each case through its workflow.", placement: 'center' },
  { title: "Switching modes", body: "The SKDLA brand at the top left flips between modes anytime. I'll switch you to Outreach now.",
    selector: '#brand-switcher', placement: 'bottom',
    beforeShow: () => switchMode('outreach') },

  // Outreach
  { title: "Click Pending Outbound", body: "Open the first tab.",
    selector: '#tabs-outreach .tab[data-tab="outbound"]', placement: 'bottom', requireClick: true },
  { title: "What you see here", body: "Every draft email is queued here for your review before it sends.",
    selector: '#panel-outbound', placement: 'top' },
  { title: "Pan number first", body: "Each row leads with the Pan number. Case number sits underneath in smaller text.",
    selector: '#panel-outbound .item .case-id-block', placement: 'right',
    beforeShow: () => {
      const t = document.querySelector('#tabs-outreach .tab[data-tab="outbound"]');
      if (t && !t.classList.contains('active')) t.click();
    } },
  { title: "Status chips", body: "Colored chips flag the reason for sending, a recent doctor reply, recent case activity, or due date risk.",
    selector: '#panel-outbound .item .item-head', placement: 'bottom',
    beforeShow: () => {
      const t = document.querySelector('#tabs-outreach .tab[data-tab="outbound"]');
      if (t && !t.classList.contains('active')) t.click();
    } },
  { title: "Expand a row", body: "Click any row to open the full email and the preferences panel. Click the first row now to keep going.",
    selector: '#panel-outbound .item .item-head', placement: 'bottom', requireClick: true,
    beforeShow: () => {
      const t = document.querySelector('#tabs-outreach .tab[data-tab="outbound"]');
      if (t && !t.classList.contains('active')) t.click();
    } },
  { title: "Email preview", body: "This is the rendered draft email. Subject up top, body below.",
    selector: '#panel-outbound .item.expanded .preview', placement: 'right',
    beforeShow: () => {
      const first = document.querySelector('#panel-outbound .item');
      if (first && !first.classList.contains('expanded')) first.classList.add('expanded');
    } },
  { title: "Doctor preferences", body: "The yellow panel on the right shows that doctor's preferences. Bold line at top is the one thing that matters for this email's reason. Full preferences sit below the divider. Scroll if it overflows.",
    selector: '#panel-outbound .item.expanded .prefs-banner', placement: 'left',
    beforeShow: () => {
      const first = document.querySelector('#panel-outbound .item');
      if (first && !first.classList.contains('expanded')) first.classList.add('expanded');
    } },
  { title: "Approve and Send", body: "Queues the email for the next send tick.",
    selector: '#panel-outbound .item.expanded .act.approve', placement: 'top',
    beforeShow: () => {
      const first = document.querySelector('#panel-outbound .item');
      if (first && !first.classList.contains('expanded')) first.classList.add('expanded');
    } },
  { title: "Edit Then Send", body: "Opens a visual editor. Type changes right in the rendered email, then save.",
    selector: '#panel-outbound .item.expanded .act.edit', placement: 'top',
    beforeShow: () => {
      const first = document.querySelector('#panel-outbound .item');
      if (first && !first.classList.contains('expanded')) first.classList.add('expanded');
    } },
  { title: "Auto Resummarize", body: "Regenerates the RX bullets automatically. Use when the first pass misses something.",
    selector: '#panel-outbound .item.expanded .act.blue', placement: 'top',
    beforeShow: () => {
      const first = document.querySelector('#panel-outbound .item');
      if (first && !first.classList.contains('expanded')) first.classList.add('expanded');
    } },
  { title: "Reject", body: "Closes the row and re-queues the case for tomorrow.",
    selector: '#panel-outbound .item.expanded .act.reject', placement: 'top',
    beforeShow: () => {
      const first = document.querySelector('#panel-outbound .item');
      if (first && !first.classList.contains('expanded')) first.classList.add('expanded');
    } },

  { title: "Click Pending Replies", body: "Open the next tab.",
    selector: '#tabs-outreach .tab[data-tab="inbound"]', placement: 'bottom', requireClick: true },
  { title: "Suggested classification", body: "Each reply comes in with a suggested classification. Confirm or override with one click.",
    selector: '#panel-inbound', placement: 'top' },
  { title: "Five buckets", body: "Approved. Modification. Approved with Mods. Pricing Question. Other.",
    selector: '#panel-inbound', placement: 'top' },
  { title: "Pricing routes to AM", body: "Pricing or product questions auto-route to the Account Manager.",
    selector: '#panel-inbound', placement: 'top' },

  { title: "Click Reschedule", body: "Open the next tab.",
    selector: '#tabs-outreach .tab[data-tab="reschedule"]', placement: 'bottom', requireClick: true },
  { title: "5 day window", body: "Cases that cannot make their due date given the 5 business day window and 9am PST cutoff.",
    selector: '#panel-reschedule', placement: 'top' },
  { title: "Export to CSV", body: "One click hands the list straight to production.",
    selector: '#panel-reschedule', placement: 'top' },

  { title: "Click Submit Request", body: "Open the next tab.",
    selector: '#tabs-outreach .tab[data-tab="submit"]', placement: 'bottom', requireClick: true },
  { title: "Drafts you approve", body: "Case Review and Case Entry use this form instead of a Case Note. The system drafts, you approve.",
    selector: '#panel-submit', placement: 'top' },

  { title: "Click Case Lookup", body: "Open the next tab.",
    selector: '#tabs-outreach .tab[data-tab="lookup"]', placement: 'bottom', requireClick: true },
  { title: "Useful for RCCA", body: "Type a case number to see every communication on it in order. Outbound, inbound, and internal notes together.",
    selector: '#panel-lookup', placement: 'top' },

  { title: "Click Audit", body: "Open the last Outreach tab.",
    selector: '#tabs-outreach .tab[data-tab="audit"]', placement: 'bottom', requireClick: true },
  { title: "Spot patterns", body: "Approve, edit, reject rates over a selectable window. High edit rate means the template needs work.",
    selector: '#panel-audit', placement: 'top' },

  // Switch to CC
  { title: "Now: Case Coordination mode", body: "I'll flip the mode for you. Top left dropdown does it manually anytime.",
    selector: '#brand-switcher', placement: 'bottom',
    beforeShow: () => switchMode('cc') },

  { title: "Click Dashboard", body: "Open the first Case Coordination tab.",
    selector: '#tabs-cc .tab[data-cc-tab="dashboard"]', placement: 'bottom', requireClick: true },
  { title: "Quick view", body: "Today's logs, the top action, and cases by current status. Filterable by coordinator and date.",
    selector: '#panel-cc-dashboard', placement: 'top' },

  { title: "Click New Log", body: "Open the next tab.",
    selector: '#tabs-cc .tab[data-cc-tab="newlog"]', placement: 'bottom', requireClick: true },
  { title: "Record an action", body: "Dr Approved, Design Changes, and the other action types. Updates the case automatically.",
    selector: '#panel-cc-newlog', placement: 'top' },

  { title: "Click History", body: "Open the next tab.",
    selector: '#tabs-cc .tab[data-cc-tab="history"]', placement: 'bottom', requireClick: true },
  { title: "Searchable archive", body: "Filter by case, coordinator, or action. Export First Pass Yield for QA metrics.",
    selector: '#panel-cc-history', placement: 'top' },

  { title: "Click Case Tracker", body: "Open the next tab.",
    selector: '#tabs-cc .tab[data-cc-tab="tracker"]', placement: 'bottom', requireClick: true },
  { title: "Every active case", body: "Stage, workflow type, and a design change counter.",
    selector: '#panel-cc-tracker', placement: 'top' },
  { title: "2 mod cap warning", body: "A warning icon appears when a case hits the 2 modification limit. Auto-escalates to live consultation.",
    selector: '#panel-cc-tracker', placement: 'top' },

  { title: "Click Coordinators", body: "Open the next tab.",
    selector: '#tabs-cc .tab[data-cc-tab="coordinators"]', placement: 'bottom', requireClick: true },
  { title: "Manage names", body: "Add or remove the names that appear in dropdowns across the app.",
    selector: '#panel-cc-coordinators', placement: 'top' },

  { title: "Click Preferences", body: "Open the last tab. This one matters.",
    selector: '#tabs-cc .tab[data-cc-tab="prefs"]', placement: 'bottom', requireClick: true },
  { title: "Auto-backfilled", body: "Doctor preferences pulled from your existing account data. Yellow badge means not reviewed yet.",
    selector: '#panel-cc-prefs', placement: 'top' },
  { title: "Click any account to edit", body: "The editor opens on the right.",
    selector: '#panel-cc-prefs', placement: 'top' },
  { title: "Auto-extract", body: "The gold ✨ button parses raw notes into structured fields automatically. Library, shade, implant system, CC emails.",
    selector: '#panel-cc-prefs', placement: 'top' },
  { title: "Preferences feed the emails", body: "Once saved here, they surface on every outbound email automatically.",
    selector: '#panel-cc-prefs', placement: 'top' },

  // Closing
  { title: "That's the tour", body: "You are set.", placement: 'center' },
  { title: "Replay anytime", body: "Gold Tour button in the top right. Click it whenever you need a refresher.",
    selector: '#tour-btn', placement: 'bottom' },
  { title: "Config and Diag", body: "Config holds your credentials. Diag shows the last API response if something looks off. Now go ship.",
    selector: '#tour-btn', placement: 'bottom' },
];

let tourStep = 0;
let tourActive = false;
let tourClickHandler = null;

function startTour() {
  tourActive = true;
  tourStep = 0;
  document.getElementById('tour-tooltip').style.display = 'block';
  document.getElementById('tour-spotlight').style.display = 'block';
  document.addEventListener('keydown', tourKeys);
  window.addEventListener('resize', positionTour);
  showTourStep();
}

function endTour() {
  tourActive = false;
  document.getElementById('tour-tooltip').style.display = 'none';
  document.getElementById('tour-spotlight').style.display = 'none';
  document.removeEventListener('keydown', tourKeys);
  window.removeEventListener('resize', positionTour);
  detachClickRequirement();
  localStorage.setItem('skdla_tour_complete', '1');
}

function tourNext() {
  if (tourStep >= TOUR_STEPS.length - 1) { endTour(); return; }
  tourStep++;
  showTourStep();
}
function tourBack() {
  if (tourStep === 0) return;
  tourStep--;
  showTourStep();
}
function tourKeys(e) {
  if (e.key === 'Escape') endTour();
  else if (e.key === 'ArrowRight' || e.key === 'Enter') tourNext();
  else if (e.key === 'ArrowLeft') tourBack();
}

function attachClickRequirement(selector) {
  detachClickRequirement();
  tourClickHandler = (e) => {
    if (!e.target.closest(selector)) return;
    // Let the native click finish its work, then advance
    setTimeout(() => {
      detachClickRequirement();
      tourNext();
    }, 280);
  };
  // Bubble phase so the element's own click handler runs first
  document.addEventListener('click', tourClickHandler);
}
function detachClickRequirement() {
  if (tourClickHandler) {
    document.removeEventListener('click', tourClickHandler);
    tourClickHandler = null;
  }
}

function showTourStep() {
  detachClickRequirement();
  const step = TOUR_STEPS[tourStep];
  if (step.beforeShow) {
    try { step.beforeShow(); } catch (e) {}
  }
  // Steps that used to require a user click (tab switches, row expands)
  // now auto-click the target so the panel/state is already in the right
  // place when the tooltip shows. Coordinator just hits Next to advance.
  if (step.requireClick && step.selector) {
    const el = document.querySelector(step.selector);
    if (el && typeof el.click === 'function') {
      try { el.click(); } catch (e) {}
    }
  }
  document.getElementById('tour-step-meta').textContent = 'Step ' + (tourStep + 1) + ' of ' + TOUR_STEPS.length;
  document.getElementById('tour-title').textContent = step.title;
  document.getElementById('tour-body').innerHTML = step.body;
  document.getElementById('tour-back').style.visibility = tourStep === 0 ? 'hidden' : 'visible';

  const nextBtn = document.getElementById('tour-next');
  nextBtn.textContent = tourStep === TOUR_STEPS.length - 1 ? 'Finish' : 'Next ›';
  nextBtn.disabled = false;
  nextBtn.style.opacity = '';
  nextBtn.style.cursor = '';

  // Scroll the target into view so the spotlight is on-screen
  if (step.selector && step.placement !== 'center') {
    const el = document.querySelector(step.selector);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }
  }
  // Give beforeShow's tab switch + scroll a tick to settle
  setTimeout(positionTour, 320);
}

function positionTour() {
  if (!tourActive) return;
  const step = TOUR_STEPS[tourStep];
  const tt = document.getElementById('tour-tooltip');
  const sp = document.getElementById('tour-spotlight');
  tt.classList.remove('center');

  if (step.placement === 'center' || !step.selector) {
    sp.style.display = 'none';
    tt.classList.add('center');
    tt.style.top = '50%';
    tt.style.left = '50%';
    return;
  }

  const el = document.querySelector(step.selector);
  if (!el) {
    // Element not in DOM yet (tab just switched, async render not finished).
    // Retry a few times before falling back to center placement.
    if (!step._retryCount) step._retryCount = 0;
    if (step._retryCount < 8) {
      step._retryCount++;
      sp.style.display = 'none';
      setTimeout(positionTour, 150);
      return;
    }
    step._retryCount = 0;
    sp.style.display = 'none';
    tt.classList.add('center');
    tt.style.top = '50%';
    tt.style.left = '50%';
    return;
  }
  step._retryCount = 0;
  const r = el.getBoundingClientRect();
  const pad = 6;
  sp.style.display = 'block';
  sp.style.top    = (r.top - pad) + 'px';
  sp.style.left   = (r.left - pad) + 'px';
  sp.style.width  = (r.width + pad*2) + 'px';
  sp.style.height = (r.height + pad*2) + 'px';

  // Position tooltip near the target
  const ttWidth  = tt.offsetWidth || 380;
  const ttHeight = tt.offsetHeight || 200;
  const vw = window.innerWidth, vh = window.innerHeight;
  let top, left;
  const place = step.placement || 'bottom';

  if (place === 'bottom' || place === 'bottom-left' || place === 'bottom-right') {
    top = r.bottom + 14;
    left = place === 'bottom-left' ? r.right - ttWidth :
           place === 'bottom-right' ? r.left :
           r.left + (r.width - ttWidth) / 2;
  } else if (place === 'top') {
    top = r.top - ttHeight - 14;
    left = r.left + (r.width - ttWidth) / 2;
  } else if (place === 'right') {
    top = r.top + (r.height - ttHeight) / 2;
    left = r.right + 14;
  } else if (place === 'left') {
    top = r.top + (r.height - ttHeight) / 2;
    left = r.left - ttWidth - 14;
  }

  // Clamp to viewport with 16px margin
  top  = Math.max(16, Math.min(top,  vh - ttHeight - 16));
  left = Math.max(16, Math.min(left, vw - ttWidth - 16));
  tt.style.top  = top  + 'px';
  tt.style.left = left + 'px';
}

// =====================================================================
// Boot
// =====================================================================
let _bootRan = false;
function boot() {
  if (_bootRan) return;
  _bootRan = true;

  const sel = document.getElementById('audit-window');
  if (sel) sel.value = String(auditWindowDays);

  if (!inCowork && !getConfig().key) {
    openConfig();
  } else {
    loadAll();
    setInterval(loadAll, 60_000);
  }

  // Show the hidden-sender count chip immediately, even before data loads
  if (typeof renderHiddenSendersList === 'function') renderHiddenSendersList();

  // Restore the last-used mode (outreach or case coordination)
  if (currentMode === 'cc') switchMode('cc');
  else switchMode('outreach');

  // Hide tabs/controls this role isn't allowed to see, and land on a permitted
  // tab. Runs after switchMode so it can correct the active tab if needed.
  applyPermissions();

  // First-time visitors get the tour automatically (after the panels settle)
  if (!localStorage.getItem('skdla_tour_complete')) {
    setTimeout(() => { if (!tourActive) startTour(); }, 600);
  }
}

// Kick off auth flow — boot() only runs once user is authenticated AND approved
initAuth(() => boot());

// =====================================================================
// Metrics — by-doctor KPIs from v_dr_outreach_metrics_by_doctor.
// Opens as a modal from the gold "Metrics" button in the appbar.
// Lazy-loads on open; caches rows in metricsRows for client-side sort/filter.
// =====================================================================
let metricsRows = null;

async function openMetrics() {
  // Capability guard — design_approver / case_entry can't open Metrics even if
  // an onclick path reached this function.
  if (!can(CAPABILITIES.METRICS)) return;
  const modal = document.getElementById('metrics-modal');
  if (!modal) return;
  modal.classList.add('open');
  if (!metricsRows) {
    await loadMetrics();
  } else {
    renderMetricsTable();
  }
}

function closeMetrics() {
  document.getElementById('metrics-modal')?.classList.remove('open');
}

async function loadMetrics() {
  const wrap = document.getElementById('metrics-table-wrap');
  if (wrap) wrap.innerHTML = '<div class="metrics-loading">Loading metrics…</div>';
  try {
    const rows = await restGet('/rest/v1/v_dr_outreach_metrics_by_doctor?select=*&limit=2000');
    metricsRows = rows || [];
    renderMetricsSummary();
    renderMetricsTable();
  } catch (err) {
    if (wrap) wrap.innerHTML = '<div class="metrics-empty">Could not load metrics: ' + esc(String(err.message || err)) + '</div>';
  }
}

function renderMetricsSummary() {
  const el = document.getElementById('metrics-summary');
  if (!el || !metricsRows) return;
  const rows = metricsRows;
  const totalDoctors = rows.length;
  const totalCases   = rows.reduce((s, r) => s + (Number(r.total_cases) || 0), 0);

  const respRows = rows.filter(r => r.median_response_hours != null && r.reply_sample_size > 0);
  let medianResp = null;
  if (respRows.length) {
    const totalW = respRows.reduce((s, r) => s + r.reply_sample_size, 0);
    medianResp = respRows.reduce((s, r) => s + r.median_response_hours * r.reply_sample_size, 0) / totalW;
  }

  const fyRows = rows.filter(r => r.first_yield_pct != null && r.design_approval_cases > 0);
  let avgYield = null;
  if (fyRows.length) {
    const totalW = fyRows.reduce((s, r) => s + r.design_approval_cases, 0);
    avgYield = fyRows.reduce((s, r) => s + r.first_yield_pct * r.design_approval_cases, 0) / totalW;
  }

  const partsInfoTotal = rows.reduce((s, r) => s + (Number(r.parts_info_total) || 0), 0);
  const adjustmentsTotal = rows.reduce((s, r) => s + (Number(r.adjustment_cycles_total) || 0), 0);

  el.innerHTML =
    tile('Doctors tracked', String(totalDoctors), totalCases + ' cases total') +
    tile('Median response',
         medianResp == null ? '—' : formatHours(medianResp),
         medianResp == null ? 'no replies yet' : respRows.length + ' doctors w/ replies') +
    tile('First-yield rate',
         avgYield == null ? '—' : avgYield.toFixed(1) + '%',
         avgYield == null ? 'no design approvals yet' : 'weighted avg') +
    tile('Holds + adjustments',
         (partsInfoTotal + adjustmentsTotal).toString(),
         partsInfoTotal + ' parts/info · ' + adjustmentsTotal + ' adjustments');

  function tile(label, value, sub) {
    return '<div class="metrics-summary-tile">' +
             '<span class="label">' + esc(label) + '</span>' +
             '<span class="value">' + esc(value) + '</span>' +
             '<span class="sub">' + esc(sub) + '</span>' +
           '</div>';
  }
}

function renderMetricsTable() {
  const wrap = document.getElementById('metrics-table-wrap');
  if (!wrap || !metricsRows) return;
  const q = (document.getElementById('metrics-search')?.value || '').trim().toLowerCase();
  const sortKey = document.getElementById('metrics-sort')?.value || 'total_cases';

  let rows = metricsRows.slice();
  if (q) {
    rows = rows.filter(r =>
      (r.doctor || '').toLowerCase().includes(q) ||
      (r.practice_name || '').toLowerCase().includes(q) ||
      (r.strategic_partner || '').toLowerCase().includes(q) ||
      (r.account_manager || '').toLowerCase().includes(q)
    );
  }

  rows.sort((a, b) => {
    if (sortKey === 'doctor') return (a.doctor || '').localeCompare(b.doctor || '');
    if (sortKey === 'first_yield_pct') {
      const av = a.first_yield_pct == null ? 999 : a.first_yield_pct;
      const bv = b.first_yield_pct == null ? 999 : b.first_yield_pct;
      return av - bv;
    }
    if (sortKey === 'median_response_hours') {
      const av = a.median_response_hours == null ? -1 : a.median_response_hours;
      const bv = b.median_response_hours == null ? -1 : b.median_response_hours;
      return bv - av;
    }
    return (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0);
  });

  if (!rows.length) {
    wrap.innerHTML = '<div class="metrics-empty">No doctors match this filter.</div>';
    return;
  }

  let html =
    '<table class="metrics-table">' +
      '<thead><tr>' +
        '<th>Doctor / Practice</th>' +
        '<th class="numeric">Cases</th>' +
        '<th class="numeric">Median<br>response</th>' +
        '<th class="numeric">First-yield<br>%</th>' +
        '<th class="numeric">Parts /<br>info holds</th>' +
        '<th class="numeric">Avg hold<br>duration</th>' +
        '<th class="numeric">Adjustment<br>cycles</th>' +
      '</tr></thead><tbody>';

  for (const r of rows) {
    html +=
      '<tr>' +
        '<td>' +
          '<div class="doctor-cell">' +
            '<span class="name">' + esc(r.doctor || '—') + '</span>' +
            (r.practice_name && r.practice_name !== r.doctor
              ? '<span class="practice">' + esc(r.practice_name) + '</span>' : '') +
            (r.strategic_partner
              ? '<span class="practice"><span class="partner-chip">' + esc(r.strategic_partner) + '</span></span>' : '') +
          '</div>' +
        '</td>' +
        '<td class="numeric"><strong>' + (r.total_cases || 0) + '</strong></td>' +
        '<td class="numeric">' + (
          r.median_response_hours == null
            ? '<span class="metric-empty">no replies</span>'
            : formatHours(r.median_response_hours) +
              '<div style="font-size:10px;color:var(--slate);">n=' + r.reply_sample_size + '</div>'
        ) + '</td>' +
        '<td class="numeric">' + yieldPill(r.first_yield_pct, r.design_approval_cases) + '</td>' +
        '<td class="numeric">' + (
          (Number(r.parts_info_total) || 0) === 0
            ? '<span class="metric-empty">0</span>'
            : '<strong>' + r.parts_info_total + '</strong>' +
              '<div style="font-size:10px;color:var(--slate);">' +
              (r.waiting_parts_count || 0) + ' parts · ' +
              (r.missing_info_count || 0) + ' info</div>'
        ) + '</td>' +
        '<td class="numeric duration-cell">' + (
          r.avg_parts_info_days == null
            ? '<span class="metric-empty">—</span>'
            : '<span class="dur-days">' + Number(r.avg_parts_info_days).toFixed(1) + ' days</span>' +
              '<div class="dur-sub">avg per hold</div>'
        ) + '</td>' +
        '<td class="numeric">' + (
          (Number(r.adjustment_cycles_total) || 0) === 0
            ? '<span class="metric-empty">0</span>'
            : '<strong>' + r.adjustment_cycles_total + '</strong>' +
              (r.avg_adjustment_cycles_per_case
                ? '<div style="font-size:10px;color:var(--slate);">' +
                  Number(r.avg_adjustment_cycles_per_case).toFixed(2) + ' per case</div>'
                : '')
        ) + '</td>' +
      '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function yieldPill(pct, sample) {
  if (pct == null || !sample) return '<span class="yield-pill muted">no data</span>';
  const cls = pct >= 85 ? 'good' : pct >= 65 ? 'okay' : 'bad';
  return '<span class="yield-pill ' + cls + '">' + Number(pct).toFixed(1) + '%</span>' +
         '<div style="font-size:10px;color:var(--slate);margin-top:2px;">n=' + sample + '</div>';
}

function formatHours(h) {
  if (h == null) return '—';
  const hours = Number(h);
  if (hours < 1)   return Math.round(hours * 60) + ' min';
  if (hours < 24)  return hours.toFixed(1) + ' hr';
  return (hours / 24).toFixed(1) + ' days';
}

// =====================================================================
// Call Notes — modal that lets a coordinator log a phone call, get an AI
// summary, and print a styled PDF (browser print → save as PDF).
// =====================================================================
function openCallNotes(prefillCaseNumber) {
  const modal = document.getElementById('call-notes-modal');
  if (!modal) return;
  document.getElementById('cn-case').value    = prefillCaseNumber || '';
  document.getElementById('cn-when').value    = new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
  document.getElementById('cn-with').value    = '';
  document.getElementById('cn-who').value     = loginIdentity().name || localStorage.getItem('skdla_reviewer') || '';
  document.getElementById('cn-notes').value   = '';
  document.getElementById('cn-summary').value = '';
  modal.classList.add('open');
  setTimeout(() => document.getElementById('cn-notes')?.focus(), 60);
}

function closeCallNotes() {
  document.getElementById('call-notes-modal')?.classList.remove('open');
}

async function generateCallSummary() {
  const notes = document.getElementById('cn-notes').value.trim();
  const hint  = document.getElementById('cn-summary-hint');
  const btn   = document.getElementById('cn-generate-btn');
  const summaryEl = document.getElementById('cn-summary');
  if (!notes) { toast('Type the call notes first', 'err'); return; }
  if (hint) hint.textContent = '(generating…)';
  if (btn)  btn.disabled = true;
  try {
    const prompt = `Summarize the following phone-call notes between a dental lab coordinator and a dentist's office in 2-3 sentences. Be specific about decisions made, action items, and any follow-ups required. Plain text, no bullet points, no markdown.

Notes:
"""
${notes}
"""

Summary:`;
    const out = await callAnthropic(prompt, 350);
    summaryEl.value = (out || '').trim();
    if (hint) hint.textContent = '(auto-generated; you can edit before printing)';
  } catch (e) {
    if (hint) hint.textContent = '(could not generate — type a summary by hand)';
  } finally {
    if (btn) btn.disabled = false;
  }
}

function printCallNotes() {
  const caseNum = document.getElementById('cn-case').value.trim();
  const when    = document.getElementById('cn-when').value.trim();
  const wth     = document.getElementById('cn-with').value.trim();
  const who     = document.getElementById('cn-who').value.trim();
  const notes   = document.getElementById('cn-notes').value.trim();
  const summary = document.getElementById('cn-summary').value.trim();
  if (!notes) { toast('Notes are empty — nothing to print', 'err'); return; }

  const target = document.getElementById('call-notes-print');
  target.innerHTML = `
    <div class="cnp-header">
      <div class="cnp-brand">Spectrum Killian<small>Design Approvals · Phone Call Record</small></div>
      <div class="cnp-date">${esc(when || new Date().toLocaleString())}</div>
    </div>
    <h2>Phone Call Notes${caseNum ? ' — Case ' + esc(caseNum) : ''}</h2>
    <div class="cnp-meta">
      ${caseNum ? '<div><strong>Case:</strong> ' + esc(caseNum) + '</div>' : ''}
      ${wth ? '<div><strong>Spoke with:</strong> ' + esc(wth) + '</div>' : ''}
      ${who ? '<div><strong>Coordinator:</strong> ' + esc(who) + '</div>' : ''}
      <div><strong>Date / Time:</strong> ${esc(when || new Date().toLocaleString())}</div>
    </div>
    ${summary ? `
      <div class="cnp-section-label">Summary</div>
      <div class="cnp-summary">${esc(summary)}</div>
    ` : ''}
    <div class="cnp-section-label">Full Notes</div>
    <div class="cnp-body">${esc(notes)}</div>
    <div class="cnp-footer">
      Spectrum Killian Dental Lab Alliance · Generated ${new Date().toLocaleString()}
    </div>
  `;
  setTimeout(() => window.print(), 80);
}

// main.js is a type="module" — top-level declarations are scoped to the module
// and not visible in the global window. Inline onclick="fn()" handlers need
// these functions on window, so we assign them explicitly here.
Object.assign(window, {
  // Tour
  startTour, endTour, tourNext, tourBack,
  // Navigation / UI
  toggleAppSwitcher, switchMode, loadAll,
  toggleSettings, openConfig, closeConfig, saveConfig,
  toggleDiag,
  // Global search
  onGlobalSearch, clearGlobalSearch,
  // Outbound filters & sort
  setOutboundSort,
  toggleFilterDd, setOutboundRevenue, closeFilterDd,
  togglePartnerDd, setOutboundPartner, closePartnerDd,
  // Inbound filters
  toggleInboundStatusDd, closeInboundStatusDd, toggleInboundCaseDd, closeInboundCaseDd,
  setInboundFilter, clearInboundSearch,
  // Hidden senders
  toggleHiddenSenders, addHiddenSender, removeHiddenSender, closeHiddenSenders,
  // Outbound actions
  toggleItem, approve, showEdit, hideEdit, resummarize, reject, saveEdit, saveExocadLink,
  // Inbound actions
  classifyReply, manuallyLinkReply, escalateForCall, markReplyNoCase,
  // Reschedule filters / actions
  toggleReschedFilterDd, closeReschedFilterDd, setReschedFilter, queueRescheduleCheck,
  // Audit / misc
  exportReschedule, setAuditWindow,
  // Outreach panels
  lookupCase, generateCaseSummary, printCaseLookup,
  onCaseLookupInput, pickCaseSuggestion,
  submitFeedback, submitRequest,
  // Case Coordination
  setCaseTab, submitLog, exportFPY, deleteLogEntry,
  setTrackerSubTab, addCaseToTracker,
  updateCaseInlineStage, updateCaseHoldDuration, deleteCaseFromTracker,
  renderDashboard, renderHistory, renderTracker, renderPrefsList,
  addCoordinator, removeCoord, selectPrefAcct, savePrefs, extractPrefsWithAI, bulkExtractPrefs,
  generatePrefSummaries,
  // Metrics modal
  openMetrics, closeMetrics, loadMetrics, renderMetricsTable,
  // Call Notes modal
  openCallNotes, closeCallNotes, generateCallSummary, printCallNotes,
  // Auth
  authSignOut,
});
