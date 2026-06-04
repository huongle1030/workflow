// CaseFlow data layer — persists the prototype's in-memory case model to the
// Supabase `caseflow_*` tables + the `caseflow-files` Storage bucket, using the
// same publishable-key REST path as the rest of this app (src/main.js restGet).
//
// Attribution is client-stamped (matches the rest of this app — the data path
// sends the publishable key, not the user JWT; see the project's auth notes).
import { getCurrentEmployee } from '../auth.js';

const BUCKET = 'caseflow-files';

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

async function rest(path, opts) {
  const c = cfg();
  if (!c.key) throw new Error('Supabase is not configured (set the publishable key in Settings).');
  const resp = await fetch(c.url + path, opts);
  if (!resp.ok) { const t = await resp.text(); throw new Error('HTTP ' + resp.status + ': ' + t); }
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) { const d = await resp.json(); return d; }
  return null;
}

// ── row <-> in-memory case mapping (single-table: events + files are JSONB) ──
function rowToCase(row) {
  const f = row.files || {};
  return {
    uuid: row.id,
    id: row.case_id,
    patient: row.patient || '—',
    doctor: row.doctor || '—',
    caseNum: row.case_num || '',
    rush: !!row.rush,
    shipDate: row.ship_date || '',
    drDueDate: row.dr_due_date || '',
    stage: row.stage,
    deHold: row.de_hold || null,
    notes: row.notes || '',
    designNotes: row.design_notes || '',
    designReqs: row.design_reqs || [],
    reqsAck: !!row.reqs_ack,
    reqsAckBy: row.reqs_ack_by || null,
    reqsAckAt: row.reqs_ack_at || null,
    aox: row.aox || {},
    aoxReview: row.aox_review || {},   // includes aspFiles (review drag-drop metadata)
    dclType: row.dcl_type || null,
    dclData: row.dcl || {},
    checklistDone: row.checklist_done || [],
    coordReason: row.coord_reason || '',
    outsourceNotes: row.outsource_notes || '',
    qcNotes: row.qc_notes || '',
    updated: fmtUpdated(row.updated_at),
    timeline: row.events || [],
    files: f.entry || [], reviewFiles: f.review || [], scanFiles: f.scan || [], designFile: f.design || null,
  };
}
function caseToRow(c) {
  return {
    patient: c.patient, doctor: c.doctor, case_num: c.caseNum || null,
    rush: !!c.rush, ship_date: c.shipDate || null, dr_due_date: c.drDueDate || null,
    stage: c.stage, de_hold: c.deHold || null, notes: c.notes || null,
    design_notes: c.designNotes || null, design_reqs: c.designReqs || [],
    reqs_ack: !!c.reqsAck, reqs_ack_by: c.reqsAckBy || null, reqs_ack_at: c.reqsAckAt || null,
    aox: c.aox || {}, aox_review: c.aoxReview || {},
    dcl_type: c.dclType || null, dcl: c.dclData || {}, checklist_done: c.checklistDone || [],
    coord_reason: c.coordReason || null,
    outsource_notes: c.outsourceNotes || null, qc_notes: c.qcNotes || null,
    events: c.timeline || [],
    files: { entry: c.files || [], review: c.reviewFiles || [], scan: c.scanFiles || [], design: c.designFile || null },
    updated_at: new Date().toISOString(),
  };
}
function fmtUpdated(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
}

// ── reads ───────────────────────────────────────────────────────────
export async function loadAll() {
  const rows = await rest('/rest/v1/caseflow_cases?select=*&order=updated_at.desc.nullslast&limit=1000', { headers: headers() });
  return (rows || []).map(rowToCase);
}

// ── writes ──────────────────────────────────────────────────────────
export function nextCaseId(existing) {
  let max = 0;
  (existing || []).forEach(c => { const m = /^CF-0*(\d+)$/.exec(c.id || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); });
  return 'CF-' + String(max + 1).padStart(3, '0');
}

export async function insertCase(fields) {
  const body = Object.assign({}, fields, { updated_at: new Date().toISOString() });
  const rows = await rest('/rest/v1/caseflow_cases', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  return rowToCase(Array.isArray(rows) ? rows[0] : rows);
}

export async function saveCase(c) {
  if (!c || !c.uuid) return;
  await rest('/rest/v1/caseflow_cases?id=eq.' + c.uuid, {
    method: 'PATCH',
    headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(caseToRow(c)),
  });
}

// Upload bytes to Storage and return the metadata. The caller pushes this into
// the case's in-memory file arrays and persists via saveCase() (single-table).
export async function uploadFile(c, kind, file, section) {
  const safe = (file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = 'cases/' + c.id + '/' + kind + '/' + Date.now() + '_' + safe;
  await rest('/storage/v1/object/' + BUCKET + '/' + path, {
    method: 'POST',
    headers: headers({ 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' }),
    body: file,
  });
  return { name: file.name, size: fmtSize(file.size), path, by: currentUser() };
}

export function fmtSize(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return Math.round(b / 1024) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
