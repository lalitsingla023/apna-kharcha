'use strict';

// Apna Kharcha — version 2.0
// Local-first personal finance tracker. Existing v1 transaction storage is migrated in place.

const APP_VERSION = 2;
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
function saveData() {
  if (!user) return false;
  const state = { format: 'apna-kharcha-backup', version: APP_VERSION, savedAt: new Date().toISOString(), transactions, creditPurchases, loans };
  try {
    localStorage.setItem(getStorageKey('state'), JSON.stringify(state));
    // Keep the v1 transaction key in sync for safe rollback to the earlier website version.
    localStorage.setItem(getStorageKey('data'), JSON.stringify(transactions));
    return true;
  } catch (error) {
    console.error('Could not save Apna Kharcha data:', error);
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
function saveAndRefresh(closeId = null) {
  if (!saveData()) return false;
  if (closeId) closeModal(closeId);
  refreshDashboardSafely();
  return true;
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

// Authentication remains local to this device, as in the original personalized app.
authToggleBtn.addEventListener('click', () => {
  const isLogin = authModeInput.value === 'login';
  authModeInput.value = isLogin ? 'register' : 'login';
  regNameGroup.style.display = isLogin ? 'block' : 'none';
  regNameInput.required = isLogin;
  authSubmitBtn.textContent = isLogin ? 'Create account' : 'Login';
  authToggleLabel.textContent = isLogin ? 'Already have an account?' : "Don't have an account?";
  authToggleBtn.textContent = isLogin ? 'Login here' : 'Register here';
});
authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const mode = authModeInput.value;
  const userid = usernameInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  const existingUsers = JSON.parse(localStorage.getItem('apna_kharcha_accounts') || '{}');
  if (mode === 'register') {
    const fullName = regNameInput.value.trim();
    if (!fullName) { showToast('Please enter your name.', 'error'); return; }
    if (existingUsers[userid]) { showToast('That User ID is already in use.', 'error'); return; }
    existingUsers[userid] = { password, fullName };
    localStorage.setItem('apna_kharcha_accounts', JSON.stringify(existingUsers));
    user = { name: userid, fullName };
    localStorage.setItem('apna_kharcha_user', JSON.stringify(user));
    transactions = []; creditPurchases = []; loans = []; saveData();
    showScreen('main'); showToast(`Welcome to Apna Kharcha, ${fullName}.`);
  } else {
    if (!existingUsers[userid]) { showToast('User ID not found on this device.', 'error'); return; }
    if (existingUsers[userid].password !== password) { showToast('That password does not match.', 'error'); return; }
    user = { name: userid, fullName: existingUsers[userid].fullName };
    localStorage.setItem('apna_kharcha_user', JSON.stringify(user));
    try { loadData(); showScreen('main'); showToast(`Welcome back, ${user.fullName || user.name}.`); }
    catch (error) { console.error(error); showToast(error.message || 'Could not load your records.', 'error'); }
  }
});
$('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('apna_kharcha_user');
  user = null; transactions = []; creditPurchases = []; loans = [];
  usernameInput.value = ''; passwordInput.value = ''; showScreen('auth');
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
  if (!modal) return;
  document.querySelectorAll('.modal-overlay.active').forEach(open => {
    if (open !== modal) closeModal(open.id);
  });
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  modal.classList.add('active');
}
function closeModal(id) {
  const modal = $(id);
  if (!modal) return;
  modal.classList.remove('active');
  modal.setAttribute('aria-hidden', 'true');
  modal.hidden = true;
}
window.closeModal = () => closeModal('transaction-modal');
txForm.addEventListener('submit', event => {
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
  if (!saveAndRefresh('transaction-modal')) return;
  showToast(id ? 'Transaction updated.' : (type === 'in' ? 'Money received has been recorded.' : 'Expense saved.'));
});
function deleteTransaction(id) {
  const tx = transactions.find(item => item.id === id);
  if (!tx || tx.systemManaged) { showToast('This linked item is managed in its own section.', 'error'); return; }
  if (!window.confirm(`Delete “${tx.title}” (${formatCurrency(tx.amount)})?`)) return;
  transactions = transactions.filter(item => item.id !== id);
  saveData(); updateDashboard(); showToast('Transaction deleted.');
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
function deleteCardPurchase(id) {
  const purchase = creditPurchases.find(p => p.id === id);
  if (!purchase || purchase.paidAmount > 0) return;
  if (!window.confirm(`Delete “${purchase.title}” (${formatCurrency(purchase.amount)})?`)) return;
  creditPurchases = creditPurchases.filter(p => p.id !== id);
  saveData(); updateDashboard(); showToast('Card purchase deleted.');
}
window.openCardPurchaseModal = openCardPurchaseModal;
$('add-card-purchase-btn').addEventListener('click', openCardPurchaseModal);
$('card-purchase-form').addEventListener('submit', event => {
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
  if (!saveAndRefresh('card-purchase-modal')) return;
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
$('card-payment-form').addEventListener('submit', event => {
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
  if (!saveAndRefresh('card-payment-modal')) return;
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
$('loan-form').addEventListener('submit', event => {
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
  if (!saveAndRefresh('loan-modal')) return;
  showToast(successMessage);
});
function deleteLoan(id) {
  const loan = loans.find(item => item.id === id);
  if (!loan) return;

  // Remove the original cash-out and all linked returns together so the balance
  // and transaction ledger stay consistent when a lending record is deleted.
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
  showToast(`Lending record for ${loan.person} deleted.`);
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
$('loan-repayment-form').addEventListener('submit', event => {
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
  if (!saveAndRefresh('loan-repayment-modal')) return;
  showToast('Repayment recorded. Your available balance has been increased.');
});

// Tabs, filters and modal controls.
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => changeTab(btn.dataset.tab)));
document.querySelectorAll('[data-go-tab]').forEach(btn => btn.addEventListener('click', () => changeTab(btn.dataset.goTab)));
document.querySelectorAll('.modal-overlay').forEach(modal => {
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
});
document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
document.querySelectorAll('.modal-overlay').forEach(overlay => overlay.addEventListener('click', event => {
  if (event.target === overlay) closeModal(overlay.id);
}));
$('insights-period').addEventListener('change', renderInsights);
$('activity-search').addEventListener('input', renderActivity);
$('activity-type').addEventListener('change', renderActivity);

// Backup format v2, while continuing to accept the original array-of-transactions JSON.
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.style.display = 'none';
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}
$('backup-btn').addEventListener('click', () => showModal('backup-modal'));
$('download-backup').addEventListener('click', () => {
  const backup = { format: 'apna-kharcha-backup', version: APP_VERSION, exportedAt: new Date().toISOString(), user: { name: user?.name || '', fullName: user?.fullName || '' }, transactions, creditPurchases, loans };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
  downloadBlob(`Apna_Kharcha_Full_Backup_${user.name}_${localDateISO()}.json`, blob);
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
      throw new Error('This is not a recognised Apna Kharcha backup.');
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
    if (!saveAndRefresh('backup-modal')) return;
    showToast(`Restored ${transactions.length} transactions successfully.`);
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

// PDF statement. User-entered values are inserted with textContent, never interpreted as HTML.
const exportModal = $('export-modal');
$('open-export-modal').addEventListener('click', () => {
  if (!transactions.length && !creditPurchases.length) { showToast('There are no records to export yet.', 'error'); return; }
  const now = new Date();
  $('export-start').value = localDateISO(new Date(now.getFullYear(), now.getMonth(), 1));
  $('export-end').value = localDateISO();
  showModal('export-modal');
});
document.querySelectorAll('input[name="export-range"]').forEach(radio => radio.addEventListener('change', () => {
  $('export-date-range').hidden = document.querySelector('input[name="export-range"]:checked').value !== 'custom';
}));
$('generate-pdf-btn').addEventListener('click', async () => {
  if (typeof window.html2pdf !== 'function') { showToast('PDF library is unavailable. Check your internet connection and try again.', 'error'); return; }
  const range = document.querySelector('input[name="export-range"]:checked').value;
  let start = '', end = '';
  if (range === 'custom') {
    start = $('export-start').value; end = $('export-end').value;
    if (!isValidDateISO(start) || !isValidDateISO(end) || start > end) { showToast('Please choose a valid date range.', 'error'); return; }
  }
  const included = tx => range === 'all' || (tx.date >= start && tx.date <= end);
  const rows = transactions.filter(included).sort((a,b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
  const cards = creditPurchases.filter(p => range === 'all' || (p.date >= start && p.date <= end));
  if (!rows.length && !cards.length) { showToast('No records found for this period.', 'error'); return; }
  const totalIn = sum(rows.filter(t => t.type === 'in'), t => t.amount);
  const totalOut = sum(rows.filter(t => t.type === 'out'), t => t.amount);
  const cardTotal = sum(cards, c => c.amount);
  $('pdf-user-name').textContent = user?.fullName || user?.name || '';
  $('pdf-date').textContent = new Date().toLocaleDateString('en-IN');
  $('pdf-period').textContent = range === 'all' ? 'All records' : `${formatDate(start)} to ${formatDate(end)}`;
  $('pdf-total-in').textContent = formatCurrency(totalIn);
  $('pdf-total-out').textContent = formatCurrency(totalOut);
  $('pdf-net').textContent = formatCurrency(totalIn - totalOut);
  $('pdf-card-total').textContent = formatCurrency(cardTotal);
  const tbody = $('pdf-table-body'); tbody.replaceChildren();
  rows.forEach(tx => {
    const tr = document.createElement('tr');
    [formatDateTime(tx.date, tx.time), tx.title, `${tx.category || '—'} / ${tx.method || '—'}`, tx.type === 'in' ? 'Money in' : 'Money out', `${tx.type === 'in' ? '+' : '−'}${formatCurrency(tx.amount)}`].forEach(value => {
      const td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  cards.forEach(card => {
    const tr = document.createElement('tr');
    [formatDate(card.date), `${card.title} (${card.cardName})`, `${card.category} / Credit Card`, 'Card purchase · non-cash', formatCurrency(card.amount)].forEach(value => { const td = document.createElement('td'); td.textContent = value; tr.appendChild(td); });
    tbody.appendChild(tr);
  });
  const area = $('pdf-content'); area.classList.remove('pdf-content-hidden');
  const pdfButton = $('generate-pdf-btn');
  pdfButton.disabled = true;
  closeModal('export-modal');
  showToast('Preparing your statement…');
  try {
    await window.html2pdf().set({
      margin: 10,
      filename: `Apna_Kharcha_Statement_${user.name}_${localDateISO()}.pdf`,
      image: { type: 'jpeg', quality: 0.96 },
      html2canvas: { scale: 2, logging: false, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] }
    }).from(area).save();
    showToast('Statement downloaded.');
  } catch (error) {
    console.error('PDF generation failed:', error); showToast('Could not generate the PDF. Please try again.', 'error');
  } finally {
    area.classList.add('pdf-content-hidden');
    pdfButton.disabled = false;
    closeModal('export-modal');
  }
});

// Boot and attempt to load an existing v1 session without disrupting its LocalStorage data.
function init() {
  setInitialFormOptions();
  setTodayDefaults();
  const storedUser = localStorage.getItem('apna_kharcha_user');
  if (storedUser) {
    try {
      user = JSON.parse(storedUser);
      if (!user || !user.name) throw new Error('Invalid local account session.');
      loadData();
      showScreen('main');
    } catch (error) {
      console.error('App startup:', error);
      showScreen('auth');
      showToast('Could not load the saved session. Sign in again or restore your JSON backup.', 'error');
    }
  } else {
    showScreen('auth');
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(reg => { serviceWorkerRegistration = reg; }).catch(() => {});
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && user) { renderReminders(); deliverDueReminders(); }
  });
  notificationTimer = window.setInterval(() => { if (user && !document.hidden) deliverDueReminders(); }, 60 * 1000);
}
init();
