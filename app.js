'use strict';

// MONETRA v4.4 — Google sign-in with Supabase cross-device finance sync.
// Local storage remains the offline cache; Supabase is the shared account data store.

const APP_VERSION = 2; // Keep backup format compatible with existing v2 JSON files.
const CATEGORIES = [
  'Food & Dining', 'Groceries', 'Travel', 'Outing & Entertainment', 'Shopping',
  'Bills & Recharge', 'Health & Medicine', 'Personal Care', 'Home & Household',
  'Gifts & Donations', 'Education', 'Money Lent', 'Others'
];
const METHODS = ['UPI', 'Cash', 'Other'];
const EXPENSE_CATEGORIES = CATEGORIES.filter(category => category !== 'Money Lent');
const MONEY_METHODS = ['UPI', 'Cash', 'Other'];

let user = null;
let transactions = [];
let creditPurchases = [];
let loans = [];
let appTab = 'overview';
let serviceWorkerRegistration = null;
let notificationTimer = null;

const $ = (id) => document.getElementById(id);
const authScreen = $('auth-screen');
const mainScreen = $('main-screen');
const authForm = $('auth-form');
const authModeInput = $('auth-mode');
const regNameGroup = $('display-name-group');
const regNameInput = $('reg-name');
const usernameInput = $('username');
const passwordInput = $('password');
const authToggleBtn = $('auth-toggle-btn');
const authToggleLabel = $('auth-toggle-label');
const authSubmitBtn = $('auth-submit-btn');
const displayName = $('display-name');
const txModal = $('transaction-modal');
const txForm = $('transaction-form');
const toastEl = $('toast');

// Google-only sign-in with a stable local account per Supabase user.
// The first Google login can clear old local Apna Kharcha data only after explicit confirmation.
let monetraSupabase = null;
let monetraCloudUser = null;
let authProcessingUserId = null;
let authStartupResolved = false;
let authStateSubscription = null;
const MONETRA_CLOUD_TABLES = {
  transactions: 'transactions',
  creditPurchases: 'credit_purchases',
  loans: 'loans'
};
let cloudSyncReady = false;
let cloudSyncQueue = Promise.resolve();
let lastCloudSyncPromise = Promise.resolve(true);
function setGoogleStatus(message, isError = false) {
  const el = $('google-auth-status');
  if (el) { el.textContent = message; el.style.color = isError ? 'var(--danger, #c44)' : ''; }
}
function clearLegacyLocalFinanceData() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('apna_kharcha_')) keys.push(key);
  }
  keys.forEach(key => localStorage.removeItem(key));
  return keys.length;
}
function googleLocalAccountName(authUser) {
  return 'google_' + String(authUser.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
}
async function finishGoogleSignIn(authUser) {
  if (!authUser) return;
  if (authProcessingUserId === authUser.id) return;
  authProcessingUserId = authUser.id;
  monetraCloudUser = authUser;
  try {
    localStorage.setItem('monetra_cloud_user_id', authUser.id);
    const cleanMarker = 'monetra_google_cleaned_' + authUser.id;
    if (!localStorage.getItem(cleanMarker)) {
      const oldKeys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('apna_kharcha_')) oldKeys.push(key);
      }
      if (oldKeys.length) {
        const approved = window.confirm(
          'Start MONETRA fresh with this Google account?\n\n' +
          'This will remove the older MONETRA / Apna Kharcha records stored in this browser only. ' +
          'Your separate JSON backup file will not be changed. After sign-in, use Backup & Restore → Restore backup to import your JSON file.\n\n' +
          'Continue only if your JSON backup is safely saved.'
        );
        if (!approved) {
          setGoogleStatus('Sign-in paused. Your older local records have been kept. Sign in again when you are ready to start fresh.');
          await monetraSupabase.auth.signOut();
          showScreen('auth');
          return;
        }
        clearLegacyLocalFinanceData();
      }
      localStorage.setItem(cleanMarker, '1');
    }
    try { await ensureCloudProfile(authUser); }
    catch (error) { console.error('MONETRA profile:', error); setGoogleStatus('Google sign-in succeeded, but cloud profile setup failed: ' + (error.message || 'Please try again.'), true); return; }

    const accountName = googleLocalAccountName(authUser);
    const fullName = authUser.user_metadata?.full_name || authUser.user_metadata?.name || authUser.email || 'MONETRA user';
    user = { name: accountName, fullName };
    localStorage.setItem('apna_kharcha_user', JSON.stringify(user));
    loadData();
    try {
      const syncResult = await initializeCloudData();
      if (syncResult.source === 'cloud') {
        showToast(`Loaded ${syncResult.counts.transactions} transactions and cloud records from your Google account.`);
      } else if (syncResult.source === 'local') {
        showToast(`Uploaded ${syncResult.counts.transactions} restored transactions to your MONETRA cloud account.`);
      }
      setGoogleStatus('Signed in with Google. MONETRA data is synchronized with this account across your devices.');
    } catch (cloudError) {
      cloudSyncReady = false;
      console.error('MONETRA cloud data initialization:', cloudError);
      setGoogleStatus('Google sign-in succeeded, but cloud sync needs attention: ' + (cloudError.message || 'Please reload and try again.'), true);
      showToast('Your device data is safe, but cloud sync did not finish. ' + (cloudError.message || 'Check the cloud setup.'), 'error');
    }
    showScreen('main');
  } finally {
    authProcessingUserId = null;
    authStartupResolved = true;
    document.body.classList.remove('auth-pending');
  }
}
function resolveInitialAuthScreen(session) {
  if (session?.user) {
    finishGoogleSignIn(session.user).catch(error => {
      console.error('MONETRA session restore:', error);
      setGoogleStatus(error.message || 'Could not restore your Google session. Please sign in again.', true);
      showScreen('auth');
      authStartupResolved = true;
      document.body.classList.remove('auth-pending');
    });
  } else {
    user = null;
    showScreen('auth');
    authStartupResolved = true;
    document.body.classList.remove('auth-pending');
  }
}
function initMonetraCloudAuth() {
  try {
    const cfg = window.MONETRA_SUPABASE_CONFIG;
    if (!cfg || !window.supabase?.createClient) {
      setGoogleStatus('Google sign-in is unavailable. Check your connection and reload.', true);
      document.body.classList.remove('auth-pending');
      return;
    }
    monetraSupabase = window.supabase.createClient(cfg.url, cfg.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    $('google-login-btn')?.addEventListener('click', async () => {
      const button = $('google-login-btn'); button.disabled = true; setGoogleStatus('Connecting to Google…');
      try {
        const { error } = await monetraSupabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin + window.location.pathname } });
        if (error) throw error;
      } catch (error) {
        console.error('Google OAuth:', error); setGoogleStatus(error.message || 'Google sign-in could not start.', true); button.disabled = false;
      }
    });
    const { data } = monetraSupabase.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION') {
        resolveInitialAuthScreen(session);
      } else if (session?.user && ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event)) {
        if (!authProcessingUserId) {
          setTimeout(() => finishGoogleSignIn(session.user).catch(error => {
            console.error('MONETRA auth event:', error); setGoogleStatus(error.message || 'Could not finish Google sign-in.', true);
          }), 0);
        }
      } else if (event === 'SIGNED_OUT') {
        user = null; transactions = []; creditPurchases = []; loans = [];
        showScreen('auth');
      }
    });
    authStateSubscription = data?.subscription || null;
  } catch (error) {
    console.warn('MONETRA cloud setup:', error);
    setGoogleStatus('Google sign-in could not be initialized.', true);
    document.body.classList.remove('auth-pending');
  }
}
async function ensureCloudProfile(authUser) {
  if (!monetraSupabase || !authUser) return;
  const display = authUser.user_metadata?.full_name || authUser.user_metadata?.name || authUser.email || 'MONETRA user';
  const { error } = await monetraSupabase.from('profiles').upsert({
    id: authUser.id, display_name: display, updated_at: new Date().toISOString()
  }, { onConflict: 'id' });
  if (error) throw error;
}

function currentFinanceSnapshot() {
  return JSON.parse(JSON.stringify({ transactions, creditPurchases, loans }));
}
function cloudRecordData(row, index, normalizer) {
  let value = row?.data;
  if (typeof value === 'string') value = JSON.parse(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`A cloud record (${row?.record_id || index + 1}) has invalid data.`);
  }
  if (!value.id && row.record_id) value.id = row.record_id;
  return normalizer(value, index, false);
}
function mergeByRecordId(localItems, cloudItems) {
  const merged = new Map();
  // Supabase is authoritative for records that already exist in the account.
  // Preserve local-only records (for example, a backup import not yet uploaded),
  // but do not let an older cached copy overwrite a newer cloud edit on sign-in.
  localItems.forEach(item => merged.set(String(item.id), item));
  cloudItems.forEach(item => merged.set(String(item.id), item));
  return [...merged.values()];
}
async function readCloudFinanceData(authUser) {
  if (!monetraSupabase || !authUser?.id) throw new Error('Your Google session is not ready for cloud sync.');
  const tables = [
    ['transactions', normalizeTransaction],
    ['credit_purchases', normalizeCardPurchase],
    ['loans', normalizeLoan]
  ];
  const result = {};
  for (const [table, normalizer] of tables) {
    const { data, error } = await monetraSupabase
      .from(table)
      .select('record_id,data,deleted_at')
      .eq('user_id', authUser.id);
    if (error) {
      if (/deleted_at|column/i.test(error.message || '')) {
        throw new Error(`Cloud schema for ${table} is not upgraded. Run MONETRA_CLOUD_SYNC_V45.sql in Supabase SQL Editor, then reload.`);
      }
      throw new Error(`Could not read ${table}: ${error.message}`);
    }
    const rows = data || [];
    result[table] = rows
      .filter(row => !row.deleted_at)
      .map((row, index) => cloudRecordData(row, index, normalizer));
    result[`${table}DeletedIds`] = new Set(rows.filter(row => row.deleted_at).map(row => String(row.record_id)));
  }
  return result;
}
async function syncCloudCollection(table, items, authUserId, timestamp, allowRestore = false) {
  // Read the complete ID set first. Soft-deleted IDs are tombstones: a stale device
  // must never silently recreate them during an ordinary snapshot upload.
  const { data: existing, error: readError } = await monetraSupabase
    .from(table).select('record_id,deleted_at').eq('user_id', authUserId);
  if (readError) {
    if (/deleted_at|column/i.test(readError.message || '')) {
      throw new Error(`Cloud schema for ${table} is not upgraded. Run MONETRA_CLOUD_SYNC_V45.sql in Supabase SQL Editor, then reload.`);
    }
    throw new Error(`Could not inspect ${table}: ${readError.message}`);
  }

  const existingRows = existing || [];
  const tombstonedIds = new Set(existingRows.filter(row => row.deleted_at).map(row => String(row.record_id)));
  const attemptedResurrection = !allowRestore && items.find(item => tombstonedIds.has(String(item.id)));
  if (attemptedResurrection) {
    throw new Error(`A record in ${table} was deleted on another device. Reload MONETRA before making more changes; this prevents an old copy from restoring a deleted record.`);
  }

  const rows = items.map(item => ({
    user_id: authUserId,
    record_id: String(item.id),
    data: item,
    updated_at: timestamp,
    deleted_at: null
  }));
  if (rows.length) {
    const { data: savedRows, error } = await monetraSupabase
      .from(table)
      .upsert(rows, { onConflict: 'user_id,record_id' })
      .select('record_id');
    if (error) {
      const detail = /on conflict|unique|constraint/i.test(error.message)
        ? ' Run MONETRA_CLOUD_SYNC_SETUP.sql once in Supabase SQL Editor.'
        : '';
      throw new Error(`Could not upload/update ${table}: ${error.message}.${detail}`);
    }
    if ((savedRows || []).length !== rows.length) {
      throw new Error(`Supabase did not confirm every ${table} upload/update. Check the authenticated-user INSERT and UPDATE RLS policies.`);
    }
  }

  const wanted = new Set(items.map(item => String(item.id)));
  const stale = existingRows
    .filter(row => !row.deleted_at && !wanted.has(String(row.record_id)))
    .map(row => String(row.record_id));
  // Soft delete, rather than physically deleting, so another device can learn
  // about the deletion and cannot resurrect an outdated local copy.
  for (let start = 0; start < stale.length; start += 100) {
    const batch = stale.slice(start, start + 100);
    const { data: deletedRows, error } = await monetraSupabase
      .from(table)
      .update({ deleted_at: timestamp, updated_at: timestamp })
      .eq('user_id', authUserId)
      .in('record_id', batch)
      .is('deleted_at', null)
      .select('record_id');
    if (error) {
      throw new Error(`Could not synchronize deletion in ${table}: ${error.message}. Check the authenticated-user UPDATE RLS policy and run MONETRA_CLOUD_SYNC_V45.sql.`);
    }
    const deletedIds = new Set((deletedRows || []).map(row => String(row.record_id)));
    const missing = batch.filter(id => !deletedIds.has(id));
    if (missing.length) {
      throw new Error(`Supabase did not confirm deletion of ${missing.length} ${table} record(s). Your device copy is retained. Check the UPDATE RLS policy and reload before using another device.`);
    }
  }
}
async function syncCloudSnapshot(snapshot, options = {}) {
  if (!monetraSupabase || !monetraCloudUser?.id) throw new Error('No active Google account is available for cloud sync.');
  const timestamp = new Date().toISOString();
  const allowRestore = options.allowRestore === true;
  await syncCloudCollection(MONETRA_CLOUD_TABLES.transactions, snapshot.transactions, monetraCloudUser.id, timestamp, allowRestore);
  await syncCloudCollection(MONETRA_CLOUD_TABLES.creditPurchases, snapshot.creditPurchases, monetraCloudUser.id, timestamp, allowRestore);
  await syncCloudCollection(MONETRA_CLOUD_TABLES.loans, snapshot.loans, monetraCloudUser.id, timestamp, allowRestore);
}
function queueCloudSync(snapshot, options = {}) {
  const operation = cloudSyncQueue.catch(() => {}).then(() => syncCloudSnapshot(snapshot, options));
  cloudSyncQueue = operation;
  return operation;
}
function excludeCloudDeleted(items, deletedIds) {
  return items.filter(item => !deletedIds.has(String(item.id)));
}
async function initializeCloudData() {
  cloudSyncReady = false;
  const localSnapshot = currentFinanceSnapshot();
  const localCount = localSnapshot.transactions.length + localSnapshot.creditPurchases.length + localSnapshot.loans.length;
  const cloud = await readCloudFinanceData(monetraCloudUser);
  const cloudCount = cloud.transactions.length + cloud.credit_purchases.length + cloud.loans.length;
  const tombstoneCount = cloud.transactionsDeletedIds.size + cloud.credit_purchasesDeletedIds.size + cloud.loansDeletedIds.size;

  if (cloudCount > 0 || tombstoneCount > 0) {
    // Cloud tombstones outrank local cached copies. This is what makes a deletion
    // on one device stay deleted when a different, older device signs in later.
    const localTransactions = excludeCloudDeleted(localSnapshot.transactions, cloud.transactionsDeletedIds);
    const localCards = excludeCloudDeleted(localSnapshot.creditPurchases, cloud.credit_purchasesDeletedIds);
    const localLoans = excludeCloudDeleted(localSnapshot.loans, cloud.loansDeletedIds);
    transactions = sortByDateDesc(mergeByRecordId(localTransactions, cloud.transactions));
    creditPurchases = mergeByRecordId(localCards, cloud.credit_purchases);
    loans = mergeByRecordId(localLoans, cloud.loans);
    if (!saveData()) throw new Error('Could not save cloud records to this device. Check available browser storage.');
    await syncCloudSnapshot(currentFinanceSnapshot());
    cloudSyncReady = true;
    return { source: 'cloud', counts: { transactions: transactions.length, creditPurchases: creditPurchases.length, loans: loans.length } };
  }

  // First device after backup restore: upload its local records to this account.
  if (localCount > 0) await syncCloudSnapshot(localSnapshot);
  cloudSyncReady = true;
  return { source: localCount > 0 ? 'local' : 'empty', counts: { transactions: localSnapshot.transactions.length, creditPurchases: localSnapshot.creditPurchases.length, loans: localSnapshot.loans.length } };
}
const THEME_STORAGE_KEY = 'montera_theme_preference';
const themeMediaQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function getThemePreference() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return ['system', 'light', 'dark'].includes(stored) ? stored : 'system';
  } catch (_) { return 'system'; }
}

function applyThemePreference(preference, options = {}) {
  const safePreference = ['system', 'light', 'dark'].includes(preference) ? preference : 'system';
  const systemDark = !!(themeMediaQuery && themeMediaQuery.matches);
  const effectiveTheme = safePreference === 'system' ? (systemDark ? 'dark' : 'light') : safePreference;
  const root = document.documentElement;
  root.setAttribute('data-theme', effectiveTheme);
  root.setAttribute('data-theme-preference', safePreference);
  root.style.colorScheme = effectiveTheme;

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', effectiveTheme === 'dark' ? '#050b09' : '#f4f2eb');

  document.querySelectorAll('input[name="theme-preference"]').forEach(input => {
    input.checked = input.value === safePreference;
    const option = input.closest('.appearance-option');
    if (option) option.classList.toggle('selected', input.checked);
  });
  const appearanceButton = $('appearance-btn');
  if (appearanceButton) {
    const icon = appearanceButton.querySelector('i');
    if (icon) icon.className = effectiveTheme === 'dark' ? 'ph ph-moon-stars' : 'ph ph-sun-dim';
    appearanceButton.setAttribute('aria-label', `Appearance settings. Current theme: ${safePreference}.`);
    appearanceButton.title = `Appearance: ${safePreference}`;
  }

  if (options.persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, safePreference); }
    catch (error) { console.warn('Could not save appearance preference:', error); }
  }
  return effectiveTheme;
}

function bindThemePreference() {
  applyThemePreference(getThemePreference());
  $('appearance-btn')?.addEventListener('click', () => {
    applyThemePreference(getThemePreference());
    showModal('appearance-modal');
  });
  document.querySelectorAll('input[name="theme-preference"]').forEach(input => {
    input.addEventListener('change', event => {
      if (!event.target.checked) return;
      applyThemePreference(event.target.value, { persist: true });
      showToast(`${event.target.value === 'system' ? 'System' : event.target.value === 'dark' ? 'Dark' : 'Light'} appearance selected.`);
    });
  });
  if (themeMediaQuery) {
    const handleSystemThemeChange = () => {
      if (getThemePreference() === 'system') applyThemePreference('system');
    };
    if (typeof themeMediaQuery.addEventListener === 'function') themeMediaQuery.addEventListener('change', handleSystemThemeChange);
    else if (typeof themeMediaQuery.addListener === 'function') themeMediaQuery.addListener(handleSystemThemeChange);
  }
}

function localDateISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function addDaysISO(isoDate, days) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return localDateISO(date);
}
function parseLocalDate(isoDate) {
  const [y, m, d] = String(isoDate || '').split('-').map(Number);
  if (!y || !m || !d) return new Date(NaN);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}
function isValidDateISO(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  return !Number.isNaN(parseLocalDate(value).getTime()) && localDateISO(parseLocalDate(value)) === value;
}
function createId(prefix = 'ak') {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return `${prefix}-${window.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}
function formatCurrency(value) {
  return '₹' + safeNumber(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatDate(isoDate) {
  const d = parseLocalDate(isoDate);
  return Number.isNaN(d.getTime()) ? String(isoDate || '') : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function formatDateTime(date, time) {
  if (!time) return formatDate(date);
  return `${formatDate(date)} · ${formatTime(time)}`;
}
function formatTime(time) {
  if (!/^\d{2}:\d{2}$/.test(String(time || ''))) return String(time || '');
  const [hours, minutes] = time.split(':').map(Number);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const h = hours % 12 || 12;
  return `${h}:${String(minutes).padStart(2, '0')} ${suffix}`;
}
function sum(items, getter) {
  return safeNumber(items.reduce((total, item) => total + Number(getter(item) || 0), 0));
}
function showToast(message, type = 'success') {
  if (!toastEl) return;
  const icon = document.createElement('i');
  icon.className = `ph ${type === 'success' ? 'ph-check-circle' : 'ph-warning-circle'}`;
  toastEl.replaceChildren(icon, document.createTextNode(` ${message}`));
  toastEl.className = `toast show ${type}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toastEl.classList.remove('show'), 3600);
}
function setTodayDefaults() {
  const today = localDateISO();
  ['tx-date', 'cc-date', 'card-payment-date', 'loan-date', 'repayment-date'].forEach(id => {
    const el = $(id);
    if (el) el.value = today;
  });
  $('today-label').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}
function setOptions(select, options, firstLabel = null) {
  select.replaceChildren();
  if (firstLabel) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = firstLabel;
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
  }
  options.forEach(value => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
}
function setInitialFormOptions() {
  setOptions($('tx-category'), EXPENSE_CATEGORIES, 'Choose a category');
  setOptions($('cc-category'), CATEGORIES.filter(c => c !== 'Money Lent'), 'Choose a category');
}
function getStorageKey(suffix) {
  return `apna_kharcha_${suffix}_${user.name}`;
}
function inferLegacyCategory(title, type) {
  const t = String(title || '').toLowerCase();
  if (type === 'in') return 'Income';
  if (/\budhaar\b|\bloan\b|\blent\b/.test(t)) return 'Money Lent';
  if (/breakfast|lunch|dinner|shake|tea|chai|coffee|lassi|sandwich|maggi|khana|food|swiggy|zomato|chips|snack|samosa|milk|chocolate|biscuit|fruit bowl|juice|restaurant|subway|momos|pizza|burger|ice.?cream|lassi|narial|guava|seetafal/.test(t)) return 'Food & Dining';
  if (/rashan|grocery|grocer|sabzi|vegetable|detergent|soap|surf|ghee|oats|makhana|matar|atta|rice|dal|samaan|household/.test(t)) return 'Groceries';
  if (/train|bus|ticket|cab|uber|ola|petrol|fuel|scooty|flight|airport|metro|travel|trip|auto|rickshaw/.test(t)) return 'Travel';
  if (/recharge|sim|mobile|phone bill|wifi|internet|yt music|subscription|google play|electricity|bill|broadband/.test(t)) return 'Bills & Recharge';
  if (/dwaai|medicine|doctor|medical|hospital|pharmacy|health/.test(t)) return 'Health & Medicine';
  if (/barber|salon|haircut|cream|shampoo|personal care/.test(t)) return 'Personal Care';
  if (/gift|shagan|donation|daan|mandir|temple|charity/.test(t)) return 'Gifts & Donations';
  if (/outing|movie|cinema|game|entertainment|park|entry fee/.test(t)) return 'Outing & Entertainment';
  if (/trends|earphone|clothes|shirt|shoe|shopping|order|photo download|box|accessor/.test(t)) return 'Shopping';
  if (/course|book|exam|college|school|study|scholarship/.test(t)) return 'Education';
  return 'Others';
}
function inferLegacyMethod(title) {
  const t = String(title || '').toLowerCase();
  if (/\bupi\b|gpay|google pay|phonepe|paytm/.test(t)) return 'UPI';
  if (/\bcash\b/.test(t)) return 'Cash';
  return 'Other';
}
function normalizeTransaction(raw, index, allowLegacyInference = false) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Transaction ${index + 1} is not an object.`);
  const amount = safeNumber(raw.amount);
  const type = raw.type === 'in' || raw.type === 'out' ? raw.type : null;
  const title = String(raw.title ?? raw.description ?? '').trim();
  const date = String(raw.date || '');
  if (!type || !title || !Number.isFinite(amount) || amount <= 0 || !isValidDateISO(date)) {
    throw new Error(`Transaction ${index + 1} has a missing or invalid amount, description, type or date.`);
  }
  const time = /^\d{2}:\d{2}$/.test(String(raw.time || '')) ? String(raw.time) : '00:00';
  const category = String(raw.category || (allowLegacyInference ? inferLegacyCategory(title, type) : (type === 'out' ? 'Others' : 'Income')));
  const method = METHODS.includes(raw.method) ? raw.method : (allowLegacyInference ? inferLegacyMethod(title) : 'Other');
  const tx = {
    ...raw,
    id: String(raw.id || createId('tx')),
    amount,
    title: title.slice(0, 160),
    date,
    time,
    type,
    category,
    method
  };
  if (allowLegacyInference) tx.categorySuggested = true;
  return tx;
}
function normalizeCardPurchase(raw, index) {
  if (!raw || typeof raw !== 'object') throw new Error(`Card purchase ${index + 1} is invalid.`);
  const amount = safeNumber(raw.amount);
  if (!amount || amount <= 0 || !String(raw.title || '').trim() || !isValidDateISO(raw.date)) throw new Error(`Card purchase ${index + 1} is incomplete.`);
  return {
    ...raw,
    id: String(raw.id || createId('card')),
    amount,
    paidAmount: Math.min(amount, Math.max(0, safeNumber(raw.paidAmount || 0))),
    title: String(raw.title).trim().slice(0, 160),
    category: CATEGORIES.includes(raw.category) && raw.category !== 'Money Lent' ? raw.category : 'Others',
    cardName: String(raw.cardName || 'My Credit Card').slice(0, 60),
    date: raw.date,
    dueDate: isValidDateISO(raw.dueDate) ? raw.dueDate : addDaysISO(raw.date, 25),
    payments: Array.isArray(raw.payments) ? raw.payments : []
  };
}
function normalizeLoan(raw, index) {
  if (!raw || typeof raw !== 'object') throw new Error(`Lending record ${index + 1} is invalid.`);
  const amount = safeNumber(raw.amount);
  if (!amount || amount <= 0 || !String(raw.person || '').trim() || !isValidDateISO(raw.lentOn)) throw new Error(`Lending record ${index + 1} is incomplete.`);
  return {
    ...raw,
    id: String(raw.id || createId('loan')),
    person: String(raw.person).trim().slice(0, 100),
    note: String(raw.note || '').slice(0, 160),
    amount,
    outstanding: Math.min(amount, Math.max(0, safeNumber(raw.outstanding ?? amount))),
    lentOn: raw.lentOn,
    dueDate: isValidDateISO(raw.dueDate) ? raw.dueDate : addDaysISO(raw.lentOn, 20),
    sourceTransactionId: raw.sourceTransactionId ? String(raw.sourceTransactionId) : null,
    repayments: Array.isArray(raw.repayments) ? raw.repayments : []
  };
}
function migrateLegacyArray(array) {
  const txs = array.map((item, i) => normalizeTransaction(item, i, true));
  const ids = new Set();
  txs.forEach((tx, i) => {
    if (ids.has(tx.id)) tx.id = createId(`legacy-${i}`);
    ids.add(tx.id);
  });
  const importedLoans = [];
  txs.forEach(tx => {
    if (tx.type === 'out' && /\budhaar\b|\bloan\b|\blent\b/i.test(tx.title)) {
      const cleaned = tx.title.replace(/udhaar|loan|lent|ditte|diye|diy[e]?/ig, ' ').replace(/[^a-zA-Z ]/g, ' ').trim();
      const person = (cleaned.split(/\s+/).filter(Boolean)[0] || 'Unknown').replace(/^./, c => c.toUpperCase());
      tx.category = 'Money Lent';
      tx.categorySuggested = true;
      tx.excludeFromSpendStats = true;
      const lentDate = tx.date;
      importedLoans.push({
        id: `legacy-loan-${tx.id}`,
        person,
        note: `Imported from “${tx.title}”`,
        amount: tx.amount,
        outstanding: tx.amount,
        lentOn: lentDate,
        dueDate: addDaysISO(lentDate, 20),
        sourceTransactionId: tx.id,
        repayments: [],
        importedFromLegacy: true
      });
      tx.systemManaged = true;
      tx.kind = 'loan-disbursement';
      tx.loanId = `legacy-loan-${tx.id}`;
    }
  });
  return { transactions: txs, creditPurchases: [], loans: importedLoans };
}
function loadData() {
  const stateRaw = localStorage.getItem(getStorageKey('state'));
  if (stateRaw) {
    const state = JSON.parse(stateRaw);
    transactions = Array.isArray(state.transactions) ? state.transactions.map((t, i) => normalizeTransaction(t, i, false)) : [];
    creditPurchases = Array.isArray(state.creditPurchases) ? state.creditPurchases.map(normalizeCardPurchase) : [];
    loans = Array.isArray(state.loans) ? state.loans.map(normalizeLoan) : [];
    return;
  }
  const legacyRaw = localStorage.getItem(getStorageKey('data'));
  if (legacyRaw) {
    const legacy = JSON.parse(legacyRaw);
    if (!Array.isArray(legacy)) throw new Error('Your existing transaction data could not be read. Please restore a backup.');
    const migrated = migrateLegacyArray(legacy);
    transactions = migrated.transactions;
    creditPurchases = migrated.creditPurchases;
    loans = migrated.loans;
    saveData();
    showToast('Your existing records are ready. Categories have been suggested where possible.');
  } else {
    transactions = [];
    creditPurchases = [];
    loans = [];
  }
}
function saveData(options = {}) {
  if (!user) return false;
  const state = { format: 'apna-kharcha-backup', version: APP_VERSION, savedAt: new Date().toISOString(), transactions, creditPurchases, loans };
  try {
    localStorage.setItem(getStorageKey('state'), JSON.stringify(state));
    // Keep the v1 transaction key in sync for safe rollback to the earlier website version.
    localStorage.setItem(getStorageKey('data'), JSON.stringify(transactions));
    if (cloudSyncReady && monetraCloudUser?.id) {
      const snapshot = currentFinanceSnapshot();
      lastCloudSyncPromise = queueCloudSync(snapshot, { allowRestore: options.allowRestore === true })
        .then(() => true)
        .catch(error => {
          console.error('MONETRA cloud sync:', error);
          showToast('Saved on this device, but Supabase did not confirm the change: ' + (error.message || 'Please reload and try again.'), 'error');
          return false;
        });
    } else {
      lastCloudSyncPromise = Promise.resolve(false);
    }
    return true;
  } catch (error) {
    console.error('Could not save MONETRA data:', error);
    showToast('Could not save all changes. Download a backup and free some device storage.', 'error');
    return false;
  }
}
function sortByDateDesc(items, dateField = 'date') {
  return [...items].sort((a, b) => {
    const da = `${a[dateField] || ''}T${a.time || '00:00'}`;
    const db = `${b[dateField] || ''}T${b.time || '00:00'}`;
    return db.localeCompare(da);
  });
}
function signedBalance() {
  return safeNumber(sum(transactions, tx => tx.type === 'in' ? tx.amount : -tx.amount));
}
function cardOutstanding() {
  return safeNumber(sum(creditPurchases, p => Math.max(0, p.amount - p.paidAmount)));
}
function loanOutstanding() {
  return safeNumber(sum(loans, loan => loan.outstanding));
}
function currentMonthPrefix() {
  return localDateISO().slice(0, 7);
}
function spendingForPeriod(period) {
  const matchesMonth = date => period === 'all' || String(date || '').startsWith(currentMonthPrefix());
  const cashSpend = sum(transactions.filter(tx => tx.type === 'out' && !tx.excludeFromSpendStats && tx.category !== 'Money Lent' && matchesMonth(tx.date)), tx => tx.amount);
  const cardSpend = sum(creditPurchases.filter(p => matchesMonth(p.date)), p => p.amount);
  return safeNumber(cashSpend + cardSpend);
}
function categoryTotals(period = 'month') {
  const matchesMonth = date => period === 'all' || String(date || '').startsWith(currentMonthPrefix());
  const totals = new Map();
  transactions.filter(tx => tx.type === 'out' && !tx.excludeFromSpendStats && tx.category !== 'Money Lent' && matchesMonth(tx.date)).forEach(tx => {
    const key = tx.category || 'Others';
    totals.set(key, safeNumber((totals.get(key) || 0) + tx.amount));
  });
  creditPurchases.filter(p => matchesMonth(p.date)).forEach(p => {
    const key = p.category || 'Others';
    totals.set(key, safeNumber((totals.get(key) || 0) + p.amount));
  });
  return [...totals.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
}
function methodTotals(type) {
  const result = new Map();
  if (type === 'in') {
    transactions.filter(tx => tx.type === 'in').forEach(tx => {
      const key = METHODS.includes(tx.method) ? tx.method : 'Other';
      result.set(key, safeNumber((result.get(key) || 0) + tx.amount));
    });
  } else {
    transactions.filter(tx => tx.type === 'out' && !tx.excludeFromSpendStats && tx.category !== 'Money Lent').forEach(tx => {
      const key = METHODS.includes(tx.method) ? tx.method : 'Other';
      result.set(key, safeNumber((result.get(key) || 0) + tx.amount));
    });
    creditPurchases.forEach(p => result.set('Credit Card', safeNumber((result.get('Credit Card') || 0) + p.amount)));
  }
  return [...result.entries()].map(([method, amount]) => ({ method, amount })).sort((a, b) => b.amount - a.amount);
}
function updateDashboard() {
  const totalIn = sum(transactions.filter(t => t.type === 'in'), t => t.amount);
  const totalOut = sum(transactions.filter(t => t.type === 'out'), t => t.amount);
  $('total-balance').textContent = formatCurrency(signedBalance());
  $('total-in').textContent = formatCurrency(totalIn);
  $('total-out').textContent = formatCurrency(totalOut);
  $('month-spend').textContent = formatCurrency(spendingForPeriod('month'));
  $('card-outstanding-small').textContent = formatCurrency(cardOutstanding());
  $('card-due-small').textContent = cardOutstanding() > 0 ? `${creditPurchases.filter(p => p.amount > p.paidAmount).length} unpaid purchase(s)` : 'No pending card payment';
  $('card-outstanding').textContent = formatCurrency(cardOutstanding());
  $('card-purchase-count').textContent = `${creditPurchases.filter(p => p.amount > p.paidAmount).length} unpaid · ${creditPurchases.length} total purchase(s)`;
  $('loan-outstanding').textContent = formatCurrency(loanOutstanding());
  $('loan-count').textContent = `${loans.filter(l => l.outstanding > 0).length} active · ${loans.length} total lending record(s)`;
  const cardDue = creditPurchases.filter(p => p.amount > p.paidAmount).length;
  const loanDue = loans.filter(l => l.outstanding > 0).length;
  $('card-tab-badge').textContent = String(cardDue);
  $('card-tab-badge').hidden = cardDue === 0;
  $('loan-tab-badge').textContent = String(loanDue);
  $('loan-tab-badge').hidden = loanDue === 0;
  renderOverviewBreakdown();
  renderRecentTransactions();
  renderActivity();
  renderInsights();
  renderCreditPurchases();
  renderLoans();
  renderReminders();
}
// A successful save should close its form before any optional screen redraw.
// This prevents a rendering hiccup from leaving a modal stuck over the application.
function refreshDashboardSafely() {
  try {
    updateDashboard();
  } catch (error) {
    console.error('Dashboard refresh failed after saving:', error);
    showToast('Your entry was saved, but the screen could not refresh. Reopen this section to view it.', 'error');
  }
}
async function saveAndRefresh(closeId = null, options = {}) {
  if (!saveData(options)) return false;
  if (closeId) closeModal(closeId);
  refreshDashboardSafely();
  if (!cloudSyncReady) {
    showToast('Saved on this device only. Cloud sync is not ready; reload and sign in before using another device.', 'error');
    return false;
  }
  return await lastCloudSyncPromise;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function icon(name) {
  const node = document.createElement('i');
  node.className = `ph ${name}`;
  return node;
}
function emptyState(message, iconName = 'ph-receipt') {
  const wrap = element('div', 'empty-state');
  wrap.append(icon(iconName), element('p', '', message));
  return wrap;
}
function renderOverviewBreakdown() {
  const holder = $('overview-category-list');
  holder.replaceChildren();
  const totals = categoryTotals('month').slice(0, 4);
  if (!totals.length) {
    holder.appendChild(element('p', 'empty-inline', 'Add a few expenses to see your spending breakdown.'));
    return;
  }
  const max = totals[0].amount || 1;
  totals.forEach(row => {
    const line = element('div', 'mini-breakdown-row');
    const top = element('div', 'mini-breakdown-top');
    top.append(element('span', '', row.category), element('strong', '', formatCurrency(row.amount)));
    const track = element('div', 'bar-track');
    const fill = element('div', 'bar-fill');
    fill.style.width = `${Math.max(3, row.amount / max * 100)}%`;
    track.appendChild(fill);
    line.append(top, track);
    holder.appendChild(line);
  });
}
function transactionNode(tx, compact = false) {
  const row = element('article', `transaction-row ${tx.type === 'in' ? 'row-income' : 'row-expense'}`);
  const badge = element('div', `transaction-symbol ${tx.type === 'in' ? 'symbol-income' : 'symbol-expense'}`);
  badge.appendChild(icon(tx.type === 'in' ? 'ph-arrow-down-left' : 'ph-arrow-up-right'));
  const info = element('div', 'transaction-info');
  info.appendChild(element('strong', 'transaction-title', tx.title));
  const meta = element('div', 'transaction-meta');
  meta.appendChild(element('span', '', formatDateTime(tx.date, tx.time)));
  if (tx.category && tx.category !== 'Income') meta.appendChild(element('span', 'meta-pill', tx.category));
  if (tx.categorySuggested) meta.appendChild(element('span', 'meta-pill suggested-pill', 'Suggested'));
  if (tx.method) meta.appendChild(element('span', 'meta-pill method-pill', tx.method));
  info.appendChild(meta);
  const amountBox = element('div', 'transaction-amount-box');
  amountBox.appendChild(element('strong', `transaction-amount ${tx.type === 'in' ? 'amount-positive' : 'amount-negative'}`, `${tx.type === 'in' ? '+' : '−'}${formatCurrency(tx.amount)}`));
  if (!compact && !tx.systemManaged) {
    const actions = element('div', 'transaction-actions');
    const edit = element('button', 'mini-action', 'Edit');
    edit.type = 'button'; edit.appendChild(icon('ph-pencil-simple'));
    edit.addEventListener('click', () => openEditTransaction(tx.id));
    const del = element('button', 'mini-action delete-action', 'Delete');
    del.type = 'button'; del.appendChild(icon('ph-trash'));
    del.addEventListener('click', () => deleteTransaction(tx.id));
    actions.append(edit, del);
    amountBox.appendChild(actions);
  } else if (!compact && tx.systemManaged) {
    amountBox.appendChild(element('span', 'system-tag', tx.kind === 'loan-disbursement' ? 'Lending record' : tx.kind === 'loan-repayment' ? 'Repayment' : 'Card payment'));
  }
  row.append(badge, info, amountBox);
  return row;
}
function renderRecentTransactions() {
  const holder = $('recent-list');
  holder.replaceChildren();
  const recent = sortByDateDesc(transactions).slice(0, 6);
  if (!recent.length) holder.appendChild(emptyState('Nothing here yet. Start with your first cash in or cash out.', 'ph-wallet'));
  else recent.forEach(tx => holder.appendChild(transactionNode(tx, true)));
}
function renderActivity() {
  const holder = $('transactions-list');
  if (!holder) return;
  holder.replaceChildren();
  const query = ($('activity-search')?.value || '').trim().toLowerCase();
  const type = $('activity-type')?.value || 'all';
  const matches = sortByDateDesc(transactions).filter(tx => {
    if (type !== 'all' && tx.type !== type) return false;
    if (!query) return true;
    return `${tx.title} ${tx.category || ''} ${tx.method || ''}`.toLowerCase().includes(query);
  });
  if (!matches.length) holder.appendChild(emptyState(transactions.length ? 'No transactions match this search.' : 'No transactions have been recorded yet.', 'ph-magnifying-glass'));
  else matches.forEach(tx => holder.appendChild(transactionNode(tx, false)));
}
function renderInsights() {
  const period = $('insights-period').value || 'month';
  const rows = categoryTotals(period);
  const holder = $('category-breakdown');
  holder.replaceChildren();
  const total = sum(rows, r => r.amount);
  if (!rows.length) holder.appendChild(element('p', 'empty-inline', 'No spending recorded for this period yet.'));
  else {
    const max = rows[0].amount || 1;
    rows.forEach((row, index) => {
      const line = element('div', 'category-line');
      const head = element('div', 'category-line-head');
      const left = element('div', 'category-name-wrap');
      left.append(element('span', 'category-rank', String(index + 1)), element('strong', '', row.category));
      const pct = total ? (row.amount / total * 100) : 0;
      head.append(left, element('strong', 'category-value', formatCurrency(row.amount)));
      const track = element('div', 'bar-track category-track');
      const fill = element('div', 'bar-fill');
      fill.style.width = `${Math.max(2, row.amount / max * 100)}%`;
      track.appendChild(fill);
      line.append(head, track, element('small', 'category-percent', `${pct.toFixed(1)}% of tracked spending`));
      holder.appendChild(line);
    });
  }
  renderMethodList($('income-methods'), methodTotals('in'), 'No income recorded.');
  renderMethodList($('expense-methods'), methodTotals('out'), 'No spending recorded.');
}
function renderMethodList(holder, rows, emptyText) {
  holder.replaceChildren();
  const total = sum(rows, r => r.amount);
  if (!rows.length) { holder.appendChild(element('p', 'empty-inline', emptyText)); return; }
  rows.forEach(row => {
    const line = element('div', 'method-row');
    const pct = total ? row.amount / total * 100 : 0;
    line.append(element('span', '', row.method), element('strong', '', formatCurrency(row.amount)));
    const track = element('div', 'bar-track');
    const fill = element('div', 'bar-fill'); fill.style.width = `${Math.max(2, pct)}%`; track.appendChild(fill);
    const block = element('div', 'method-row-wrap'); block.append(line, track); holder.appendChild(block);
  });
}
function renderCreditPurchases() {
  const holder = $('card-purchase-list');
  holder.replaceChildren();
  const rows = [...creditPurchases].sort((a, b) => b.date.localeCompare(a.date));
  if (!rows.length) { holder.appendChild(emptyState('No credit card purchases yet. Add one to start tracking the outstanding amount.', 'ph-credit-card')); return; }
  rows.forEach(purchase => {
    const outstanding = safeNumber(purchase.amount - purchase.paidAmount);
    const row = element('article', 'record-card');
    const top = element('div', 'record-top');
    const titleGroup = element('div', 'record-title-group');
    titleGroup.append(element('strong', 'record-title', purchase.title), element('span', 'record-subtitle', `${purchase.cardName} · ${purchase.category}`));
    top.append(titleGroup, element('strong', 'record-amount', formatCurrency(purchase.amount)));
    const foot = element('div', 'record-foot');
    foot.append(element('span', '', `Bought ${formatDate(purchase.date)}`));
    const dueClass = outstanding <= 0 ? 'status-paid' : (purchase.dueDate <= localDateISO() ? 'status-due' : 'status-pending');
    const dueText = outstanding <= 0 ? 'Paid' : `Reminder ${formatDate(purchase.dueDate)}`;
    foot.append(element('span', `status-pill ${dueClass}`, dueText));
    row.append(top, foot);
    const bottom = element('div', 'record-bottom');
    bottom.append(element('span', 'muted-line', outstanding > 0 ? `Still due ${formatCurrency(outstanding)}` : `Settled ${formatCurrency(purchase.amount)}`));
    const actions = element('div', 'record-actions');
    if (outstanding > 0) {
      const pay = element('button', 'text-link', 'Pay this'); pay.type = 'button'; pay.addEventListener('click', () => openCardPaymentModal(outstanding, purchase.id)); actions.appendChild(pay);
    }
    if (purchase.paidAmount <= 0) {
      const edit = element('button', 'mini-action', 'Edit'); edit.type = 'button'; edit.appendChild(icon('ph-pencil-simple')); edit.addEventListener('click', () => openEditCardPurchase(purchase.id)); actions.appendChild(edit);
      const del = element('button', 'mini-action delete-action', 'Delete'); del.type = 'button'; del.appendChild(icon('ph-trash')); del.addEventListener('click', () => deleteCardPurchase(purchase.id)); actions.appendChild(del);
    }
    bottom.appendChild(actions);
    row.appendChild(bottom);
    holder.appendChild(row);
  });
}
function renderLoans() {
  const holder = $('loan-list');
  holder.replaceChildren();
  const rows = [...loans].sort((a, b) => b.lentOn.localeCompare(a.lentOn));
  if (!rows.length) { holder.appendChild(emptyState('No lending records yet. Add money you lend so it does not get forgotten.', 'ph-hand-coins')); return; }
  rows.forEach(loan => {
    const row = element('article', 'record-card');
    const top = element('div', 'record-top');
    const titleGroup = element('div', 'record-title-group');
    titleGroup.append(element('strong', 'record-title', loan.person), element('span', 'record-subtitle', loan.note || 'Personal lending'));
    top.append(titleGroup, element('strong', 'record-amount', formatCurrency(loan.amount)));
    const foot = element('div', 'record-foot');
    foot.append(element('span', '', `Lent ${formatDate(loan.lentOn)}`));
    const dueClass = loan.outstanding <= 0 ? 'status-paid' : (loan.dueDate <= localDateISO() ? 'status-due' : 'status-pending');
    const dueText = loan.outstanding <= 0 ? 'Returned' : `Follow up ${formatDate(loan.dueDate)}`;
    foot.append(element('span', `status-pill ${dueClass}`, dueText));
    row.append(top, foot);
    const bottom = element('div', 'record-bottom');
    bottom.append(element('span', 'muted-line', loan.outstanding > 0 ? `Still owed ${formatCurrency(loan.outstanding)}` : 'Fully returned'));
    const actions = element('div', 'record-actions');
    if (loan.outstanding > 0) {
      const repay = element('button', 'text-link', 'Record return'); repay.type = 'button'; repay.addEventListener('click', () => openLoanRepayment(loan.id)); actions.appendChild(repay);
    }
    const edit = element('button', 'mini-action', 'Edit'); edit.type = 'button'; edit.appendChild(icon('ph-pencil-simple')); edit.addEventListener('click', () => openEditLoan(loan.id)); actions.appendChild(edit);
    const del = element('button', 'mini-action delete-action', 'Delete'); del.type = 'button'; del.appendChild(icon('ph-trash')); del.addEventListener('click', () => deleteLoan(loan.id)); actions.appendChild(del);
    bottom.appendChild(actions);
    row.appendChild(bottom);
    holder.appendChild(row);
  });
}
function getDueReminders() {
  const today = localDateISO();
  const cardItems = creditPurchases.filter(p => p.amount > p.paidAmount && p.dueDate <= today).map(p => ({
    id: `card:${p.id}`, type: 'card', title: `${p.cardName}: ${p.title}`, amount: safeNumber(p.amount - p.paidAmount), dueDate: p.dueDate
  }));
  const loanItems = loans.filter(l => l.outstanding > 0 && l.dueDate <= today).map(l => ({
    id: `loan:${l.id}`, type: 'loan', title: `Follow up with ${l.person}`, amount: l.outstanding, dueDate: l.dueDate
  }));
  return [...cardItems, ...loanItems].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}
function renderReminders() {
  const holder = $('reminder-list');
  holder.replaceChildren();
  const reminders = getDueReminders();
  if (!reminders.length) {
    const pendingCard = creditPurchases.filter(p => p.amount > p.paidAmount).sort((a,b) => a.dueDate.localeCompare(b.dueDate))[0];
    const pendingLoan = loans.filter(l => l.outstanding > 0).sort((a,b) => a.dueDate.localeCompare(b.dueDate))[0];
    const next = [pendingCard && { title: `Card reminder · ${pendingCard.title}`, dueDate: pendingCard.dueDate }, pendingLoan && { title: `Ask ${pendingLoan.person} to return the money`, dueDate: pendingLoan.dueDate }].filter(Boolean).sort((a,b)=>a.dueDate.localeCompare(b.dueDate))[0];
    holder.appendChild(element('p', 'empty-inline', next ? `Nothing overdue. Next follow-up: ${next.title} on ${formatDate(next.dueDate)}.` : 'You are all caught up.'));
    return;
  }
  reminders.forEach(item => {
    const row = element('div', 'reminder-row');
    const ic = element('span', `reminder-icon ${item.type === 'card' ? 'reminder-card-icon' : 'reminder-loan-icon'}`);
    ic.appendChild(icon(item.type === 'card' ? 'ph-credit-card' : 'ph-handshake'));
    const content = element('div', 'reminder-content');
    content.append(element('strong', '', item.title), element('small', '', `Due since ${formatDate(item.dueDate)} · ${formatCurrency(item.amount)}`));
    row.append(ic, content, element('span', 'overdue-pill', 'Due'));
    holder.appendChild(row);
  });
}
async function deliverDueReminders(force = false) {
  const reminders = getDueReminders();
  if (!reminders.length) return;
  const notifiedKey = user ? getStorageKey('notified') : null;
  let previouslyNotified = [];
  try { previouslyNotified = JSON.parse(localStorage.getItem(notifiedKey) || '[]'); } catch (_) { previouslyNotified = []; }
  const notified = new Set(Array.isArray(previouslyNotified) ? previouslyNotified : []);
  const fresh = reminders.filter(r => force || !notified.has(r.id));
  if (!fresh.length) return;
  fresh.forEach(r => notified.add(r.id));
  localStorage.setItem(notifiedKey, JSON.stringify([...notified]));
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = serviceWorkerRegistration || (await navigator.serviceWorker?.ready);
      if (reg && reg.showNotification) {
        for (const reminder of fresh) {
          await reg.showNotification(reminder.type === 'card' ? 'Credit card follow-up' : 'Money to collect', {
            body: `${reminder.title} · ${formatCurrency(reminder.amount)}`,
            icon: './icon-192.png',
            tag: reminder.id,
            data: { tab: reminder.type === 'card' ? 'cards' : 'loans' }
          });
        }
      } else {
        showToast(`${fresh.length} reminder(s) are due. Check the follow-up list.`);
      }
    } catch (error) {
      console.warn('Notification could not be shown:', error);
      showToast(`${fresh.length} reminder(s) are due. Check the follow-up list.`);
    }
  } else {
    showToast(`${fresh.length} follow-up reminder(s) are due. Check the overview.`);
  }
}
function showScreen(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  if (screen === 'auth') authScreen.classList.add('active');
  if (screen === 'main') {
    mainScreen.classList.add('active');
    displayName.textContent = user?.fullName || user?.name || 'there';
    changeTab('overview');
    updateDashboard();
    deliverDueReminders();
  }
}
function changeTab(tab) {
  appTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `tab-${tab}`));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Google is the only sign-in method. Signing out does not delete financial records.
$('logout-btn').addEventListener('click', async () => {
  localStorage.removeItem('apna_kharcha_user');
  if (monetraSupabase) {
    const { error } = await monetraSupabase.auth.signOut();
    if (error) { console.error('MONETRA sign out:', error); showToast('Could not sign out. Please try again.', 'error'); return; }
  }
  user = null; transactions = []; creditPurchases = []; loans = [];
  showScreen('auth');
});

// Cash in / cash out form, including edit existing transaction.
function openTransactionModal(type) {
  txForm.reset();
  $('tx-id').value = '';
  $('tx-type').value = type;
  $('modal-title').textContent = type === 'in' ? 'Add money received' : 'Add an expense';
  $('tx-submit-btn').textContent = type === 'in' ? 'Save money in' : 'Save expense';
  $('tx-category-group').hidden = type === 'in';
  $('tx-category').required = type === 'out';
  $('tx-method').value = 'Other';
  $('tx-date').value = localDateISO();
  const now = new Date(); $('tx-time').value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  showModal('transaction-modal');
  window.setTimeout(() => $('tx-amount').focus(), 80);
}
window.openTransactionModal = openTransactionModal;
function openEditTransaction(id) {
  const tx = transactions.find(item => item.id === id);
  if (!tx || tx.systemManaged) return;
  txForm.reset();
  $('tx-id').value = tx.id;
  $('tx-type').value = tx.type;
  $('modal-title').textContent = 'Edit transaction';
  $('tx-submit-btn').textContent = 'Save changes';
  $('tx-amount').value = tx.amount;
  $('tx-title').value = tx.title;
  $('tx-category').value = tx.category || 'Others';
  $('tx-method').value = METHODS.includes(tx.method) ? tx.method : 'Other';
  $('tx-date').value = tx.date;
  $('tx-time').value = tx.time || '00:00';
  $('tx-category-group').hidden = tx.type === 'in';
  $('tx-category').required = tx.type === 'out';
  showModal('transaction-modal');
}
function showModal(id) {
  const modal = $(id);
  if (!modal) {
    console.error(`MONETRA: modal not found: ${id}`);
    return false;
  }
  document.querySelectorAll('.modal-overlay.active').forEach(open => {
    if (open !== modal) closeModal(open.id);
  });
  modal.style.removeProperty('display');
  modal.style.removeProperty('pointer-events');
  modal.hidden = false;
  modal.removeAttribute('inert');
  modal.setAttribute('aria-hidden', 'false');
  modal.classList.add('active');
  document.body.classList.add('modal-open');
  return true;
}
function closeModal(id) {
  const modal = typeof id === 'string' ? $(id) : id;
  if (!modal) return false;
  modal.classList.remove('active');
  modal.setAttribute('aria-hidden', 'true');
  modal.hidden = true;
  // Explicitly suppress display and touch events as an extra safeguard against
  // stale modal styles in installed PWAs / Android Custom Tabs.
  modal.style.setProperty('display', 'none');
  modal.style.setProperty('pointer-events', 'none');
  modal.setAttribute('inert', '');
  if (!document.querySelector('.modal-overlay.active')) document.body.classList.remove('modal-open');
  return true;
}
// Expose the real modal function directly. Do not wrap it by calling the global
// closeModal name: that would recurse after the window property is reassigned.
window.closeModal = closeModal;
txForm.addEventListener('submit', async event => {
  event.preventDefault();
  const id = $('tx-id').value;
  const type = $('tx-type').value;
  const amount = safeNumber($('tx-amount').value);
  const title = $('tx-title').value.trim();
  const date = $('tx-date').value;
  const time = $('tx-time').value;
  const category = type === 'out' ? $('tx-category').value : 'Income';
  const method = $('tx-method').value;
  if (!amount || amount <= 0 || !title || !isValidDateISO(date) || !/^\d{2}:\d{2}$/.test(time) || !METHODS.includes(method) || (type === 'out' && !EXPENSE_CATEGORIES.includes(category))) {
    showToast('Please complete the amount, description, category, method and date.', 'error'); return;
  }
  if (id) {
    const index = transactions.findIndex(tx => tx.id === id);
    if (index < 0 || transactions[index].systemManaged) { showToast('This linked record must be updated from its own section.', 'error'); return; }
    transactions[index] = { ...transactions[index], amount, title, date, time, type, category, method, categorySuggested: false };
  } else {
    transactions.push({ id: createId('tx'), amount, title, date, time, type, category, method, categorySuggested: false });
  }
  transactions = sortByDateDesc(transactions);
  if (!await saveAndRefresh('transaction-modal')) return;
  showToast(id ? 'Transaction updated.' : (type === 'in' ? 'Money received has been recorded.' : 'Expense saved.'));
});
async function deleteTransaction(id) {
  const tx = transactions.find(item => item.id === id);
  if (!tx || tx.systemManaged) { showToast('This linked item is managed in its own section.', 'error'); return; }
  if (!window.confirm(`Delete “${tx.title}” (${formatCurrency(tx.amount)})?`)) return;
  const previous = transactions;
  transactions = transactions.filter(item => item.id !== id);
  if (!saveData()) { transactions = previous; refreshDashboardSafely(); return; }
  refreshDashboardSafely();
  if (!cloudSyncReady) {
    showToast('Removed on this device only. Cloud sync is not ready; do not use another device until synchronization succeeds.', 'error');
    return;
  }
  const synced = await lastCloudSyncPromise;
  if (synced) showToast('Transaction deleted and deletion confirmed in your MONETRA cloud account.');
  else showToast('Transaction is removed on this device, but Supabase did not confirm the deletion. Keep this device data and reload after fixing the sync error.', 'error');
}
window.deleteTransaction = deleteTransaction;

// Credit card purchases and repayments. Card purchases are not cash out until paid.
function openCardPurchaseModal() {
  $('card-purchase-form').reset();
  $('cc-id').value = '';
  $('card-modal-title').textContent = 'Add a card purchase';
  $('cc-date').value = localDateISO();
  $('cc-card-name').value = creditPurchases[0]?.cardName || 'My Credit Card';
  showModal('card-purchase-modal');
}
function openEditCardPurchase(id) {
  const purchase = creditPurchases.find(p => p.id === id);
  if (!purchase || purchase.paidAmount > 0) return;
  $('card-purchase-form').reset();
  $('cc-id').value = purchase.id;
  $('card-modal-title').textContent = 'Edit card purchase';
  $('cc-amount').value = purchase.amount;
  $('cc-title').value = purchase.title;
  $('cc-category').value = purchase.category;
  $('cc-card-name').value = purchase.cardName;
  $('cc-date').value = purchase.date;
  showModal('card-purchase-modal');
}
async function deleteCardPurchase(id) {
  const purchase = creditPurchases.find(p => p.id === id);
  if (!purchase || purchase.paidAmount > 0) return;
  if (!window.confirm(`Delete “${purchase.title}” (${formatCurrency(purchase.amount)})?`)) return;
  const previous = creditPurchases;
  creditPurchases = creditPurchases.filter(p => p.id !== id);
  if (!saveData()) { creditPurchases = previous; refreshDashboardSafely(); return; }
  refreshDashboardSafely();
  if (!cloudSyncReady) {
    showToast('Removed on this device only. Cloud sync is not ready; do not use another device until synchronization succeeds.', 'error');
    return;
  }
  const synced = await lastCloudSyncPromise;
  if (synced) showToast('Card purchase deleted and deletion confirmed in your MONETRA cloud account.');
  else showToast('Card purchase is removed on this device, but Supabase did not confirm the deletion. Keep this device data and reload after fixing the sync error.', 'error');
}
window.openCardPurchaseModal = openCardPurchaseModal;
$('add-card-purchase-btn').addEventListener('click', openCardPurchaseModal);
$('card-purchase-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = $('cc-id').value;
  const amount = safeNumber($('cc-amount').value);
  const title = $('cc-title').value.trim();
  const category = $('cc-category').value;
  const cardName = $('cc-card-name').value.trim();
  const date = $('cc-date').value;
  if (!amount || amount <= 0 || !title || !cardName || !CATEGORIES.includes(category) || category === 'Money Lent' || !isValidDateISO(date)) {
    showToast('Please complete all card purchase details.', 'error'); return;
  }
  if (id) {
    const index = creditPurchases.findIndex(p => p.id === id);
    if (index < 0 || creditPurchases[index].paidAmount > 0) { showToast('A card purchase with payments already recorded cannot be edited here.', 'error'); return; }
    creditPurchases[index] = { ...creditPurchases[index], amount, title, category, cardName, date, dueDate: addDaysISO(date, 25) };
  } else {
    creditPurchases.push({ id: createId('card'), amount, paidAmount: 0, title, category, cardName, date, dueDate: addDaysISO(date, 25), payments: [], createdAt: new Date().toISOString() });
  }
  if (!await saveAndRefresh('card-purchase-modal')) return;
  showToast(id ? 'Card purchase updated.' : 'Card purchase saved. It will be included in spending insights, not deducted from cash yet.');
});
function openCardPaymentModal(prefillAmount = null, targetPurchaseId = '') {
  const outstanding = cardOutstanding();
  if (outstanding <= 0) { showToast('There is no outstanding card amount to pay.', 'error'); return; }
  $('card-payment-form').reset();
  $('card-payment-target-id').value = targetPurchaseId || '';
  $('payment-outstanding-label').textContent = formatCurrency(outstanding);
  $('card-payment-amount').max = outstanding.toFixed(2);
  $('card-payment-amount').value = (prefillAmount ? Math.min(prefillAmount, outstanding) : outstanding).toFixed(2);
  $('card-payment-date').value = localDateISO();
  showModal('card-payment-modal');
}
$('pay-card-btn').addEventListener('click', () => openCardPaymentModal());
$('card-payment-form').addEventListener('submit', async event => {
  event.preventDefault();
  const amount = safeNumber($('card-payment-amount').value);
  const outstanding = cardOutstanding();
  const method = $('card-payment-method').value;
  const date = $('card-payment-date').value;
  if (!amount || amount <= 0 || amount > outstanding + 0.001 || !MONEY_METHODS.includes(method) || !isValidDateISO(date)) {
    showToast(`Enter a payment between ₹0.01 and ${formatCurrency(outstanding)}.`, 'error'); return;
  }
  let remaining = amount;
  const allocations = [];
  const targetPurchaseId = $('card-payment-target-id').value;
  const pending = [...creditPurchases].filter(p => p.amount > p.paidAmount).sort((a, b) => {
    if (a.id === targetPurchaseId) return -1;
    if (b.id === targetPurchaseId) return 1;
    return a.date.localeCompare(b.date);
  });
  pending.forEach(purchase => {
    if (remaining <= 0.001) return;
    const due = safeNumber(purchase.amount - purchase.paidAmount);
    const applied = safeNumber(Math.min(due, remaining));
    if (applied > 0) {
      purchase.paidAmount = safeNumber(purchase.paidAmount + applied);
      purchase.payments = Array.isArray(purchase.payments) ? purchase.payments : [];
      purchase.payments.push({ date, amount: applied, method });
      allocations.push({ purchaseId: purchase.id, amount: applied });
      remaining = safeNumber(remaining - applied);
    }
  });
  const paymentId = createId('cc-payment');
  transactions.push({ id: paymentId, amount, title: 'Credit card payment', date, time: `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`, type: 'out', category: 'Credit Card Payment', method, kind: 'credit-card-payment', systemManaged: true, excludeFromSpendStats: true, ccAllocations: allocations });
  if (!await saveAndRefresh('card-payment-modal')) return;
  showToast('Card payment recorded and deducted from your available balance.');
});

// Lending and partial/full repayments.
function openLoanModal() {
  $('loan-form').reset();
  $('loan-id').value = '';
  $('loan-modal-title').textContent = 'Record money lent';
  $('loan-date').value = localDateISO();
  showModal('loan-modal');
}
function openEditLoan(id) {
  const loan = loans.find(item => item.id === id);
  if (!loan) return;
  $('loan-form').reset();
  $('loan-id').value = loan.id;
  $('loan-modal-title').textContent = 'Edit lending record';
  $('loan-amount').value = loan.amount;
  $('loan-person').value = loan.person;
  $('loan-note').value = loan.note || '';
  $('loan-date').value = loan.lentOn;
  const source = transactions.find(tx => tx.id === loan.sourceTransactionId);
  $('loan-method').value = source?.method || 'Other';
  showModal('loan-modal');
}
window.openLoanModal = openLoanModal;
$('add-loan-btn').addEventListener('click', openLoanModal);
$('loan-form').addEventListener('submit', async event => {
  event.preventDefault();
  const loanId = $('loan-id').value;
  const amount = safeNumber($('loan-amount').value);
  const person = $('loan-person').value.trim();
  const note = $('loan-note').value.trim();
  const date = $('loan-date').value;
  const method = $('loan-method').value;
  if (!amount || amount <= 0 || !person || !isValidDateISO(date) || !MONEY_METHODS.includes(method)) {
    showToast('Please enter a valid amount, person, date and payment method.', 'error'); return;
  }
  let successMessage = '';
  if (loanId) {
    const loan = loans.find(item => item.id === loanId);
    if (!loan) { showToast('Lending record could not be found.', 'error'); return; }
    const alreadyReturned = safeNumber(sum(loan.repayments || [], r => r.amount));
    if (amount + 0.001 < alreadyReturned) { showToast(`The amount cannot be less than repayments already received (${formatCurrency(alreadyReturned)}).`, 'error'); return; }
    loan.amount = amount;
    loan.outstanding = safeNumber(amount - alreadyReturned);
    loan.person = person;
    loan.note = note;
    loan.lentOn = date;
    loan.dueDate = addDaysISO(date, 20);
    const source = transactions.find(tx => tx.id === loan.sourceTransactionId);
    if (source) { source.amount = amount; source.title = `Money lent to ${person}`; source.date = date; source.method = method; }
    successMessage = 'Lending record updated. Your available balance has been recalculated.';
  } else {
    const newLoanId = createId('loan');
    const txId = createId('tx-loan');
    const loan = { id: newLoanId, person, note, amount, outstanding: amount, lentOn: date, dueDate: addDaysISO(date, 20), sourceTransactionId: txId, repayments: [] };
    loans.push(loan);
    transactions.push({ id: txId, amount, title: `Money lent to ${person}`, date, time: '12:00', type: 'out', category: 'Money Lent', method, kind: 'loan-disbursement', loanId: newLoanId, systemManaged: true, excludeFromSpendStats: true });
    successMessage = `Recorded. ${formatCurrency(amount)} has been deducted from your balance.`;
  }
  if (!await saveAndRefresh('loan-modal')) return;
  showToast(successMessage);
});
async function deleteLoan(id) {
  const loan = loans.find(item => item.id === id);
  if (!loan) return;

  // The loan and its linked ledger entries are one logical deletion.
  const linked = transactions.filter(tx => tx.loanId === id || tx.id === loan.sourceTransactionId);
  const repayments = linked.filter(tx => tx.kind === 'loan-repayment');
  const returnedAmount = sum(repayments, tx => tx.amount);
  const confirmation = `Delete the lending record for ${loan.person}?\n\nThis removes the original ${formatCurrency(loan.amount)} lending entry and ${repayments.length} linked repayment ${repayments.length === 1 ? 'entry' : 'entries'}${returnedAmount > 0 ? ` totalling ${formatCurrency(returnedAmount)}` : ''} from your app history and balance calculation.\n\nThis cannot be undone unless you have a backup.`;
  if (!window.confirm(confirmation)) return;

  const previousLoans = loans;
  const previousTransactions = transactions;
  loans = loans.filter(item => item.id !== id);
  transactions = transactions.filter(tx => tx.loanId !== id && tx.id !== loan.sourceTransactionId);
  if (!saveData()) {
    loans = previousLoans;
    transactions = previousTransactions;
    refreshDashboardSafely();
    return;
  }
  refreshDashboardSafely();
  if (!cloudSyncReady) {
    showToast('Removed on this device only. Cloud sync is not ready; do not use another device until synchronization succeeds.', 'error');
    return;
  }
  const synced = await lastCloudSyncPromise;
  if (synced) showToast(`Lending record for ${loan.person} and its linked entries were deleted and confirmed in your MONETRA cloud account.`);
  else showToast('Lending record is removed on this device, but Supabase did not confirm every deletion. Keep this device data and reload after fixing the sync error.', 'error');
}
window.deleteLoan = deleteLoan;
function openLoanRepayment(id) {
  const loan = loans.find(item => item.id === id);
  if (!loan || loan.outstanding <= 0) return;
  $('loan-repayment-form').reset();
  $('repayment-loan-id').value = loan.id;
  $('repayment-person').textContent = loan.person;
  $('repayment-outstanding').textContent = formatCurrency(loan.outstanding);
  $('repayment-amount').max = loan.outstanding.toFixed(2);
  $('repayment-amount').value = loan.outstanding.toFixed(2);
  $('repayment-date').value = localDateISO();
  showModal('loan-repayment-modal');
}
$('loan-repayment-form').addEventListener('submit', async event => {
  event.preventDefault();
  const loan = loans.find(item => item.id === $('repayment-loan-id').value);
  if (!loan || loan.outstanding <= 0) return;
  const amount = safeNumber($('repayment-amount').value);
  const method = $('repayment-method').value;
  const date = $('repayment-date').value;
  if (!amount || amount <= 0 || amount > loan.outstanding + 0.001 || !MONEY_METHODS.includes(method) || !isValidDateISO(date)) {
    showToast(`Enter a repayment between ₹0.01 and ${formatCurrency(loan.outstanding)}.`, 'error'); return;
  }
  loan.outstanding = safeNumber(loan.outstanding - amount);
  loan.repayments = Array.isArray(loan.repayments) ? loan.repayments : [];
  loan.repayments.push({ id: createId('repay'), amount, date, method });
  transactions.push({ id: createId('tx-repay'), amount, title: `Money returned by ${loan.person}`, date, time: '12:00', type: 'in', category: 'Loan repayment', method, kind: 'loan-repayment', loanId: loan.id, systemManaged: true, excludeFromIncomeStats: true });
  if (!await saveAndRefresh('loan-repayment-modal')) return;
  showToast('Repayment recorded. Your available balance has been increased.');
});

// Tabs, filters and modal controls.
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => changeTab(btn.dataset.tab)));
document.querySelectorAll('[data-go-tab]').forEach(btn => btn.addEventListener('click', () => changeTab(btn.dataset.goTab)));
document.querySelectorAll('.modal-overlay').forEach(modal => {
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
});
// One capture-phase handler owns all modal dismissals. It intentionally handles clicks
// on the close button's child icon as well as the button itself.
document.addEventListener('click', event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const closeButton = target.closest('[data-close]');
  if (closeButton) {
    event.preventDefault();
    event.stopPropagation();
    closeModal(closeButton.getAttribute('data-close'));
    return;
  }
  if (target.classList.contains('modal-overlay')) closeModal(target.id);
}, true);

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const activeModal = document.querySelector('.modal-overlay.active');
  if (activeModal) {
    event.preventDefault();
    closeModal(activeModal.id);
  }
});
$('insights-period').addEventListener('change', renderInsights);
$('activity-search').addEventListener('input', renderActivity);
$('activity-type').addEventListener('change', renderActivity);

// Backup format v2, while continuing to accept the original array-of-transactions JSON.
function downloadBlob(filename, blob) {
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error('The file could not be prepared.');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.position = 'fixed';
  link.style.left = '-10000px';
  link.style.top = '0';
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Keep the object URL alive long enough for Android/Chrome's download manager to read it.
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}
$('backup-btn').addEventListener('click', () => showModal('backup-modal'));
$('download-backup').addEventListener('click', () => {
  const backup = { format: 'apna-kharcha-backup', version: APP_VERSION, exportedAt: new Date().toISOString(), user: { name: user?.name || '', fullName: user?.fullName || '' }, transactions, creditPurchases, loans };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
  downloadBlob(`MONETRA_Full_Backup_${user.name}_${localDateISO()}.json`, blob);
  closeModal('backup-modal');
  showToast('Full backup downloaded. Keep it somewhere private.');
});
$('restore-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 15 * 1024 * 1024) throw new Error('This backup is unusually large. Please choose a file under 15 MB.');
    const parsed = JSON.parse(await file.text());
    let restored;
    if (Array.isArray(parsed)) {
      restored = migrateLegacyArray(parsed);
    } else if (parsed && parsed.format === 'apna-kharcha-backup' && Number(parsed.version) >= 2) {
      if (!Array.isArray(parsed.transactions) || !Array.isArray(parsed.creditPurchases) || !Array.isArray(parsed.loans)) throw new Error('The backup is missing one or more data sections.');
      restored = {
        transactions: parsed.transactions.map((tx, i) => normalizeTransaction(tx, i, false)),
        creditPurchases: parsed.creditPurchases.map(normalizeCardPurchase),
        loans: parsed.loans.map(normalizeLoan)
      };
    } else {
      throw new Error('This is not a recognised MONETRA or legacy Apna Kharcha backup.');
    }
    if (!restored.transactions.length) throw new Error('The backup does not contain any transactions.');
    const dates = restored.transactions.map(tx => tx.date).sort();
    const legacyNote = Array.isArray(parsed) ? '\n\nThis older file has no category or payment-method fields. Categories will be suggested from descriptions, and unclear methods will be set to Other.' : '';
    const summary = `${restored.transactions.length} transactions${restored.creditPurchases.length ? `, ${restored.creditPurchases.length} card purchases` : ''}${restored.loans.length ? `, ${restored.loans.length} lending records` : ''}.\nPeriod: ${dates[0]} to ${dates[dates.length - 1]}.${legacyNote}\n\nThis will replace the records currently stored in this app. Continue?`;
    if (!window.confirm(summary)) return;
    transactions = sortByDateDesc(restored.transactions);
    creditPurchases = restored.creditPurchases;
    loans = restored.loans;
    localStorage.removeItem(getStorageKey('notified'));
    if (!await saveAndRefresh('backup-modal', { allowRestore: true })) return;
    showToast(`Restored ${transactions.length} transactions and synchronized them to your Google account.`);
  } catch (error) {
    console.error('Restore failed:', error);
    showToast(error.message || 'Could not restore this backup.', 'error');
  } finally {
    event.target.value = '';
  }
});

// Reminder permission is opt-in. Due dates are checked at app open and while it remains open.
$('notifications-btn').addEventListener('click', async () => {
  if (!('Notification' in window)) { showToast('This browser does not support notifications. In-app reminders will still appear.'); return; }
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') { showToast('Notifications enabled for reminders.'); await deliverDueReminders(true); }
    else showToast('Notifications are off. Due reminders will remain visible in the app.');
  } catch (error) { console.warn(error); showToast('Could not enable notifications.'); }
});

// PDF statement. This creates a real PDF directly, without relying on a third-party CDN.
// That keeps statement downloads available when html2pdf/canvas CDNs are blocked or offline.
const exportModal = $('export-modal');
$('open-export-modal').addEventListener('click', () => {
  if (!transactions.length && !creditPurchases.length) {
    showToast('There are no records to export yet.', 'error');
    return;
  }
  const now = new Date();
  $('export-start').value = localDateISO(new Date(now.getFullYear(), now.getMonth(), 1));
  $('export-end').value = localDateISO();
  showModal('export-modal');
});
document.querySelectorAll('input[name="export-range"]').forEach(radio => radio.addEventListener('change', () => {
  const selected = document.querySelector('input[name="export-range"]:checked');
  $('export-date-range').hidden = !selected || selected.value !== 'custom';
}));

function pdfAscii(value) {
  return String(value ?? '')
    .replace(/₹/g, 'INR ')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2022\u00b7]/g, ' | ')
    .replace(/\u2026/g, '...')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '?');
}
function pdfEscape(value) {
  return pdfAscii(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
function pdfWrap(value, maxChars, maxLines = 2) {
  const clean = pdfAscii(value).replace(/\s+/g, ' ').trim();
  if (!clean) return ['-'];
  const words = clean.split(' ');
  const lines = [];
  let line = '';
  for (let word of words) {
    while (word.length > maxChars) {
      if (line) { lines.push(line); line = ''; }
      if (lines.length >= maxLines) break;
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (lines.length >= maxLines) break;
    if (!word) continue;
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) { lines.push(line); line = word; }
    else line = next;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (!lines.length) return ['-'];
  const consumed = lines.join(' ').replace(/\s/g, '').length;
  const original = clean.replace(/\s/g, '').length;
  if (consumed < original) {
    const last = lines.length - 1;
    lines[last] = lines[last].replace(/[. ]+$/g, '') + '...';
  }
  return lines;
}
function pdfCurrency(value) {
  return `INR ${safeNumber(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function pdfCompactCurrency(value) {
  return safeNumber(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function isLoanRepaymentEntry(tx) {
  return tx.kind === 'loan-repayment' || tx.category === 'Loan repayment';
}
function isLoanDisbursementEntry(tx) {
  return tx.kind === 'loan-disbursement' || tx.category === 'Money Lent';
}
function isCardRepaymentEntry(tx) {
  return tx.kind === 'credit-card-payment' || tx.category === 'Credit Card Payment';
}
function isDirectExpenseEntry(tx) {
  return tx.type === 'out' && !tx.excludeFromSpendStats && !isLoanDisbursementEntry(tx) && !isCardRepaymentEntry(tx) && tx.category !== 'Money Lent';
}
function groupPdfAmounts(items, getKey, getAmount, labels) {
  const totals = new Map((labels || []).map(label => [label, 0]));
  items.forEach(item => {
    const key = getKey(item) || 'Other';
    totals.set(key, safeNumber((totals.get(key) || 0) + Number(getAmount(item) || 0)));
  });
  return [...totals.entries()].map(([label, amount]) => ({ label, amount })).filter(item => item.amount > 0).sort((a, b) => b.amount - a.amount);
}
function calculateOutstandingAtDate(items, amountField, purchaseDateField, repaymentsField, endDate, today) {
  let total = 0;
  let complete = true;
  items.forEach(item => {
    if (String(item[purchaseDateField] || '') > endDate) return;
    const repayments = Array.isArray(item[repaymentsField]) ? item[repaymentsField] : [];
    let paid = safeNumber(repayments.filter(payment => isValidDateISO(payment.date) && payment.date <= endDate)
      .reduce((s, payment) => s + Number(payment.amount || 0), 0));
    // Old records can contain a current paid/outstanding snapshot without dated repayment rows.
    // It is safe for a statement ending today, but must not be backdated into an earlier period.
    if (!repayments.length) {
      const storedPaid = repaymentsField === 'payments'
        ? safeNumber(item.paidAmount || 0)
        : safeNumber(Number(item.amount || 0) - Number(item.outstanding ?? item.amount));
      if (endDate >= today) paid = storedPaid;
      else if (storedPaid > 0) complete = false;
    }
    total += Math.max(0, Number(item[amountField] || 0) - paid);
  });
  return { value: complete ? safeNumber(total) : null, complete };
}
function makeStatementPdf(report) {
  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const LEFT = 36;
  const RIGHT = 559;
  const CONTENT_W = RIGHT - LEFT;
  const pages = [];
  let ops = [];

  const C = {
    forest: [0.075, 0.225, 0.155],
    forest2: [0.12, 0.32, 0.235],
    ink: [0.13, 0.19, 0.155],
    muted: [0.39, 0.46, 0.41],
    sage: [0.43, 0.57, 0.47],
    gold: [0.82, 0.67, 0.40],
    white: [1, 1, 1],
    paper: [0.985, 0.989, 0.979],
    panel: [0.965, 0.976, 0.960],
    border: [0.87, 0.90, 0.86],
    green: [0.16, 0.45, 0.30],
    greenLight: [0.91, 0.955, 0.92],
    red: [0.70, 0.31, 0.27],
    redLight: [0.985, 0.94, 0.93],
    blue: [0.29, 0.43, 0.58],
    blueLight: [0.93, 0.955, 0.975],
    amberLight: [0.985, 0.965, 0.92],
    grayBar: [0.89, 0.92, 0.88]
  };
  const rgb = color => color.map(v => Number(v).toFixed(3)).join(' ');
  const rect = (x, y, w, h, color) => ops.push(`q ${rgb(color)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f Q`);
  const strokeRect = (x, y, w, h, color, width = 0.6) => ops.push(`q ${rgb(color)} RG ${width} w ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S Q`);
  const line = (x1, y1, x2, y2, color = C.border, width = 0.55) => ops.push(`q ${rgb(color)} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S Q`);
  const text = (x, y, value, size = 8, font = 'F1', color = C.ink) => {
    const safe = pdfEscape(value);
    ops.push(`q ${rgb(color)} rg BT /${font} ${size.toFixed(2)} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${safe}) Tj ET Q`);
  };
  const textRight = (rightX, y, value, size = 8, font = 'F1', color = C.ink) => {
    const safe = pdfAscii(value);
    // A conservative Helvetica width estimate; it keeps amounts aligned without clipping.
    const width = safe.length * size * 0.54;
    text(rightX - width, y, safe, size, font, color);
  };
  const bar = (x, y, w, h, ratio, color = C.green) => {
    rect(x, y, w, h, C.grayBar);
    if (ratio > 0) rect(x, y, Math.max(1.5, w * Math.min(1, ratio)), h, color);
  };
  const sectionTitle = (x, y, title, subtitle = '') => {
    text(x, y, title.toUpperCase(), 8.2, 'F2', C.forest);
    if (subtitle) text(x, y - 11, subtitle, 6.8, 'F1', C.muted);
  };
  const addFooter = pageIndex => {
    line(LEFT, 38, RIGHT, 38, C.border, 0.65);
    text(LEFT, 24, 'MONETRA  |  PERSONAL FINANCIAL RECORD', 6.4, 'F2', C.muted);
    textRight(RIGHT, 24, `PAGE ${pageIndex + 1} OF __TOTAL__`, 6.4, 'F1', C.muted);
  };
  const startPage = () => { ops = []; };
  const finishPage = () => pages.push(ops.join('\n'));

  // PAGE 1: executive summary, cash flow, spending patterns and outstanding balances.
  startPage();
  rect(0, 716, PAGE_W, 126, C.forest);
  rect(0, 712, PAGE_W, 4, C.gold);
  text(LEFT, 798, 'MONETRA', 21, 'F2', C.white);
  text(LEFT, 780, 'PERSONAL FINANCE  |  CASH FLOW & SPENDING REPORT  |  AMOUNTS IN INR', 7.2, 'F2', [0.83, 0.88, 0.83]);
  text(LEFT, 754, `PREPARED FOR  ${pdfWrap(report.accountName || 'Personal account', 42, 1)[0]}`, 8, 'F1', C.white);
  text(LEFT, 738, `REPORT PERIOD  ${pdfWrap(report.period || 'All records', 48, 1)[0]}`, 8, 'F2', C.white);
  rect(439, 786, 120, 21, C.forest2);
  text(451, 793, 'PRIVATE STATEMENT', 7, 'F2', C.white);
  textRight(RIGHT, 755, `Generated ${report.generatedAt}`, 6.8, 'F1', [0.88, 0.91, 0.87]);

  // Three high-level measures are all actual recorded cash movements.
  const kpis = [
    { label: 'CASH RECEIVED', value: pdfCurrency(report.cashIn), note: 'All recorded inflows', fill: C.greenLight, valueColor: C.green },
    { label: 'CASH PAID OUT', value: pdfCurrency(report.cashOut), note: 'All recorded outflows', fill: C.redLight, valueColor: C.red },
    { label: 'NET CASH MOVEMENT', value: pdfCurrency(report.netCash), note: 'Received minus paid out', fill: C.blueLight, valueColor: report.netCash >= 0 ? C.green : C.red }
  ];
  const kpiTop = 696, kpiH = 67, gap = 10, kpiW = (CONTENT_W - gap * 2) / 3;
  kpis.forEach((kpi, i) => {
    const x = LEFT + i * (kpiW + gap);
    rect(x, kpiTop - kpiH, kpiW, kpiH, kpi.fill);
    rect(x, kpiTop - 4, kpiW, 4, i === 1 ? C.red : (i === 2 ? C.blue : C.green));
    text(x + 10, kpiTop - 19, kpi.label, 7, 'F2', C.muted);
    text(x + 10, kpiTop - 42, pdfWrap(kpi.value, 22, 1)[0], 11, 'F2', kpi.valueColor);
    text(x + 10, kpiTop - 56, kpi.note, 6.3, 'F1', C.muted);
  });

  sectionTitle(LEFT, 608, 'Cash flow summary', 'Actual movements recorded in your cash and bank balances');
  const flowTop = 583, flowH = 143, flowW = (CONTENT_W - 10) / 2;
  const leftX = LEFT, rightX = LEFT + flowW + 10, flowBottom = flowTop - flowH;
  rect(leftX, flowBottom, flowW, flowH, C.paper); strokeRect(leftX, flowBottom, flowW, flowH, C.border);
  rect(rightX, flowBottom, flowW, flowH, C.paper); strokeRect(rightX, flowBottom, flowW, flowH, C.border);
  rect(leftX, flowTop - 26, flowW, 26, C.greenLight);
  rect(rightX, flowTop - 26, flowW, 26, C.redLight);
  text(leftX + 10, flowTop - 17, 'MONEY IN', 7.6, 'F2', C.green);
  text(rightX + 10, flowTop - 17, 'MONEY OUT', 7.6, 'F2', C.red);
  const drawFlowRows = (x, rows, totalLabel, totalValue, totalColor) => {
    let yy = flowTop - 43;
    rows.forEach((row, index) => {
      text(x + 10, yy, row.label, 7.0, 'F1', C.muted);
      textRight(x + flowW - 10, yy, pdfCompactCurrency(row.value), 7.0, 'F2', C.ink);
      yy -= 17;
    });
    line(x + 10, yy + 7, x + flowW - 10, yy + 7, C.border, 0.6);
    text(x + 10, yy - 7, totalLabel, 7.1, 'F2', C.ink);
    textRight(x + flowW - 10, yy - 7, pdfCurrency(totalValue), 7.3, 'F2', totalColor);
  };
  drawFlowRows(leftX, [
    { label: 'Income and other receipts', value: report.incomeReceived },
    { label: 'Loan repayments received', value: report.loanReturned },
    { label: 'Other tagged receipts', value: report.otherCashIn }
  ], 'TOTAL CASH IN', report.cashIn, C.green);
  drawFlowRows(rightX, [
    { label: 'Day-to-day expenses', value: report.directExpenses },
    { label: 'Money lent to others', value: report.moneyLent },
    { label: 'Credit card repayments', value: report.cardRepayments },
    { label: 'Other cash outflows', value: report.otherCashOut }
  ], 'TOTAL CASH OUT', report.cashOut, C.red);

  sectionTitle(LEFT, 419, 'Spending breakdown', `Recorded spending this period  |  ${pdfCurrency(report.totalSpending)} (direct expenses + card purchases)`);
  const spendTop = 391, spendH = 183, spendBottom = spendTop - spendH;
  const catX = LEFT, catW = 330, methodX = catX + catW + 10, methodW = CONTENT_W - catW - 10;
  rect(catX, spendBottom, catW, spendH, C.paper); strokeRect(catX, spendBottom, catW, spendH, C.border);
  rect(methodX, spendBottom, methodW, spendH, C.paper); strokeRect(methodX, spendBottom, methodW, spendH, C.border);
  text(catX + 10, spendTop - 17, 'BY CATEGORY', 7.1, 'F2', C.forest);
  textRight(catX + catW - 10, spendTop - 17, 'AMOUNT (INR)', 6.3, 'F2', C.muted);
  line(catX + 10, spendTop - 24, catX + catW - 10, spendTop - 24, C.border);
  const rawCategories = report.categoryTotals;
  const categories = rawCategories.length > 13
    ? [...rawCategories.slice(0, 12), { label: `Other categories (${rawCategories.length - 12})`, amount: safeNumber(rawCategories.slice(12).reduce((total, item) => total + item.amount, 0)) }]
    : rawCategories;
  if (!categories.length) {
    text(catX + 12, spendTop - 48, 'No spending recorded for this period.', 7.5, 'F1', C.muted);
  } else {
    const maxCategory = Math.max(...categories.map(item => item.amount), 1);
    const rowStep = 11.4;
    categories.forEach((item, i) => {
      const yy = spendTop - 39 - i * rowStep;
      if (yy < spendBottom + 5) return;
      text(catX + 10, yy, pdfWrap(item.label, 34, 1)[0], 6.7, 'F1', C.ink);
      bar(catX + 151, yy - 2, 83, 4, item.amount / maxCategory, C.sage);
      textRight(catX + catW - 10, yy, pdfCompactCurrency(item.amount), 6.5, 'F2', C.ink);
    });
  }

  text(methodX + 9, spendTop - 17, 'SPENDING CHANNELS', 6.8, 'F2', C.forest);
  line(methodX + 9, spendTop - 24, methodX + methodW - 9, spendTop - 24, C.border);
  const channelRows = report.spendByMethod;
  const maxChannel = Math.max(1, ...channelRows.map(item => item.amount));
  if (!channelRows.length) text(methodX + 9, spendTop - 45, 'No spending recorded.', 6.7, 'F1', C.muted);
  channelRows.forEach((item, i) => {
    const yy = spendTop - 39 - i * 14;
    if (yy < spendTop - 95) return;
    text(methodX + 9, yy, pdfWrap(item.label, 11, 1)[0], 6.2, 'F1', C.muted);
    bar(methodX + 57, yy - 2, 43, 4, item.amount / maxChannel, item.label === 'Credit Card' ? C.blue : C.sage);
    textRight(methodX + methodW - 9, yy, pdfCompactCurrency(item.amount), 5.9, 'F2', C.ink);
  });
  const incomeTitleY = spendTop - 103;
  text(methodX + 9, incomeTitleY, 'INCOME RECEIVED BY', 6.5, 'F2', C.forest);
  line(methodX + 9, incomeTitleY - 6, methodX + methodW - 9, incomeTitleY - 6, C.border);
  report.incomeByMethod.forEach((item, i) => {
    const yy = incomeTitleY - 20 - i * 12;
    if (yy < spendBottom + 4) return;
    text(methodX + 9, yy, pdfWrap(item.label, 11, 1)[0], 6.1, 'F1', C.muted);
    textRight(methodX + methodW - 9, yy, pdfCompactCurrency(item.amount), 6.1, 'F2', C.ink);
  });

  sectionTitle(LEFT, 194, 'Outstanding balances', `Calculated as at ${report.asOfDateLabel}`);
  const snapTop = 167, snapH = 76, snapBottom = snapTop - snapH;
  const snapW = (CONTENT_W - 10) / 2;
  rect(LEFT, snapBottom, snapW, snapH, C.blueLight); strokeRect(LEFT, snapBottom, snapW, snapH, C.border);
  rect(LEFT + snapW + 10, snapBottom, snapW, snapH, C.amberLight); strokeRect(LEFT + snapW + 10, snapBottom, snapW, snapH, C.border);
  text(LEFT + 9, snapTop - 16, 'CREDIT CARD', 7.1, 'F2', C.blue);
  text(LEFT + snapW + 19, snapTop - 16, 'MONEY LENT', 7.1, 'F2', [0.58, 0.40, 0.18]);
  const snapRows = (x, w, items) => items.forEach((item, i) => {
    const yy = snapTop - 31 - i * 13;
    text(x + 9, yy, item.label, 6.2, 'F1', C.muted);
    textRight(x + w - 9, yy, pdfCompactCurrency(item.value), 6.2, 'F2', C.ink);
  });
  snapRows(LEFT, snapW, [
    { label: 'Purchases in period', value: report.cardPurchases },
    { label: 'Repayments in period', value: report.cardRepayments },
    { label: 'Outstanding at period end', value: report.cardOutstanding }
  ]);
  snapRows(LEFT + snapW + 10, snapW, [
    { label: 'Lent in period', value: report.moneyLent },
    { label: 'Returned in period', value: report.loanReturned },
    { label: 'Still owed to you', value: report.loanOutstanding }
  ]);
  text(LEFT, 78, 'Note: Card purchases are spending, not cash outflow until repaid. Card repayments are shown in cash flow but are not counted again as expenses.', 5.9, 'F1', C.muted);
  text(LEFT, 68, 'Money lent is shown as a receivable, not day-to-day spending. Net cash movement is not a bank balance; no opening balance is assumed.', 5.9, 'F1', C.muted);
  if (!report.cardOutstandingComplete || !report.loanOutstandingComplete) {
    text(LEFT, 58, 'Undated history: a historical outstanding balance cannot be reconstructed for records whose repayment dates were not saved.', 5.7, 'F1', C.red);
  }
  addFooter(0);
  finishPage();

  // PAGE 2+: complete transaction register, including card purchases as a distinct non-cash entry type.
  const rows = report.rows || [];
  let pageNumber = 1;
  const drawRegisterHeader = (continued = false) => {
    startPage();
    rect(0, 760, PAGE_W, 82, C.forest);
    rect(0, 756, PAGE_W, 4, C.gold);
    text(LEFT, 808, continued ? 'TRANSACTION REGISTER  |  CONTINUED' : 'TRANSACTION REGISTER', 15, 'F2', C.white);
    text(LEFT, 789, 'Chronological record of cash movements and card purchases', 7.4, 'F1', [0.85, 0.90, 0.85]);
    textRight(RIGHT, 790, report.period, 7, 'F2', C.white);
    text(LEFT, 741, 'IN = money received   OUT = cash paid   CARD = credit-card purchase (not cash outflow)', 6.5, 'F1', C.muted);
    const tableTop = 721;
    rect(LEFT, tableTop - 24, CONTENT_W, 24, C.forest2);
    const cols = { date: 44, description: 105, category: 260, method: 365, flow: 423, amountRight: RIGHT - 8 };
    text(cols.date, tableTop - 15, 'DATE / TIME', 6.3, 'F2', C.white);
    text(cols.description, tableTop - 15, 'DESCRIPTION', 6.3, 'F2', C.white);
    text(cols.category, tableTop - 15, 'CATEGORY', 6.3, 'F2', C.white);
    text(cols.method, tableTop - 15, 'METHOD', 6.3, 'F2', C.white);
    text(cols.flow, tableTop - 15, 'FLOW', 6.3, 'F2', C.white);
    textRight(cols.amountRight, tableTop - 15, 'AMOUNT (INR)', 6.3, 'F2', C.white);
    return { y: tableTop - 35, cols };
  };
  let table = drawRegisterHeader(false);
  rows.forEach((row, index) => {
    const dateLines = pdfWrap(row.dateTime, 14, 2);
    const descriptionLines = pdfWrap(row.description, 31, 2);
    const categoryLines = pdfWrap(row.category, 20, 2);
    const methodLines = pdfWrap(row.method, 14, 1);
    const maxLines = Math.max(dateLines.length, descriptionLines.length, categoryLines.length, methodLines.length, 1);
    const rowH = Math.max(27, maxLines * 10 + 9);
    if (table.y - rowH < 53) {
      addFooter(pageNumber);
      finishPage();
      pageNumber += 1;
      table = drawRegisterHeader(true);
    }
    if (index % 2 === 1) rect(LEFT, table.y - rowH + 2, CONTENT_W, rowH, C.panel);
    const yy = table.y - 10;
    dateLines.forEach((lineText, lineIndex) => text(table.cols.date, yy - lineIndex * 10, lineText, 6.0, 'F1', C.muted));
    descriptionLines.forEach((lineText, lineIndex) => text(table.cols.description, yy - lineIndex * 10, lineText, 6.5, 'F1', C.ink));
    categoryLines.forEach((lineText, lineIndex) => text(table.cols.category, yy - lineIndex * 10, lineText, 6.1, 'F1', C.muted));
    methodLines.forEach((lineText, lineIndex) => text(table.cols.method, yy - lineIndex * 10, lineText, 6.0, 'F1', C.muted));
    const flowColor = row.flow === 'IN' ? C.green : (row.flow === 'CARD' ? C.blue : C.red);
    text(table.cols.flow, yy, row.flow, 6.2, 'F2', flowColor);
    textRight(table.cols.amountRight, yy, pdfCompactCurrency(row.amount), 6.3, 'F2', C.ink);
    line(LEFT, table.y - rowH + 1, RIGHT, table.y - rowH + 1, C.border, 0.35);
    table.y -= rowH;
  });
  addFooter(pageNumber);
  finishPage();

  // Assemble an uncompressed PDF with byte-accurate cross-reference offsets.
  const objects = [];
  const addObject = value => { objects.push(value); return objects.length; };
  const catalogId = addObject('');
  const pagesId = addObject('');
  const regularFontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const boldFontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds = [];
  pages.forEach(pageOps => {
    const numberedPageOps = pageOps.replace(/OF __TOTAL__/g, `OF ${pages.length}`);
    const stream = `${numberedPageOps}\n`;
    const streamLength = new TextEncoder().encode(stream).length;
    const contentId = addObject(`<< /Length ${streamLength} >>\nstream\n${stream}endstream`);
    const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  });
  const infoId = addObject(`<< /Title (MONETRA - Financial Statement) /Author (${pdfEscape(report.accountName || 'MONETRA')}) /Subject (Cash flow, expense categories, credit card and lending summary) /Creator (MONETRA) >>`);
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let pdf = '%PDF-1.4\n%MONETRA\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(new TextEncoder().encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Blob([pdf], { type: 'application/pdf' });
}

function buildStatementReport(range, start, end) {
  const inPeriod = date => range === 'all' || (String(date || '') >= start && String(date || '') <= end);
  const selectedTransactions = transactions.filter(tx => inPeriod(tx.date));
  const selectedCards = creditPurchases.filter(card => inPeriod(card.date));
  const selectedLoans = loans.filter(loan => String(loan.lentOn || '') <= (range === 'custom' ? end : localDateISO()));
  const cashIns = selectedTransactions.filter(tx => tx.type === 'in');
  const cashOuts = selectedTransactions.filter(tx => tx.type === 'out');
  const cashIn = sum(cashIns, tx => tx.amount);
  const cashOut = sum(cashOuts, tx => tx.amount);
  const loanReturnedEntries = cashIns.filter(isLoanRepaymentEntry);
  const incomeEntries = cashIns.filter(tx => !isLoanRepaymentEntry(tx) && !tx.excludeFromIncomeStats);
  const loanLentEntries = cashOuts.filter(isLoanDisbursementEntry);
  const cardRepaymentEntries = cashOuts.filter(isCardRepaymentEntry);
  const directExpenseEntries = cashOuts.filter(isDirectExpenseEntry);
  const loanReturned = sum(loanReturnedEntries, tx => tx.amount);
  const incomeReceived = sum(incomeEntries, tx => tx.amount);
  const moneyLent = sum(loanLentEntries, tx => tx.amount);
  const cardRepayments = sum(cardRepaymentEntries, tx => tx.amount);
  const directExpenses = sum(directExpenseEntries, tx => tx.amount);
  const otherCashIn = Math.max(0, safeNumber(cashIn - incomeReceived - loanReturned));
  const otherCashOut = Math.max(0, safeNumber(cashOut - directExpenses - moneyLent - cardRepayments));
  const cardPurchases = sum(selectedCards, card => card.amount);
  const totalSpending = safeNumber(directExpenses + cardPurchases);
  const netCash = safeNumber(cashIn - cashOut);
  const today = localDateISO();
  const asOfDate = range === 'custom' ? end : today;

  const categoryItems = [
    ...directExpenseEntries.map(tx => ({ category: tx.category || 'Others', amount: tx.amount })),
    ...selectedCards.map(card => ({ category: card.category || 'Others', amount: card.amount }))
  ];
  const categoryTotals = groupPdfAmounts(categoryItems, item => item.category, item => item.amount, []);
  const spendMethodItems = [
    ...directExpenseEntries.map(tx => ({ method: ['UPI', 'Cash', 'Other'].includes(tx.method) ? tx.method : 'Other', amount: tx.amount })),
    ...selectedCards.map(card => ({ method: 'Credit Card', amount: card.amount }))
  ];
  const spendByMethod = groupPdfAmounts(spendMethodItems, item => item.method, item => item.amount, []);
  const incomeByMethod = groupPdfAmounts(incomeEntries, tx => ['UPI', 'Cash', 'Other'].includes(tx.method) ? tx.method : 'Other', tx => tx.amount, []);
  const cardOutstandingData = calculateOutstandingAtDate(creditPurchases, 'amount', 'date', 'payments', asOfDate, today);
  const loanOutstandingData = calculateOutstandingAtDate(loans, 'amount', 'lentOn', 'repayments', asOfDate, today);

  const rows = [
    ...selectedTransactions.map(tx => {
      let category = tx.category || (tx.type === 'in' ? 'Income' : 'Others');
      if (isLoanRepaymentEntry(tx)) category = 'Loan repayment';
      else if (isLoanDisbursementEntry(tx)) category = 'Money lent';
      else if (isCardRepaymentEntry(tx)) category = 'Credit card payment';
      return {
        sortKey: `${tx.date}T${tx.time || '00:00'}`,
        dateTime: `${formatDate(tx.date)}${tx.time ? ` ${formatTime(tx.time)}` : ''}`,
        description: tx.title || 'Transaction',
        category,
        method: tx.method || 'Other',
        flow: tx.type === 'in' ? 'IN' : 'OUT',
        amount: safeNumber(tx.amount)
      };
    }),
    ...selectedCards.map(card => ({
      sortKey: `${card.date}T12:00`,
      dateTime: formatDate(card.date),
      description: `${card.title || 'Card purchase'}${card.cardName ? ` - ${card.cardName}` : ''}`,
      category: card.category || 'Others',
      method: 'Credit Card',
      flow: 'CARD',
      amount: safeNumber(card.amount)
    }))
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const allDates = [
    ...transactions.map(tx => tx.date),
    ...creditPurchases.map(card => card.date),
    ...loans.map(loan => loan.lentOn)
  ].filter(isValidDateISO).sort();
  const period = range === 'custom'
    ? `${formatDate(start)} - ${formatDate(end)}`
    : (allDates.length ? `${formatDate(allDates[0])} - ${formatDate(today)}` : `Through ${formatDate(today)}`);

  return {
    accountName: user?.fullName || user?.name || 'Personal account',
    generatedAt: new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    period,
    asOfDateLabel: formatDate(asOfDate),
    cashIn, cashOut, netCash,
    incomeReceived, loanReturned, otherCashIn,
    directExpenses, moneyLent, cardRepayments, otherCashOut,
    cardPurchases, totalSpending,
    cardOutstanding: cardOutstandingData.value,
    cardOutstandingComplete: cardOutstandingData.complete,
    loanOutstanding: loanOutstandingData.value,
    loanOutstandingComplete: loanOutstandingData.complete,
    categoryTotals, spendByMethod, incomeByMethod,
    rows
  };
}

$('generate-pdf-btn').addEventListener('click', () => {
  const pdfButton = $('generate-pdf-btn');
  if (pdfButton.disabled) return;
  const selectedRange = document.querySelector('input[name="export-range"]:checked');
  const range = selectedRange?.value || 'all';
  let start = '', end = '';
  if (range === 'custom') {
    start = $('export-start').value;
    end = $('export-end').value;
    if (!isValidDateISO(start) || !isValidDateISO(end) || start > end) {
      showToast('Please choose a valid date range.', 'error');
      return;
    }
  }
  let report;
  try {
    report = buildStatementReport(range, start, end);
  } catch (error) {
    console.error('Could not prepare the financial statement:', error);
    showToast('Could not prepare the statement data. Please try again.', 'error');
    return;
  }
  if (!report.rows.length) {
    showToast('No records found for this period.', 'error');
    return;
  }
  pdfButton.disabled = true;
  try {
    const pdfBlob = makeStatementPdf(report);
    const accountSlug = pdfAscii(report.accountName).replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'Personal';
    const filename = `MONETRA_Financial_Report_${accountSlug}_${localDateISO()}.pdf`;
    closeModal('export-modal');
    downloadBlob(filename, pdfBlob);
    showToast('Your detailed financial PDF is ready.');
  } catch (error) {
    console.error('PDF generation failed:', error);
    showToast('Could not generate the PDF. Please try again.', 'error');
  } finally {
    pdfButton.disabled = false;
  }
});

// Boot: keep screens hidden until Supabase has restored the persisted Google session.
function init() {
  document.body.classList.add('auth-pending');
  initMonetraCloudAuth();
  bindThemePreference();
  setInitialFormOptions();
  setTodayDefaults();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(reg => { serviceWorkerRegistration = reg; }).catch(() => {});
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && user) { renderReminders(); deliverDueReminders(); }
  });
  notificationTimer = window.setInterval(() => { if (user && !document.hidden) deliverDueReminders(); }, 60 * 1000);
}
init();
