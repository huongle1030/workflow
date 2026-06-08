// Quality Control data layer — writes the SAME Supabase tables the qc-app uses
// (`qc_logs`, `staged_cases`) via the suite's publishable-key REST path (mirrors
// src/caseflow/data.js). The notify-expert-staged edge function is called with
// the anon JWT (see EDGE_ANON_KEY note in constants.js).
//
// RLS is OFF on both tables with public insert/read grants, so the publishable
// key can read/write them. Attribution is client-stamped (the data path sends
// the publishable key, not the user JWT).
import { getCurrentEmployee } from '../auth.js';
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

// Insert an Internal Remake submission into the existing public.mrb_cases table
// (the MRB review workflow). Stores EVERY submission (needs_expert true and
// false). Maps the form onto mrb_cases columns and seeds the MRB workflow
// defaults (source='internal', status='Open', disposition='Pending', opened_date
// = today); the MRB reviewer fills severity/fault/root_cause/etc. later.
function todayDate() {
  const d = new Date();
  const p = n => ('0' + n).slice(-2);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
export async function createMrbEntry(f) {
  const body = {
    case_number: f.case_number,
    source: 'internal',
    team: f.department,
    defect_description: f.description,
    logged_by: f.logged_by,
    // Internal Remake additions: technician who worked on the product, the step the issue occurred
    // on, and the case facts auto-populated from qc_case_lookup.
    technician: f.technician || null,
    issue_step: f.issue_step || null,
    ship_date: f.ship_date,
    dr_due_date: f.dr_due_date,
    received_date: f.received_date || null,
    start_date: f.start_date || null,
    time_in_lab_days: (f.time_in_lab_days ?? null),
    total_invoice: (f.total_invoice ?? null),
    needs_expert: f.needs_expert,
    status: 'Open',
    disposition: 'Pending',
    opened_date: todayDate(),
  };
  await rest('/rest/v1/mrb_cases', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify([body]),
  });
}

// One-call case lookup for the Internal Remake form (auto-populate + the step dropdown).
// Returns the qc_case_lookup JSON ({ found, ship_date, dr_due_date, received_date, start_date,
// time_in_lab_days, total_invoice, steps:[...] }) or { found:false } when the case isn't on file.
export async function lookupCaseForRemake(caseNumber) {
  const res = await rest('/rest/v1/rpc/qc_case_lookup', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ p_case_number: caseNumber }),
  });
  return res || { found: false };
}

// Latest internal-remake rows for the dashboard. Reads mrb_cases (source=internal)
// for now — internal_remake_log is the eventual read source but isn't synced yet.
export async function listMrb(limit = 100) {
  const rows = await rest('/rest/v1/mrb_cases?select=*&source=eq.internal&order=created_date.desc.nullslast&limit=' + limit, { headers: headers() });
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
