const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxTvBxmYv47CdClb1RmuB3KwM4fv2nE6UlzDp2SgIwbwlVD7JrL24-labaq2DeNwXlr2g/exec";

let currentAuthMode = 'signin';
let userSessionEmail = "";
let transactions = [];
const CATEGORIES = {
    INCOME: ['Salary', 'Freelance', 'Investments', 'Bonus', 'Other Income'],
    EXPENSE: ['Rent / Housing', 'Groceries', 'Utilities', 'Transportation', 'Dining / Food', 'Entertainment', 'Shopping', 'Healthcare', 'Bills', 'Other Expense']
};

let currentFilterMode = 'month';
let pieChartInstance = null;
let barChartInstance = null;
let pendingDeleteId = null;

window.addEventListener('DOMContentLoaded', () => {
    initTheme();
    setupDefaultDates();
    checkExistingSession();
});

function checkExistingSession() {
    const activeUser = sessionStorage.getItem('active_user_email');
    if (activeUser) {
        userSessionEmail = activeUser;
        document.getElementById('user-badge').textContent = activeUser;
        document.getElementById('login-section').classList.add('hidden');
        document.getElementById('app-section').classList.remove('hidden');
        fetchTransactionsFromSheet();
    }
}

function setAuthMode(mode) {
    currentAuthMode = mode;
    const signinBtn = document.getElementById('auth-tab-signin');
    const signupBtn = document.getElementById('auth-tab-signup');
    const title = document.getElementById('auth-title');
    const subtitle = document.getElementById('auth-subtitle');
    const submitText = document.getElementById('auth-submit-text');

    if (mode === 'signup') {
        signupBtn.className = "flex-1 py-2 rounded-md text-xs font-semibold bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-xs transition";
        signinBtn.className = "flex-1 py-2 rounded-md text-xs font-medium text-gray-500 dark:text-gray-400";
        title.textContent = "Create Account";
        subtitle.textContent = "Register a new user account in Google Sheet";
        submitText.textContent = "Sign Up";
    } else {
        signinBtn.className = "flex-1 py-2 rounded-md text-xs font-semibold bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-xs transition";
        signupBtn.className = "flex-1 py-2 rounded-md text-xs font-medium text-gray-500 dark:text-gray-400";
        title.textContent = "Welcome Back";
        subtitle.textContent = "Sign in to access your personal expense database";
        submitText.textContent = "Sign In";
    }
}

function fetchJSONP(url) {
    return new Promise((resolve, reject) => {
        const callbackName = 'jsonp_cb_' + Math.round(100000 * Math.random());
        window[callbackName] = function(data) {
            delete window[callbackName];
            document.body.removeChild(script);
            resolve(data);
        };
        const script = document.createElement('script');
        script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + callbackName;
        script.onerror = function() {
            delete window[callbackName];
            document.body.removeChild(script);
            reject(new Error('JSONP request failed'));
        };
        document.body.appendChild(script);
    });
}

document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;

    showToast(currentAuthMode === 'signup' ? 'Creating Account...' : 'Authenticating...', 'info');

    try {
        const action = currentAuthMode === 'signup' ? 'signup' : 'auth';
        const targetUrl = `${GOOGLE_SCRIPT_URL}?action=${action}&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;
        const res = await fetchJSONP(targetUrl);

        if (currentAuthMode === 'signup') {
            if (res.success) {
                showToast('Account created!', 'success');
                userSessionEmail = email;
                sessionStorage.setItem('active_user_email', email);
                document.getElementById('user-badge').textContent = email;
                document.getElementById('login-section').classList.add('hidden');
                document.getElementById('app-section').classList.remove('hidden');
                await fetchTransactionsFromSheet();
            } else {
                showToast(res.message || 'Registration failed', 'error');
            }
        } else {
            if (res && res.success) {
                userSessionEmail = email;
                sessionStorage.setItem('active_user_email', email);
                document.getElementById('user-badge').textContent = email;
                document.getElementById('login-section').classList.add('hidden');
                document.getElementById('app-section').classList.remove('hidden');
                showToast('Welcome back!', 'success');
                await fetchTransactionsFromSheet();
            } else {
                showToast('Invalid Email or Password!', 'error');
            }
        }
    } catch(err) {
        console.error(err);
        showToast('Authentication error connecting to Sheets DB', 'error');
    }
});

async function fetchTransactionsFromSheet() {
    showToast('Syncing user data...', 'info');
    try {
        const targetUrl = `${GOOGLE_SCRIPT_URL}?action=get&email=${encodeURIComponent(userSessionEmail)}`;
        const data = await fetchJSONP(targetUrl);
        transactions = Array.isArray(data) ? data : [];
        refreshAppView();
        showToast('Synced with Google Sheets!', 'success');
    } catch (err) {
        console.error("Fetch error:", err);
        transactions = [];
        refreshAppView();
        showToast('Sync failed', 'error');
    }
}

async function sendToSheet(payload) {
    payload.email = userSessionEmail;
    try {
        await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(payload)
        });
    } catch (err) {
        console.error("Sheet POST sync error:", err);
    }
}

document.getElementById('logout-btn').addEventListener('click', () => {
    userSessionEmail = "";
    sessionStorage.removeItem('active_user_email');
    document.getElementById('app-section').classList.add('hidden');
    document.getElementById('login-section').classList.remove('hidden');
    document.getElementById('auth-password').value = "";
    showToast('Logged out successfully', 'info');
});

document.getElementById('toggle-password').addEventListener('click', () => {
    const passInput = document.getElementById('auth-password');
    const eyeIcon = document.getElementById('eye-icon');
    passInput.type = passInput.type === 'password' ? 'text' : 'password';
    eyeIcon.classList.toggle('fa-eye');
    eyeIcon.classList.toggle('fa-eye-slash');
});

function initTheme() {
    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.classList.toggle('dark', isDark);
}

document.getElementById('theme-toggle').addEventListener('click', () => {
    document.documentElement.classList.toggle('dark');
    renderAnalyticsCharts();
});

function setupDefaultDates() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    document.getElementById('filter-month-input').value = `${year}-${month}`;
    document.getElementById('entry-date').value = now.toISOString().split('T')[0];
    document.getElementById('filter-from-date').value = `${year}-${month}-01`;
    document.getElementById('filter-to-date').value = new Date(year, now.getMonth() + 1, 0).toISOString().split('T')[0];
}

function switchTab(tabName) {
    document.querySelectorAll('.tab-view').forEach(view => view.classList.add('hidden'));
    document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.remove('text-blue-600', 'dark:text-blue-400', 'bg-blue-50', 'dark:bg-blue-900/30'));
    
    document.getElementById(`view-${tabName}`).classList.remove('hidden');
    const activeTab = document.getElementById(`tab-${tabName}`);
    if (activeTab) activeTab.classList.add('text-blue-600', 'dark:text-blue-400', 'bg-blue-50', 'dark:bg-blue-900/30');

    if (tabName === 'analytics') renderAnalyticsCharts();
}

function setFilterMode(mode) {
    currentFilterMode = mode;
    const activeBtnClass = "px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all duration-300 bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-xs";
    const inactiveBtnClass = "px-2.5 py-1 rounded-md text-[11px] font-medium transition-all duration-300 text-gray-500 dark:text-gray-400";

    ['month', 'range', 'all'].forEach(m => {
        const btn = document.getElementById(`filter-mode-${m}`);
        btn.className = (m === mode) ? activeBtnClass : inactiveBtnClass;
    });

    const monthCont = document.getElementById('month-filter-container');
    const rangeCont = document.getElementById('range-filter-container');

    if (mode === 'month') {
        monthCont.classList.remove('hidden');
        rangeCont.classList.add('hidden');
    } else if (mode === 'range') {
        monthCont.classList.add('hidden');
        rangeCont.classList.remove('hidden');
    } else {
        monthCont.classList.add('hidden');
        rangeCont.classList.add('hidden');
    }

    refreshAppView();
}

function applyFilters() { refreshAppView(); }

function getFilteredTransactions() {
    return transactions.filter(item => {
        if (currentFilterMode === 'month') {
            return item.date && item.date.startsWith(document.getElementById('filter-month-input').value);
        } else if (currentFilterMode === 'range') {
            const from = document.getElementById('filter-from-date').value;
            const to = document.getElementById('filter-to-date').value;
            return (!from || item.date >= from) && (!to || item.date <= to);
        }
        return true;
    });
}

function refreshAppView() {
    renderSummaryCards();
    populateCategoryFilterOptions();
    renderTransactionsTable();
    renderAnalyticsCharts();
}

function renderSummaryCards() {
    const filtered = getFilteredTransactions();
    const income = filtered.filter(t => t.type === 'INCOME').reduce((acc, t) => acc + Number(t.amount), 0);
    const expense = filtered.filter(t => t.type === 'EXPENSE').reduce((acc, t) => acc + Number(t.amount), 0);
    document.getElementById('card-total-income').textContent = `₹${income.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    document.getElementById('card-total-expense').textContent = `₹${expense.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    document.getElementById('card-net-balance').textContent = `₹${(income - expense).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function populateCategoryFilterOptions() {
    const catSelect = document.getElementById('table-category-filter');
    const categories = new Set(transactions.map(t => t.category));
    catSelect.innerHTML = '<option value="ALL">All Categories</option>';
    categories.forEach(cat => { if(cat) catSelect.innerHTML += `<option value="${cat}">${cat}</option>`; });
}

function renderTransactionsTable() {
    const tbody = document.getElementById('transactions-tbody');
    const searchVal = document.getElementById('table-search').value.toLowerCase();
    const typeVal = document.getElementById('table-type-filter').value;
    const catVal = document.getElementById('table-category-filter').value;

    let filtered = getFilteredTransactions().filter(t => {
        return (t.description || '').toLowerCase().includes(searchVal) || (t.category || '').toLowerCase().includes(searchVal);
    }).filter(t => {
        return (typeVal === 'ALL' || t.type === typeVal) && (catVal === 'ALL' || t.category === catVal);
    });

    filtered.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="px-4 py-6 text-center text-gray-400 text-xs">No entries found for this user.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(item => `
        <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition">
            <td class="px-4 py-3 font-mono text-[11px]">${item.date}</td>
            <td class="px-4 py-3"><span class="px-2 py-0.5 text-[10px] font-semibold rounded-full ${item.type === 'INCOME' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">${item.type}</span></td>
            <td class="px-4 py-3 font-medium">${item.category}</td>
            <td class="px-4 py-3 text-gray-500 max-w-[150px] truncate">${item.description || '-'}</td>
            <td class="px-4 py-3 text-right font-bold ${item.type === 'INCOME' ? 'text-emerald-600' : 'text-rose-600'}">${item.type === 'INCOME' ? '+' : '-'}₹${Number(item.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
            <td class="px-4 py-3 text-center">
                <button onclick="editEntry('${item.id}')" class="p-1 text-blue-600 hover:bg-blue-50 rounded mr-1"><i class="fas fa-edit"></i></button>
                <button onclick="openDeleteModal('${item.id}')" class="p-1 text-rose-600 hover:bg-rose-50 rounded"><i class="fas fa-trash-alt"></i></button>
            </td>
        </tr>
    `).join('');
}

function updateCategoryOptions() {
    const type = document.getElementById('entry-type').value;
    const categorySelect = document.getElementById('entry-category');
    categorySelect.innerHTML = CATEGORIES[type].map(c => `<option value="${c}">${c}</option>`).join('');
}

function openEntryModal(id = null) {
    updateCategoryOptions();
    if (!id) {
        document.getElementById('entry-id').value = '';
        document.getElementById('entry-type').value = 'EXPENSE';
        updateCategoryOptions();
        document.getElementById('entry-amount').value = '';
        document.getElementById('entry-description').value = '';
    }
    document.getElementById('entry-modal').classList.remove('hidden');
}

function closeEntryModal() { document.getElementById('entry-modal').classList.add('hidden'); }

function editEntry(id) {
    const item = transactions.find(t => t.id == id);
    if (!item) return;
    document.getElementById('entry-id').value = item.id;
    document.getElementById('entry-type').value = item.type;
    updateCategoryOptions();
    document.getElementById('entry-category').value = item.category;
    document.getElementById('entry-date').value = item.date;
    document.getElementById('entry-amount').value = item.amount;
    document.getElementById('entry-description').value = item.description || '';
    openEntryModal(item.id);
}

document.getElementById('transaction-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('entry-id').value;
    const entry = {
        action: id ? "edit" : "add",
        id: id || Date.now().toString(),
        type: document.getElementById('entry-type').value,
        date: document.getElementById('entry-date').value,
        category: document.getElementById('entry-category').value,
        amount: parseFloat(document.getElementById('entry-amount').value),
        description: document.getElementById('entry-description').value.trim()
    };

    showToast('Saving entry...', 'info');
    closeEntryModal();

    await sendToSheet(entry);
    setTimeout(async () => {
        await fetchTransactionsFromSheet();
        showToast(id ? 'Updated!' : 'Added!', 'success');
    }, 1500);
});

function openDeleteModal(id) { pendingDeleteId = id; document.getElementById('delete-modal').classList.remove('hidden'); }
function closeDeleteModal() { pendingDeleteId = null; document.getElementById('delete-modal').classList.add('hidden'); }

document.getElementById('confirm-delete-btn').addEventListener('click', async () => {
    if (pendingDeleteId) {
        showToast('Deleting...', 'info');
        closeDeleteModal();

        await sendToSheet({ action: "delete", id: pendingDeleteId });
        setTimeout(async () => {
            await fetchTransactionsFromSheet();
            showToast('Entry deleted!', 'info');
        }, 1500);
    }
});

function openPasswordModal() { document.getElementById('password-modal').classList.remove('hidden'); }
function closePasswordModal() { document.getElementById('password-modal').classList.add('hidden'); }

document.getElementById('change-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const curr = document.getElementById('curr-password').value;
    const next = document.getElementById('new-password').value;

    showToast('Updating Password...', 'info');
    closePasswordModal();

    await sendToSheet({
        action: "change_password",
        email: userSessionEmail,
        currentPassword: curr,
        newPassword: next
    });

    showToast('Password updated in DB!', 'success');
});

function renderAnalyticsCharts() {
    const filtered = getFilteredTransactions();
    const expCategories = {};
    filtered.filter(t => t.type === 'EXPENSE').forEach(t => expCategories[t.category] = (expCategories[t.category] || 0) + Number(t.amount));

    if (pieChartInstance) pieChartInstance.destroy();
    const pieCtx = document.getElementById('expense-pie-chart');
    if(pieCtx) {
        pieChartInstance = new Chart(pieCtx.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: Object.keys(expCategories),
                datasets: [{ data: Object.values(expCategories), backgroundColor: ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'] }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });
    }

    const incomeTotal = filtered.filter(t => t.type === 'INCOME').reduce((acc, t) => acc + Number(t.amount), 0);
    const expenseTotal = filtered.filter(t => t.type === 'EXPENSE').reduce((acc, t) => acc + Number(t.amount), 0);

    if (barChartInstance) barChartInstance.destroy();
    const barCtx = document.getElementById('income-expense-chart');
    if(barCtx) {
        barChartInstance = new Chart(barCtx.getContext('2d'), {
            type: 'bar',
            data: {
                labels: ['Income', 'Expense'],
                datasets: [{ data: [incomeTotal, expenseTotal], backgroundColor: ['#10b981', '#ef4444'] }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });
    }
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    const icon = document.getElementById('toast-icon');
    document.getElementById('toast-message').textContent = message;
    
    toast.className = "fixed top-3 right-3 left-3 sm:left-auto sm:right-5 z-50 pointer-events-auto transform transition-transform duration-300 ease-in-out px-4 py-3 rounded-xl shadow-2xl text-xs sm:text-sm font-medium flex items-center justify-between sm:justify-start gap-2.5 text-white ";
    if (type === 'success') { toast.classList.add('bg-emerald-600'); icon.className = 'fas fa-check-circle'; }
    else if (type === 'error') { toast.classList.add('bg-rose-600'); icon.className = 'fas fa-exclamation-circle'; }
    else { toast.classList.add('bg-blue-600'); icon.className = 'fas fa-info-circle'; }

    toast.classList.remove('translate-y-[-150%]', 'sm:translate-x-[120%]');
    setTimeout(() => toast.classList.add('translate-y-[-150%]', 'sm:translate-x-[120%]'), 3000);
}