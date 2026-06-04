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
  DESIGN_APPROVER:   'design_approver',
  CASE_ENTRY:        'case_entry',
  ACCOUNT_MANAGER:   'account_manager',
  TECHNICAL_ADVISOR: 'technical_advisor',
  MANAGER:           'manager',
  EXECUTIVE:         'executive',
  ADMIN:             'admin',
  // CaseFlow production-only roles. These see ONLY their CaseFlow mode(s) — no
  // Design Approvals (outreach) and no Case Coordination access.
  DATA_ENTRY:        'data_entry',
  CASE_REVIEW:       'case_review',
  DESIGNER:          'designer',
  SCANNING:          'scanning',
  EDWARD_TA:         'edward_ta',
  // QC mode-only role. Sees ONLY the Quality Control mode — no outreach, no
  // case coordination, no other CaseFlow modes.
  QC_TECH:           'qc_tech',
};

// Human-readable labels for every role (including admin-assigned ones).
export const ROLE_LABELS = {
  [ROLES.DESIGN_APPROVER]:   'Design Approver',
  [ROLES.CASE_ENTRY]:        'Case Entry/Review',
  [ROLES.ACCOUNT_MANAGER]:   'Account Manager',
  [ROLES.TECHNICAL_ADVISOR]: 'Technical Advisor',
  [ROLES.MANAGER]:           'Manager',
  [ROLES.EXECUTIVE]:         'Executive',
  [ROLES.ADMIN]:             'Admin',
  [ROLES.DATA_ENTRY]:        'Data Entry',
  [ROLES.CASE_REVIEW]:       'Case Review',
  [ROLES.DESIGNER]:          'Designer',
  [ROLES.SCANNING]:          'Scanning',
  // edward_ta is admin-assigned (a named individual); shown as this label.
  [ROLES.EDWARD_TA]:         'CaseFlow Tech Advisor',
  [ROLES.QC_TECH]:           'QC Tech',
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
  VIEW_CASE_SUGGESTION: 'inbound.case_suggestion', // AI case-# chip/buttons on unmatched Pending Replies (admin + executive)
  HIDE_SENDER:          'inbound.hide_sender',     // Add/remove hidden senders (admin + executive + manager). Viewing the list is NOT gated.
  // Mode (app-switcher) access. These gate WHOLE apps in the brand switcher:
  //   MODE_OUTREACH -> the Design Approvals (outreach) app + all its tabs.
  //   MODE_CC       -> the Case Coordination app (#tabs-cc).
  // The four CaseFlow modes below are gated by their own caseflow.* caps.
  MODE_OUTREACH:    'mode.outreach',
  MODE_CC:          'mode.cc',
  // CaseFlow production modes (Data Entry / Case Review / Scanning / Design Team).
  // Each mode is gated by its cap (mode-switcher item + switchMode guard).
  CASEFLOW_ENTRY:   'caseflow.entry',
  CASEFLOW_REVIEW:  'caseflow.review',
  CASEFLOW_SCAN:    'caseflow.scan',
  CASEFLOW_DESIGN:  'caseflow.design',
  // Quality Control mode (Log QC Reject + Internal Remake). Gated to qc_tech
  // plus the full-access roles (via ALL_CAPS).
  CASEFLOW_QC:      'caseflow.qc',
};

const C = CAPABILITIES;

// Restricted capabilities: deliberately EXCLUDED from the blanket ALL_CAPS so the
// broad full-access roles (account_manager/manager) don't pick them up via
// Object.values(CAPABILITIES). They are granted explicitly per role below.
//   VIEW_CASE_SUGGESTION -> admin (via can() short-circuit) + executive (explicit).
//   HIDE_SENDER          -> admin (via can() short-circuit) + executive + manager (explicit).
const RESTRICTED_CAPS = [
  C.VIEW_CASE_SUGGESTION,
  C.HIDE_SENDER,
];

// All four CaseFlow mode caps. Granted in full to the outreach roles
// (design_approver/case_entry) and to account_manager+ via ALL_CAPS; the
// CaseFlow production-only roles below get a hand-picked subset instead.
const CASEFLOW_CAPS = [C.CASEFLOW_ENTRY, C.CASEFLOW_REVIEW, C.CASEFLOW_SCAN, C.CASEFLOW_DESIGN];

const DESIGN_APPROVER_CAPS = [
  C.MODE_OUTREACH,  // can open the Design Approvals app...
  C.MODE_CC,        // ...and the Case Coordination app.
  C.TAB_SUBMIT,
  C.TAB_OUTBOUND,   // can open Pending Outbound...
  C.TAB_INBOUND,
  C.TAB_READY,
  C.TAB_RESCHEDULE,
  C.TAB_LOOKUP,
  ...CASEFLOW_CAPS,
  // ...but NOT outbound.revenue, audit, editlog, or metrics.
];

const CASE_ENTRY_CAPS = [
  C.MODE_OUTREACH,
  C.MODE_CC,
  C.TAB_SUBMIT,
  C.TAB_READY,
  C.TAB_RESCHEDULE,
  C.TAB_LOOKUP,
  ...CASEFLOW_CAPS,
  // No outbound, inbound, audit, editlog, metrics.
];

// CaseFlow production-only roles — each sees ONLY the CaseFlow mode(s) listed.
// None get MODE_OUTREACH or MODE_CC, so the Design Approvals and Case
// Coordination apps are hidden from the brand switcher and unreachable.
const DATA_ENTRY_CAPS  = [C.CASEFLOW_ENTRY];
const CASE_REVIEW_CAPS = [C.CASEFLOW_REVIEW, C.CASEFLOW_ENTRY, C.CASEFLOW_SCAN];
const DESIGNER_CAPS    = [C.CASEFLOW_DESIGN, C.CASEFLOW_SCAN];
const SCANNING_CAPS    = [C.CASEFLOW_SCAN];
const EDWARD_TA_CAPS   = [...CASEFLOW_CAPS]; // all 4 CaseFlow modes
// QC Tech sees ONLY the Quality Control mode. The full-access roles also get
// CASEFLOW_QC automatically via ALL_CAPS (Object.values(CAPABILITIES)).
const QC_TECH_CAPS     = [C.CASEFLOW_QC];

// Full capability set — account_manager and above see the whole app, EXCEPT
// restricted capabilities (granted explicitly per role below).
const ALL_CAPS = Object.values(CAPABILITIES).filter(c => !RESTRICTED_CAPS.includes(c));

// ---- Role -> capability set (encodes both matrices) ----
export const ROLE_CAPABILITIES = {
  [ROLES.DESIGN_APPROVER]: new Set(DESIGN_APPROVER_CAPS),
  [ROLES.CASE_ENTRY]:      new Set(CASE_ENTRY_CAPS),
  [ROLES.ACCOUNT_MANAGER]: new Set(ALL_CAPS),
  // Technical Advisor mirrors Account Manager exactly (same full access set).
  [ROLES.TECHNICAL_ADVISOR]: new Set(ALL_CAPS),
  // Manager additionally can hide/unhide senders.
  [ROLES.MANAGER]:         new Set([...ALL_CAPS, C.HIDE_SENDER]),
  // Executive additionally sees the AI case-number suggestion and can hide senders.
  [ROLES.EXECUTIVE]:       new Set([...ALL_CAPS, C.VIEW_CASE_SUGGESTION, C.HIDE_SENDER]),
  [ROLES.ADMIN]:           new Set(ALL_CAPS), // admin also short-circuits in can()
  // CaseFlow production-only roles (no outreach / case coordination).
  [ROLES.DATA_ENTRY]:      new Set(DATA_ENTRY_CAPS),
  [ROLES.CASE_REVIEW]:     new Set(CASE_REVIEW_CAPS),
  [ROLES.DESIGNER]:        new Set(DESIGNER_CAPS),
  [ROLES.SCANNING]:        new Set(SCANNING_CAPS),
  [ROLES.EDWARD_TA]:       new Set(EDWARD_TA_CAPS),
  [ROLES.QC_TECH]:         new Set(QC_TECH_CAPS),
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
