// Nest data layer — reads the read-only `v_nest_worklist` view via the suite's
// publishable-key REST path (mirrors src/caseflow/data.js + src/qc/data.js).
// Read-only: the Nest boards never write case data.
//
// The view (supabase/migrations/20260607_08_v_nest_worklist.sql) already does the
// mill/print classification, rush/hot/hold flags and priority_rank, so this layer
// only normalizes column names to camelCase for the renderer.
import { getCurrentEmployee } from '../auth.js';

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
  if (ct.includes('application/json')) { return resp.json(); }
  return null;
}

// Map a v_nest_worklist row to the in-memory tile model.
function rowToCase(r) {
  return {
    caseNumber:      r.case_number || '',
    panNumber:       r.pan_number,                 // free text; '0'/''/null => "Pan unassigned" in the UI
    dueDate:         r.doctor_due_date_only || (r.doctor_due_date ? String(r.doctor_due_date).slice(0, 10) : null),
    businessUnit:    r.business_unit || '',
    currentStep:     r.current_step || '',
    product:         r.primary_product || '',
    material:        r.finishing_material || '',   // for the Material filter + modal
    method:          r.method === 'print' ? 'print' : 'mill',
    methodUncertain: !!r.method_uncertain,         // drives the red asterisk
    isRush:          !!r.is_rush,
    isHot:           !!r.is_hot,
    isOnHold:        !!r.is_on_hold,
    holdDays:        Number(r.hold_days) || 0,
    holdReason:      r.hold_reason || '',
    priorityRank:    r.priority_rank == null ? 2 : Number(r.priority_rank),
    // case-detail fields (click-through modal)
    receivedDate:    r.received_date || null,
    daysInLab:       r.days_in_lab == null ? null : Number(r.days_in_lab),
    invoiceTotal:    r.invoice_total == null ? null : Number(r.invoice_total),
    lastTech:        r.last_tech || null,
    lastTechStep:    r.last_tech_step || null,
    lastTechAt:      r.last_tech_at || null,
  };
}

// Load the whole nest worklist (mill + print). The view is already scoped to the
// nesting queue (WIP/Hold at a Nest step), so this is a small result set.
export async function loadNest() {
  const rows = await rest('/rest/v1/v_nest_worklist?select=*', { headers: headers() });
  return (rows || []).map(rowToCase);
}
