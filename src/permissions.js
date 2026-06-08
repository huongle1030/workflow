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
  ACCOUNT_MANAGER:   'account_manager',
  // Technical Advisor: full Design Approvals access + all 4 CaseFlow modes.
  // (Absorbs the retired `edward_ta` "CaseFlow Tech Advisor" role.)
  TECHNICAL_ADVISOR: 'technical_advisor',
  MANAGER:           'manager',
  EXECUTIVE:         'executive',
  ADMIN:             'admin',
  // Entry roles: Design Approvals access + a hand-picked subset of CaseFlow.
  //   DATA_ENTRY   absorbs the retired `case_entry` role (Design Approvals +
  //                Data Entry CaseFlow tab only).
  //   CASE_REVIEW  = DATA_ENTRY + Case Review + Scanning CaseFlow tabs.
  DATA_ENTRY:        'data_entry',
  CASE_REVIEW:       'case_review',
  // CaseFlow production-only roles (no Design Approvals / Case Coordination).
  DESIGNER:          'designer',
  SCANNING:          'scanning',
  // QC mode-only role. Sees ONLY the Quality Control mode's "Log QC Reject" tab —
  // no outreach, no case coordination, no other CaseFlow modes, no Internal Remake.
  QC_TECH:           'qc_tech',
  // Department Lead — QC mode-only role that sees ONLY the "Internal Remake" tab.
  DEPT_LEAD:         'dept_lead',
  // Case Lookup-only role. Holds NO capabilities, so every gated mode is hidden;
  // the only mode it can reach is the ungated Case Lookup (see ROLE_CAPABILITIES).
  NINJA:             'ninja',
};


// Human-readable labels for every role (including admin-assigned ones).
export const ROLE_LABELS = {
  [ROLES.DESIGN_APPROVER]:   'Design Approver',
  [ROLES.ACCOUNT_MANAGER]:   'Account Manager',
  [ROLES.TECHNICAL_ADVISOR]: 'Technical Advisor',
  [ROLES.MANAGER]:           'Manager',
  [ROLES.EXECUTIVE]:         'Executive',
  [ROLES.ADMIN]:             'Admin',
  [ROLES.DATA_ENTRY]:        'Data Entry',
  [ROLES.CASE_REVIEW]:       'Case Review',
  [ROLES.DESIGNER]:          'Designer',
  [ROLES.SCANNING]:          'Scanning',
  [ROLES.QC_TECH]:           'QC Tech',
  [ROLES.DEPT_LEAD]:         'Department Lead',
  [ROLES.NINJA]:             'Ninja',
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
  // NOTE: Case Lookup is no longer an outreach tab — it is its own top-level mode
  // (brand-switcher app `lookup`) available to EVERY role. It is intentionally
  // ungated: it has no capability here and no MODE_CAP entry in main.js, so
  // isModePermitted('lookup') is always true. See switchMode/MODE_ORDER.
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
  // Quality Control mode (Log QC Reject + Internal Remake). Gated to qc_tech,
  // dept_lead, plus the full-access roles (via ALL_CAPS).
  CASEFLOW_QC:      'caseflow.qc',
  // The two Quality Control sub-tabs, gated independently:
  //   QC_REJECT -> "Log QC Reject" tab  (qc_tech + full-access)
  //   QC_REMAKE -> "Internal Remake" tab (dept_lead + full-access)
  CASEFLOW_QC_REJECT: 'caseflow.qc.reject',
  CASEFLOW_QC_REMAKE: 'caseflow.qc.remake',
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

const DESIGN_APPROVER_CAPS = [
  C.MODE_OUTREACH,  // can open the Design Approvals app...
  C.MODE_CC,        // ...and the Case Coordination app.
  C.TAB_SUBMIT,
  C.TAB_OUTBOUND,   // can open Pending Outbound...
  C.TAB_INBOUND,
  C.TAB_READY,
  C.TAB_RESCHEDULE,
  // NOT outbound.revenue, audit, editlog, or metrics.
  // NOT any CaseFlow mode: Data Entry, Case Review, Scanning, Design Team, and
  // Quality Control are all hidden from design_approver (outreach + CC only).
];

// Shared Design Approvals (outreach) access for the entry roles
// (Data Entry / Case Review). Mirrors the access the retired `case_entry`
// role had — no outbound, inbound, audit, editlog, metrics.
const ENTRY_DA_CAPS = [
  C.MODE_OUTREACH,
  C.MODE_CC,
  C.TAB_SUBMIT,
  C.TAB_READY,
  C.TAB_RESCHEDULE,
];

// Data Entry = Design Approvals access + Data Entry CaseFlow tab only.
const DATA_ENTRY_CAPS  = [...ENTRY_DA_CAPS, C.CASEFLOW_ENTRY];
// Case Review = everything Data Entry has + Case Review + Scanning CaseFlow tabs.
const CASE_REVIEW_CAPS = [...DATA_ENTRY_CAPS, C.CASEFLOW_REVIEW, C.CASEFLOW_SCAN];

// CaseFlow production-only roles — each sees ONLY the CaseFlow mode(s) listed.
// None get MODE_OUTREACH or MODE_CC, so the Design Approvals and Case
// Coordination apps are hidden from the brand switcher and unreachable.
const DESIGNER_CAPS    = [C.CASEFLOW_DESIGN, C.CASEFLOW_SCAN];
const SCANNING_CAPS    = [C.CASEFLOW_SCAN];
// QC Tech sees ONLY the Quality Control mode's "Log QC Reject" tab. dept_lead sees ONLY the
// "Internal Remake" tab. The full-access roles get CASEFLOW_QC + both sub-caps automatically via
// ALL_CAPS (Object.values(CAPABILITIES)), so they keep seeing both tabs.
const QC_TECH_CAPS     = [C.CASEFLOW_QC, C.CASEFLOW_QC_REJECT];
const DEPT_LEAD_CAPS   = [C.CASEFLOW_QC, C.CASEFLOW_QC_REMAKE];
// Ninja sees ONLY Case Lookup. Lookup is ungated (no cap / no MODE_CAP entry), so
// an empty cap set hides every other mode while firstPermittedMode() falls through
// to 'lookup'. Do NOT add caps here or other modes will become visible.
const NINJA_CAPS       = [];

// Full capability set — account_manager and above see the whole app, EXCEPT
// restricted capabilities (granted explicitly per role below).
const ALL_CAPS = Object.values(CAPABILITIES).filter(c => !RESTRICTED_CAPS.includes(c));

// ---- Role -> capability set (encodes both matrices) ----
export const ROLE_CAPABILITIES = {
  [ROLES.DESIGN_APPROVER]: new Set(DESIGN_APPROVER_CAPS),
  [ROLES.ACCOUNT_MANAGER]: new Set(ALL_CAPS),
  // Technical Advisor mirrors Account Manager exactly (full access set, which
  // already includes all 4 CaseFlow modes). Absorbs the retired edward_ta role.
  [ROLES.TECHNICAL_ADVISOR]: new Set(ALL_CAPS),
  // Manager additionally can hide/unhide senders.
  [ROLES.MANAGER]:         new Set([...ALL_CAPS, C.HIDE_SENDER]),
  // Executive additionally sees the AI case-number suggestion and can hide senders.
  [ROLES.EXECUTIVE]:       new Set([...ALL_CAPS, C.VIEW_CASE_SUGGESTION, C.HIDE_SENDER]),
  [ROLES.ADMIN]:           new Set(ALL_CAPS), // admin also short-circuits in can()
  // Entry roles: Design Approvals access + a CaseFlow subset.
  [ROLES.DATA_ENTRY]:      new Set(DATA_ENTRY_CAPS),
  [ROLES.CASE_REVIEW]:     new Set(CASE_REVIEW_CAPS),
  // CaseFlow production-only roles (no outreach / case coordination).
  [ROLES.DESIGNER]:        new Set(DESIGNER_CAPS),
  [ROLES.SCANNING]:        new Set(SCANNING_CAPS),
  [ROLES.QC_TECH]:         new Set(QC_TECH_CAPS),
  [ROLES.DEPT_LEAD]:       new Set(DEPT_LEAD_CAPS),
  // Case Lookup-only role — empty cap set; only the ungated Case Lookup is reachable.
  [ROLES.NINJA]:           new Set(NINJA_CAPS),
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
