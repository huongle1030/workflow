// CaseFlow ZIP + filled-PDF export. Ported from caseflow_portal_v37.html; the
// only change from the prototype is using the npm `pdf-lib` import instead of the
// CDN global, and taking the case object directly instead of looking it up by id.
import * as PDFLib from 'pdf-lib';
import { DCL_PDF_B64 } from './pdfTemplate.js';
import { DCL_SCHEMAS } from './schemas.js';
import { getDcl, dclAutoPopulate, dclVisibility } from './dcl.js';

function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) { crc ^= bytes[i]; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1)); }
  return (~crc) >>> 0;
}

function makeZip(files) {
  const u16 = n => [n & 255, (n >> 8) & 255];
  const u32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
  const parts = []; const central = []; let offset = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name); const data = f.bytes; const crc = crc32(data);
    const lfh = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
    parts.push(Uint8Array.from(lfh)); parts.push(name); parts.push(data);
    central.push({ crc, size: data.length, name, offset });
    offset += lfh.length + name.length + data.length;
  }
  const cdStart = offset; let cdSize = 0;
  for (const c of central) {
    const cdh = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(c.crc), u32(c.size), u32(c.size), u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset));
    const a = new Uint8Array(cdh.length + c.name.length); a.set(cdh, 0); a.set(c.name, cdh.length); parts.push(a); cdSize += a.length;
  }
  const eocd = [].concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0));
  parts.push(Uint8Array.from(eocd));
  let total = 0; for (const p of parts) total += p.length; const out = new Uint8Array(total); let pos = 0; for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

export async function fillDesignPdf(c) {
  if (!c.dclType || !DCL_PDF_B64[c.dclType]) return null;
  try {
    dclAutoPopulate(c);
    const PL = PDFLib, PDFName = PL.PDFName, rgb = PL.rgb;
    const raw = atob(DCL_PDF_B64[c.dclType]); const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const doc = await PL.PDFDocument.load(bytes, { ignoreEncryption: true });
    const form = doc.getForm(); const d = getDcl(c); const type = c.dclType; const vis = dclVisibility(type, d);
    const texts = {}; const marks = [];
    DCL_SCHEMAS[type].forEach((sec, si) => {
      if (sec.hide) return;
      sec.it.forEach((it, ii) => {
        if (!vis(it)) return; const key = type + '_' + si + '_' + ii;
        if (it.type === 'text') { if (it.pf && d['t:' + key]) texts[it.pf] = d['t:' + key]; }
        else if (it.type === 'check') { if ((it.always || d['k:' + key]) && it.pf) marks.push(it.pf); }
        else if (it.type === 'choice') { const s = d['c:' + key]; if (s != null && it.pf && it.pf[s]) marks.push(it.pf[s]); }
        else if (it.type === 'yn') { const v = d['y:' + key]; if (v === 'y' && it.pfY) marks.push(it.pfY); else if (v === 'n' && it.pfN) marks.push(it.pfN); }
        else if (it.type === 'sites') { it.rows.forEach((row, r) => { const tv = d['site:' + key + '_' + r]; if (tv) texts[row.t] = tv; const p = d['sitep:' + key + '_' + r]; if (p === 'P37') marks.push(row.p37); else if (p === 'P45') marks.push(row.p45); }); }
      });
    });
    Object.keys(texts).forEach(f => { try { form.getTextField(f).setText(String(texts[f])); } catch (e) {} });
    const helv = await doc.embedFont(PL.StandardFonts.Helvetica);
    const pages = doc.getPages();
    const pageForRef = ref => { if (!ref) return null; for (const pg of pages) { if (pg.ref === ref) return pg; } for (const pg of pages) { try { if (pg.ref && ref.objectNumber === pg.ref.objectNumber && ref.generationNumber === pg.ref.generationNumber) return pg; } catch (e) {} } return null; };
    marks.forEach(name => {
      if (!name) return;
      try {
        const field = form.getField(name);
        field.acroField.getWidgets().forEach(w => {
          let rect; try { rect = w.getRectangle(); } catch (e) { const ra = w.dict.lookup(PDFName.of('Rect')); rect = { x: ra.lookup(0).asNumber(), y: ra.lookup(1).asNumber(), width: ra.lookup(2).asNumber() - ra.lookup(0).asNumber(), height: ra.lookup(3).asNumber() - ra.lookup(1).asNumber() }; }
          let page = null; try { page = pageForRef(w.dict.get(PDFName.of('P'))); } catch (e) {}
          if (!page) page = pages[0];
          const h = rect.height || 11;
          page.drawText('X', { x: rect.x + h * 0.12, y: rect.y + h * 0.14, size: h * 0.92, font: helv, color: rgb(0, 0, 0) });
        });
      } catch (e) {}
    });
    // NOTE: not flattening — Design & QC columns must remain fillable for the outsourcer/QC tech
    return await doc.save();
  } catch (e) { return null; }
}

// Build + download the case ZIP. `toast` is an optional (msg)=>void callback.
export async function exportZip(c, toast) {
  if (!c) return;
  const enc = new TextEncoder();
  const reqs = (c.designReqs || []).filter(x => x && x.trim());
  const reqText = reqs.length ? reqs.map((r, i) => `${i + 1}. ${r}`).join('\n') : '(none recorded)';
  const summary = [`Case: ${c.caseNum || c.id}`, `Patient: ${c.patient}`, `Doctor: ${c.doctor}`, `Stage: ${c.stage}`, `Rush: ${c.rush ? 'Yes' : 'No'}`, `Ship date: ${c.shipDate || '-'}`, `Dr due date: ${c.drDueDate || '-'}`, '', 'Doctor Requirements:', reqText].join('\n');
  const files = [{ name: 'case_summary.txt', bytes: enc.encode(summary + '\n') }, { name: 'doctor_requirements.txt', bytes: enc.encode(reqText + '\n') }];
  const attached = [...(c.files || []), ...(c.reviewFiles || []), ...(c.scanFiles || [])];
  if (attached.length) files.push({ name: 'attachments_manifest.txt', bytes: enc.encode(attached.map(f => `${f.name}\t${f.size}`).join('\n') + '\n') });
  const dpdf = await fillDesignPdf(c); if (dpdf) files.push({ name: 'design_checklist_' + c.dclType + '_' + (c.caseNum || c.id) + '.pdf', bytes: dpdf });
  const zip = makeZip(files);
  try { const blob = new Blob([zip], { type: 'application/zip' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${c.caseNum || c.id}_export.zip`; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (e) {}
  if (toast) toast(`Exported ${c.caseNum || c.id}_export.zip — includes doctor requirements`);
}
