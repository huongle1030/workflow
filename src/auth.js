// Auth flow: Microsoft SSO via Supabase Auth, gated on the `employees` table.
// State machine: no row -> role-select; role_approval=false -> pending;
// active=false -> rejected; role_approval=true + active=true -> approved.
import { supabase } from './supabase.js';
import {
  showLoginScreen,
  showRoleSelectionScreen,
  showPendingScreen,
  showRejectedScreen,
  hideAuthOverlay,
} from './auth-ui.js';

const ALLOWED_DOMAIN = 'skdla.com';
const APP_NAME = 'caseCoord_designApprovals';

// Roles a new hire may self-request on the role-selection screen.
// NOTE: `admin` and `executive` are intentionally excluded — they are assigned
// by an admin directly in the Supabase `employees` table, never self-requested.
// The full role list + labels live in permissions.js (ROLES / ROLE_LABELS).
export const ROLE_OPTIONS = [
  { value: 'design_approver',  label: 'Design Approver' },
  { value: 'case_entry',       label: 'Case Entry/Review' },
  { value: 'account_manager',  label: 'Account Manager' },
  { value: 'manager',          label: 'Manager' },
];

let currentUser = null;
let currentEmployee = null;
let onApprovedCallback = null;

export function getCurrentUser()     { return currentUser; }
export function getCurrentEmployee() { return currentEmployee; }

// Current Supabase access token (sent to /api/anthropic so the server can
// verify the caller is a signed-in @skdla.com user before using the API key).
export async function getAccessToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token || null;
}

// Strip the OAuth token fragment (#access_token=...) left in the URL after a
// Microsoft sign-in redirect. If it lingers, `detectSessionInUrl` can re-read
// it and silently restore the session — making "Sign out" look broken.
function clearAuthHashFromUrl() {
  if (window.location.hash && /access_token|refresh_token|[?&]code=/.test(window.location.hash + window.location.search)) {
    window.history.replaceState(null, '', window.location.pathname);
  }
}

// ---- Inactivity auto-logout ----
// Sign the user out after this many ms with no mouse/keyboard/touch activity.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
let idleTimerId = null;

function onIdleTimeout() {
  signOut('You were signed out after 5 minutes of inactivity.');
}

function resetIdleTimer() {
  if (idleTimerId) clearTimeout(idleTimerId);
  idleTimerId = setTimeout(onIdleTimeout, IDLE_TIMEOUT_MS);
}

function startIdleTimer() {
  stopIdleTimer();
  for (const ev of ACTIVITY_EVENTS) {
    window.addEventListener(ev, resetIdleTimer, { passive: true });
  }
  resetIdleTimer();
}

function stopIdleTimer() {
  if (idleTimerId) { clearTimeout(idleTimerId); idleTimerId = null; }
  for (const ev of ACTIVITY_EVENTS) {
    window.removeEventListener(ev, resetIdleTimer);
  }
}

export async function initAuth(onApproved) {
  onApprovedCallback = onApproved;

  // Handle initial session (page load or post-OAuth redirect)
  const { data: { session } } = await supabase.auth.getSession();
  await routeFromSession(session);

  // React to sign-in / sign-out events
  supabase.auth.onAuthStateChange(async (_event, session) => {
    await routeFromSession(session);
  });
}

// Resolves the current session to a screen and returns a status string so
// callers (e.g. the pending screen's "Check again" button) can react when the
// status hasn't changed.
async function routeFromSession(session) {
  if (!session || !session.user) {
    currentUser = null;
    currentEmployee = null;
    showLoginScreen();
    return 'logged-out';
  }

  const user = session.user;
  const email = (user.email || '').toLowerCase();

  // Domain guard — block non-@skdla.com accounts even if they slip past Supabase
  if (!email.endsWith('@' + ALLOWED_DOMAIN)) {
    await supabase.auth.signOut();
    showLoginScreen('Only @' + ALLOWED_DOMAIN + ' accounts are allowed.');
    return 'wrong-domain';
  }

  currentUser = user;
  // Token has been consumed into a session — remove it from the URL so it
  // can't be replayed to restore the session after sign-out.
  clearAuthHashFromUrl();
  const employee = await getEmployeeRecord(user.id);
  currentEmployee = employee;

  if (!employee) {
    showRoleSelectionScreen(user);
    return 'role-selection';
  }
  if (employee.active === false) {
    showRejectedScreen();
    return 'rejected';
  }
  if (employee.role_approval === true && employee.active !== false) {
    await updateLoginTime(user.id);
    hideAuthOverlay();
    startIdleTimer();
    if (onApprovedCallback) onApprovedCallback(employee);
    return 'approved';
  }
  // Pending: row exists but not yet approved
  showPendingScreen();
  return 'pending';
}

export async function signInWithMicrosoft() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'azure',
    options: {
      scopes: 'email openid profile',
      redirectTo: window.location.origin + window.location.pathname,
      queryParams: {
        prompt: 'select_account',
      },
    },
  });
  if (error) {
    console.error('[auth] signInWithOAuth failed:', error);
    alert('Sign-in failed: ' + error.message);
  }
}

export async function signOut(message) {
  // signOut is also used directly as a click handler, where the first arg is
  // the click Event — only treat an actual string as a login-screen message.
  const reason = typeof message === 'string' ? message : undefined;
  stopIdleTimer();
  await supabase.auth.signOut();
  currentUser = null;
  currentEmployee = null;
  clearAuthHashFromUrl();
  showLoginScreen(reason);
}

async function getEmployeeRecord(userId) {
  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.error('[auth] getEmployeeRecord failed:', error);
    return null;
  }
  return data;
}

export async function createEmployeeRecord(requestedRole) {
  if (!currentUser) throw new Error('No authenticated user');
  const user = currentUser;
  const displayName =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    (user.email || '').split('@')[0];

  const row = {
    id:                   user.id,
    name:                 displayName,
    email:                user.email,
    role:                 requestedRole,
    role_approval:        false,
    active:               true,
    website_applications: APP_NAME + ' (' + window.location.origin + ')',
    login_time:           new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('employees')
    .insert(row)
    .select()
    .single();
  if (error) {
    console.error('[auth] createEmployeeRecord failed:', error);
    throw error;
  }
  currentEmployee = data;
  return data;
}

async function updateLoginTime(userId) {
  const { error } = await supabase
    .from('employees')
    .update({ login_time: new Date().toISOString() })
    .eq('id', userId);
  if (error) console.warn('[auth] updateLoginTime failed:', error);
}

// Manual refresh — used by the pending screen's "Check again" button.
// Returns the resolved status so the UI can give feedback when nothing changed.
export async function refreshEmployeeStatus() {
  const { data: { session } } = await supabase.auth.getSession();
  return routeFromSession(session);
}
