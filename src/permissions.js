// Central role-based access control for the Design Approvals (outreach) app.
//
// This is the SINGLE source of truth for "which role can see what". The UI
// gating in main.js and (eventually) the SQL `has_cap()` function must encode
// the same matrix — keep them in lockstep so the UI never shows a control the
// database blocks (or vice-versa).
//
// Scope: this module gates ONLY the Design Approvals (outreach) tabs and the
// Pending-Outbound revenue features. The Case Coordination mode (#tabs-cc) and
// the Feedback tab are intentionally NOT gated — all approved users keep them.
//
// Pure module: no DOM access. Unit-testable by importing and asserting `can()`.
import { getCurrentEmployee } from './auth.js';

// ---- Roles (DB employees.role value) ----
export const ROLES = {
  DESIGN_APPROVER: 'design_approver',
  CASE_ENTRY:      'case_entry',
  ACCOUNT_MANAGER: 'account_manager',
  MANAGER:         'manager',
  EXECUTIVE:       'executive',
  ADMIN:           'admin',
};

// Human-readable labels for every role (including admin-assigned ones).
export const ROLE_LABELS = {
  [ROLES.DESIGN_APPROVER]: 'Design Approver',
  [ROLES.CASE_ENTRY]:      'Case Entry/Review',
  [ROLES.ACCOUNT_MANAGER]: 'Account Manager',
  [ROLES.MANAGER]:         'Manager',
  [ROLES.EXECUTIVE]:       'Executive',
  [ROLES.ADMIN]:           'Admin',
};

// ---- Capability keys ----
// tab.*  -> a tab in #tabs-outreach (data-tab value in parentheses)
// metrics -> KPI strip (#kpi-strip) + the appbar "Metrics" button
// outbound.revenue -> revenue chip/sort/filter inside Pending Outbound
export const CAPABILITIES = {
  TAB_SUBMIT:       'tab.submit',      // Submit Request   (data-tab="submit")
  TAB_OUTBOUND:     'tab.outbound',    // Pending Outbound (data-tab="outbound")
  TAB_INBOUND:      'tab.inbound',     // Pending Replies  (data-tab="inbound")
  TAB_READY:        'tab.ready',       // Ready for Approval (data-tab="ready")
  TAB_RESCHEDULE:   'tab.reschedule',  // Reschedule       (data-tab="reschedule")
  TAB_LOOKUP:       'tab.lookup',      // Case Lookup      (data-tab="lookup")
  TAB_AUDIT:        'tab.audit',       // Audit            (data-tab="audit")
  TAB_EDITLOG:      'tab.editlog',     // Edit Log         (data-tab="editlog")
  METRICS:          'metrics',         // KPI strip + Metrics modal button
  OUTBOUND_REVENUE: 'outbound.revenue',// Revenue chip/sort/filter in Outbound
};

const C = CAPABILITIES;

// Capabilities granted to the two non-privileged limited roles.
// account_manager / manager / executive / admin get everything (see below).
const DESIGN_APPROVER_CAPS = [
  C.TAB_SUBMIT,
  C.TAB_OUTBOUND,   // can open Pending Outbound...
  C.TAB_INBOUND,
  C.TAB_READY,
  C.TAB_RESCHEDULE,
  C.TAB_LOOKUP,
  // ...but NOT outbound.revenue, audit, editlog, or metrics.
];

const CASE_ENTRY_CAPS = [
  C.TAB_SUBMIT,
  C.TAB_READY,
  C.TAB_RESCHEDULE,
  C.TAB_LOOKUP,
  // No outbound, inbound, audit, editlog, metrics.
];

// Full capability set — account_manager and above see the whole app.
const ALL_CAPS = Object.values(CAPABILITIES);

// ---- Role -> capability set (encodes both matrices) ----
export const ROLE_CAPABILITIES = {
  [ROLES.DESIGN_APPROVER]: new Set(DESIGN_APPROVER_CAPS),
  [ROLES.CASE_ENTRY]:      new Set(CASE_ENTRY_CAPS),
  [ROLES.ACCOUNT_MANAGER]: new Set(ALL_CAPS),
  [ROLES.MANAGER]:         new Set(ALL_CAPS),
  [ROLES.EXECUTIVE]:       new Set(ALL_CAPS),
  [ROLES.ADMIN]:           new Set(ALL_CAPS), // admin also short-circuits in can()
};

// Returns the current signed-in employee's role string, or null if unknown.
export function getCurrentRole() {
  const emp = getCurrentEmployee();
  return emp && emp.role ? emp.role : null;
}

// Capability check for the current user.
// - admin short-circuits to true.
// - unknown / unapproved role -> false (deny by default).
export function can(capability) {
  const role = getCurrentRole();
  if (!role) return false;
  if (role === ROLES.ADMIN) return true;
  const caps = ROLE_CAPABILITIES[role];
  return !!(caps && caps.has(capability));
}

// Convenience: check a capability for an explicit role (used in tests / SQL parity).
export function roleCan(role, capability) {
  if (role === ROLES.ADMIN) return true;
  const caps = ROLE_CAPABILITIES[role];
  return !!(caps && caps.has(capability));
}
