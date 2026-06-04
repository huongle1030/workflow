// Design Checklist (DCL) engine — pure helpers shared by the UI (app.js) and the
// PDF exporter (export.js). Ported verbatim from caseflow_portal_v37.html, with
// the only change being getA(c.id) -> c.aox (the case object already carries it).
import { DCL_SCHEMAS } from './schemas.js';

export function dclEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
export function dclAttr(s) { return dclEsc(s).replace(/"/g, '&quot;'); }
export function getDcl(c) { if (!c.dclData) c.dclData = {}; return c.dclData; }

export function dclAutoPopulate(c) {
  if (!c.dclType || !DCL_SCHEMAS[c.dclType]) return;
  const d = getDcl(c); const aox = c.aox || {}; const isCont = !!aox.crm;
  const reqs = (c.designReqs || []).filter(x => x && x.trim());
  DCL_SCHEMAS[c.dclType].forEach((sec, si) => sec.it.forEach((it, ii) => {
    const key = c.dclType + '_' + si + '_' + ii;
    if (it.role === 'casetype' && d['c:' + key] === undefined) d['c:' + key] = isCont ? 1 : 0;
    if (it.role === 'reference' && !d['t:' + key] && isCont && aox.refCase) d['t:' + key] = aox.refCase;
    if (it.type === 'text' && it.l === 'Case number' && !d['t:' + key] && c.caseNum) d['t:' + key] = c.caseNum;
    if (it.role === 'designNote' && d['t:' + key] === undefined && reqs[it.ni] != null) d['t:' + key] = reqs[it.ni];
    if (it.role === 'tissueChoice' && d['c:' + key] === undefined) d['c:' + key] = 0;
  }));
}

export function dclVisibility(sel, d) {
  let ctKey, dcKey, nsKey, imKey, tbKey, sbKey, davKey, vdoKey, midKey, ojKey, obKey, tisKey;
  DCL_SCHEMAS[sel].forEach((sec, si) => sec.it.forEach((it, ii) => {
    const key = sel + '_' + si + '_' + ii; const r = it.role;
    if (r === 'casetype') ctKey = key; if (r === 'designChanges') dcKey = key; if (r === 'newScans') nsKey = key;
    if (r === 'implantMethod') imKey = key; if (r === 'tiBase') tbKey = key; if (r === 'muaScanBody') sbKey = key;
    if (r === 'davinci') davKey = key; if (r === 'rxVDO') vdoKey = key; if (r === 'rxMidline') midKey = key;
    if (r === 'rxOverjet') ojKey = key; if (r === 'rxOverbite') obKey = key; if (r === 'tissueChoice') tisKey = key;
  }));
  const cont = d['c:' + ctKey] === 1, dcY = d['y:' + dcKey] === 'y', nsY = d['y:' + nsKey] === 'y';
  const im = d['c:' + imKey], tb = d['c:' + tbKey], sb = d['c:' + sbKey], dav = d['y:' + davKey];
  const vdo = !!d['k:' + vdoKey], mid = !!d['k:' + midKey], oj = !!d['k:' + ojKey], ob = !!d['k:' + obKey], tisOther = d['c:' + tisKey] === 1;
  return it => {
    const r = it.role;
    if (r === 'hidden') return false;
    if (r === 'reference' || r === 'designChanges') return cont;
    if (r === 'newScans') return cont && dcY;
    if (r === 'scanItem') return cont && dcY && nsY;
    if (r === 'tiBase') return im === 0;
    if (r === 'ascUL') return im === 0 && tb === 2;
    if (r === 'muaScanBody') return im === 1;
    if (r === 'otherScanBody') return im === 1 && sb === 3;
    if (r === 'dessScrew') return im === 1 && sb === 0;
    if (r === 'toothLibrary') return dav === 'y';
    if (r === 'vdoOpenClose' || r === 'vdoSub') return vdo;
    if (r === 'midSub') return mid;
    if (r === 'ojSub') return oj;
    if (r === 'obSub') return ob;
    if (r === 'tissueOther') return tisOther;
    return true;
  };
}
