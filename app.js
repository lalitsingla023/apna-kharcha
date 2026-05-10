// State
let user = null;
let transactions = [];

// DOM Elements
const authScreen = document.getElementById('auth-screen');
const mainScreen = document.getElementById('main-screen');
const authForm = document.getElementById('auth-form');
const authModeInput = document.getElementById('auth-mode');
const regNameGroup = document.getElementById('display-name-group');
const regNameInput = document.getElementById('reg-name');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const authToggleBtn = document.getElementById('auth-toggle-btn');
const authToggleLabel = document.getElementById('auth-toggle-label');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const displayName = document.getElementById('display-name');

const totalBalanceEl = document.getElementById('total-balance');
const totalInEl = document.getElementById('total-in');
const totalOutEl = document.getElementById('total-out');
const transactionsListEl = document.getElementById('transactions-list');

const txModal = document.getElementById('transaction-modal');
const txForm = document.getElementById('transaction-form');
const txTypeInput = document.getElementById('tx-type');
const txAmountInput = document.getElementById('tx-amount');
const txTitleInput = document.getElementById('tx-title');
const txDateInput = document.getElementById('tx-date');
const txTimeInput = document.getElementById('tx-time');
const modalTitle = document.getElementById('modal-title');
const txSubmitBtn = document.getElementById('tx-submit-btn');

const backupModal = document.getElementById('backup-modal');
const toastEl = document.getElementById('toast');

// Initialize
function init() {
    // Set default date to today
    txDateInput.valueAsDate = new Date();
    
    // Check local storage for user
    const storedUser = localStorage.getItem('apna_kharcha_user');
    if (storedUser) {
        user = JSON.parse(storedUser);
        loadData();
        showScreen('main');
    } else {
        showScreen('auth');
    }
}

// Show Toast
function showToast(message, type = 'success') {
    toastEl.innerHTML = `<i class="ph ph-${type === 'success' ? 'check-circle' : 'warning-circle'}"></i> ${message}`;
    toastEl.className = `toast show ${type}`;
    setTimeout(() => {
        toastEl.classList.remove('show');
    }, 3000);
}

// Screen Management
function showScreen(screen) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    if (screen === 'auth') authScreen.classList.add('active');
    if (screen === 'main') {
        mainScreen.classList.add('active');
        displayName.textContent = user.fullName || user.name; // fallback for older format
        updateUI();
    }
}

// Auth Toggle logic
authToggleBtn.addEventListener('click', () => {
    if (authModeInput.value === 'login') {
        authModeInput.value = 'register';
        regNameGroup.style.display = 'block';
        regNameInput.required = true;
        authSubmitBtn.textContent = 'Create Account';
        authToggleLabel.textContent = 'Already have an account?';
        authToggleBtn.textContent = 'Login here';
    } else {
        authModeInput.value = 'login';
        regNameGroup.style.display = 'none';
        regNameInput.required = false;
        authSubmitBtn.textContent = 'Login';
        authToggleLabel.textContent = 'Don\'t have an account?';
        authToggleBtn.textContent = 'Register here';
    }
});

// Authentication
authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const mode = authModeInput.value;
    const userid = usernameInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    
    const existingUsers = JSON.parse(localStorage.getItem('apna_kharcha_accounts') || '{}');
    
    if (mode === 'register') {
        const fullName = regNameInput.value.trim();
        
        if (existingUsers[userid]) {
            showToast('UserID already exists. Please choose a different one.', 'error');
            return;
        }
        
        // Register New User
        existingUsers[userid] = { password, fullName };
        localStorage.setItem('apna_kharcha_accounts', JSON.stringify(existingUsers));
        
        user = { name: userid, fullName: fullName };
        localStorage.setItem('apna_kharcha_user', JSON.stringify(user));
        transactions = [];
        saveData();
        showScreen('main');
        showToast(`Account created, welcome ${fullName}!`);
        
    } else if (mode === 'login') {
        if (!existingUsers[userid]) {
            showToast('UserID not found.', 'error');
            return;
        }
        
        if (existingUsers[userid].password !== password) {
            showToast('Incorrect password.', 'error');
            return;
        }
        
        // Login Success
        user = { name: userid, fullName: existingUsers[userid].fullName };
        localStorage.setItem('apna_kharcha_user', JSON.stringify(user));
        loadData();
        showScreen('main');
        showToast(`Welcome back, ${user.fullName}!`);
    }
});

document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.removeItem('apna_kharcha_user');
    user = null;
    transactions = [];
    usernameInput.value = '';
    passwordInput.value = '';
    showScreen('auth');
});

// Data Management
function loadData() {
    const data = localStorage.getItem(`apna_kharcha_data_${user.name}`);
    transactions = data ? JSON.parse(data) : [];
    
    // Sort by date and then time descending
    transactions.sort((a, b) => {
        const dateA = new Date(`${a.date}T${a.time || '00:00'}`);
        const dateB = new Date(`${b.date}T${b.time || '00:00'}`);
        return dateB - dateA;
    });
}

function saveData() {
    localStorage.setItem(`apna_kharcha_data_${user.name}`, JSON.stringify(transactions));
}

// Modals
window.openModal = function(type) {
    txTypeInput.value = type;
    modalTitle.textContent = type === 'in' ? 'Add Income' : 'Add Expense';
    txSubmitBtn.textContent = type === 'in' ? 'Save Income' : 'Save Expense';
    
    // Style the button
    txSubmitBtn.style.background = type === 'in' ? 'var(--success)' : 'var(--danger)';
    
    txForm.reset();
    
    const now = new Date();
    txDateInput.valueAsDate = now;
    
    // Format time to HH:MM for input type="time"
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    txTimeInput.value = `${hours}:${minutes}`;
    
    txModal.classList.add('active');
    setTimeout(() => txAmountInput.focus(), 100);
}

window.closeModal = function() {
    txModal.classList.remove('active');
}

// Transaction Handling
txForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const amount = parseFloat(txAmountInput.value);
    const title = txTitleInput.value.trim();
    const date = txDateInput.value;
    const time = txTimeInput.value;
    const type = txTypeInput.value;
    
    if (isNaN(amount) || amount <= 0) {
        showToast('Please enter a valid amount', 'error');
        return;
    }
    
    const transaction = {
        id: Date.now().toString(),
        amount,
        title,
        date,
        time,
        type
    };
    
    transactions.unshift(transaction);
    
    // Re-sort just in case date/time was changed
    transactions.sort((a, b) => {
        const dateA = new Date(`${a.date}T${a.time || '00:00'}`);
        const dateB = new Date(`${b.date}T${b.time || '00:00'}`);
        return dateB - dateA;
    });
    
    saveData();
    updateUI();
    closeModal();
    
    showToast(type === 'in' ? 'Income added successfully' : 'Expense recorded successfully');
});

function formatCurrency(amount) {
    return '₹' + amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateTime(dateString, timeString) {
    const dateOptions = { year: 'numeric', month: 'short', day: 'numeric' };
    const datePart = new Date(dateString).toLocaleDateString('en-IN', dateOptions);
    
    if (!timeString) return datePart;
    
    // Convert HH:MM to 12-hour format
    const [hours, minutes] = timeString.split(':');
    let h = parseInt(hours);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    h = h ? h : 12; 
    const timePart = `${h}:${minutes} ${ampm}`;
    
    return `${datePart} • ${timePart}`;
}

// UI Rendering
function updateUI() {
    // Calculate totals
    const totalIn = transactions.filter(t => t.type === 'in').reduce((sum, t) => sum + t.amount, 0);
    const totalOut = transactions.filter(t => t.type === 'out').reduce((sum, t) => sum + t.amount, 0);
    const balance = totalIn - totalOut;
    
    // Update header
    totalBalanceEl.textContent = formatCurrency(balance);
    totalInEl.textContent = formatCurrency(totalIn);
    totalOutEl.textContent = formatCurrency(totalOut);
    
    // Render list
    transactionsListEl.innerHTML = '';
    
    if (transactions.length === 0) {
        transactionsListEl.innerHTML = `
            <div class="empty-state">
                <i class="ph ph-receipt"></i>
                <p>No transactions yet</p>
                <p class="text-xs text-muted mt-2">Tap Cash In or Cash Out to start tracking</p>
            </div>
        `;
        return;
    }
    
    transactions.forEach(tx => {
        const item = document.createElement('div');
        item.className = `tx-item ${tx.type}`;
        item.innerHTML = `
            <div class="tx-left">
                <div class="tx-icon">
                    <i class="ph ${tx.type === 'in' ? 'ph-arrow-down-left' : 'ph-arrow-up-right'}"></i>
                </div>
                <div class="tx-info">
                    <h4>${tx.title}</h4>
                    <p>${formatDateTime(tx.date, tx.time)}</p>
                </div>
            </div>
            <div class="tx-right">
                <span class="tx-amount">${tx.type === 'in' ? '+' : '-'}${formatCurrency(tx.amount)}</span>
                <button class="btn-text" onclick="deleteTransaction('${tx.id}')" style="padding: 4px; margin-left: 8px; color: var(--text-muted);"><i class="ph ph-trash"></i></button>
            </div>
        `;
        transactionsListEl.appendChild(item);
    });
}

window.deleteTransaction = function(id) {
    if(confirm('Are you sure you want to delete this transaction?')) {
        transactions = transactions.filter(t => t.id !== id);
        saveData();
        updateUI();
        showToast('Transaction deleted');
    }
}

// Export Modal & PDF Generation
const exportModal = document.getElementById('export-modal');
const exportDateRange = document.getElementById('export-date-range');
const exportStart = document.getElementById('export-start');
const exportEnd = document.getElementById('export-end');

document.getElementById('open-export-modal').addEventListener('click', () => {
    if (transactions.length === 0) {
        showToast('No transactions to export', 'error');
        return;
    }
    
    // Set default dates to current month
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    
    exportStart.valueAsDate = firstDay;
    exportEnd.valueAsDate = now;
    
    exportModal.classList.add('active');
});

window.closeExportModal = function() {
    exportModal.classList.remove('active');
}

// Toggle date inputs based on radio selection
document.querySelectorAll('input[name="export-range"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
        if (e.target.value === 'custom') {
            exportDateRange.style.display = 'flex';
        } else {
            exportDateRange.style.display = 'none';
        }
    });
});

document.getElementById('generate-pdf-btn').addEventListener('click', () => {
    const rangeType = document.querySelector('input[name="export-range"]:checked').value;
    let filteredTransactions = [...transactions];
    let periodText = 'All Transactions';
    
    if (rangeType === 'custom') {
        const start = exportStart.value;
        const end = exportEnd.value;
        
        if (!start || !end) {
            showToast('Please select both start and end dates', 'error');
            return;
        }
        
        if (new Date(start) > new Date(end)) {
            showToast('Start date cannot be after end date', 'error');
            return;
        }
        
        filteredTransactions = transactions.filter(tx => {
            return tx.date >= start && tx.date <= end;
        });
        
        periodText = `${formatDateTime(start)} to ${formatDateTime(end)}`;
    }
    
    if (filteredTransactions.length === 0) {
        showToast('No transactions found in this date range', 'error');
        return;
    }
    
    showToast('Generating PDF statement...');
    
    // Prepare PDF Data
    document.getElementById('pdf-user-name').textContent = user.fullName || user.name;
    document.getElementById('pdf-date').textContent = new Date().toLocaleDateString('en-IN');
    document.getElementById('pdf-period').textContent = periodText;
    
    const totalIn = filteredTransactions.filter(t => t.type === 'in').reduce((sum, t) => sum + t.amount, 0);
    const totalOut = filteredTransactions.filter(t => t.type === 'out').reduce((sum, t) => sum + t.amount, 0);
    
    document.getElementById('pdf-total-in').textContent = formatCurrency(totalIn);
    document.getElementById('pdf-total-out').textContent = formatCurrency(totalOut);
    document.getElementById('pdf-net').textContent = formatCurrency(totalIn - totalOut);
    
    const tableBody = document.getElementById('pdf-table-body');
    tableBody.innerHTML = '';
    
    filteredTransactions.forEach(tx => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${formatDateTime(tx.date, tx.time)}</td>
            <td>${tx.title}</td>
            <td>${tx.type === 'in' ? 'Income' : 'Expense'}</td>
            <td class="text-right ${tx.type === 'in' ? 'amount-in' : 'amount-out'}">
                ${tx.type === 'in' ? '+' : '-'}${formatCurrency(tx.amount)}
            </td>
        `;
        tableBody.appendChild(tr);
    });
    
    // Generate PDF
    const element = document.getElementById('pdf-content');
    element.style.display = 'block'; // Temporarily show to render
    
    const opt = {
        margin:       10,
        filename:     `Apna_Kharcha_Statement_${user.name}.pdf`,
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  { scale: 2, logging: false },
        jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };
    
    html2pdf().set(opt).from(element).save().then(() => {
        element.style.display = 'none'; // Hide again
        closeExportModal();
        showToast('PDF downloaded successfully');
    });
});

// Backup System
document.getElementById('backup-btn').addEventListener('click', () => {
    backupModal.classList.add('active');
});

window.closeBackupModal = function() {
    backupModal.classList.remove('active');
}

// Download JSON Backup
document.getElementById('download-backup').addEventListener('click', () => {
    if(transactions.length === 0) {
        showToast('No data to backup', 'error');
        return;
    }
    
    const dataStr = JSON.stringify(transactions, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    
    const exportFileDefaultName = `Apna_Kharcha_Backup_${user.name}_${new Date().toISOString().split('T')[0]}.json`;
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    
    showToast('Backup file downloaded. Save this to Google Drive!');
    closeBackupModal();
});

// Restore from JSON
document.getElementById('restore-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const parsedData = JSON.parse(e.target.result);
            if (Array.isArray(parsedData)) {
                transactions = parsedData;
                saveData();
                updateUI();
                showToast('Data restored successfully!');
                closeBackupModal();
            } else {
                showToast('Invalid backup file format', 'error');
            }
        } catch (err) {
            showToast('Error reading backup file', 'error');
            console.error(err);
        }
    };
    reader.readAsText(file);
    // Reset input
    e.target.value = '';
});

// Start App
init();
