// =====================================================================
// Code 39 barcode generator for the Case Lookup tab.
//
// ABS (EvoData) prints case-number barcodes on work tickets via Crystal
// Reports using the FREE3OF9 font with the formula "*" + {Case_Number} + "*".
// That font is "Free 3 of 9" = the Code 39 symbology; the asterisks are
// Code 39's start/stop delimiter (drawn as guard bars, no check digit). We
// render the SAME symbology with JsBarcode, so a barcode generated from the
// same input string decodes to the same value on a scanner as the
// ABS-printed one — fidelity depends on the encoded string, not the renderer.
//
// This is 100% client-side from a string already on screen: nothing is read
// from or written to Supabase, so the publishable-key / RLS data-layer
// limitation noted in project memory does not apply here.
// =====================================================================
import JsBarcode from 'jsbarcode';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Default Code 39 options. `mod43:false` matches ABS (no check digit).
// JsBarcode adds the *…* start/stop guards itself, so callers pass the BARE
// case number (no asterisks). White background + margin give scanners the
// light "quiet zone" they need around the bars.
const CODE39_OPTS = {
  format: 'CODE39',
  mod43: false,
  displayValue: true,
  width: 2,
  height: 60,
  margin: 12,
  fontSize: 14,
  background: '#ffffff',
  lineColor: '#000000',
};

/**
 * The single switch-point for WHAT we encode. Today the Case Lookup tab shows
 * the normalized case number (leading zeros stripped, e.g. "2026-65397") and
 * that is what we encode. If a scan comparison shows ABS prints the raw
 * zero-padded form (e.g. "2026-065397"), change ONLY this function to emit
 * that form and every barcode (on-screen + both downloads) follows.
 */
export function barcodeValueFor(caseNumber) {
  return String(caseNumber == null ? '' : caseNumber).trim();
}

/**
 * Draw a Code 39 barcode for `caseNumber` into an existing <svg> element.
 * No-ops on a missing element or empty value; lets JsBarcode throw on a value
 * it cannot encode so the caller can decide how to degrade.
 */
export function renderCode39(svgEl, caseNumber, opts = {}) {
  const value = barcodeValueFor(caseNumber);
  if (!svgEl || !value) return;
  JsBarcode(svgEl, value, { ...CODE39_OPTS, ...opts });
}

function triggerDownload(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Case numbers are digits + hyphen, so this is mostly belt-and-suspenders to
// keep the saved filename valid across OSes.
function safeName(caseNumber) {
  return barcodeValueFor(caseNumber).replace(/[^A-Za-z0-9_-]+/g, '_') || 'case';
}

/** Render off-DOM to a canvas and save barcode-<case>.png. */
export function downloadCode39Png(caseNumber, opts = {}) {
  const value = barcodeValueFor(caseNumber);
  if (!value) return;
  const canvas = document.createElement('canvas');
  JsBarcode(canvas, value, { ...CODE39_OPTS, ...opts });
  triggerDownload(canvas.toDataURL('image/png'), `barcode-${safeName(caseNumber)}.png`);
}

/** Render off-DOM to an SVG and save barcode-<case>.svg. */
export function downloadCode39Svg(caseNumber, opts = {}) {
  const value = barcodeValueFor(caseNumber);
  if (!value) return;
  const svg = document.createElementNS(SVG_NS, 'svg');
  JsBarcode(svg, value, { ...CODE39_OPTS, ...opts });
  const xml = new XMLSerializer().serializeToString(svg);
  const blob = new Blob(
    [`<?xml version="1.0" standalone="no"?>\n${xml}`],
    { type: 'image/svg+xml;charset=utf-8' }
  );
  const url = URL.createObjectURL(blob);
  triggerDownload(url, `barcode-${safeName(caseNumber)}.svg`);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
