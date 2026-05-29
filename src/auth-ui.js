// Renders auth overlays (login, role-select, pending, rejected) above the app.
import {
  ROLE_OPTIONS,
  signInWithMicrosoft,
  signOut,
  createEmployeeRecord,
  getCurrentUser,
} from './auth.js';

const OVERLAY_ID = 'auth-overlay';

function ensureOverlay() {
  let el = document.getElementById(OVERLAY_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.className = 'auth-overlay';
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
  return el;
}

export function hideAuthOverlay() {
  const el = document.getElementById(OVERLAY_ID);
  if (el) el.style.display = 'none';
}

function authCard(innerHtml) {
  return `
    <div class="auth-card">
      <div class="auth-logo"></div>
      <div class="auth-brand">
        <div class="auth-brand-name">SKDLA</div>
        <div class="auth-brand-sub">Design Approvals</div>
      </div>
      ${innerHtml}
    </div>
  `;
}

export function showLoginScreen(message) {
  const overlay = ensureOverlay();
  overlay.innerHTML = authCard(`
    <h2>Sign in</h2>
    <p class="auth-sub">Use your @skdla.com Microsoft account to continue.</p>
    ${message ? `<div class="auth-error">${escapeHtml(message)}</div>` : ''}
    <button class="auth-btn auth-btn-ms" id="auth-ms-btn">
      <span class="ms-logo" aria-hidden="true">
        <span></span><span></span><span></span><span></span>
      </span>
      Sign in with Microsoft
    </button>
  `);
  document.getElementById('auth-ms-btn').addEventListener('click', signInWithMicrosoft);
}

export function showRoleSelectionScreen(user) {
  const overlay = ensureOverlay();
  const name =
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    (user?.email || '').split('@')[0];
  const options = ROLE_OPTIONS.map(
    (r) => `<option value="${r.value}">${r.label}</option>`
  ).join('');
  overlay.innerHTML = authCard(`
    <h2>Welcome, ${escapeHtml(name)}</h2>
    <p class="auth-sub">Select your role. An admin will review your request before you get access.</p>
    <label class="auth-label">Your role</label>
    <select id="auth-role-select" class="auth-select">
      <option value="" disabled selected>— Choose a role —</option>
      ${options}
    </select>
    <div id="auth-role-err" class="auth-error" style="display:none;"></div>
    <button class="auth-btn auth-btn-primary" id="auth-submit-role">Submit request</button>
    <button class="auth-link" id="auth-signout">Sign out</button>
  `);
  document.getElementById('auth-submit-role').addEventListener('click', onSubmitRole);
  document.getElementById('auth-signout').addEventListener('click', signOut);
}

async function onSubmitRole() {
  const sel = document.getElementById('auth-role-select');
  const err = document.getElementById('auth-role-err');
  const btn = document.getElementById('auth-submit-role');
  const role = sel.value;
  if (!role) {
    err.textContent = 'Please choose a role.';
    err.style.display = 'block';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  try {
    await createEmployeeRecord(role);
    showPendingScreen();
  } catch (e) {
    err.textContent = 'Could not submit: ' + (e.message || e);
    err.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Submit request';
  }
}

export function showPendingScreen() {
  const overlay = ensureOverlay();
  overlay.innerHTML = authCard(`
    <div class="auth-icon auth-icon-clock">⏳</div>
    <h2>Pending approval</h2>
    <p class="auth-sub">
      Your role request has been submitted. An admin will review and approve it soon.
      You'll get access once approved.
    </p>
    <button class="auth-btn auth-btn-primary" id="auth-refresh">Check again</button>
    <button class="auth-link" id="auth-signout">Sign out</button>
  `);
  document.getElementById('auth-refresh').addEventListener('click', onCheckAgain);
  document.getElementById('auth-signout').addEventListener('click', signOut);
}

// Reload the page so the full auth check (initAuth -> routeFromSession) re-runs
// from a clean state. Re-checking in-place could hang on a slow/stuck Supabase
// call and leave the button spinning with no feedback; a reload always resolves.
function onCheckAgain() {
  const btn = document.getElementById('auth-refresh');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Checking…';
  }
  window.location.reload();
}

export function showRejectedScreen() {
  const overlay = ensureOverlay();
  overlay.innerHTML = authCard(`
    <div class="auth-icon auth-icon-blocked">⛔</div>
    <h2>Access not granted</h2>
    <p class="auth-sub">
      Your account is not active. Please contact an admin if you believe this is a mistake.
    </p>
    <button class="auth-link" id="auth-signout">Sign out</button>
  `);
  document.getElementById('auth-signout').addEventListener('click', signOut);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
