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

/* =========================================================
   SESSION / AUTH
   ========================================================= */
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

function fetchJSONP(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const callbackName = 'jsonp_cb_' + Math.round(100000 * Math.random());
        const script = document.createElement('script');
        let settled = false;

        const cleanup = () => {
            delete window[callbackName];
            if (script.parentNode) script.parentNode.removeChild(script);
            clearTimeout(timer);
        };

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(
                'JSONP request timed out. The Apps Script web app did not respond in time. ' +
                'Check that GOOGLE_SCRIPT_URL is the current /exec URL and that the deployment is still active.'
            ));
        }, timeoutMs);

        window[callbackName] = function (data) {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(data);
        };

        script.onerror = function () {
            if (settled) return;
            settled = true;
            cleanup();
            // This fires when the script tag itself fails to load - almost always because
            // the Apps Script deployment returned something other than JavaScript (an HTML
            // sign-in/permission page) or the URL/deployment no longer exists. Modern
            // browsers block ("Opaque Response Blocking") these non-JS cross-origin
            // responses, which surfaces here as a generic load failure.
            reject(new Error(
                'JSONP request failed. Most likely cause: the Apps Script deployment is not ' +
                'public (Who has access must be "Anyone"), or GOOGLE_SCRIPT_URL points to a ' +
                'deployment that was deleted or replaced. Re-check Deploy > Manage deployments ' +
                'in the Apps Script editor and the URL in script.js.'
            ));
        };

        script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + callbackName;
        document.body.appendChild(script);
    });
}

document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = await hashPassword(document.getElementById('auth-password').value);

    showToast(currentAuthMode === 'signup' ? 'Creating account...' : 'Authenticating...', 'info');

    try {
        const action = currentAuthMode === 'signup' ? 'signup' : 'auth';
        const targetUrl = `${GOOGLE_SCRIPT_URL}?action=${action}&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;
        const res = await fetchJSONP(targetUrl);

        if (currentAuthMode === 'signup') {
            if (res.success) {
                showToast('Account created!', 'success');
                startSession(email);
                await fetchTransactionsFromSheet();
            } else {
                showToast(res.message || 'Registration failed', 'error');
            }
        } else {
            if (res && res.success) {
                startSession(email);
                showToast('Welcome back!', 'success');
                await fetchTransactionsFromSheet();
            } else {
                showToast('Invalid email or password!', 'error');
            }
        }
    } catch (err) {
        console.error(err);
        showToast('Authentication error while connecting to the Sheets database', 'error');
    }
});

function startSession(email) {
    userSessionEmail = email;
    sessionStorage.setItem('active_user_email', email);
    document.getElementById('user-badge').textContent = email;
    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('app-section').classList.remove('hidden');
}

/* =========================================================
   GOOGLE SHEET SYNC
   ========================================================= */
async function fetchTransactionsFromSheet() {
    showToast('Syncing your data...', 'info');
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
        showToast(err && err.message ? err.message : 'Sync failed', 'error');
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
    transactions = [];
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

/* =========================================================
   THEME / DATES / TABS / FILTERS
   ========================================================= */
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
    const today = toYMD(now);
    document.getElementById('filter-month-input').value = `${year}-${month}`;
    document.getElementById('entry-date').value = today;
    // Expenses/income can only be logged for today or earlier, never for a future date.
    document.getElementById('entry-date').max = today;
    document.getElementById('filter-from-date').value = `${year}-${month}-01`;
    document.getElementById('filter-from-date').max = today;
    document.getElementById('filter-to-date').value = toYMD(new Date(year, now.getMonth() + 1, 0));
    document.getElementById('filter-to-date').max = today;
}

function switchTab(tabName) {
    document.querySelectorAll('.tab-view').forEach(view => view.classList.add('hidden'));
    document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.remove('text-blue-600', 'dark:text-blue-400', 'bg-blue-50', 'dark:bg-blue-900/30'));

    document.getElementById(`view-${tabName}`).classList.remove('hidden');
    const activeTab = document.getElementById(`tab-${tabName}`);
    if (activeTab) activeTab.classList.add('text-blue-600', 'dark:text-blue-400', 'bg-blue-50', 'dark:bg-blue-900/30');

    if (tabName === 'analytics') renderAnalyticsCharts();
}

/* ----- mobile sidebar (tab menu slides in below 768px) ----- */
function setSidebarOpen(open) {
    const nav = document.getElementById('tab-nav');
    const overlay = document.getElementById('sidebar-overlay');
    const toggle = document.getElementById('menu-toggle');
    if (nav) nav.classList.toggle('is-open', open);
    if (overlay) overlay.classList.toggle('is-open', open);
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
    // Lets CSS drop the header's backdrop-filter while open, so the fixed
    // drawer/overlay size against the viewport instead of the header's box.
    document.body.classList.toggle('sidebar-drawer-open', open);
    document.body.classList.toggle('overflow-hidden', open);
}

function openSidebar() { setSidebarOpen(true); }

function closeSidebar() { setSidebarOpen(false); }

function toggleSidebar() {
    const nav = document.getElementById('tab-nav');
    setSidebarOpen(!(nav && nav.classList.contains('is-open')));
}

window.addEventListener('DOMContentLoaded', () => {
    // Picking any menu item (including Add Entry) closes the sidebar
    const nav = document.getElementById('tab-nav');
    if (nav) nav.addEventListener('click', e => { if (e.target.closest('button')) closeSidebar(); });

    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });

    // Reset the drawer state when the window grows to desktop size
    window.matchMedia('(min-width: 768px)').addEventListener('change', e => { if (e.matches) closeSidebar(); });
});

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
        const date = (item.date || '').toString().slice(0, 10);
        if (currentFilterMode === 'month') {
            return date.startsWith(document.getElementById('filter-month-input').value);
        } else if (currentFilterMode === 'range') {
            const from = document.getElementById('filter-from-date').value;
            const to = document.getElementById('filter-to-date').value;
            return (!from || date >= from) && (!to || date <= to);
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

/* =========================================================
   DASHBOARD RENDERING
   ========================================================= */
// Smoothly counts an element's displayed ₹ value from its last rendered
// number up to the new one, instead of just snapping the text in place.
function animateCardValue(el, value) {
    if (!el) return;
    const prev = Number(el.dataset.rawValue || 0);
    const next = Number(value) || 0;
    el.dataset.rawValue = next;

    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.textContent = `₹${next.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
        return;
    }

    const duration = 650;
    const start = performance.now();
    cancelAnimationFrame(el._countRaf);

    function tick(now) {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
        const current = prev + (next - prev) * eased;
        el.textContent = `₹${current.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
        if (t < 1) el._countRaf = requestAnimationFrame(tick);
    }
    el._countRaf = requestAnimationFrame(tick);
}

function renderSummaryCards() {
    const filtered = getFilteredTransactions();
    const income = filtered.filter(t => t.type === 'INCOME').reduce((acc, t) => acc + Number(t.amount), 0);
    const expense = filtered.filter(t => t.type === 'EXPENSE').reduce((acc, t) => acc + Number(t.amount), 0);
    animateCardValue(document.getElementById('card-total-income'), income);
    animateCardValue(document.getElementById('card-total-expense'), expense);
    animateCardValue(document.getElementById('card-net-balance'), income - expense);
}

function populateCategoryFilterOptions() {
    const catSelect = document.getElementById('table-category-filter');
    const previous = catSelect.value || 'ALL';
    const categories = new Set(transactions.map(t => t.category));
    catSelect.innerHTML = '<option value="ALL">All Categories</option>';
    categories.forEach(cat => { if (cat) catSelect.innerHTML += `<option value="${cat}">${cat}</option>`; });
    if ([...catSelect.options].some(o => o.value === previous)) catSelect.value = previous;
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
            <td class="px-4 py-3 font-mono text-[11px]">${(item.date || '').toString().slice(0, 10)}</td>
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

/* =========================================================
   ENTRY MODAL (ADD / EDIT / DELETE)
   ========================================================= */
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
    document.getElementById('entry-date').value = (item.date || '').toString().slice(0, 10);
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
        showToast(id ? 'Entry updated!' : 'Entry added!', 'success');
    }, 1500);
});

function openDeleteModal(id) { pendingDeleteId = id; document.getElementById('delete-modal').classList.remove('hidden'); }
function closeDeleteModal() { pendingDeleteId = null; document.getElementById('delete-modal').classList.add('hidden'); }

document.getElementById('confirm-delete-btn').addEventListener('click', async () => {
    if (pendingDeleteId) {
        const idToDelete = pendingDeleteId;
        showToast('Deleting...', 'info');
        closeDeleteModal();

        await sendToSheet({ action: "delete", id: idToDelete });
        setTimeout(async () => {
            await fetchTransactionsFromSheet();
            showToast('Entry deleted!', 'info');
        }, 1500);
    }
});

/* =========================================================
   PASSWORD
   ========================================================= */
function openPasswordModal() { document.getElementById('password-modal').classList.remove('hidden'); }
function closePasswordModal() { document.getElementById('password-modal').classList.add('hidden'); }

document.getElementById('change-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const curr = await hashPassword(document.getElementById('curr-password').value);
    const next = await hashPassword(document.getElementById('new-password').value);

    showToast('Updating password...', 'info');
    closePasswordModal();

    await sendToSheet({
        action: "change_password",
        email: userSessionEmail,
        currentPassword: curr,
        newPassword: next
    });

    verifyPasswordChange(next);
    document.getElementById('curr-password').value = '';
    document.getElementById('new-password').value = '';
});

/* =========================================================
   CHARTS
   ========================================================= */
function renderAnalyticsCharts() {
    const filtered = getFilteredTransactions();
    const expCategories = {};
    filtered.filter(t => t.type === 'EXPENSE').forEach(t => expCategories[t.category] = (expCategories[t.category] || 0) + Number(t.amount));

    if (pieChartInstance) pieChartInstance.destroy();
    const pieCtx = document.getElementById('expense-pie-chart');
    if (pieCtx) {
        pieChartInstance = new Chart(pieCtx.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: Object.keys(expCategories),
                datasets: [{ data: Object.values(expCategories), backgroundColor: ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16'] }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });
    }

    const incomeTotal = filtered.filter(t => t.type === 'INCOME').reduce((acc, t) => acc + Number(t.amount), 0);
    const expenseTotal = filtered.filter(t => t.type === 'EXPENSE').reduce((acc, t) => acc + Number(t.amount), 0);

    if (barChartInstance) barChartInstance.destroy();
    const barCtx = document.getElementById('income-expense-chart');
    if (barCtx) {
        barChartInstance = new Chart(barCtx.getContext('2d'), {
            type: 'bar',
            data: {
                labels: ['Income', 'Expense'],
                datasets: [{ data: [incomeTotal, expenseTotal], backgroundColor: ['#10b981', '#ef4444'] }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
    }
}

/* =========================================================
   TOAST
   ========================================================= */
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    const icon = document.getElementById('toast-icon');
    document.getElementById('toast-message').textContent = message;

    toast.className = "fixed top-3 right-3 left-3 sm:left-auto sm:right-5 z-50 pointer-events-auto transform transition-transform duration-300 ease-in-out px-4 py-3 rounded-xl shadow-2xl text-xs sm:text-sm font-medium flex items-center justify-between sm:justify-start gap-2.5 text-white ";
    if (type === 'success') { toast.classList.add('bg-emerald-600'); icon.className = 'fas fa-check-circle'; }
    else if (type === 'error') { toast.classList.add('bg-rose-600'); icon.className = 'fas fa-exclamation-circle'; }
    else { toast.classList.add('bg-blue-600'); icon.className = 'fas fa-info-circle'; }

    toast.classList.remove('translate-y-[-150%]', 'sm:translate-x-[120%]');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => toast.classList.add('translate-y-[-150%]', 'sm:translate-x-[120%]'), 3000);
}

/* =========================================================
   EXPORT (PERIOD BASED)
   ========================================================= */
function toYMD(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getActiveUserSession() {
    const email = userSessionEmail || sessionStorage.getItem('active_user_email') || '';
    return {
        id: email,
        name: email ? email.split('@')[0] : 'User',
        email: email
    };
}

// Dropdown toggle
function toggleExportMenu() {
    const menu = document.getElementById('exportMenu');
    if (menu) menu.classList.toggle('hidden');
}

// Close dropdown when clicking outside
window.addEventListener('click', function (e) {
    const container = document.getElementById('exportDropdownContainer');
    if (container && !container.contains(e.target)) {
        const menu = document.getElementById('exportMenu');
        if (menu) menu.classList.add('hidden');
    }
});

// Returns the transactions for the selected export period
function getExportData(period) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    let from = null, to = null;

    switch (period) {
        case 'this_month':
            from = new Date(y, m, 1); to = new Date(y, m + 1, 0); break;
        case 'last_month':
            from = new Date(y, m - 1, 1); to = new Date(y, m, 0); break;
        case 'last_6_months':
            from = new Date(y, m - 6, d); to = now; break;
        case 'last_year':
            from = new Date(y - 1, m, d); to = now; break;
        case 'current_filter':
            return { data: getFilteredTransactions().slice(), label: 'Filtered' };
        default:
            return { data: transactions.slice(), label: 'All_Data' };
    }

    const labels = { this_month: 'This_Month', last_month: 'Last_Month', last_6_months: 'Last_6_Months', last_year: 'Last_Year' };
    const fromStr = toYMD(from), toStr = toYMD(to);
    const data = transactions.filter(t => {
        const dt = (t.date || '').toString().slice(0, 10);
        return dt >= fromStr && dt <= toStr;
    });
    return { data, label: labels[period] };
}

let pendingExportFormat = null;

function openExportModal(format) {
    pendingExportFormat = format;
    const menu = document.getElementById('exportMenu');
    if (menu) menu.classList.add('hidden');
    document.getElementById('export-modal-title').textContent = ({ excel: 'Export to Excel', pdf: 'Export to PDF', csv: 'Export to CSV' })[format] || 'Export Data';
    updateExportCount();
    document.getElementById('export-modal').classList.remove('hidden');
}

function closeExportModal() {
    document.getElementById('export-modal').classList.add('hidden');
}

function updateExportCount() {
    const { data } = getExportData(document.getElementById('export-period').value);
    document.getElementById('export-count').textContent = `${data.length} entries will be exported`;
}

function confirmExport() {
    const period = document.getElementById('export-period').value;
    const { data, label } = getExportData(period);

    if (data.length === 0) {
        showToast('No data available to export for the selected period.', 'error');
        return;
    }

    closeExportModal();
    data.sort((a, b) => new Date(a.date) - new Date(b.date));

    const userName = getActiveUserSession().name || 'User';
    const fileName = `${userName}_Expenses_${label}_${toYMD(new Date())}`;

    if (pendingExportFormat === 'excel') exportToExcel(data, fileName);
    else if (pendingExportFormat === 'pdf') exportToPDF(data, fileName, userName);
    else if (pendingExportFormat === 'csv') exportToCSV(data, fileName);

    showToast(`Exported ${data.length} entries`, 'success');
}

function exportToExcel(data, fileName) {
    const formattedData = data.map((item, index) => ({
        "S.No": index + 1,
        "Date": (item.date || 'N/A').toString().slice(0, 10),
        "Type": item.type || 'EXPENSE',
        "Category": item.category || 'General',
        "Description": item.description || item.title || '',
        "Amount (₹)": Number(item.amount || 0)
    }));

    const worksheet = XLSX.utils.json_to_sheet(formattedData);
    worksheet['!cols'] = [{ wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 30 }, { wch: 12 }];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "My Expenses");
    XLSX.writeFile(workbook, `${fileName}.xlsx`);
}

function exportToPDF(data, fileName, userName) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    doc.setFontSize(18);
    doc.text(`Expense Report - ${userName}`, 14, 20);

    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Generated Date: ${new Date().toLocaleDateString()}`, 14, 28);

    const totalIncome = data.filter(t => t.type === 'INCOME').reduce((s, t) => s + Number(t.amount || 0), 0);
    const totalExpense = data.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + Number(t.amount || 0), 0);
    doc.text(`Records: ${data.length} | Income: Rs. ${totalIncome.toFixed(2)} | Expense: Rs. ${totalExpense.toFixed(2)} | Balance: Rs. ${(totalIncome - totalExpense).toFixed(2)}`, 14, 34);

    const tableColumn = ["S.No", "Date", "Type", "Category", "Description", "Amount (Rs)"];
    const tableRows = data.map((item, index) => [
        index + 1,
        (item.date || 'N/A').toString().slice(0, 10),
        item.type || 'EXPENSE',
        item.category || 'General',
        item.description || item.title || '-',
        Number(item.amount || 0).toFixed(2)
    ]);

    doc.autoTable({
        startY: 40,
        head: [tableColumn],
        body: tableRows,
        theme: 'striped',
        headStyles: { fillColor: [2, 132, 199] },
        styles: { fontSize: 8 },
        columnStyles: {
            0: { cellWidth: 12 },
            1: { cellWidth: 22 },
            2: { cellWidth: 20 },
            3: { cellWidth: 30 },
            4: { cellWidth: 65 },
            5: { cellWidth: 25, halign: 'right' }
        }
    });

    doc.save(`${fileName}.pdf`);
}

/* =========================================================
   RESULT POPUP
   ========================================================= */
function showConfirmModal(title, message, okText = 'Yes', iconClass = 'fas fa-question') {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');

        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').textContent = message;
        document.getElementById('confirm-icon').className = iconClass;
        okBtn.textContent = okText;
        modal.classList.remove('hidden');

        const finish = (result) => {
            modal.classList.add('hidden');
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            resolve(result);
        };
        okBtn.onclick = () => finish(true);
        cancelBtn.onclick = () => finish(false);
    });
}

function showResultModal(type, title, message) {
    const styles = {
        success: { wrap: 'bg-emerald-100 text-emerald-600', icon: 'fas fa-check' },
        error:   { wrap: 'bg-rose-100 text-rose-600',       icon: 'fas fa-times' },
        warning: { wrap: 'bg-amber-100 text-amber-600',      icon: 'fas fa-exclamation' }
    };
    const st = styles[type] || styles.success;
    document.getElementById('result-icon-wrap').className = `inline-flex items-center justify-center w-14 h-14 rounded-full mb-3 text-2xl ${st.wrap}`;
    document.getElementById('result-icon').className = st.icon;
    document.getElementById('result-title').textContent = title;
    document.getElementById('result-message').textContent = message;
    document.getElementById('result-modal').classList.remove('hidden');
}

function closeResultModal() {
    document.getElementById('result-modal').classList.add('hidden');
}

/* =========================================================
   IMPORT FROM EXCEL
   ========================================================= */
function downloadImportTemplate() {
    const sample = [
        { "Date": "2026-10-01", "Type": "INCOME", "Category": "Salary", "Description": "October salary", "Amount": 50000 },
        { "Date": "2026-10-02", "Type": "EXPENSE", "Category": "Groceries", "Description": "Weekly groceries", "Amount": 2500 }
    ];
    const ws = XLSX.utils.json_to_sheet(sample);
    ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 18 }, { wch: 30 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Import");
    XLSX.writeFile(wb, "Expense_Import_Template.xlsx");
}

function triggerImport() {
    document.getElementById('exportMenu').classList.add('hidden');
    document.getElementById('import-file').click();
}

document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => processImportFile(ev.target.result);
    reader.readAsArrayBuffer(file);
    e.target.value = ''; // allows selecting the same file again
});

function pickColumn(row, names) {
    for (const key of Object.keys(row)) {
        const k = key.toString().trim().toLowerCase();
        if (names.some(n => k.startsWith(n))) return row[key];
    }
    return '';
}

function parseImportDate(val) {
    if (val instanceof Date && !isNaN(val)) return toYMD(val);
    if (typeof val === 'number') {
        const p = XLSX.SSF.parse_date_code(val);
        if (p) return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    }
    const s = (val || '').toString().trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); // DD/MM/YYYY
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
}

async function processImportFile(buffer) {
    try {
        const wb = XLSX.read(buffer, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json(ws, { defval: '' });

        const valid = [];
        let skipped = 0;

        rawRows.forEach((row, i) => {
            const date = parseImportDate(pickColumn(row, ['date']));
            const type = pickColumn(row, ['type']).toString().trim().toUpperCase();
            const amount = parseFloat(pickColumn(row, ['amount']));
            let category = pickColumn(row, ['category']).toString().trim();
            const description = pickColumn(row, ['description', 'title']).toString().trim();

            if (!date || !['INCOME', 'EXPENSE'].includes(type) || !(amount > 0)) { skipped++; return; }
            if (!category) category = type === 'INCOME' ? 'Other Income' : 'Other Expense';

            valid.push({ id: Date.now() + '_' + i, date, type, category, amount, description });
        });

        if (valid.length === 0) {
            showResultModal('error', 'Nothing to Import', 'No valid rows were found. Please use the import template.');
            return;
        }

        const skippedText = skipped ? ` ${skipped} invalid row(s) will be skipped.` : '';
        const ok = await showConfirmModal(
            'Import Entries?',
            `${valid.length} ${valid.length === 1 ? 'entry' : 'entries'} will be added to your account.${skippedText}`,
            'Yes, Import',
            'fas fa-file-import'
        );
        if (!ok) return;

        const countBefore = transactions.length;
        showToast(`Importing ${valid.length} entries...`, 'info');

        const CHUNK = 200;
        for (let i = 0; i < valid.length; i += CHUNK) {
            await sendToSheet({ action: 'bulk_add', rows: valid.slice(i, i + CHUNK) });
        }

        setTimeout(async () => {
            await fetchTransactionsFromSheet();
            const added = transactions.length - countBefore;
            const skippedNote = skipped ? ` ${skipped} invalid row(s) were skipped.` : '';
            if (added >= valid.length) {
                showResultModal('success', 'Import Successful', `${valid.length} ${valid.length === 1 ? 'entry was' : 'entries were'} imported successfully.${skippedNote}`);
            } else if (added > 0) {
                showResultModal('warning', 'Partly Imported', `Only ${added} of ${valid.length} entries were imported.${skippedNote}`);
            } else {
                showResultModal('error', 'Import Failed', 'No entries were saved. Please redeploy your Google Apps Script as a New version and try again.');
            }
        }, 2500);
    } catch (err) {
        console.error(err);
        showResultModal('error', 'Import Failed', 'Please check the file format and try again.');
    }
}
