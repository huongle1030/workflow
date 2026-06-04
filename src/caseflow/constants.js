// CaseFlow constants — ported verbatim from caseflow_portal_v37.html (the
// single source of truth). Option arrays, checklist items, badge/stage maps.
// DCL_SCHEMAS lives in ./schemas.js; the blank-PDF templates in ./pdfTemplate.js.

export const DESIGN_CL = ['All patient assets received and verified', 'Spec guidelines reviewed and noted', 'Dimensions and format confirmed', 'Content proofread for errors', 'Special instructions flagged for outsourcer'];

// Stage -> badge css class
export const SC = { 'Data Entry': 'badge-entry', 'Review': 'badge-review', 'Scanning': 'badge-scanning', 'Design Check': 'badge-design', 'Outsourcing': 'badge-outsource', 'QC': 'badge-qc', 'Complete': 'badge-complete', 'QC Failed - Rework': 'badge-rework', 'QC Failed - Resend': 'badge-rework', 'Case Coordination': 'badge-coord' };

export const CAT_NAMES = { CC: 'Clear Choice', ASP: 'Aspen', SKD: 'SKDLA ACNT', ENG: 'Engle Aesthetics', TRI: 'TRI' };

// Pass/Fail items (Case Review)
export const BASIC_INFO_ITEMS = ['Account and Patient Info', 'Case Type', 'Doctor Notes accounted for'];
export const PRODUCT_ITEMS = ['Delivery Due Date', 'Product Selection', 'Production Recipe', 'Production Steps align with case needs'];
export const SCAN_ITEMS = ['Scan Quality', 'Scans/Additional files dragged and attached in box below'];
export const DESIGN_NEEDS_OPTS = ['New', 'Continuation', 'Remake', 'Copy Mill* (do not set new teeth)'];
export const ASP_DESIGN_REQ = ['Copy Mill', 'Design Changes Needed (set new teeth)', 'Reset teeth to Mould'];
export const ASP_SPEC_ITEMS = [['davinci', 'DaVinci / Endura Elite'], ['designApproval', 'Design Approval Required'], ['mgrApproval', 'In-House Manager Approval Required'], ['ccDigital', 'Clear Choice Digital: Exact / iCAM direct to MUA'], ['lfx', 'LFX'], ['stlOnly', 'STL Only — Dr to Print']];
export const ASP_LFX_SCANS = ['360 Denture Scan', 'Zest Locator Scan Body Scan', 'Opposing Scan', 'Bite Scan', 'Photos'];
export const ASP_NONLFX_SCANS = ['Preop Scans (U/L)', 'Opposing', 'Bite Scan', 'Photos'];
export const ASP_TIBASE_OPTS = ['Open Implants', 'DESS', 'DESS ASC', 'Other'];
export const ASP_SCANBODY_OPTS = ['ELOS', 'DESS iOS', 'Straumann SRA', 'Other'];
export const ASP_SCREW_OPTS = ['OI Nobel', 'OI Straumann', 'OI Neodent (ClearChoice Bars)', 'DESS ASC (for Ti base)', 'DESS 19.069 (Aspen Bars, Direct to MUA / digital / ASC, non-ClearChoice)', 'DESS 19.006 (for Ti base)', 'Badger (ClearChoice digital, Exact & iCAM including Bars)', 'Neodent DirectFit Screws (ClearChoice digital, Exact & iCAM including bars)'];
export const TRI_SCAN_SECTIONS = ['Preop U/L', 'Opposing', 'Bite Scans', 'Photos'];

export const OPTS = {
  CC_NEW: ['DAVINCI Finish *Endura Elite*', 'ClearChoice ICAM fee ADD on (ICAM cases only)', 'Zirconia *Endura* (12 days) — Oss Final Zirconia + Clear Choice Stage 2 + Aesthetic charge', 'Temporary Try In (PMMA) (12 working days) — One Suite Smile PMMA + One Suite Smile Stage 4', 'STL FILE (6 working days) — Oss Final Zirconia + Clear Choice Stage 1'],
  CC_CONT: ['Zirconia *continuation from models* (12 working days)', 'Zirconia *continuation from STL design only*', 'Temporary Try In (PMMA) (12 working days)'],
  RCP_DIG_YES: ['ICAM / Exact (NO JIG)', 'EXACT Workflow (JIG Used)'],
  RCP_NO_NEW: ['Zirconia — Scans & Models ONLY', 'Zirconia — Scans/Models AND PMMA', 'PMMA — Analog milled (no mounting)', 'PMMA — Analog milled (needs mounting)', 'Full Digital (Exact Workflow)', 'STL File — Digital', 'STL File — Analog'],
  RCP_NO_CONT: ['PMMA Adjustments (needs mounting)', 'PMMA Adjustments (no mounting)'],
  ASP_ZP_TYPE: ['New Case (add *One Suite Smile PMMA* code for charge)', 'Continuation'],
  ASP_ZP_FINAL: ['Zirconia (10/12 days) — Stage 4', 'PMMA (10/12 days) — Stage 4', 'Verification Jig + Custom Tray (7 days) — Stage 1', 'Bite Rim (7 days) — Stage 2', 'Wax Teeth Setup (7 days) — Stage 3'],
  ASP_LFX_TYPE: ['New LFX Case', 'LFX Cont.'],
  ASP_LFX_FINAL: ['LFX Try In (7/6 days)', 'LFX Final (8/6 days)'],
  ASP_RCP_ZIRC: ['PMMA Adjustments (needs mounting)', 'PMMA Adjustments (no mounting)'],
  ASP_RCP_PMMA_TYPE: ['Analog Milled', 'Verification Jig'],
  ASP_RCP_VJ: ['Analog (Impressions received)', 'Digital (Scans only received)'],
  ASP_RCP_LFX: ['Digital (Scans only)', 'Analog (Models and Try In)', 'Design Only — Send STL'],
  SKD_TYPE: ['New Case', 'Continuation'],
  SKD_FINAL: ['Verification Jig + Custom Tray (7 days)', 'Bite Rim (7 days)', 'Wax Teeth Setup (7 days)', 'PMMA (10 days)', 'Zirconia (10 days)', 'Straight to Mill — FMR Zirconia Final (8 days)'],
  SKD_RCP_ZIRC: ['PMMA Adjustments (needs mounting)', 'PMMA Adjustments (no mounting)'],
  SKD_RCP_VJ: ['Analog (Impressions received)', 'Digital (Scans only received)'],
  ENG_FINAL: ['PMMA — One Suite Smile PMMA + Stage 4', 'Zirconia — One Suite Smile Zirconia Final', 'Surgical Guides + Add Ons (if requested)', 'Surgical Guide Singles — CT Scan — Toothborn Single Site + Sleeves'],
  ENG_SURGICAL: ['Stackable — Stackable Surgical Guides (Engel)', 'PMMA Add On — Stackable Printed Provisional (Engel)', 'Denture Add On — Printed Full Denture — AOX Add On'],
  TRI_IMPLANT_OPTS: ['Send STL — Full Service Full Arch Lab 1 + TRI Stage 1 (6 days)', 'PMMA — Full Service Full Arch Lab 1 + TRI Stage 2 (10/12 days)', 'Zirconia Esthetic — Full Service Full Arch Lab 1 + TRI Stage 3 (10/12 days)', 'Zirconia High Esthetic — Full Service Full Arch HIGH Lab 1 + TRI Stage 3 (10/12 days)'],
  TRI_NON_IMPLANT_OPTS: ['Send STL — Full Service Full Arch Lab 1-NON TRI + TRI Stage 1 (6 days)', 'PMMA — Full Service Full Arch Lab 1-NON TRI + TRI Stage 2 (10/12 days)', 'Zirconia Esthetic — Full Service Full Arch Lab 1-NON TRI + TRI Stage 3 (10/12 days)', 'Zirconia High Esthetic — Full Service Full Arch HIGH Lab 1-NON TRI + TRI Stage 3 (10/12 days)'],
  TRI_CONT_OPTS: ['Send STL — TRI Stage 1 (6 days)', 'PMMA — TRI Stage 2 (10/12 days)', 'Zirconia — TRI Stage 3 (10/12 days)'],
  TRI_PRE_TRI_OPTS: ['Pre-Design Full Service Full Arch (8 days)', 'Pre-Design Full Service Full Arch (8 days)', 'Mill and Sinter Only Full Arch (6 days)'],
  TRI_PRE_NONTRI_OPTS: ['Pre-Design Full Service Full Arch Lab 1-Non TRI (8 days)', 'Pre-Design Full Service Full Arch-Non TRI (8 days)'],
  TRI_SINGLE_OPTS: ['Full Service Single Unit (7 days) — Include Analog Code (P45/P37)', 'Mill and Sinter Single Unit (5 days) — Do NOT Include Analog Code'],
  TRI_RCP_ARCH: ['TRI — No Approval', 'TRI — Design Approval'],
  ADDON: ['Printed Full Denture — AOX add on', 'Nightguard — Comfort (hard/soft)']
};

// AOX option-row field mapping + cascade resets (Data Entry checklist)
export const FIELD_MAP = { ccType: 'ccType', CC_NEW: 'ccOption', CC_CONT: 'ccOption', rcpDigital: 'rcpDigital', RCP_DIG_YES: 'rcpOption', RCP_NO_NEW: 'rcpOption', RCP_NO_CONT: 'rcpOption', aspSub: 'aspSub', ASP_ZP_TYPE: 'aspType', ASP_LFX_TYPE: 'aspType', ASP_ZP_FINAL: 'aspFinal', ASP_LFX_FINAL: 'aspFinal', aspRcpMat: 'aspRcpMat', ASP_RCP_ZIRC: 'aspRcpZirc', aspRcpPmmaType: 'aspRcpPmmaType', ASP_RCP_VJ: 'aspRcpVJ', ASP_RCP_LFX: 'aspRcpLfx', skdType: 'skdType', SKD_FINAL: 'skdFinal', skdRcpMat: 'skdRcpMat', SKD_RCP_ZIRC: 'skdRcpZirc', SKD_RCP_VJ: 'skdRcpVJ', ENG_FINAL: 'engFinal', ENG_SURGICAL: 'engSurgicalAddon', triBar: 'triBar', triArch: 'triArch', triFaType: 'triFaType', triImpType: 'triImpType', TRI_IMPLANT_OPTS: 'triImpOpt', TRI_NON_IMPLANT_OPTS: 'triImpOpt', TRI_CONT_OPTS: 'triContOpt', triPreSub: 'triPreSub', TRI_PRE_TRI_OPTS: 'triPreOpt', TRI_PRE_NONTRI_OPTS: 'triPreOpt', TRI_SINGLE_OPTS: 'triSingleOpt', triRcpArch: 'triRcpArch', TRI_RCP_ARCH: 'triRcpFaOpt', ADDON: 'addonSel' };
export const TRI_ALL = ['triBar', 'triArch', 'triFaType', 'triImpType', 'triImpOpt', 'triContOpt', 'triPreSub', 'triPreOpt', 'triSingleOpt', 'triRcpArch', 'triRcpFaOpt'];
export const RESET_MAP = { ccType: ['ccOption', 'rcpDigital', 'rcpOption'], ccOption: [], rcpDigital: ['rcpOption'], rcpOption: [], aspSub: ['aspType', 'aspFinal', 'aspRcpMat', 'aspRcpZirc', 'aspRcpPmmaType', 'aspRcpVJ', 'aspRcpLfx'], aspType: ['aspFinal', 'aspRcpMat', 'aspRcpZirc', 'aspRcpPmmaType', 'aspRcpVJ', 'aspRcpLfx'], aspFinal: [], aspRcpMat: ['aspRcpZirc', 'aspRcpPmmaType', 'aspRcpVJ'], aspRcpZirc: [], aspRcpPmmaType: ['aspRcpVJ'], aspRcpVJ: [], aspRcpLfx: [], skdType: ['skdFinal', 'skdRcpMat', 'skdRcpZirc', 'skdRcpVJ'], skdFinal: ['skdRcpMat', 'skdRcpZirc', 'skdRcpVJ'], skdRcpMat: ['skdRcpZirc', 'skdRcpVJ'], skdRcpZirc: [], skdRcpVJ: [], engFinal: ['engSurgicalAddon'], engSurgicalAddon: [], triBar: ['triArch', 'triFaType', 'triImpType', 'triImpOpt', 'triContOpt', 'triPreSub', 'triPreOpt', 'triSingleOpt', 'triRcpArch', 'triRcpFaOpt'], triArch: ['triFaType', 'triImpType', 'triImpOpt', 'triContOpt', 'triPreSub', 'triPreOpt', 'triSingleOpt', 'triRcpArch', 'triRcpFaOpt'], triFaType: ['triImpType', 'triImpOpt', 'triContOpt', 'triPreSub', 'triPreOpt', 'triRcpArch', 'triRcpFaOpt'], triImpType: ['triImpOpt', 'triRcpArch', 'triRcpFaOpt'], triImpOpt: ['triRcpArch', 'triRcpFaOpt'], triContOpt: ['triRcpArch', 'triRcpFaOpt'], triPreSub: ['triPreOpt', 'triRcpArch', 'triRcpFaOpt'], triPreOpt: ['triRcpArch', 'triRcpFaOpt'], triSingleOpt: ['triRcpArch', 'triRcpFaOpt'], triRcpArch: ['triRcpFaOpt'], triRcpFaOpt: [], addonSel: [] };

// Stage ordering for the progress track.
export function stageN(s) { return { 'Data Entry': 0, 'Review': 1, 'Scanning': 1.5, 'Design Check': 2, 'Outsourcing': 3, 'QC': 4, 'Complete': 5 }[s] ?? -1; }

// Stages owned by the Design Team queue.
export const DESIGN_STAGES = ['Design Check', 'Outsourcing', 'QC', 'QC Failed - Rework', 'QC Failed - Resend'];

export function isSet(v) { return v !== null && v !== undefined && !isNaN(v); }
