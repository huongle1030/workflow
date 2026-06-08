// Design-department worklist data layer — reads the read-only `v_design_worklist`
// view via the suite's publishable-key REST path (mirrors src/nest/data.js).
// Read-only board: cases whose current step is in Department 1 = 'Design'.
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

function rowToCase(r) {
  return {
    caseNumber:       r.case_number || '',
    panNumber:        r.pan_number,
    dueDate:          r.doctor_due_date_only || (r.doctor_due_date ? String(r.doctor_due_date).slice(0, 10) : null),
    receivedDate:     r.received_date || null,
    businessUnit:     r.business_unit || '',
    currentStep:      r.current_step || '',
    stepConsolidated: r.step_consolidated || '',
    productLine:      r.product_line || '',
    product:          r.primary_product || '',
    material:         r.finishing_material || '',
    caseStatus:       r.case_status || '',
    isRush:           !!r.is_rush,
    isHot:            !!r.is_hot,
    isOnHold:         !!r.is_on_hold,
    holdDays:         Number(r.hold_days) || 0,
    holdReason:       r.hold_reason || '',
    priorityRank:     r.priority_rank == null ? 2 : Number(r.priority_rank),
    daysInLab:        r.days_in_lab == null ? null : Number(r.days_in_lab),
    invoiceTotal:     r.invoice_total == null ? null : Number(r.invoice_total),
    lastTech:         r.last_tech || null,
    lastTechStep:     r.last_tech_step || null,
    lastTechAt:       r.last_tech_at || null,
  };
}

export async function loadDesign() {
  const rows = await rest('/rest/v1/v_design_worklist?select=*', { headers: headers() });
  return (rows || []).map(rowToCase);
}
