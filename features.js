/* =========================================================
   FEATURES.JS  -  extra features for the Expense Tracker
   (budgets, goals, recurring, insights, custom categories,
    sorting + pagination, CSV export, shortcuts, theme memory)
   Load AFTER script.js
   ========================================================= */

const EXTRA = { budgets: [], goals: [], recurring: [], categories: [], settings: {} };
const BASE_CATEGORIES = JSON.parse(JSON.stringify(CATEGORIES));
let extrasLoadedFor = '';
let tableSort = { key: 'date', dir: 'desc' };
let tablePage = 1, tablePageSize = 10, lastFilterSig = '';
let trendChartInstance = null;

/* ---------- small helpers ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = (n) => '₹' + Math.round(Number(n || 0)).toLocaleString('en-IN');
const dOf = (t) => (t.date || '').toString().slice(0, 10);
const todayYM = () => toYMD(new Date()).slice(0, 7);
const daysIn = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const monthLabel = (ym) => new Date(ym + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const openModal = (id) => $(id).classList.remove('hidden');
const closeModal = (id) => $(id).classList.add('hidden');
const uid = (p) => Date.now() + '_' + p + Math.floor(Math.random() * 1000);

function progressBar(pct) {
    const c = pct >= 100 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#10b981';
    return `<div class="pbar"><div class="pbar-fill" style="width:${Math.min(pct, 100)}%;background:${c}"></div></div>`;
}

/* =========================================================
   PASSWORD HASHING (SHA-256, sent instead of plain text)
   ========================================================= */
async function hashPassword(pw) {
    pw = (pw || '').trim();
    try {
        if (window.crypto && crypto.subtle) {
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
            return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
        }
    } catch (e) { console.warn('Hashing unavailable, sending plain text', e); }
    return pw;
}

async function verifyPasswordChange(newHash) {
    await new Promise(r => setTimeout(r, 1800));
    try {
        const res = await fetchJSONP(`${GOOGLE_SCRIPT_URL}?action=auth&email=${encodeURIComponent(userSessionEmail)}&password=${encodeURIComponent(newHash)}`);
        if (res && res.success) showResultModal('success', 'Password Changed', 'Your password was updated successfully.');
        else showResultModal('error', 'Password Not Changed', 'Your current password was incorrect. Please try again.');
    } catch (e) {
        showResultModal('error', 'Check Failed', 'Could not verify the password change. Please try again.');
    }
}

/* =========================================================
   THEME MEMORY
   ========================================================= */
function updateThemeIcon() {
    const icon = $('theme-icon');
    if (icon) icon.className = (document.documentElement.classList.contains('dark') ? 'fas fa-sun' : 'fas fa-moon') + ' text-xs sm:text-sm';
}
window.initTheme = function () {
    let saved = null;
    try { saved = localStorage.getItem('theme'); } catch (e) { }
    const dark = saved ? saved === 'dark' : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    updateThemeIcon();
};
$('theme-toggle').addEventListener('click', () => {
    try { localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light'); } catch (e) { }
    updateThemeIcon();
});
window.initTheme();

/* =========================================================
   EXTRAS LOADING (budgets, goals, recurring, categories)
   ========================================================= */
function applyCustomCategories() {
    ['INCOME', 'EXPENSE'].forEach(type => {
        const base = BASE_CATEGORIES[type].slice(0, -1);
        const last = BASE_CATEGORIES[type][BASE_CATEGORIES[type].length - 1];
        const custom = EXTRA.categories.filter(c => c.type === type).map(c => c.name);
        CATEGORIES[type] = [...base, ...custom, last];
    });
}

async function loadExtras() {
    if (!userSessionEmail) return;
    try {
        const d = await fetchJSONP(`${GOOGLE_SCRIPT_URL}?action=get_extras&email=${encodeURIComponent(userSessionEmail)}`);
        EXTRA.budgets = d.budgets || [];
        EXTRA.goals = d.goals || [];
        EXTRA.recurring = d.recurring || [];
        EXTRA.categories = d.categories || [];
        EXTRA.settings = d.settings || {};
        extrasLoadedFor = userSessionEmail;
        applyCustomCategories();
        applyRecGoalLinks();
    } catch (e) { console.error('Extras load failed', e); }
    renderBudgets(); renderGoals(); renderRecurring();
    if (window.onExtrasLoaded) window.onExtrasLoaded();
}

// The Recurring sheet (excel.gs) has no goal_id/goal_amount columns, so the
// link between a recurring entry and a savings goal is stored instead as a
// plain key/value setting ("recgoal_<recurringId>" = "<goalId>:<amount>")
// using the existing set_setting action. This merges that link back onto
// each EXTRA.recurring item after (re)loading from the sheet.
function applyRecGoalLinks() {
    EXTRA.recurring.forEach(r => {
        const raw = EXTRA.settings['recgoal_' + r.id];
        if (raw) {
            const [gid, amt] = raw.split(':');
            r.goal_id = gid || '';
            r.goal_amount = Number(amt) || 0;
        } else {
            r.goal_id = r.goal_id || '';
            r.goal_amount = r.goal_amount || 0;
        }
    });
}

const _fetchTx = window.fetchTransactionsFromSheet;
window.fetchTransactionsFromSheet = async function () {
    await _fetchTx();
    if (extrasLoadedFor !== userSessionEmail) {
        await loadExtras();
        await processRecurring();
    }
};

const _refreshAppView = window.refreshAppView;
window.refreshAppView = function () {
    _refreshAppView();
    renderBudgets(); renderGoals(); renderRecurring();
    setTimeout(checkBudgetAlerts, 700);
};

/* =========================================================
   ADD CHOICE (Data Entry vs Set Recurring for Goal)
   ========================================================= */
function openAddChoiceModal() { openModal('add-choice-modal'); }
function chooseDataEntry() { closeModal('add-choice-modal'); openEntryModal(); }
function chooseRecurringGoal() {
    closeModal('add-choice-modal');
    if (!EXTRA.goals.length) {
        showToast('Create a savings goal first (Goals tab), then set up recurring saving.', 'error');
        return;
    }
    openGoalRecurringModal();
}

const _switchTab = window.switchTab;
window.switchTab = function (name) {
    _switchTab(name);
    const tb = $('filter-toolbar');
    if (tb) tb.classList.toggle('hidden', ['goals', 'recurring'].includes(name));
    if (name === 'budgets') renderBudgets();
    if (name === 'goals') renderGoals();
    if (name === 'recurring') renderRecurring();
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

$('logout-btn').addEventListener('click', () => {
    EXTRA.budgets = []; EXTRA.goals = []; EXTRA.recurring = []; EXTRA.categories = []; EXTRA.settings = {};
    extrasLoadedFor = '';
    applyCustomCategories();
    switchTab('dashboard');
});

/* =========================================================
   ENTRY MODAL: title + duplicate + custom categories
   ========================================================= */
const _openEntryModal = window.openEntryModal;
window.openEntryModal = function (id = null) {
    _openEntryModal(id);
    $('modal-form-title').textContent = id === 'dup' ? 'Duplicate Entry' : id ? 'Edit Entry' : 'Add New Entry';
};

function duplicateEntry(id) {
    const it = transactions.find(t => t.id == id);
    if (!it) return;
    openEntryModal('dup');
    $('entry-id').value = '';
    $('entry-type').value = it.type;
    updateCategoryOptions();
    $('entry-category').value = it.category;
    $('entry-date').value = toYMD(new Date());
    $('entry-amount').value = it.amount;
    $('entry-description').value = it.description || '';
}

function renderCustomCatList() {
    const type = $('entry-type').value;
    const mine = EXTRA.categories.filter(c => c.type === type);
    $('custom-cat-type').textContent = type === 'INCOME' ? 'Income' : 'Expense';
    $('custom-cat-list').innerHTML = mine.length ? mine.map(c => `
        <span class="chip">${esc(c.name)}
            <button type="button" onclick="deleteCustomCategory('${esc(c.name).replace(/'/g, "\\'")}')" title="Remove"><i class="fas fa-times"></i></button>
        </span>`).join('') : '<span class="text-[11px] text-gray-400">No custom categories yet.</span>';
}
function openCategoryModal() { $('cat-name').value = ''; renderCustomCatList(); openModal('category-modal'); setTimeout(() => $('cat-name').focus(), 100); }
$('category-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = $('entry-type').value;
    const name = $('cat-name').value.trim().slice(0, 30);
    if (!name) return;
    if (CATEGORIES[type].some(c => c.toLowerCase() === name.toLowerCase())) {
        showToast('That category already exists.', 'error');
        return;
    }
    EXTRA.categories.push({ type, name });
    applyCustomCategories();
    updateCategoryOptions();
    $('entry-category').value = name;
    closeModal('category-modal');
    showToast('Category added!', 'success');
    await sendToSheet({ action: 'cat_add', type, name });
});
async function deleteCustomCategory(name) {
    const type = $('entry-type').value;
    const current = $('entry-category').value;
    EXTRA.categories = EXTRA.categories.filter(c => !(c.type === type && c.name === name));
    applyCustomCategories();
    updateCategoryOptions();
    if (current !== name) $('entry-category').value = current;
    renderCustomCatList();
    await sendToSheet({ action: 'cat_delete', type, name });
}

/* =========================================================
   TRANSACTION TABLE: sorting + pagination + duplicate
   ========================================================= */
function setSort(key) {
    tableSort = { key, dir: tableSort.key === key && tableSort.dir === 'desc' ? 'asc' : 'desc' };
    renderTransactionsTable();
}
function goPage(n) { tablePage = n; renderTransactionsTable(); }
function setPageSize(v) { tablePageSize = Number(v); tablePage = 1; renderTransactionsTable(); }

function updateSortHeaders() {
    document.querySelectorAll('th[data-sort]').forEach(th => {
        const active = th.dataset.sort === tableSort.key;
        const arrow = active ? (tableSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
        th.innerHTML = th.dataset.label + `<span class="sort-arrow">${arrow}</span>`;
        th.classList.toggle('sort-active', active);
    });
}

window.renderTransactionsTable = function () {
    const tbody = $('transactions-tbody');
    const searchVal = $('table-search').value.toLowerCase();
    const typeVal = $('table-type-filter').value;
    const catVal = $('table-category-filter').value;

    let rows = getFilteredTransactions()
        .filter(t => String(t.description || '').toLowerCase().includes(searchVal) || String(t.category || '').toLowerCase().includes(searchVal))
        .filter(t => (typeVal === 'ALL' || t.type === typeVal) && (catVal === 'ALL' || t.category === catVal));
    const { key, dir } = tableSort;
    rows.sort((a, b) => {
        let r = key === 'amount' ? Number(a.amount) - Number(b.amount)
            : key === 'date' ? dOf(a).localeCompare(dOf(b))
            : String(a[key] || '').localeCompare(String(b[key] || ''));
        return dir === 'asc' ? r : -r;
    });

    const sig = [searchVal, typeVal, catVal, currentFilterMode, $('filter-month-input').value, $('filter-from-date').value, $('filter-to-date').value].join('|');
    if (sig !== lastFilterSig) { tablePage = 1; lastFilterSig = sig; }
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / tablePageSize));
    if (tablePage > pages) tablePage = pages;
    const slice = rows.slice((tablePage - 1) * tablePageSize, tablePage * tablePageSize);

    updateSortHeaders();

    if (total === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="px-4 py-10 text-center text-gray-400 text-xs"><div class="text-3xl mb-2"><i class="fas fa-receipt"></i></div>No entries found. Tap <b>+</b> to add your first one.</td></tr>`;
        $('pagination-bar').innerHTML = '';
        return;
    }

    tbody.innerHTML = slice.map(item => `
        <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition">
            <td class="px-4 py-3 font-mono text-[11px]">${esc(dOf(item))}</td>
            <td class="px-4 py-3"><span class="px-2 py-0.5 text-[10px] font-semibold rounded-full ${item.type === 'INCOME' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">${esc(item.type)}</span></td>
            <td class="px-4 py-3 font-medium">${esc(item.category)}</td>
            <td class="px-4 py-3 text-gray-500 max-w-[150px] truncate" title="${esc(item.description)}">${esc(item.description) || '-'}</td>
            <td class="px-4 py-3 text-right font-bold ${item.type === 'INCOME' ? 'text-emerald-600' : 'text-rose-600'}">${item.type === 'INCOME' ? '+' : '-'}${inr(item.amount)}</td>
            <td class="px-4 py-3 text-center whitespace-nowrap">
                <button onclick="editEntry('${esc(item.id)}')" title="Edit" class="p-1 text-blue-600 hover:bg-blue-50 rounded mr-1"><i class="fas fa-edit"></i></button>
                <button onclick="duplicateEntry('${esc(item.id)}')" title="Duplicate" class="p-1 text-violet-600 hover:bg-violet-50 rounded mr-1"><i class="fas fa-copy"></i></button>
                <button onclick="openDeleteModal('${esc(item.id)}')" title="Delete" class="p-1 text-rose-600 hover:bg-rose-50 rounded"><i class="fas fa-trash-alt"></i></button>
            </td>
        </tr>`).join('');

    // pagination bar
    const from = (tablePage - 1) * tablePageSize + 1, to = Math.min(tablePage * tablePageSize, total);
    let nums = '';
    for (let p = Math.max(1, tablePage - 2); p <= Math.min(pages, tablePage + 2); p++) {
        nums += `<button onclick="goPage(${p})" class="pg-btn ${p === tablePage ? 'pg-active' : ''}">${p}</button>`;
    }
    $('pagination-bar').innerHTML = `
        <div class="text-[11px] text-gray-500 dark:text-gray-400">Showing ${from}-${to} of ${total}</div>
        <div class="flex items-center gap-1">
            <button onclick="goPage(${tablePage - 1})" class="pg-btn" ${tablePage === 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>
            ${nums}
            <button onclick="goPage(${tablePage + 1})" class="pg-btn" ${tablePage === pages ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>
        </div>
        <select onchange="setPageSize(this.value)" class="fld pg-size">
            ${[10, 25, 50, 100].map(n => `<option value="${n}" ${n === tablePageSize ? 'selected' : ''}>${n} / page</option>`).join('')}
        </select>`;
};

/* =========================================================
   BUDGETS
   ========================================================= */
function getViewMonth() {
    if (currentFilterMode === 'month') { const v = $('filter-month-input').value; if (v) return v; }
    return todayYM();
}

// Budgets for one month: its own budgets, plus default budgets (no month) for categories with no budget of their own
function budgetsFor(ym) {
    const own = EXTRA.budgets.filter(b => b.month === ym);
    const defaults = EXTRA.budgets.filter(b => !b.month && !own.some(o => o.category === b.category));
    return [...own, ...defaults];
}
function monthExpenseByCat(ym) {
    const byCat = {}; let total = 0;
    transactions.forEach(t => {
        if (t.type === 'EXPENSE' && dOf(t).startsWith(ym)) {
            const a = Number(t.amount) || 0;
            byCat[t.category] = (byCat[t.category] || 0) + a;
            total += a;
        }
    });
    return { byCat, total };
}

function renderBudgets() {
    const list = $('budget-list'); if (!list) return;
    const ym = getViewMonth();
    const { byCat, total } = monthExpenseByCat(ym);
    $('budget-month-label').textContent = monthLabel(ym);

    const ov = budgetsFor(ym).find(b => b.category === '__TOTAL__');
    if (!ov) {
        $('budget-overall').innerHTML = `<div class="rounded-xl border border-gray-200 dark:border-gray-700 p-5 text-center text-xs text-gray-500 dark:text-gray-400">
            <div class="text-3xl mb-1"><i class="fas fa-bullseye"></i></div>No overall budget set for the month.
            <div class="mt-3"><button onclick="openBudgetModal('__TOTAL__')" class="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-medium">Set Monthly Budget</button></div></div>`;
    } else {
        const pct = ov.limit ? total / ov.limit * 100 : 0, remaining = ov.limit - total;
        const now = new Date(), isCur = ym === todayYM();
        const daysLeft = isCur ? daysIn(ym) - now.getDate() + 1 : 0;
        const perDay = isCur && remaining > 0 && daysLeft > 0 ? remaining / daysLeft : null;
        $('budget-overall').innerHTML = `<div class="rounded-xl border border-gray-200 dark:border-gray-700 p-5">
            <div class="flex items-start justify-between gap-3">
                <div><div class="text-xs text-gray-500 dark:text-gray-400">Overall monthly budget${ov.month ? '' : ' <span class="text-amber-600"></span>'}</div>
                <div class="text-2xl font-bold mt-0.5">${inr0(total)} <span class="text-sm font-medium text-gray-400">of ${inr0(ov.limit)}</span></div></div>
                <div class="text-right"><div class="text-2xl font-bold ${pct >= 100 ? 'text-rose-500' : pct >= 80 ? 'text-amber-500' : 'text-emerald-500'}">${Math.round(pct)}%</div>
                <div class="text-[11px] text-gray-400">used</div></div>
            </div>
            <div class="my-3">${progressBar(pct)}</div>
            <div class="flex flex-wrap items-center justify-between gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                <span>${remaining >= 0 ? inr0(remaining) + ' left' : inr0(-remaining) + ' over budget'}</span>
                ${perDay !== null ? `<span>You can spend about <b>${inr0(perDay)}</b> per day for the remaining ${daysLeft} days</span>` : ''}
                <span><button onclick="openBudgetModal('__TOTAL__')" class="text-blue-600 hover:underline">Edit</button> · <button onclick="removeBudget('__TOTAL__')" class="text-rose-500 hover:underline">Remove</button></span>
            </div></div>`;
    }

    const cats = budgetsFor(ym).filter(b => b.category !== '__TOTAL__')
        .map(b => ({ ...b, spent: byCat[b.category] || 0 }))
        .map(b => ({ ...b, pct: b.limit ? b.spent / b.limit * 100 : 0 }))
        .sort((a, b) => b.pct - a.pct);

    list.innerHTML = cats.map(b => `<div class="rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div class="flex items-center justify-between mb-2">
            <div class="font-semibold text-sm">${esc(b.category)}${b.month ? '' : ' <span class="text-[10px] font-normal text-amber-600">(default)</span>'}</div>
            <div class="text-xs font-bold ${b.pct >= 100 ? 'text-rose-500' : b.pct >= 80 ? 'text-amber-500' : 'text-emerald-500'}">${Math.round(b.pct)}%</div>
        </div>
        ${progressBar(b.pct)}
        <div class="flex items-center justify-between mt-2 text-[11px] text-gray-500 dark:text-gray-400">
            <span>${inr0(b.spent)} / ${inr0(b.limit)}</span>
            <span><button onclick="openBudgetModal('${esc(b.category).replace(/'/g, "\\'")}')" class="text-blue-600 hover:underline">Edit</button> · <button onclick="removeBudget('${esc(b.category).replace(/'/g, "\\'")}')" class="text-rose-500 hover:underline">Remove</button></span>
        </div></div>`).join('');

    const unbudgeted = Object.entries(byCat).filter(([c]) => !budgetsFor(ym).some(b => b.category === c)).sort((a, b) => b[1] - a[1]);
    if (unbudgeted.length) {
        list.innerHTML += `<div class="md:col-span-2 rounded-xl border border-dashed border-gray-300 dark:border-gray-600 p-4">
            <div class="text-xs font-semibold mb-2">Spending without a budget <span class="font-normal text-gray-400">(tap to set one)</span></div>
            <div class="flex flex-wrap gap-2">${unbudgeted.map(([c, v]) => `<button onclick="openBudgetModal('${esc(c).replace(/'/g, "\\'")}')" class="chip chip-btn">${esc(c)} · ${inr0(v)}</button>`).join('')}</div></div>`;
    }
}

function openBudgetModal(cat, ym = getViewMonth()) {
    const sel = $('budget-category');
    sel.innerHTML = '<option value="__TOTAL__">Overall (all expenses)</option>' + CATEGORIES.EXPENSE.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    sel.value = cat || '__TOTAL__';
    $('budget-form').dataset.month = ym;
    $('budget-modal-month').textContent = `Applies to ${monthLabel(ym)} only`;
    const ex = budgetsFor(ym).find(b => b.category === sel.value);
    $('budget-limit').value = ex ? ex.limit : '';
    openModal('budget-modal');
}
$('budget-category').addEventListener('change', () => {
    const ex = budgetsFor($('budget-form').dataset.month).find(b => b.category === $('budget-category').value);
    $('budget-limit').value = ex ? ex.limit : '';
});
$('budget-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const category = $('budget-category').value;
    const limit = parseFloat($('budget-limit').value);
    const month = $('budget-form').dataset.month || todayYM();
    if (!(limit > 0)) return;
    EXTRA.budgets = EXTRA.budgets.filter(b => !(b.category === category && (b.month || '') === month));
    EXTRA.budgets.push({ category, limit, month });
    closeModal('budget-modal');
    renderBudgets();
    showToast('Budget saved!', 'success');
    await sendToSheet({ action: 'set_budget', category, limit, month });
    setTimeout(checkBudgetAlerts, 500);
});
async function removeBudget(category, ym = getViewMonth()) {
    const row = budgetsFor(ym).find(b => b.category === category);
    if (!row) return;
    const msg = row.month ? 'This budget for this month will be deleted.' : 'This default budget will be removed from every month that has no budget of its own.';
    const ok = await showConfirmModal('Remove Budget?', msg, 'Yes, Remove', 'fas fa-trash-alt');
    if (!ok) return;
    const month = row.month || '';
    EXTRA.budgets = EXTRA.budgets.filter(b => !(b.category === category && (b.month || '') === month));
    renderBudgets();
    showToast('Budget removed', 'info');
    await sendToSheet({ action: 'set_budget', category, limit: 0, month });
}

function checkBudgetAlerts() {
    if (extrasLoadedFor !== userSessionEmail || !EXTRA.budgets.length) return;
    if (!$('result-modal').classList.contains('hidden')) return;
    const ym = todayYM();
    const { byCat, total } = monthExpenseByCat(ym);
    let seen = [];
    try { seen = JSON.parse(sessionStorage.getItem('budget_alerts') || '[]'); } catch (e) { }
    const msgs = []; let worst = 'warning';
    budgetsFor(ym).forEach(b => {
        const spent = b.category === '__TOTAL__' ? total : (byCat[b.category] || 0);
        const pct = b.limit ? spent / b.limit * 100 : 0;
        const lv = pct >= 100 ? 'over' : pct >= 80 ? 'near' : null;
        if (!lv) return;
        const key = `${userSessionEmail}|${ym}|${b.category}|${lv}`;
        if (seen.includes(key)) return;
        seen.push(key);
        const name = b.category === '__TOTAL__' ? 'Overall budget' : b.category + ' budget';
        msgs.push(lv === 'over' ? `${name} exceeded by ${inr0(spent - b.limit)}.` : `${name} is ${Math.round(pct)}% used.`);
        if (lv === 'over') worst = 'error';
    });
    if (msgs.length) {
        try { sessionStorage.setItem('budget_alerts', JSON.stringify(seen)); } catch (e) { }
        showResultModal(worst, 'Budget Alert', msgs.join(' '));
    }
}

/* =========================================================
   SAVINGS GOALS
   ========================================================= */
function goalEta(g) {
    const remaining = Math.max(0, g.target - g.saved);
    if (remaining <= 0) return 'Goal reached!';
    if (!(g.monthly > 0)) return '';
    const months = Math.ceil(remaining / g.monthly);
    const d = new Date(); d.setMonth(d.getMonth() + months);
    return `At ${inr0(g.monthly)}/month you will reach it in ${months} month(s) (${d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })})`;
}

function renderGoalAlloc() {
    const el = $('goal-alloc-summary'); if (!el) return;
    const active = EXTRA.goals.filter(g => g.saved < g.target && g.monthly > 0);
    if (!active.length) { el.innerHTML = ''; return; }
    const planned = active.reduce((s, g) => s + g.monthly, 0);
    const ym = todayYM();
    let inc = 0, exp = 0;
    transactions.forEach(t => { if (dOf(t).startsWith(ym)) { const a = Number(t.amount) || 0; if (t.type === 'INCOME') inc += a; else exp += a; } });
    const saved = Math.max(0, inc - exp);
    const ok = saved >= planned;
    el.innerHTML = `<div class="rounded-xl border border-gray-200 dark:border-gray-700 p-4 text-xs flex flex-wrap items-center justify-between gap-2">
        <span><b>Planned monthly allocation:</b> ${inr0(planned)} across ${active.length} goal(s)</span>
        <span class="${ok ? 'text-emerald-600' : 'text-amber-600'} font-semibold">${ok ? 'This month\'s savings (' + inr0(saved) + ') cover it' : 'This month\'s savings so far: ' + inr0(saved) + ' (short by ' + inr0(planned - saved) + ')'}</span></div>`;
}

function renderGoals() {
    const root = $('goal-list'); if (!root) return;
    renderGoalAlloc();
    if (!EXTRA.goals.length) {
        root.innerHTML = `<div class="md:col-span-2 lg:col-span-3 rounded-xl border border-gray-200 dark:border-gray-700 p-8 text-center text-xs text-gray-500 dark:text-gray-400"><div class="text-4xl mb-2"><i class="fas fa-trophy"></i></div>No savings goals yet. Planning a mobile, a bike, a trip? Create a goal and set how much to allocate every month.</div>`;
        return;
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    root.innerHTML = EXTRA.goals.map(g => {
        const pct = g.target ? Math.min(100, g.saved / g.target * 100) : 0;
        const done = g.saved >= g.target;
        let info = '';
        if (g.deadline) {
            const days = Math.ceil((new Date(g.deadline + 'T00:00:00') - today) / 864e5);
            const remaining = Math.max(0, g.target - g.saved);
            if (done) info = 'Goal reached!';
            else if (days < 0) info = `Deadline passed ${-days} day(s) ago`;
            else {
                const months = Math.max(1, Math.ceil(days / 30.44));
                info = `${days} day(s) left · save ${inr0(remaining / months)} / month`;
            }
        }
        const eta = goalEta(g);
        const safeId = esc(g.id);
        return `<div class="rounded-xl border border-gray-200 dark:border-gray-700 p-4 goal-card ${done ? 'goal-done' : ''}">
            <div class="flex items-start justify-between gap-2">
                <div class="min-w-0"><h3 class="font-bold text-sm truncate">${esc(g.name)} ${done ? '<i class="fas fa-circle-check text-emerald-500"></i>' : ''}</h3>
                <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">${esc(info) || 'No deadline'}</p></div>
                <div class="shrink-0"><button onclick="openGoalModal('${safeId}')" class="p-1 text-blue-600" title="Edit"><i class="fas fa-edit"></i></button>
                <button onclick="deleteGoal('${safeId}')" class="p-1 text-rose-600" title="Delete"><i class="fas fa-trash-alt"></i></button></div>
            </div>
            <div class="flex items-center gap-4 mt-3">
                <div class="goal-ring" style="--p:${pct.toFixed(1)}"><span>${Math.round(pct)}%</span></div>
                <div class="text-xs"><div class="font-bold text-base">${inr0(g.saved)}</div><div class="text-gray-500 dark:text-gray-400">of ${inr0(g.target)}</div></div>
            </div>
            ${eta ? `<p class="text-[11px] text-indigo-600 dark:text-indigo-300 mt-2">${esc(eta)}</p>` : ''}
            <div class="flex gap-2 mt-3">
                ${!done && g.monthly > 0 ? `<button onclick="allocateMonthly('${safeId}')" class="flex-1 py-2 bg-blue-600 text-white rounded-lg text-xs font-medium"><i class="fas fa-piggy-bank mr-1"></i>Allocate ${inr0(g.monthly)}</button>` : ''}
                <button onclick="openContribModal('${safeId}')" class="flex-1 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-xs font-medium"><i class="fas fa-plus mr-1"></i>Custom amount</button>
            </div>
        </div>`;
    }).join('');
}

async function allocateMonthly(id) {
    const g = EXTRA.goals.find(x => x.id == id); if (!g || !(g.monthly > 0)) return;
    const ok = await showConfirmModal('Allocate Money?', `Add ${inr0(g.monthly)} to "${g.name}" now?`, 'Yes, Allocate', 'fas fa-piggy-bank');
    if (!ok) return;
    const wasDone = g.saved >= g.target;
    g.saved += g.monthly;
    renderGoals();
    await sendToSheet({ action: 'goal_save', ...g });
    if (!wasDone && g.saved >= g.target && window.goalReached) goalReached(g);
    else showToast(`${inr0(g.monthly)} allocated to ${g.name}`, 'success');
}

function openGoalModal(id) {
    const g = EXTRA.goals.find(x => x.id == id);
    $('goal-modal-title').textContent = g ? 'Edit Goal' : 'New Savings Goal';
    $('goal-id').value = g ? g.id : '';
    $('goal-name').value = g ? g.name : '';
    $('goal-target').value = g ? g.target : '';
    $('goal-saved').value = g ? g.saved : 0;
    // A savings goal deadline only makes sense in the future, so block past dates here.
    $('goal-deadline').min = toYMD(new Date());
    $('goal-deadline').value = g ? g.deadline : '';
    $('goal-monthly').value = g && g.monthly ? g.monthly : '';
    openModal('goal-modal');
}
$('goal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('goal-id').value;
    const old = EXTRA.goals.find(x => x.id == id);
    const goal = {
        id: id || uid('g'),
        name: $('goal-name').value.trim(),
        target: parseFloat($('goal-target').value),
        saved: parseFloat($('goal-saved').value) || 0,
        deadline: $('goal-deadline').value,
        monthly: parseFloat($('goal-monthly').value) || 0,
        created: old ? old.created : toYMD(new Date())
    };
    if (!goal.name || !(goal.target > 0)) return;
    EXTRA.goals = EXTRA.goals.filter(x => x.id != goal.id).concat(goal);
    closeModal('goal-modal');
    renderGoals();
    showToast('Goal saved!', 'success');
    await sendToSheet({ action: 'goal_save', ...goal });
    if (goal.saved >= goal.target && !(old && old.saved >= old.target) && window.goalReached) goalReached(goal);
});
async function deleteGoal(id) {
    const ok = await showConfirmModal('Delete Goal?', 'This savings goal will be removed permanently.', 'Yes, Delete', 'fas fa-trash-alt');
    if (!ok) return;
    EXTRA.goals = EXTRA.goals.filter(g => g.id != id);
    renderGoals();
    showToast('Goal deleted', 'info');
    await sendToSheet({ action: 'goal_delete', id });
}
function openContribModal(id) {
    const g = EXTRA.goals.find(x => x.id == id); if (!g) return;
    $('contrib-goal-id').value = id;
    $('contrib-goal-name').textContent = g.name;
    $('contrib-amount').value = '';
    openModal('contrib-modal');
    setTimeout(() => $('contrib-amount').focus(), 100);
}
$('contrib-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const g = EXTRA.goals.find(x => x.id == $('contrib-goal-id').value); if (!g) return;
    const amt = parseFloat($('contrib-amount').value);
    if (!amt) return;
    const wasDone = g.saved >= g.target;
    g.saved = Math.max(0, g.saved + amt);
    closeModal('contrib-modal');
    renderGoals();
    await sendToSheet({ action: 'goal_save', ...g });
    if (!wasDone && g.saved >= g.target && window.goalReached) goalReached(g);
    else showToast(amt > 0 ? 'Money added to goal!' : 'Money withdrawn', 'success');
});

/* =========================================================
   RECURRING TRANSACTIONS
   ========================================================= */
function nextDue(r) {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    let y = now.getFullYear(), m = now.getMonth();
    if (r.last_run && r.last_run >= todayYM()) { m++; if (m > 11) { m = 0; y++; } }
    const day = Math.min(r.day, new Date(y, m + 1, 0).getDate());
    return new Date(y, m, day);
}

function renderRecurring() {
    const root = $('recurring-list'); if (!root) return;
    if (!EXTRA.recurring.length) {
        root.innerHTML = `<div class="md:col-span-2 rounded-xl border border-gray-200 dark:border-gray-700 p-8 text-center text-xs text-gray-500 dark:text-gray-400"><div class="text-4xl mb-2"><i class="fas fa-rotate"></i></div>No recurring entries yet. Add rent, subscriptions, EMIs or salary and they will be logged automatically every month.</div>`;
        return;
    }
    root.innerHTML = EXTRA.recurring.map(r => {
        const paused = r.active === 'no';
        const inc = r.type === 'INCOME';
        const id = esc(r.id);
        const goal = r.goal_id ? EXTRA.goals.find(g => g.id == r.goal_id) : null;
        return `<div class="rounded-xl border border-gray-200 dark:border-gray-700 p-4 ${paused ? 'opacity-60' : ''}">
            <div class="flex items-start justify-between gap-2">
                <div class="min-w-0"><div class="font-semibold text-sm truncate">${esc(r.description) || esc(r.category)}</div>
                <div class="text-[11px] text-gray-500 dark:text-gray-400">${esc(r.category)} · every month on day ${r.day}</div></div>
                <div class="text-right font-bold ${inc ? 'text-emerald-600' : 'text-rose-600'}">${inc ? '+' : '-'}${inr0(r.amount)}</div>
            </div>
            ${goal ? `<div class="text-[11px] text-indigo-600 dark:text-indigo-300 mt-1"><i class="fas fa-piggy-bank mr-1"></i>Auto-saves ${inr0(r.goal_amount)} to "${esc(goal.name)}"</div>` : ''}
            <div class="flex items-center justify-between mt-3 text-[11px]">
                <span class="text-gray-500 dark:text-gray-400">${paused ? 'Paused' : 'Next: ' + nextDue(r).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                <span>
                    <button onclick="toggleRecurring('${id}')" class="text-amber-600 hover:underline">${paused ? 'Resume' : 'Pause'}</button> ·
                    <button onclick="${goal ? `openGoalRecurringModal('${id}')` : `openRecurringModal('${id}')`}" class="text-blue-600 hover:underline">Edit</button> ·
                    <button onclick="deleteRecurring('${id}')" class="text-rose-500 hover:underline">Delete</button>
                </span>
            </div></div>`;
    }).join('');
}

function updateRecCategoryOptions(selected) {
    const type = $('rec-type').value;
    $('rec-category').innerHTML = CATEGORIES[type].map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if (selected) $('rec-category').value = selected;
}
function openRecurringModal(id) {
    const r = EXTRA.recurring.find(x => x.id == id);
    $('recurring-modal-title').textContent = r ? 'Edit Recurring Entry' : 'New Recurring Entry';
    $('rec-id').value = r ? r.id : '';
    $('rec-type').value = r ? r.type : 'EXPENSE';
    updateRecCategoryOptions(r ? r.category : null);
    $('rec-amount').value = r ? r.amount : '';
    $('rec-desc').value = r ? r.description : '';
    $('rec-day').value = r ? r.day : new Date().getDate();
    openModal('recurring-modal');
}
$('recurring-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('rec-id').value;
    const old = EXTRA.recurring.find(x => x.id == id);
    const day = Math.min(31, Math.max(1, parseInt($('rec-day').value) || 1));
    const rec = {
        id: id || uid('r'),
        type: $('rec-type').value,
        category: $('rec-category').value,
        amount: parseFloat($('rec-amount').value),
        description: $('rec-desc').value.trim(),
        day,
        last_run: old ? old.last_run : (day <= new Date().getDate() ? todayYM() : ''),
        active: old ? old.active : 'yes'
    };
    if (!(rec.amount > 0)) return;
    EXTRA.recurring = EXTRA.recurring.filter(x => x.id != rec.id).concat(rec);
    closeModal('recurring-modal');
    renderRecurring();
    showToast('Recurring entry saved!', 'success');
    await sendToSheet({ action: 'rec_save', ...rec });
});

/* ---------- dedicated: Recurring entry that auto-saves into a Goal ---------- */
function updateGoalRecOptions(selected) {
    const sel = $('goalrec-goal'); if (!sel) return;
    sel.innerHTML = EXTRA.goals.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('') || '<option value="">No goals yet — create one first</option>';
    sel.value = selected || '';
}
function openGoalRecurringModal(id) {
    const r = id ? EXTRA.recurring.find(x => x.id == id) : null;
    $('goalrec-modal-title').innerHTML = `<i class="fas fa-piggy-bank text-indigo-500"></i>${r ? 'Edit Recurring for Goal' : 'New Recurring for Goal'}`;
    $('goalrec-id').value = r ? r.id : '';
    updateGoalRecOptions(r ? r.goal_id : '');
    $('goalrec-day').value = r ? r.day : new Date().getDate();
    $('goalrec-amount').value = r ? (r.goal_amount || r.amount) : '';
    openModal('goal-recurring-modal');
}
$('goal-recurring-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('goalrec-id').value;
    const old = EXTRA.recurring.find(x => x.id == id);
    const goalId = $('goalrec-goal').value;
    const goal = EXTRA.goals.find(g => g.id == goalId);
    if (!goalId || !goal) { showToast('Choose a savings goal first.', 'error'); return; }
    const amount = parseFloat($('goalrec-amount').value);
    if (!(amount > 0)) return;
    const day = Math.min(31, Math.max(1, parseInt($('goalrec-day').value) || 1));
    const rec = {
        id: id || uid('r'),
        type: 'EXPENSE',
        category: 'Other Expense',
        amount,
        description: `Savings: ${goal.name}`,
        day,
        last_run: old ? old.last_run : (day <= new Date().getDate() ? todayYM() : ''),
        active: old ? old.active : 'yes',
        goal_id: goalId,
        goal_amount: amount
    };
    EXTRA.recurring = EXTRA.recurring.filter(x => x.id != rec.id).concat(rec);
    closeModal('goal-recurring-modal');
    renderRecurring();
    showToast('Recurring goal saving set up!', 'success');
    await sendToSheet({ action: 'rec_save', id: rec.id, type: rec.type, category: rec.category, amount: rec.amount, description: rec.description, day: rec.day, last_run: rec.last_run, active: rec.active });
    const settingKey = 'recgoal_' + rec.id;
    const settingVal = `${goalId}:${amount}`;
    EXTRA.settings[settingKey] = settingVal;
    await sendToSheet({ action: 'set_setting', key: settingKey, value: settingVal });
});
async function toggleRecurring(id) {
    const r = EXTRA.recurring.find(x => x.id == id); if (!r) return;
    r.active = r.active === 'no' ? 'yes' : 'no';
    renderRecurring();
    await sendToSheet({ action: 'rec_save', ...r });
}
async function deleteRecurring(id) {
    const ok = await showConfirmModal('Delete Recurring Entry?', 'Past entries stay in your history. Only future automatic entries stop.', 'Yes, Delete', 'fas fa-trash-alt');
    if (!ok) return;
    EXTRA.recurring = EXTRA.recurring.filter(x => x.id != id);
    renderRecurring();
    await sendToSheet({ action: 'rec_delete', id });
    const settingKey = 'recgoal_' + id;
    if (EXTRA.settings[settingKey]) {
        delete EXTRA.settings[settingKey];
        await sendToSheet({ action: 'set_setting', key: settingKey, value: '' });
    }
}

// Adds due recurring entries (runs once after login)
async function processRecurring() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const endIdx = today.getFullYear() * 12 + today.getMonth();
    const toAdd = [], changed = [];
    const goalCredits = {}; // goal_id -> total ₹ to add from occurrences fired this run
    let n = 0;
    EXTRA.recurring.filter(r => r.active !== 'no').forEach(r => {
        let startIdx = endIdx;
        if (/^\d{4}-\d{2}$/.test(r.last_run || '')) {
            const [ly, lm] = r.last_run.split('-').map(Number);
            startIdx = ly * 12 + (lm - 1) + 1;
        }
        startIdx = Math.max(startIdx, endIdx - 24);
        let last = null, occurrences = 0;
        for (let i = startIdx; i <= endIdx; i++) {
            const yy = Math.floor(i / 12), mm = i % 12;
            const day = Math.min(r.day, new Date(yy, mm + 1, 0).getDate());
            const date = new Date(yy, mm, day);
            if (date > today) break;
            toAdd.push({ id: uid('rec') + (n++), date: toYMD(date), type: r.type, category: r.category, amount: r.amount, description: r.description || r.category });
            last = i;
            occurrences++;
        }
        if (last !== null) {
            r.last_run = `${Math.floor(last / 12)}-${String((last % 12) + 1).padStart(2, '0')}`;
            changed.push(r);
            if (r.goal_id && r.goal_amount > 0) {
                goalCredits[r.goal_id] = (goalCredits[r.goal_id] || 0) + r.goal_amount * occurrences;
            }
        }
    });
    if (!toAdd.length) return;
    await sendToSheet({ action: 'bulk_add', rows: toAdd });
    for (const r of changed) await sendToSheet({ action: 'rec_save', id: r.id, type: r.type, category: r.category, amount: r.amount, description: r.description, day: r.day, last_run: r.last_run, active: r.active });

    // Credit any savings goals linked to the recurring entries that just fired.
    const goalsHit = [];
    Object.keys(goalCredits).forEach(goalId => {
        const g = EXTRA.goals.find(x => x.id == goalId);
        if (!g) return;
        const wasDone = g.saved >= g.target;
        g.saved += goalCredits[goalId];
        goalsHit.push({ g, wasDone, amount: goalCredits[goalId] });
    });
    for (const { g } of goalsHit) await sendToSheet({ action: 'goal_save', ...g });

    await new Promise(r => setTimeout(r, 2000));
    await _fetchTx();
    renderRecurring();
    renderGoals();
    showToast(`${toAdd.length} recurring ${toAdd.length === 1 ? 'entry was' : 'entries were'} added automatically`, 'info');
    goalsHit.forEach(({ g, wasDone, amount }) => {
        if (!wasDone && g.saved >= g.target && window.goalReached) goalReached(g);
        else showToast(`${inr0(amount)} auto-allocated to ${g.name}`, 'success');
    });
}

/* =========================================================
   INSIGHTS (analytics tab)
   ========================================================= */
const _renderAnalyticsCharts = window.renderAnalyticsCharts;
window.renderAnalyticsCharts = function () {
    trendPage = 0;   // a filter or tab change starts the trend chart from the latest months
    _renderAnalyticsCharts();
    renderInsights();
};

function renderInsights() {
    if (!$('insight-stats')) return;
    const f = getFilteredTransactions();
    const inc = f.filter(t => t.type === 'INCOME').reduce((s, t) => s + Number(t.amount), 0);
    const expList = f.filter(t => t.type === 'EXPENSE');
    const exp = expList.reduce((s, t) => s + Number(t.amount), 0);

    // number of days in the selected period
    let days = 1, ym = null;
    if (currentFilterMode === 'month') {
        ym = $('filter-month-input').value || todayYM();
        days = ym === todayYM() ? new Date().getDate() : daysIn(ym);
    } else if (currentFilterMode === 'range') {
        const a = $('filter-from-date').value, b = $('filter-to-date').value;
        if (a && b) days = Math.max(1, Math.round((new Date(b) - new Date(a)) / 864e5) + 1);
    } else if (f.length) {
        const ds = f.map(dOf).sort();
        days = Math.max(1, Math.round((new Date(ds[ds.length - 1]) - new Date(ds[0])) / 864e5) + 1);
    }

    const biggest = expList.reduce((m, t) => Number(t.amount) > (m ? Number(m.amount) : 0) ? t : m, null);
    const rate = inc > 0 ? (inc - exp) / inc * 100 : null;
    const cards = [
        { icon: 'fa-piggy-bank', color: '#10b981', label: 'Savings rate', value: rate === null ? '-' : Math.round(rate) + '%', sub: rate === null ? 'No income in this period' : rate >= 20 ? 'Great, you are saving well' : rate >= 0 ? 'Try to save at least 20%' : 'Spending is more than income' },
        { icon: 'fa-calendar-day', color: '#3b82f6', label: 'Average daily spend', value: inr0(exp / days), sub: `over ${days} day(s)` },
        { icon: 'fa-receipt', color: '#f43f5e', label: 'Biggest expense', value: biggest ? inr0(biggest.amount) : '-', sub: biggest ? `${biggest.category}${biggest.description ? ' · ' + biggest.description : ''}` : 'No expenses yet' }
    ];

    // comparison: previous month (monthly filter) or the same-length period before the date range
    let prevFrom = '', prevTo = '', prevLabel = '';
    if (currentFilterMode === 'month' && ym) {
        const [y, m] = ym.split('-').map(Number);
        prevFrom = toYMD(new Date(y, m - 2, 1));
        prevTo = toYMD(new Date(y, m - 1, 0));
        prevLabel = 'vs last month';
    } else if (currentFilterMode === 'range' && $('filter-from-date').value) {
        const start = new Date($('filter-from-date').value + 'T00:00:00');
        prevFrom = toYMD(new Date(start - days * 864e5));
        prevTo = toYMD(new Date(start - 864e5));
        prevLabel = 'vs previous period';
    }
    if (prevLabel) {
        const prevExp = transactions.filter(t => t.type === 'EXPENSE' && dOf(t) >= prevFrom && dOf(t) <= prevTo).reduce((s, t) => s + Number(t.amount), 0);
        const ch = prevExp > 0 ? (exp - prevExp) / prevExp * 100 : null;
        const up = ch !== null && ch > 0;
        cards.push({ icon: up ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down', color: up ? '#f59e0b' : '#10b981', label: prevLabel, value: ch === null ? '-' : (ch > 0 ? '+' : '') + Math.round(ch) + '%', sub: ch === null ? 'No expenses in the previous period' : `Previous: ${inr0(prevExp)}` });
    }
    if (currentFilterMode === 'month' && ym === todayYM()) {
        cards.push({ icon: 'fa-chart-line', color: '#8b5cf6', label: 'Projected month spend', value: inr0(exp / days * daysIn(ym)), sub: 'If you keep spending at this pace' });
    }
    cards.push({ icon: 'fa-list-check', color: '#06b6d4', label: 'Transactions', value: String(f.length), sub: `${expList.length} expenses · ${f.length - expList.length} income` });

    $('insight-stats').innerHTML = cards.map(c => `
        <div class="stat-card rounded-xl border border-gray-200 dark:border-gray-700 p-4">
            <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><span class="stat-icon" style="background:${c.color}22;color:${c.color}"><i class="fas ${c.icon}"></i></span>${c.label}</div>
            <div class="text-xl font-bold mt-2">${esc(c.value)}</div>
            <div class="text-[11px] text-gray-400 mt-0.5 truncate">${esc(c.sub)}</div>
        </div>`).join('');

    renderTrendChart();
    renderTopCategories(expList, exp);
    renderHeatmap();
}

function renderTrendChart() {
    const canvas = $('trend-chart'); if (!canvas) return;
    // months follow the filter (see trendMonths), shown 4 at a time with prev / next paging
    const all = trendMonths();
    const pages = Math.max(1, Math.ceil(all.length / 4));
    trendPage = Math.min(trendPage, pages - 1);
    const end = all.length - trendPage * 4;
    const months = all.slice(Math.max(0, end - 4), end);
    const fmt = ym => new Date(ym + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
    const labels = months.map(fmt);
    if ($('trend-label')) $('trend-label').textContent = months.length > 1 ? `${fmt(months[0])} - ${fmt(months[months.length - 1])}` : fmt(months[0]);
    if ($('trend-prev')) $('trend-prev').disabled = trendPage >= pages - 1;
    if ($('trend-next')) $('trend-next').disabled = trendPage === 0;
    const src = currentFilterMode === 'month' ? transactions : getFilteredTransactions();
    const sumOf = (ym, type) => src.filter(t => t.type === type && dOf(t).startsWith(ym)).reduce((s, t) => s + Number(t.amount), 0);
    const inc = months.map(ym => sumOf(ym, 'INCOME'));
    const exp = months.map(ym => sumOf(ym, 'EXPENSE'));
    if (trendChartInstance) trendChartInstance.destroy();
    trendChartInstance = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels, datasets: [
            { label: 'Income', data: inc, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.15)', fill: true, tension: 0.4, pointRadius: 4 },
            { label: 'Expense', data: exp, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.15)', fill: true, tension: 0.4, pointRadius: 4 }
        ] },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { y: { beginAtZero: true } } }
    });
}

function renderTopCategories(expList, exp) {
    const by = {};
    expList.forEach(t => by[t.category] = (by[t.category] || 0) + Number(t.amount));
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 6);
    $('top-categories').innerHTML = top.length ? top.map(([c, v], i) => {
        const pct = exp ? v / exp * 100 : 0;
        return `<div class="mb-3"><div class="flex justify-between text-xs mb-1"><span class="font-medium">${i + 1}. ${esc(c)}</span><span class="text-gray-500 dark:text-gray-400">${inr0(v)} · ${Math.round(pct)}%</span></div>
            <div class="pbar"><div class="pbar-fill" style="width:${pct}%;background:linear-gradient(90deg,#6366f1,#06b6d4)"></div></div></div>`;
    }).join('') : '<div class="text-xs text-gray-400 text-center py-6">No expenses in this period.</div>';
}

/* ---------- spending calendar + trend (both follow the filter) ---------- */
let selectedDay = '';
let calMonth = '';   // calendar page (range / all mode)
let trendPage = 0;   // trend chart page (0 = latest 4 months)

// 'yyyy-MM' list from a to b (inclusive)
function monthsBetween(a, b) {
    const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number);
    const out = [];
    for (let i = y1 * 12 + m1 - 1; i <= y2 * 12 + m2 - 1; i++) {
        out.push(Math.floor(i / 12) + '-' + String((i % 12) + 1).padStart(2, '0'));
    }
    return out;
}

// Months shown in the calendar: the selected month, the months of the date range, or all months with data (max 12)
function heatmapMonths() {
    let list = [];
    if (currentFilterMode === 'month') list = [getViewMonth()];
    else if (currentFilterMode === 'range') {
        const a = $('filter-from-date').value, b = $('filter-to-date').value;
        if (a && b) list = monthsBetween(a.slice(0, 7), b.slice(0, 7)).slice(-12);
    } else {
        const ds = transactions.map(dOf).filter(Boolean).sort();
        list = monthsBetween(ds.length ? ds[0].slice(0, 7) : todayYM(), todayYM()).slice(-12);
    }
    return list.length ? list : [todayYM()];
}

// Months available in the trend chart: 12 months up to the selected month, otherwise the filter's months
function trendMonths() {
    if (currentFilterMode === 'month') {
        const [y, m] = getViewMonth().split('-').map(Number);
        return monthsBetween(toYMD(new Date(y, m - 12, 1)).slice(0, 7), `${y}-${String(m).padStart(2, '0')}`);
    }
    return heatmapMonths();
}

// Calendar arrows: in Month mode they move the filter month; otherwise they page through the months one at a time
function calStep(delta) {
    if (currentFilterMode === 'month') {
        const [y, m] = getViewMonth().split('-').map(Number);
        const d = new Date(y, m - 1 + delta, 1);
        const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (next > todayYM()) return;   // never page the filter into a future month
        $('filter-month-input').value = next;
        applyFilters();
        return;
    }
    const all = heatmapMonths();
    let idx = all.indexOf(calMonth);
    if (idx < 0) idx = all.length - 1;
    calMonth = all[Math.min(all.length - 1, Math.max(0, idx + delta))];
    renderHeatmap();
}

// Trend arrows: delta 1 = older months, -1 = newer months (4 months per page)
function trendStep(delta) {
    trendPage = Math.max(0, trendPage + delta);
    renderTrendChart();
}

function renderHeatmap() {
    const grid = $('heatmap-grid'); if (!grid) return;
    // one month per page: the selected month (Month mode) or the current calendar page
    const all = heatmapMonths();
    if (currentFilterMode !== 'month' && !all.includes(calMonth)) calMonth = all[all.length - 1];
    const months = currentFilterMode === 'month' ? [all[0]] : [calMonth];
    if (selectedDay && !months.includes(selectedDay.slice(0, 7))) selectedDay = '';
    const range = currentFilterMode === 'range' ? { from: $('filter-from-date').value, to: $('filter-to-date').value } : null;

    const perDay = {};
    getFilteredTransactions().filter(t => t.type === 'EXPENSE').forEach(t => {
        const d = dOf(t);
        perDay[d] = (perDay[d] || 0) + Number(t.amount);
    });
    const max = Math.max(0, ...Object.values(perDay));

    $('heatmap-label').textContent = monthLabel(months[0]);
    const pager = currentFilterMode !== 'month';
    const pos = all.indexOf(months[0]);
    if ($('cal-prev')) $('cal-prev').disabled = pager && pos <= 0;
    // In Month mode the next arrow stops at the current month; in paging mode it stops at the last available month.
    if ($('cal-next')) $('cal-next').disabled = pager ? pos >= all.length - 1 : months[0] >= todayYM();

    const today = toYMD(new Date());
    const head = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => `<div class="hm-head">${d}</div>`).join('');
    let html = '';
    months.forEach(ym => {
        const [y, m] = ym.split('-').map(Number);
        const startDow = new Date(y, m - 1, 1).getDay();
        if (months.length > 1) html += `<div class="hm-month">${monthLabel(ym)}</div>`;
        html += head;
        for (let i = 0; i < startDow; i++) html += '<div></div>';
        for (let d = 1; d <= daysIn(ym); d++) {
            const date = `${ym}-${String(d).padStart(2, '0')}`;
            // Future dates have no data yet, so they are shown dimmed and are not selectable.
            if (date > today) {
                html += `<div class="hm-cell hm-out" title="${date}: upcoming">${d}</div>`;
                continue;
            }
            if (range && ((range.from && date < range.from) || (range.to && date > range.to))) {
                html += `<div class="hm-cell hm-out">${d}</div>`;
                continue;
            }
            const v = perDay[date] || 0;
            const lvl = v === 0 ? 0 : Math.min(4, Math.ceil(v / max * 4));
            const sel = date === selectedDay ? ' hm-selected' : '';
            html += `<div class="hm-cell hm-${lvl}${sel}" data-date="${date}" role="button" tabindex="0" title="${date}: ${v ? inr0(v) : 'no spending'}">${d}</div>`;
        }
    });
    grid.innerHTML = html;
    renderHeatmapDetail();
}

// Shows the spending of the tapped day (works on phones, no hover needed)
function renderHeatmapDetail() {
    const box = $('heatmap-detail'); if (!box) return;
    if (!selectedDay) {
        box.innerHTML = '<div class="text-[11px] text-gray-400 text-center py-2">Tap a day to see how much you spent.</div>';
        return;
    }
    const items = getFilteredTransactions().filter(t => dOf(t) === selectedDay);
    const exps = items.filter(t => t.type === 'EXPENSE').sort((a, b) => Number(b.amount) - Number(a.amount));
    const spent = exps.reduce((s, t) => s + Number(t.amount), 0);
    const earned = items.filter(t => t.type === 'INCOME').reduce((s, t) => s + Number(t.amount), 0);
    const label = new Date(selectedDay + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    box.innerHTML = `<div class="rounded-lg bg-indigo-50 dark:bg-indigo-900/20 p-3 text-xs">
        <div class="flex items-center justify-between gap-2">
            <b>${esc(label)}</b>
            <span class="font-bold ${spent ? 'text-rose-600' : 'text-gray-500'}">${spent ? 'Spent ' + inr(spent) : 'No spending'}</span>
        </div>
        ${earned ? `<div class="text-[11px] text-emerald-600 mt-1">Income ${inr(earned)}</div>` : ''}
        ${exps.length ? `<ul class="mt-2 space-y-1">${exps.map(t => `<li class="flex justify-between gap-2 text-[11px]"><span class="truncate">${esc(t.category)}${t.description ? ' · ' + esc(t.description) : ''}</span><span class="font-semibold shrink-0">${inr(t.amount)}</span></li>`).join('')}</ul>` : ''}
    </div>`;
}

function toggleHeatDay(e) {
    const cell = e.target.closest('[data-date]');
    if (!cell || (e.type === 'keydown' && e.key !== 'Enter')) return;
    selectedDay = selectedDay === cell.dataset.date ? '' : cell.dataset.date;
    renderHeatmap();
}
$('heatmap-grid').addEventListener('click', toggleHeatDay);
$('heatmap-grid').addEventListener('keydown', toggleHeatDay);

/* =========================================================
   CSV EXPORT
   ========================================================= */
function exportToCSV(data, fileName) {
    const safe = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const lines = [['Date', 'Type', 'Category', 'Description', 'Amount'].map(safe).join(',')];
    data.forEach(t => lines.push([dOf(t), t.type, t.category, t.description || '', Number(t.amount || 0)].map((v, i) => i === 4 ? v : safe(v)).join(',')));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* =========================================================
   KEYBOARD SHORTCUTS
   N = new entry   / = search   Esc = close popups   1-5 = tabs
   ========================================================= */
document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = ['input', 'textarea', 'select'].includes(tag);
    if (e.key === 'Escape') {
        const cm = $('confirm-modal');
        if (!cm.classList.contains('hidden')) { $('confirm-cancel-btn').click(); return; }
        document.querySelectorAll('[id$="-modal"]:not(.hidden)').forEach(m => m.classList.add('hidden'));
        return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || $('app-section').classList.contains('hidden')) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openEntryModal(); }
    else if (e.key === '/') { e.preventDefault(); switchTab('dashboard'); $('table-search').focus(); }
    else if (['1', '2', '3', '4'].includes(e.key)) switchTab(['dashboard', 'analytics', 'budgets', 'goals'][Number(e.key) - 1]);
    else if (e.key === '5') switchTab('recurring');
});
