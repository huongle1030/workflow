// =====================================================================
// DraftGuard — preserve in-progress edits across re-renders / reloads
// =====================================================================
// The app re-renders whole panels with innerHTML (notably the main app's 60s
// `setInterval(loadAll, ...)`), which destroys any field a user is typing into:
// email drafts, case details, QC forms. DraftGuard captures every keystroke in a
// preservable field, mirrors it to localStorage (so it also survives a full page
// reload / Supabase token refresh), and re-applies it after each render.
//
// Safety property: an entry is only ever created when the user actually interacts
// with a field (an `input`/`change` event fires). Untouched fields are never
// stored, so a refresh never resurrects or clobbers a value the server legitimately
// changed — only the user's own unsent edits come back.
//
// Exposed as `window.DraftGuard` so the mode modules (caseflow / qc / nest) can call
// `restore()` from their own render paths without importing this file.

// v2: drafts are now scoped per record (see scopeOf / data-draft-ns). Bumping the key
// drops any legacy v1 drafts so pre-scoping caseflow keys can't leak across cases once.
const STORAGE_KEY = 'wf_drafts_v2';
const TTL_MS = 24 * 60 * 60 * 1000;     // drop drafts older than 24h
const PERSIST_DEBOUNCE_MS = 400;

// store shape: { [namespace]: { [fieldKey]: { v?, html?, checked?, ts } } }
let store = {};
let nsGetter = () => 'anon';
let installed = false;
let persistTimer = null;

// ---- persistence -----------------------------------------------------
function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    store = raw ? JSON.parse(raw) : {};
  } catch { store = {}; }
  pruneStale();
}

function pruneStale() {
  const now = Date.now();
  let changed = false;
  for (const ns of Object.keys(store)) {
    const bucket = store[ns];
    for (const key of Object.keys(bucket)) {
      if (!bucket[key] || (now - (bucket[key].ts || 0)) > TTL_MS) { delete bucket[key]; changed = true; }
    }
    if (!Object.keys(bucket).length) { delete store[ns]; changed = true; }
  }
  if (changed) persistNow();
}

function persistNow() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch {}
}

function persistSoon() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, PERSIST_DEBOUNCE_MS);
}

function bucket() {
  const ns = nsGetter() || 'anon';
  return (store[ns] = store[ns] || {});
}

// ---- field classification -------------------------------------------
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'time', 'datetime-local', 'month', 'week', '']);

function keyOf(el) {
  return el.id || el.getAttribute('name') || (el.dataset && el.dataset.draft) || null;
}

// ---- per-scope keys -------------------------------------------------
// A field whose id is reused across records (e.g. caseflow's `de-notes`, `rx-notes`
// — the same ids render for every case) would otherwise have its draft restored into
// the WRONG record. Any ancestor carrying `data-draft-ns="<scope>"` opts its fields
// into a scoped key, so a draft typed under one scope only ever restores under that
// same scope. Fields with no scoped ancestor behave exactly as before (unscoped).
const SCOPE_SEP = '\x1f';   // unit separator — never appears in element ids or scope values
function scopeOf(el) {
  try { const s = el.closest && el.closest('[data-draft-ns]'); return s ? (s.getAttribute('data-draft-ns') || '') : ''; }
  catch { return ''; }
}
function storageKey(el) {
  const base = keyOf(el);
  if (!base) return null;
  const scope = scopeOf(el);
  return scope ? scope + SCOPE_SEP + base : base;
}

// True for fields whose content we should preserve.
function isPreservable(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.disabled || el.readOnly || el.hasAttribute('readonly')) return false;
  if (!keyOf(el)) return false;
  // Never persist the config panel (secrets) — its inputs are cfg-*.
  if (typeof el.id === 'string' && el.id.startsWith('cfg-')) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'password' || t === 'file' || t === 'hidden' || t === 'button' || t === 'submit') return false;
    if (t === 'checkbox' || t === 'radio') return true;
    return TEXT_INPUT_TYPES.has(t);
  }
  return false;
}

function readEntry(el) {
  if (el.isContentEditable) return { html: el.innerHTML, ts: Date.now() };
  const t = (el.type || '').toLowerCase();
  if (t === 'checkbox' || t === 'radio') return { checked: !!el.checked, ts: Date.now() };
  return { v: el.value, ts: Date.now() };
}

// Whether the live field already matches the stored entry (so we can skip writing).
function matches(el, entry) {
  if (!entry) return true;
  if (el.isContentEditable) return el.innerHTML === entry.html;
  const t = (el.type || '').toLowerCase();
  if (t === 'checkbox' || t === 'radio') return !!el.checked === !!entry.checked;
  return el.value === entry.v;
}

function applyEntry(el, entry) {
  const tag = el.tagName;
  const type = (el.type || '').toLowerCase();
  if (el.isContentEditable) { el.innerHTML = entry.html != null ? entry.html : ''; }
  else if (type === 'checkbox' || type === 'radio') { el.checked = !!entry.checked; }
  else { el.value = entry.v != null ? entry.v : ''; }
  // Re-fire the app's own handlers so any in-memory state (qc `state`, caseflow
  // model) is kept in sync with the restored DOM value. Use `input` for text-like
  // fields (matches their `oninput` binding) and `change` for select/checkbox/radio.
  // Deliberately NOT firing `change` on text inputs avoids triggering side-effecty
  // onchange handlers (e.g. case-number lookups) on every restore.
  try {
    if (tag === 'SELECT' || type === 'checkbox' || type === 'radio') {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } catch {}
}

// ---- capture (delegated, capture-phase) -----------------------------
function onEdit(e) {
  const el = e.target;
  if (!isPreservable(el)) return;
  const key = storageKey(el);
  if (!key) return;
  bucket()[key] = readEntry(el);
  persistSoon();
}

// ---- public API ------------------------------------------------------
let applying = 0;            // >0 while restore() is writing — suppresses observer re-entry (depth-counted)
let restoreScheduled = false;

function install(opts = {}) {
  if (typeof opts.namespace === 'function') nsGetter = opts.namespace;
  if (installed) { loadStore(); return; }
  installed = true;
  loadStore();
  document.addEventListener('input', onEdit, true);
  document.addEventListener('change', onEdit, true);
  // Flush any debounced write immediately when the tab is closing or hidden, so the
  // last few keystrokes before an accidental tab-close / reload aren't lost.
  const flush = () => { if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; } persistNow(); };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  // Auto-restore on ANY DOM rebuild — covers every render path (tab navigation, mode
  // switch, the 60s loadAll, manual refreshes) without each one having to call restore().
  if (typeof MutationObserver === 'function') {
    const obs = new MutationObserver(scheduleRestore);
    const start = () => obs.observe(document.body, { childList: true, subtree: true });
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  }
}

// Coalesce a burst of mutations into a single restore on the next frame.
function scheduleRestore() {
  if (restoreScheduled || applying > 0) return;
  restoreScheduled = true;
  const run = () => { restoreScheduled = false; restore(document); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

// Re-apply every stored draft for the current user into matching fields under `root`.
function restore(root) {
  root = root || document;
  const b = bucket();
  applying++;   // suppress the MutationObserver while we write (applyEntry mutates the DOM)
  try {
    for (const key of Object.keys(b)) {
      const entry = b[key];
      if (!entry) continue;
      const el = findField(root, key);
      if (el && !matches(el, entry)) applyEntry(el, entry);
    }
  } finally {
    applying--;
  }
}

function findField(root, key) {
  // key may carry a "<scope>\x1f<base>" prefix; base is an id, a name, or a data-draft value.
  let scope = '', base = key;
  const sep = key.indexOf(SCOPE_SEP);
  if (sep !== -1) { scope = key.slice(0, sep); base = key.slice(sep + 1); }
  let el = null;
  try { el = root.querySelector(`#${cssEscape(base)}`); } catch {}
  if (!el) { try { el = root.querySelector(`[name="${cssAttr(base)}"], [data-draft="${cssAttr(base)}"]`); } catch {} }
  if (!el) return null;
  // A scoped draft only matches a field that still lives under the same scope, so a
  // draft typed in one case never restores into another that reuses the same id.
  if (scope) {
    const owner = el.closest && el.closest('[data-draft-ns]');
    if (!owner || owner.getAttribute('data-draft-ns') !== scope) return null;
  }
  return el;
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1');
}
function cssAttr(s) { return String(s).replace(/"/g, '\\"'); }

function hasDraft(key) {
  const b = bucket();
  return Object.prototype.hasOwnProperty.call(b, key) && !!b[key];
}

function clear(key) {
  const b = bucket();
  if (b[key]) { delete b[key]; persistSoon(); }
}

// Remove every stored key that contains `substr` (e.g. an attempt id, or a 'fb-' prefix).
function clearMatching(substr) {
  const b = bucket();
  let changed = false;
  for (const key of Object.keys(b)) {
    if (key.indexOf(substr) !== -1) { delete b[key]; changed = true; }
  }
  if (changed) persistSoon();
}

// Run `fn` (a re-render) while holding the window + element scroll position steady,
// so a full innerHTML replacement doesn't jump the user away from where they were.
function preserveScroll(fn, el) {
  const winY = window.scrollY;
  const elTop = el ? el.scrollTop : 0;
  fn();
  const restoreScroll = () => {
    window.scrollTo({ top: winY, behavior: 'auto' });
    if (el && typeof el.scrollTop === 'number') el.scrollTop = elTop;
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restoreScroll);
  else restoreScroll();
}

const DraftGuard = { install, restore, hasDraft, clear, clearMatching, preserveScroll };

if (typeof window !== 'undefined') window.DraftGuard = DraftGuard;

export default DraftGuard;
export { install, restore, hasDraft, clear, clearMatching, preserveScroll };
