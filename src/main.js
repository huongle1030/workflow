// =====================================================================
// Configuration
// =====================================================================
const PROJECT_ID = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? '';
const MCP_SQL = 'mcp__8dd16a38-98a9-4842-82ed-37fbae8919ae__execute_sql';
const REVIEWER = import.meta.env.VITE_REVIEWER ?? 'coordinator@skdla';
const SUPABASE_DEFAULT_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const SUPABASE_DEFAULT_KEY = import.meta.env.VITE_SUPABASE_KEY ?? '';
const ANTHROPIC_DEFAULT_KEY = import.meta.env.VITE_ANTHROPIC_KEY ?? '';

const REASON_LABEL = {
  design_approval: 'Design Approval',
  design_modification: 'Design Modification',
  missing_info: 'Missing Info',
  waiting_on_parts: 'Waiting on Parts',
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
    if (inCowork) {
      const q = v => v ? "'" + String(v).replace(/'/g, "''") + "'" : 'NULL';
      await runMcpSql(
        "INSERT INTO coordinator_feedback (submitted_by, category, message, case_number) " +
        "VALUES (" + q(by) + ", " + q(category) + ", " + q(message) + ", " + q(caseNum) + ")"
      );
    } else {
      const cfg = getConfig();
      await fetch(cfg.url + '/rest/v1/coordinator_feedback', {
        method: 'POST',
        headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ submitted_by: by, category, message, case_number: caseNum }),
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
  reschedRows = await queryView('v_cases_needing_reschedule');
  document.getElementById('badge-resched').textContent = reschedRows.length;
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
  summary.innerHTML = '<strong>' + reschedRows.length + '</strong> cases ' +
    'won\'t make their due date even if approved right now. Push the due date out, or pull the doctor for an urgent approval.';

  const header = `
    <thead><tr>
      <th>Pan / Case</th><th>Doctor / Practice</th><th>Patient</th>
      <th>Original Due</th><th>Earliest Ship</th><th style="text-align:right;">Days Late</th>
    </tr></thead>`;

  const body = reschedRows.map(r => {
    const dueDate    = r.doctor_due_date ? new Date(r.doctor_due_date + 'T12:00:00').toLocaleDateString() : '-';
    const shipDate   = r.earliest_ship_date ? new Date(r.earliest_ship_date + 'T12:00:00').toLocaleDateString() : '-';
    const daysClass  = r.days_late >= 14 ? 'severe' : 'warning';
    return `
      <tr>
        <td>
          <div class="pan-cell">${esc(r.pan_number || '-')}</div>
          <div class="case-cell">Case ${esc(r.case_number)}</div>
        </td>
        <td>
          <div>${esc(r.dr_last_name || '-')}</div>
          <div style="font-size:11px;color:var(--slate);">${esc(r.practice_name || '')}</div>
        </td>
        <td>${esc(r.patient_name || '-')}</td>
        <td>${esc(dueDate)}</td>
        <td>${esc(shipDate)}</td>
        <td style="text-align:right;"><span class="days-cell ${daysClass}">${r.days_late}d</span></td>
      </tr>`;
  }).join('');

  list.innerHTML = '<table class="resched-table">' + header + '<tbody>' + body + '</tbody></table>';
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
  const currentOpt = OUTBOUND_FILTER_OPTIONS.find(o => o.value === current) || OUTBOUND_FILTER_OPTIONS[0];
  if (btnLabelEl) btnLabelEl.textContent = currentOpt.label;
  if (btnCountEl) {
    const c = counts[currentOpt.value] ?? 0;
    btnCountEl.textContent = c;
    btnCountEl.classList.toggle('zero', c === 0);
  }
  // Menu items
  const menuEl = document.getElementById('outbound-filter-menu');
  if (menuEl) {
    menuEl.innerHTML = OUTBOUND_FILTER_OPTIONS.map(o => {
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
    const revenueChip = revStr ? '<span class="revenue-chip ' + revClass + '">' + revStr + '</span>' : '';
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
          ${reasonChip}
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
        </div>
      </div>
      <div class="item-body">
        <div class="outbound-detail-row ${r.account_preferences ? '' : 'no-prefs'}">
          <div class="preview">
            <div class="preview-subject">${esc(r.subject)}</div>
            ${r.body_html || ''}
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
          <button class="act approve" onclick="approve('${r.attempt_id}')" ${hasExocadLink ? '' : 'disabled title="Add the exocad viewer link first"'}>Approve &amp; Send</button>
          <button class="act edit" onclick="showEdit('${r.attempt_id}')" ${hasExocadLink ? '' : 'disabled title="Add the exocad viewer link first"'}>Edit Then Send</button>
          <button class="act blue" onclick="resummarize('${r.attempt_id}', '${esc(r.case_number)}')">Auto Resummarize</button>
          <button class="act reject" onclick="reject('${r.attempt_id}')">Reject</button>
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
            <button type="button" onmousedown="event.preventDefault();const u=prompt('Link URL:');if(u)document.execCommand('createLink',false,u)">🔗 Link</button>
            <button type="button" onmousedown="event.preventDefault();document.execCommand('removeFormat')">Clear</button>
          </div>
          <div id="body-${r.attempt_id}" class="email-body-editor" contenteditable="true">${r.body_html || ''}</div>
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
  const cfg = getConfig();
  if (!cfg.anthropic) return; // No key, no backfill — fall back to raw text only.
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

// Filter state for Pending Replies (persists for the session)
const inboundFilter = { search: '', classification: '' };

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

// Inbound filter options shared by the custom dropdown
const INBOUND_FILTER_OPTIONS = [
  { value: '',                              label: 'All' },
  { value: 'approved',                      label: 'Approved' },
  { value: 'modification',                  label: 'Modification' },
  { value: 'approved_with_mods',            label: 'Approved + Mods' },
  { value: 'pricing_or_product_question',   label: 'Pricing / Product Q' },
  { value: 'other',                         label: 'Other' },
  { value: 'unclear',                       label: 'Unclear' },
];

function setInboundFilter(key, value) {
  inboundFilter[key] = value;
  if (key === 'classification') {
    const dd = document.getElementById('inbound-filter-dd');
    if (dd) dd.classList.toggle('has-value', !!value);
    closeInboundFilterDd();
  }
  if (key === 'search') {
    const clearBtn = document.getElementById('inbound-search-clear');
    if (clearBtn) clearBtn.style.display = value ? 'inline-flex' : 'none';
  }
  renderInbound();
}

function toggleInboundFilterDd(ev) {
  if (ev) ev.stopPropagation();
  document.getElementById('inbound-filter-dd')?.classList.toggle('open');
}
function closeInboundFilterDd() {
  document.getElementById('inbound-filter-dd')?.classList.remove('open');
}

function clearInboundSearch() {
  const input = document.getElementById('inbound-search');
  if (input) input.value = '';
  setInboundFilter('search', '');
}

function filteredInbound() {
  const q = (inboundFilter.search || '').trim().toLowerCase();
  const cls = inboundFilter.classification;
  return (state.inbound || []).filter(r => {
    if (isSenderHidden(r.from_email)) return false;
    if (cls && (r.ai_classification || 'unclear') !== cls) return false;
    if (!q) return true;
    const hay = [
      r.case_number, r.from_email, r.practice_name, r.subject,
      r.body_text, r.ai_summary, r.ai_classification, r.patient_name,
    ].map(v => (v || '').toString().toLowerCase()).join('');
    return hay.includes(q);
  });
}

function updateInboundChipCounts() {
  const rows = state.inbound || [];
  // Bucket each row by its classification (treat missing as 'unclear')
  const counts = { '': rows.length };
  for (const r of rows) {
    const k = r.ai_classification || 'unclear';
    counts[k] = (counts[k] || 0) + 1;
  }

  const current = inboundFilter.classification || '';
  const labelEl    = document.getElementById('inbound-filter-label');
  const btnCountEl = document.getElementById('inbound-filter-count');
  const menuEl     = document.getElementById('inbound-filter-menu');
  if (!labelEl || !btnCountEl || !menuEl) return;

  const currentOpt = INBOUND_FILTER_OPTIONS.find(o => o.value === current) || INBOUND_FILTER_OPTIONS[0];
  labelEl.textContent = currentOpt.label;
  const btnCount = counts[currentOpt.value] ?? 0;
  btnCountEl.textContent = btnCount;
  btnCountEl.classList.toggle('zero', btnCount === 0);

  menuEl.innerHTML = INBOUND_FILTER_OPTIONS.map(o => {
    const c = counts[o.value] ?? 0;
    const sel = o.value === current ? ' selected' : '';
    const zero = c === 0 ? ' zero' : '';
    return `<div class="custom-dd-option${sel}" role="option" data-value="${esc(o.value)}" onclick="setInboundFilter('classification', '${o.value}')">
      <span>${esc(o.label)}</span>
      <span class="chip-count${zero}">${c}</span>
    </div>`;
  }).join('');
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
    const filterActive = !!(inboundFilter.search || inboundFilter.classification);
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
    return `
    <div class="item reason-${r.reason || 'design_approval'} ${isUnmatched ? 'unmatched' : ''}" data-id="${r.reply_id}">
      <div class="item-head" onclick="toggleItem('${r.reply_id}')">
        <div>
          ${matchChip}
          <span class="ai-chip ${r.ai_classification}">${esc(r.ai_classification || 'unclear')}</span>
          ${lowConfChip}
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
              <button class="reply-thread-toggle" onclick="this.nextElementSibling.classList.toggle('shown'); this.textContent = this.nextElementSibling.classList.contains('shown') ? '▾ Hide quoted email' : '▸ Show quoted email';">▸ Show quoted email</button>
              <div class="reply-thread">${esc(split.quote)}</div>
            ` : ''}
          `;
        })()}
        ${isUnmatched ? `
          <div class="link-gate">
            <div class="link-gate-title">⚠ No case linked to this reply yet</div>
            <div class="link-gate-sub">Our matcher couldn't link this email to a case automatically. If you know which case it's about, paste the case number below to link it; otherwise the classify buttons stay disabled.</div>
            <div class="link-gate-row">
              <input type="text" id="link-input-${r.reply_id}" placeholder="2026-XXXXX" autocomplete="off" />
              <button class="act approve" onclick="manuallyLinkReply('${r.reply_id}', document.getElementById('link-input-${r.reply_id}').value)">Link to case</button>
            </div>
          </div>
        ` : ''}
        <div class="actions" style="margin-top:14px;">
          <button class="act approve" onclick="classifyReply('${r.reply_id}', 'approved')" ${isUnmatched ? 'disabled title="Link this reply to a case first"' : ''}>Approved</button>
          <button class="act blue" onclick="classifyReply('${r.reply_id}', 'approved_with_mods')" ${isUnmatched ? 'disabled title="Link this reply to a case first"' : ''}>Approved + Mods</button>
          <button class="act edit" onclick="classifyReply('${r.reply_id}', 'modification')" ${isUnmatched ? 'disabled title="Link this reply to a case first"' : ''}>Modification</button>
          <button class="act" style="background: var(--gold);" onclick="classifyReply('${r.reply_id}', 'pricing_or_product_question')" ${isUnmatched ? 'disabled title="Link this reply to a case first"' : ''}>Pricing / Product Q</button>
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
    await callRpc('approve_attempt', { p_attempt_id: id, p_reviewer: REVIEWER, p_note: null });
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
    await callRpc('reject_attempt', { p_attempt_id: id, p_reviewer: REVIEWER, p_note: note || null });
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
      p_attempt_id: id, p_reviewer: REVIEWER,
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

// =====================================================================
// AI Re-summarize ·call Anthropic from the browser, refresh email
// =====================================================================
function stripDashes(s) { return (s || '').replace(/–/g, '-').replace(/—/g, '-'); }

async function callAnthropic(prompt, maxTokens) {
  const cfg = getConfig();
  if (!cfg.anthropic) {
    toast('Auto Resummarize is not configured. Open Config to add credentials.', 'err');
    openConfig();
    throw new Error('Credentials not configured');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': cfg.anthropic,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens || 1000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Service ' + res.status + ': ' + t.slice(0, 200));
  }
  const j = await res.json();
  return j.content?.[0]?.text || '';
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
  const inboundDd = document.getElementById('inbound-filter-dd');
  if (inboundDd && !inboundDd.contains(e.target)) inboundDd.classList.remove('open');
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
    document.getElementById('panel-outbound').classList.remove('hidden');
    document.querySelector('#tabs-outreach .tab[data-tab="outbound"]').classList.add('active');
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
  if (kpiStrip)  kpiStrip.style.display  = (mode === 'outreach') ? '' : 'none';
  if (searchRow) searchRow.style.display = (mode === 'outreach') ? '' : 'none';
  if (mode === 'outreach' && typeof updateGlobalSearchScope === 'function') updateGlobalSearchScope();
}

// =====================================================================
// Tab switching
// =====================================================================
document.querySelectorAll('#tabs-outreach .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#tabs-outreach .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    OUTREACH_PANELS.forEach(p => {
      document.getElementById('panel-' + p).classList.toggle('hidden', p !== which);
    });
    // Re-render the Ready tab on open so the "In queue?" column reflects
    // any drafts the cron has composed since the last refresh.
    if (which === 'ready') renderReady();
    if (which === 'editlog') loadEditLog();
    if (which === 'feedback') loadFeedback();
    if (typeof updateGlobalSearchScope === 'function') updateGlobalSearchScope();
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
  const who     = document.getElementById('req-who').value.trim();
  const priority = document.querySelector('input[name="req-priority"]:checked').value;
  const resultEl = document.getElementById('req-result');
  const btn = document.getElementById('req-submit');

  if (!caseNum || !summary || !who) {
    resultEl.innerHTML = '<div class="empty" style="padding:14px;color:var(--red);"><strong>Case number, issue summary, and your name are required.</strong></div>';
    return;
  }
  if (reason !== 'design_approval' && !details) {
    resultEl.innerHTML = '<div class="empty" style="padding:14px;color:var(--red);"><strong>Details are required for ' + reason + ' requests.</strong></div>';
    return;
  }

  btn.disabled = true;
  resultEl.innerHTML = '<div class="loading">Submitting request and composing draft…</div>';

  try {
    await callRpc('submit_outreach_request', {
      p_case_number: caseNum,
      p_reason: reason,
      p_requested_by: who,
      p_issue_summary: summary,
      p_details: details || null,
      p_priority: priority
    });
    resultEl.innerHTML =
      '<div style="background:var(--green-soft);border:1px solid var(--green);color:var(--green);' +
      'padding:14px 18px;border-radius:6px;">' +
      '<strong>Request submitted.</strong> The bot has drafted the email. ' +
      'Check the <strong>Pending Outbound</strong> tab ·a coordinator will review and approve before sending.' +
      '</div>';
    // Reset form fields (keep "Your Name" for the next request)
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
async function lookupCase() {
  const cn = document.getElementById('lookup-input').value.trim();
  if (!cn) { toast('Enter a case number', 'err'); return; }
  document.getElementById('lookup-result').innerHTML = '<div class="loading">Loading timeline…</div>';

  let rows;
  if (inCowork) {
    rows = await runMcpSql(
      "SELECT event_id, case_number, event_time, event_type, status, direction, " +
      "attempt_number, counterparty, subject, body, reason, actor, sub_status, note " +
      "FROM v_case_comms_timeline WHERE case_number = '" + cn.replace(/'/g, "''") + "' " +
      "ORDER BY event_time DESC LIMIT 200"
    );
  } else {
    rows = await restGet('/rest/v1/v_case_comms_timeline?case_number=eq.' +
      encodeURIComponent(cn) + '&order=event_time.desc&limit=200');
  }

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

  const header = `
    <div class="lookup-header">
      <div><div class="label">Case</div><div class="value">${esc(cn)}</div></div>
      <div><div class="label">Outbound</div><div class="value">${counts.outbound || 0}</div></div>
      <div><div class="label">Inbound</div><div class="value">${counts.inbound || 0}</div></div>
      <div><div class="label">First / Last</div><div class="value" style="font-size:11px;">${firstSeen ? firstSeen.toLocaleDateString() : '–'} → ${lastSeen ? lastSeen.toLocaleDateString() : '–'}</div></div>
    </div>`;

  const events = rows.map(r => {
    const t = r.event_time ? new Date(r.event_time) : null;
    const timeStr = t ? t.toLocaleDateString() + ' ' + t.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) : '';
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
    logs   = await runMcpSql('SELECT * FROM "CaseLog"     ORDER BY created_date DESC NULLS LAST LIMIT 1000');
    coords = await runMcpSql('SELECT * FROM "Coordinator" ORDER BY name LIMIT 200');
    prefs  = await runMcpSql('SELECT * FROM v_account_preferences ORDER BY practice_name LIMIT 2000');
  } else {
    cases  = await restGet('/rest/v1/Case?select=*&order=updated_date.desc.nullslast&limit=500');
    logs   = await restGet('/rest/v1/CaseLog?select=*&order=created_date.desc.nullslast&limit=1000');
    coords = await restGet('/rest/v1/Coordinator?select=*&order=name&limit=200');
    prefs  = await restGet('/rest/v1/v_account_preferences?select=*&order=practice_name&limit=2000');
  }
  ccData.cases = cases || [];
  ccData.logs  = logs  || [];
  ccData.coordinators = coords || [];
  ccData.preferences = prefs || [];
  ccLoaded = true;
  document.getElementById('badge-prefs').textContent = ccData.preferences.length;
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

  document.getElementById('badge-history').textContent = ccData.logs.length;
  document.getElementById('badge-tracker').textContent = ccData.cases.length;
  document.getElementById('badge-coords').textContent  = ccData.coordinators.length;
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

  const todayLogs = filtered.filter(l => l.log_date === today ||
    (l.created_date && l.created_date.startsWith(today)));

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

function renderLogTable(logs) {
  if (!logs.length) return '<div class="empty">No log entries.</div>';
  return '<table class="cc-table"><thead><tr><th>Case ID</th><th>Action</th><th>Coordinator</th><th>Date</th><th>Notes</th><th></th></tr></thead><tbody>' +
    logs.map(l => {
      const d = l.log_date || (l.created_date || '').split('T')[0] || '';
      const dateNice = d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }) : '';
      const slug = (l.action_type || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const delBtn = l.id != null
        ? '<button class="cc-trash-btn" title="Delete log entry" onclick="deleteLogEntry(\'' + esc(String(l.id)) + '\', \'' + esc(l.case_id || '') + '\')">' + TRASH_ICON + '</button>'
        : '';
      return '<tr><td class="case-id-cell">' + esc(l.case_id || '') + '</td>' +
        '<td><span class="cc-action-badge ' + slug + '">' + esc(l.action_type || '') + '</span></td>' +
        '<td>' + esc(l.coordinator || '-') + '</td>' +
        '<td class="muted">' + esc(dateNice) + '</td>' +
        '<td class="muted">' + (esc((l.notes||'').slice(0,80)) || '-') + '</td>' +
        '<td style="text-align:right; width:40px;">' + delBtn + '</td></tr>';
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

function patientInitials(name) {
  if (!name) return '';
  return name.trim().split(/\s+/).map(p => p[0]).join('').toUpperCase().slice(0, 3);
}

// Render a single case as a card row with inline stage/hold dropdowns + delete.
function renderCaseCard(c, allStages) {
  const initials = patientInitials(c.patient_name);
  const wfSlug = (c.workflow_type || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const holdBadge = c.hold_duration
    ? '<span class="hold-badge">' + esc(c.hold_duration) + '</span>'
    : '';
  const wfBadge = c.workflow_type
    ? '<span class="wf-badge ' + wfSlug + '">' + esc(c.workflow_type) + '</span>'
    : '';
  const dateNice = c.stage_updated_date
    ? new Date(c.stage_updated_date + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' })
    : '';
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
        (initials ? '<span class="sep">·</span><span class="pname">' + esc(initials) + '</span>' : '') +
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

function renderTracker() {
  if (!ccLoaded) return;
  const wfEl = document.getElementById('track-workflow');
  const stEl = document.getElementById('track-stage');
  const wf = wfEl ? wfEl.value : 'all';
  const st = stEl ? stEl.value : 'all';
  const filtered = ccData.cases.filter(c => {
    if (wf !== 'all' && c.workflow_type !== wf) return false;
    if (st !== 'all' && c.current_stage !== st) return false;
    return true;
  });
  const countEl = document.getElementById('track-count');
  if (countEl) countEl.textContent = filtered.length + ' case' + (filtered.length === 1 ? '' : 's');

  const list = document.getElementById('cc-tracker-list');
  if (list) {
    list.innerHTML = filtered.length
      ? renderCaseCardList(filtered.slice(0, 200))
      : '<div class="empty">No cases match filters.</div>';
  }

  // Live tracker section under New Log form (unfiltered, most-recent first)
  const newlog = document.getElementById('cc-newlog-tracker');
  if (newlog) {
    newlog.innerHTML = renderCaseCardList(ccData.cases.slice(0, 50));
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
  const row = {
    id: genId(),
    case_id: caseId, action_type: action,
    coordinator: coord || null, log_date: dt || pacificDate(),
    notes: notes || null,
  };
  try {
    if (inCowork) {
      await runMcpSql("INSERT INTO \"CaseLog\" (id, case_id, action_type, coordinator, log_date, notes, created_date) VALUES (" +
        "'" + row.id + "', " +
        "'" + caseId.replace(/'/g,"''") + "', " +
        "'" + action.replace(/'/g,"''") + "', " +
        (coord ? "'" + coord.replace(/'/g,"''") + "'" : 'NULL') + ", " +
        (dt    ? "'" + dt + "'" : 'NULL') + ", " +
        (notes ? "'" + notes.replace(/'/g,"''") + "'" : 'NULL') + ", now())");
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
  try {
    if (inCowork) {
      await runMcpSql("INSERT INTO \"Coordinator\" (name, created_date) VALUES ('" + nm.replace(/'/g,"''") + "', now())");
    } else {
      const cfg = getConfig();
      await fetch(cfg.url + '/rest/v1/Coordinator', {
        method: 'POST',
        headers: { apikey: cfg.key, Authorization: 'Bearer '+cfg.key, 'Content-Type':'application/json' },
        body: JSON.stringify([{ name: nm }]),
      });
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
        '<button onclick="extractPrefsWithAI(\'' + esc(p.account_number) + '\')" class="cc-btn-primary" style="margin-top:0;background:#9A7B2E;">✨ Auto-extract</button>' +
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
  if (!cfg.anthropic) { toast('Auto-extract is not configured. Open Config to add credentials.', 'err'); openConfig(); return; }
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
  if (!cfg.anthropic) {
    if (opts.silent) return;
    toast('Summary generator is not configured. Open Config to add credentials.', 'err');
    return;
  }
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
  const cfg = getConfig();
  if (!cfg.anthropic) { toast('Auto-extract is not configured. Open Config to add credentials.', 'err'); openConfig(); return; }
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
    selector: '#panel-outbound .item:first-child .case-id-block', placement: 'right' },
  { title: "Status chips", body: "Colored chips flag the reason for sending, a recent doctor reply, recent case activity, or due date risk.",
    selector: '#panel-outbound .item:first-child .item-head', placement: 'bottom' },
  { title: "Expand a row", body: "Click any row to open the full email and the preferences panel. Click the first row now to keep going.",
    selector: '#panel-outbound .item:first-child .item-head', placement: 'bottom', requireClick: true },
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
  else if (e.key === 'ArrowRight' || e.key === 'Enter') {
    // Only allow keyboard next if not click-required
    const step = TOUR_STEPS[tourStep];
    if (!step.requireClick) tourNext();
  }
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
  document.getElementById('tour-step-meta').textContent = 'Step ' + (tourStep + 1) + ' of ' + TOUR_STEPS.length;
  document.getElementById('tour-title').textContent = step.title;
  document.getElementById('tour-body').innerHTML = step.body;
  document.getElementById('tour-back').style.visibility = tourStep === 0 ? 'hidden' : 'visible';

  const nextBtn = document.getElementById('tour-next');
  if (step.requireClick && step.selector) {
    nextBtn.textContent = '👆 Click highlighted';
    nextBtn.disabled = true;
    nextBtn.style.opacity = '0.45';
    nextBtn.style.cursor = 'not-allowed';
    attachClickRequirement(step.selector);
  } else {
    nextBtn.textContent = tourStep === TOUR_STEPS.length - 1 ? 'Finish' : 'Next ›';
    nextBtn.disabled = false;
    nextBtn.style.opacity = '';
    nextBtn.style.cursor = '';
  }

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
  if (!el) { sp.style.display = 'none'; tt.classList.add('center'); return; }
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
(function boot() {
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

  // First-time visitors get the tour automatically (after the panels settle)
  if (!localStorage.getItem('skdla_tour_complete')) {
    setTimeout(() => { if (!tourActive) startTour(); }, 600);
  }
})();

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
  toggleInboundFilterDd, setInboundFilter, closeInboundFilterDd, clearInboundSearch,
  // Hidden senders
  toggleHiddenSenders, addHiddenSender, removeHiddenSender, closeHiddenSenders,
  // Outbound actions
  toggleItem, approve, showEdit, hideEdit, resummarize, reject, saveEdit, saveExocadLink,
  // Inbound actions
  classifyReply, manuallyLinkReply,
  // Audit / misc
  exportReschedule, setAuditWindow,
  // Outreach panels
  lookupCase, submitFeedback, submitRequest,
  // Case Coordination
  setCaseTab, submitLog, exportFPY, deleteLogEntry,
  setTrackerSubTab, addCaseToTracker,
  updateCaseInlineStage, updateCaseHoldDuration, deleteCaseFromTracker,
  renderDashboard, renderHistory, renderTracker, renderPrefsList,
  addCoordinator, removeCoord, selectPrefAcct, savePrefs, extractPrefsWithAI, bulkExtractPrefs,
  generatePrefSummaries,
});
