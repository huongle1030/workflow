// Quality Control data layer — writes the SAME Supabase tables the qc-app uses
// (`qc_logs`, `staged_cases`) via the suite's publishable-key REST path (mirrors
// src/caseflow/data.js). The notify-expert-staged edge function is called with
// the anon JWT (see EDGE_ANON_KEY note in constants.js).
//
// RLS is OFF on both tables with public insert/read grants, so the publishable
// key can read/write them. Attribution is client-stamped (the data path sends
// the publishable key, not the user JWT).
import { getCurrentEmployee } from '../auth.js';
import { supabase } from '../supabase.js';
import { EDGE_ANON_KEY } from './constants.js';

function cfg() {
  return {
    url: localStorage.getItem('skdla_sb_url') || import.meta.env.VITE_SUPABASE_URL || '',
    key: localStorage.getItem('skdla_sb_key') || import.meta.env.VITE_SUPABASE_KEY || '',
  };
}
function headers(extra) {
  const k = cfg().key;
  return Object.assign({ apikey: k, Authorization: 'Bearer ' + k, Accept: 'application/json' }, extra || {});
}

export function currentUser() {
  const e = getCurrentEmployee() || {};
  return e.name || e.email || 'Unknown';
}
export function currentUserId() {
  const e = getCurrentEmployee() || {};
  return e.id || null;
}

async function rest(path, opts) {
  const c = cfg();
  if (!c.key) throw new Error('Supabase is not configured (set the publishable key in Settings).');
  const resp = await fetch(c.url + path, opts);
  if (!resp.ok) { const t = await resp.text(); throw new Error('HTTP ' + resp.status + ': ' + t); }
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) { return resp.json(); }
  return null;
}

// ── reads ───────────────────────────────────────────────────────────
// Latest QC reject logs for the recent-rejects table.
export async function listQcLogs(limit = 100) {
  const rows = await rest('/rest/v1/qc_logs?select=*&order=time_stamp.desc.nullslast&limit=' + limit, { headers: headers() });
  return rows || [];
}

// ── writes ──────────────────────────────────────────────────────────
// Insert a QC reject. `fields` mirrors the qc-app form's 8 columns; we add the
// created_by / created_by_id attribution columns (already present on qc_logs).
export async function createQcLog(fields) {
  const body = Object.assign({
    created_by: currentUser(),
    created_by_id: currentUserId(),
  }, fields);
  const rows = await rest('/rest/v1/qc_logs', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

// Insert a staged_cases row (Stage for Expert Review). Mirrors the qc-app insert;
// staged_by is stamped with the current user (the source left it null).
export async function createStagedCase(fields) {
  const body = Object.assign({
    status: 'Pending',
    staged_by: currentUser(),
    staged_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, fields);
  await rest('/rest/v1/staged_cases', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify([body]),
  });
}

// Insert an Internal Remake submission into public.internal_remake_log — the SAME
// table and columns the qc-app writes (see qc-app_AOX QCLogPage.jsx:345-355).
// Stores EVERY submission (needs_expert true and false). The expert path ALSO
// stages the case (createStagedCase) so it appears in the MRB Awaiting Claim queue.
export async function createInternalRemakeLog(f) {
  const now = new Date().toISOString();
  const body = {
    case_number: f.case_number,
    department: f.department || '',
    logged_by: f.logged_by || null,
    ship_date: f.ship_date || null,
    dr_due_date: f.dr_due_date || null,
    description: f.description || null,
    needs_expert: f.needs_expert,
    time_stamp: now,
    created_date: now,
  };
  await rest('/rest/v1/internal_remake_log', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify([body]),
  });
}

// Case lookup for the Internal Remake form — the case facts the Teams card needs
// plus the de-duplicated production steps for the "reroute back to" dropdown.
// Mirrors qc-app's three reads (Cases + wip_cases + case_steps_dept_aox) via the
// supabase client (it handles the quoted, space-named master-table columns). The
// suite's anon JWT is the same key the qc-app uses, so these reads are permitted.
export async function lookupCaseForRemake(caseNumber) {
  const cn = (caseNumber || '').trim();
  const [caseRes, wfRes] = await Promise.all([
    supabase.from('Cases')
      .select('"Case Number","Business Unit","Primary Product","Doctor Due Date","Ship Date","Received Date","Hold Flag","Hold Reason"')
      .eq('Case Number', cn).maybeSingle(),
    supabase.from('wip_cases')
      .select('current_step_name, current_step_business_unit')
      .eq('case_number', cn).maybeSingle(),
  ]);
  if (!caseRes.data) return { found: false };
  const c = caseRes.data;
  const wf = wfRes.data || {};
  const { data: steps } = await supabase
    .from('case_steps_dept_aox')
    .select('step_consolidated, start_date, status')
    .eq('case_number', cn)
    .order('start_date', { ascending: true });
  const seen = new Set();
  const stepList = (steps || []).filter(s => {
    if (!s.step_consolidated || seen.has(s.step_consolidated)) return false;
    seen.add(s.step_consolidated); return true;
  }).map(s => s.step_consolidated);
  const slice10 = v => (v ? String(v).slice(0, 10) : null);
  return {
    found: true,
    case_number: c['Case Number'],
    product: c['Primary Product'] || null,
    bu: c['Business Unit'] || null,
    department: wf.current_step_business_unit || null,
    current_step: wf.current_step_name || null,
    dr_due_date: slice10(c['Doctor Due Date']),
    ship_date: slice10(c['Ship Date']),
    steps: stepList,
  };
}

// Latest internal-remake rows for the dashboard. Reads internal_remake_log (the
// table createInternalRemakeLog writes), newest first.
export async function listInternalRemakes(limit = 100) {
  const rows = await rest('/rest/v1/internal_remake_log?select=*&order=created_date.desc.nullslast&limit=' + limit, { headers: headers() });
  return rows || [];
}

// Best-effort expert email via the existing edge function. Never throws — a
// rejected key or network error must not block the QC log / staging path
// (matches the qc-app's `.catch(() => {})`).
export function notifyExpertStaged(body) {
  const c = cfg();
  return fetch(c.url + '/functions/v1/notify-expert-staged', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: EDGE_ANON_KEY },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// Best-effort Teams MessageCard via the notify-teams edge function — sent on EVERY
// Internal Remake submission (expert and self-reroute), matching qc-app's
// sendTeamsNotification (QCLogPage.jsx:239-280). Never throws.
export function notifyTeams(data) {
  const c = cfg();
  const payload = {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: data.needsExpert ? '534AB7' : '10B981',
    summary: 'Internal Remake — ' + data.case_number,
    sections: [{
      activityTitle: '🔄 Internal Remake — ' + data.case_number,
      activitySubtitle: data.needsExpert
        ? '🔴 Expert Assistance Required — case staged for review'
        : '🟢 Self Rerouted by ' + (data.logged_by || 'lead') + ' → ' + (data.reroute_step || '—'),
      facts: [
        { name: 'Case #',        value: data.case_number },
        { name: 'Product',       value: data.product || '—' },
        { name: 'Business Unit', value: data.bu || '—' },
        { name: 'Department',    value: data.department || '—' },
        { name: 'Current Step',  value: data.current_step || '—' },
        { name: 'Doctor Due',    value: data.dr_due_date || '—' },
        { name: 'Ship Date',     value: data.ship_date || '—' },
        { name: 'Logged By',     value: data.logged_by || '—' },
        { name: 'Description',   value: data.description || '—' },
        ...(data.needsExpert
          ? [{ name: 'Action', value: 'Jeannette, Ryan & Deepak have been notified' }]
          : [{ name: 'Reroute To', value: data.reroute_step || '—' }]),
      ],
      markdown: true,
    }],
  };
  return fetch(c.url + '/functions/v1/notify-teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: EDGE_ANON_KEY, Authorization: 'Bearer ' + EDGE_ANON_KEY },
    body: JSON.stringify(payload),
  }).catch(() => {});
}
