/* =========================================================
   SMART.JS - Savings score, monthly badges, monthly target
   alerts (50/80/100%), daily reminders, goal celebrations.
   Load AFTER features.js
   ========================================================= */

let swReg = null;
let reminderTimer = null;

/* =========================================================
   MONTH STATS, BADGES, SCORE
   ========================================================= */
function monthStats(ym) {
    let income = 0, expense = 0;
    const byCat = {};
    transactions.forEach(t => {
        if (!dOf(t).startsWith(ym)) return;
        const a = Number(t.amount) || 0;
        if (t.type === 'INCOME') income += a;
        else { expense += a; byCat[t.category] = (byCat[t.category] || 0) + a; }
    });
    const bud = budgetsFor(ym);
    const ov = bud.find(b => b.category === '__TOTAL__');
    const catOver = bud.filter(b => b.category !== '__TOTAL__' && (byCat[b.category] || 0) > b.limit).map(b => b.category);
    return {
        ym, income, expense, savings: income - expense,
        hasTx: income > 0 || expense > 0,
        rate: income > 0 ? (income - expense) / income * 100 : null,
        limit: ov ? ov.limit : null,
        withinBudget: ov ? (expense <= ov.limit && catOver.length === 0) : null,
        catOver
    };
}

function monthBadges(s, inProgress) {
    const out = [];
    if (s.rate !== null) {
        if (s.rate >= 40) out.push({ icon: '💎', name: 'Super Saver', color: '#8b5cf6' });
        else if (s.rate >= 20) out.push({ icon: '🏅', name: 'Smart Saver', color: '#10b981' });
        else if (s.rate >= 10) out.push({ icon: '🌱', name: 'Steady Saver', color: '#06b6d4' });
        else if (s.rate >= 0) out.push({ icon: '🚀', name: 'Getting Started', color: '#f59e0b' });
        else out.push({ icon: '⚠️', name: 'Overspent', color: '#ef4444' });
    }
    if (s.withinBudget === true) out.push({ icon: '🎯', name: inProgress ? 'On Track' : 'Budget Master', color: '#6366f1' });
    else if (s.withinBudget === false) out.push({ icon: '💸', name: 'Over Budget', color: '#ef4444' });
    return out;
}

function ymBack(n) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function computeScore() {
    const stats = [0, 1, 2].map(i => monthStats(ymBack(i))).filter(s => s.hasTx);
    if (!stats.length) return null;

    // 1) savings rate (50 pts) - 30% or more of income saved = full marks
    const rates = stats.filter(s => s.rate !== null).map(s => s.rate);
    const avgRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
    const savePts = avgRate === null ? 0 : Math.max(0, Math.min(50, avgRate / 30 * 50));

    // 2) budget discipline (30 pts)
    const budgeted = stats.filter(s => s.limit);   // months that have an overall budget
    let budgetPts = 15, budgetNote = 'Set a monthly budget to unlock these points';
    if (budgeted.length) {
        const parts = budgeted.map(s => s.expense <= s.limit ? 1 : Math.max(0, 1 - (s.expense - s.limit) / s.limit));
        budgetPts = parts.reduce((a, b) => a + b, 0) / parts.length * 30;
        const kept = budgeted.filter(s => s.withinBudget === true).length;
        budgetNote = `Stayed within budget in ${kept} of ${budgeted.length} budgeted month(s)`;
    }

    // 3) tracking habit (20 pts) - 15 active days in the last 30 days = full marks
    const since = new Date(); since.setDate(since.getDate() - 30);
    const sinceStr = toYMD(since);
    const activeDays = new Set(transactions.map(dOf).filter(d => d >= sinceStr)).size;
    const habitPts = Math.min(1, activeDays / 15) * 20;

    const total = Math.round(savePts + budgetPts + habitPts);
    const tips = [];
    if (!budgeted.length) tips.push('Set a monthly budget to earn up to 30 more points.');
    else if (budgeted.some(s => s.withinBudget === false)) tips.push('Stay within your budget to protect your score.');
    if (avgRate === null) tips.push('Add your income so savings can be measured.');
    else if (avgRate < 20) tips.push('Try to save at least 20% of your income to become a Smart Saver.');
    if (activeDays < 15) tips.push('Log your expenses on more days to improve consistency.');
    if (!tips.length) tips.push('Excellent work. Keep this up!');

    return {
        total, tips,
        parts: [
            { label: 'Savings rate', pts: savePts, max: 50, note: avgRate === null ? 'No income recorded' : `Average ${Math.round(avgRate)}% saved (last 3 months)` },
            { label: 'Budget discipline', pts: budgetPts, max: 30, note: budgetNote },
            { label: 'Tracking habit', pts: habitPts, max: 20, note: `${activeDays} active day(s) in the last 30` }
        ]
    };
}

function gradeOf(score) {
    if (score >= 85) return { name: 'Excellent', color: '#10b981' };
    if (score >= 70) return { name: 'Great', color: '#22c55e' };
    if (score >= 50) return { name: 'Good', color: '#f59e0b' };
    if (score >= 30) return { name: 'Fair', color: '#f97316' };
    return { name: 'Needs Work', color: '#ef4444' };
}

const badgeChip = (b) => `<span class="badge-chip" style="background:${b.color}22;color:${b.color}">${b.icon} ${esc(b.name)}</span>`;

/* =========================================================
   RENDER SMART SAVER TAB
   ========================================================= */
function renderSmart() {
    if (!$('score-card')) return;
    renderScoreCard();
    renderMonthBadgeCard();
    renderTargetCard();
    renderBadgeHistory();
}

function renderScoreCard() {
    const sc = computeScore();
    if (!sc) {
        $('score-card').innerHTML = `<div class="text-center text-xs text-gray-500 dark:text-gray-400 py-6"><div class="text-4xl mb-2">📊</div>Add a few entries to see your Savings Score.</div>`;
        return;
    }
    const g = gradeOf(sc.total);
    $('score-card').innerHTML = `
        <div class="flex flex-col sm:flex-row items-center gap-5">
            <div class="score-ring" style="--p:${sc.total};--c:${g.color}"><div><b>${sc.total}</b><small>/ 100</small></div></div>
            <div class="flex-1 w-full">
                <div class="text-xs text-gray-500 dark:text-gray-400">Your overall Savings Score</div>
                <div class="text-xl font-bold mb-3" style="color:${g.color}">${g.name}</div>
                ${sc.parts.map(p => `<div class="mb-2"><div class="flex justify-between text-[11px] mb-1"><span class="font-medium">${p.label}</span><span class="text-gray-500 dark:text-gray-400">${Math.round(p.pts)} / ${p.max}</span></div>
                    <div class="pbar" style="height:7px"><div class="pbar-fill" style="width:${p.pts / p.max * 100}%;background:linear-gradient(90deg,#6366f1,#06b6d4)"></div></div>
                    <div class="text-[10px] text-gray-400 mt-0.5">${esc(p.note)}</div></div>`).join('')}
            </div>
        </div>
        <div class="mt-4 text-[11px] bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-200 rounded-lg p-3">
            <b>Tips:</b> ${sc.tips.map(esc).join(' ')}
        </div>`;
}

function renderMonthBadgeCard() {
    const ym = todayYM();
    const s = monthStats(ym);
    const badges = monthBadges(s, true);
    // streak of months with 20%+ savings
    let streak = s.rate !== null && s.rate >= 20 ? 1 : 0;
    for (let i = 1; i <= 24; i++) {
        const p = monthStats(ymBack(i));
        if (!p.hasTx || p.rate === null || p.rate < 20) break;
        streak++;
    }
    const main = badges[0];
    $('month-badge-card').innerHTML = `
        <div class="text-xs text-gray-500 dark:text-gray-400 mb-2">${monthLabel(ym)} badge</div>
        ${main ? `<div class="text-center"><div class="text-5xl mb-1 badge-pop">${main.icon}</div><div class="text-lg font-bold" style="color:${main.color}">${esc(main.name)}</div>
            <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">${s.rate !== null ? `You saved ${Math.round(s.rate)}% of your income (${inr0(s.savings)})` : ''}</div>
            <div class="mt-2 flex flex-wrap justify-center gap-1">${badges.slice(1).map(badgeChip).join('')}</div></div>`
        : `<div class="text-center text-xs text-gray-500 dark:text-gray-400 py-4"><div class="text-4xl mb-2">🏅</div>Add your income and expenses to earn this month's badge.</div>`}
        <div class="mt-3 text-center text-[11px] text-gray-500 dark:text-gray-400">🔥 Smart Saver streak: <b>${streak}</b> month(s)</div>
        <div class="mt-3 text-[10px] text-gray-400 leading-relaxed border-t border-gray-200 dark:border-gray-700 pt-2">
            🏅 Smart Saver: save 20%+ of income · 💎 Super Saver: 40%+ · 🎯 Budget Master: finish the month within your budgets</div>`;
}

function renderTargetCard() {
    const ym = todayYM();
    const ov = budgetsFor(ym).find(b => b.category === '__TOTAL__');
    if (!ov) {
        $('target-card').innerHTML = `<div class="flex flex-wrap items-center justify-between gap-3">
            <div><h3 class="text-sm font-bold">Monthly Expense Target</h3><p class="text-xs text-gray-500 dark:text-gray-400">Set a target and get notified at 50%, 80% and 100%.</p></div>
            <button onclick="openBudgetModal('__TOTAL__', '${ym}')" class="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-medium">Set Monthly Target</button></div>`;
        return;
    }
    const { total } = monthExpenseByCat(ym);
    const pct = total / ov.limit * 100;
    const now = new Date(), dim = daysIn(ym);
    const projected = total / now.getDate() * dim;
    const levels = [50, 80, 100];
    $('target-card').innerHTML = `
        <div class="flex flex-wrap items-start justify-between gap-3 mb-3">
            <div><h3 class="text-sm font-bold">Monthly Expense Target · ${monthLabel(ym)}</h3>
            <p class="text-xs text-gray-500 dark:text-gray-400">${inr0(total)} spent of ${inr0(ov.limit)}</p></div>
            <button onclick="openBudgetModal('__TOTAL__', '${ym}')" class="text-xs text-blue-600 hover:underline">Change target</button>
        </div>
        <div class="target-bar">
            <div class="pbar-fill" style="width:${Math.min(pct, 100)}%;background:${pct >= 100 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#10b981'}"></div>
            ${levels.map(l => `<span class="tick" style="left:${l}%"><i>${l}%</i></span>`).join('')}
        </div>
        <div class="flex flex-wrap gap-2 mt-6">${levels.map(l => `<span class="chip ${pct >= l ? 'chip-done' : ''}">${pct >= l ? '✓' : '○'} ${l}% ${pct >= l ? 'reached' : 'alert'}</span>`).join('')}</div>
        <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-3">At this pace you will spend about <b>${inr0(projected)}</b> this month${projected > ov.limit ? ', which is above your target.' : ', which is within your target.'}</p>`;
}

function renderBadgeHistory() {
    const rows = [];
    for (let i = 0; i < 6; i++) {
        const s = monthStats(ymBack(i));
        if (!s.hasTx) continue;
        const badges = monthBadges(s, i === 0);
        const r = s.rate === null ? 0 : Math.max(0, Math.min(100, s.rate));
        rows.push(`<div class="py-3 border-b border-gray-100 dark:border-gray-700 last:border-0">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="font-semibold text-xs">${monthLabel(s.ym)}${i === 0 ? ' <span class="text-[10px] text-gray-400 font-normal">(in progress)</span>' : ''}</div>
                <div class="flex flex-wrap gap-1">${badges.map(badgeChip).join('') || '<span class="text-[10px] text-gray-400">No income recorded</span>'}</div>
            </div>
            <div class="flex items-center gap-3 mt-2">
                <div class="pbar flex-1" style="height:7px"><div class="pbar-fill" style="width:${r}%;background:${s.rate !== null && s.rate >= 20 ? '#10b981' : '#f59e0b'}"></div></div>
                <span class="text-[11px] w-24 text-right text-gray-500 dark:text-gray-400">${s.rate === null ? '-' : Math.round(s.rate) + '% saved'}</span>
            </div>
            <div class="text-[10px] text-gray-400 mt-1">Income ${inr0(s.income)} · Spent ${inr0(s.expense)}${s.limit ? ' · Budget ' + inr0(s.limit) : ''}</div></div>`);
    }
    $('badge-history').innerHTML = rows.join('') || '<div class="text-xs text-gray-400 text-center py-6">Your monthly report card will appear here.</div>';
}

/* =========================================================
   NOTIFICATIONS
   ========================================================= */
async function notify(title, body, tag, opts = {}) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;
    try {
        const reg = swReg || (navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null);
        if (reg && reg.showNotification) {
            await reg.showNotification(title, { body, tag, renotify: true, ...opts });
            return true;
        }
        const n = new Notification(title, { body, tag, requireInteraction: !!opts.requireInteraction });
        n.onclick = () => { window.focus(); n.close(); handleNotifClick(tag, ''); };
        return true;
    } catch (e) { console.warn('Notification failed', e); return false; }
}

function handleNotifClick(tag, action) {
    if (tag === 'daily-checkin') {
        if (action === 'ack') ackToday();
        else if (action === 'add') openEntryModal();
        else openCheckin();
    } else if (tag === 'goal') switchTab('goals');
    else if (tag === 'budget') switchTab('budgets');
}

function handleLaunchParams() {
    const p = new URLSearchParams(location.search);
    const tag = p.get('notif');
    if (!tag) return;
    const action = p.get('action') || '';
    try { history.replaceState({}, '', location.pathname); } catch (e) { }
    handleNotifClick(tag, action);
}

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'notif-click') handleNotifClick(e.data.tag, e.data.action);
    });
    if (location.protocol === 'https:' || location.hostname === 'localhost') {
        navigator.serviceWorker.register('sw.js').then(r => { swReg = r; }).catch(() => { });
    }
}

function notifStatus() {
    if (!('Notification' in window)) return { t: 'Notifications are not supported in this browser.', c: '#ef4444' };
    if (Notification.permission === 'granted') return { t: '✓ Browser notifications are ON', c: '#10b981' };
    if (Notification.permission === 'denied') return { t: 'Blocked. Allow notifications for this site in your browser settings.', c: '#ef4444' };
    return { t: 'Not enabled yet. Click "Enable notifications".', c: '#f59e0b' };
}
function updateNotifStatus() {
    const s = notifStatus(), el = $('notif-status');
    if (el) { el.textContent = s.t; el.style.color = s.c; }
}

/* =========================================================
   DAILY REMINDER
   ========================================================= */
const setSetting = (key, value) => { EXTRA.settings[key] = String(value); return sendToSheet({ action: 'set_setting', key, value: String(value) }); };
const hasEntryToday = () => { const t = toYMD(new Date()); return transactions.some(x => dOf(x) === t); };

function reminderConfig() {
    const s = EXTRA.settings;
    return { enabled: (s.rem_enabled || 'yes') !== 'no', time: s.rem_time || '21:00', ack: s.ack_date || '' };
}

function openCheckin() { openModal('checkin-modal'); }

async function ackToday() {
    closeModal('checkin-modal');
    await setSetting('ack_date', toYMD(new Date()));
    showToast('Great job! No more reminders today.', 'success');
    try {
        const reg = swReg || (navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null);
        if (reg) (await reg.getNotifications({ tag: 'daily-checkin' })).forEach(n => n.close());
    } catch (e) { }
}

async function fireReminder() {
    const shown = await notify('Expense Tracker · Daily check-in', "Have you added today's entries? Tap to confirm.", 'daily-checkin', {
        requireInteraction: true,
        actions: [{ action: 'ack', title: '✅ All added' }, { action: 'add', title: '➕ Add entry' }]
    });
    if (shown) showToast("Reminder: have you added today's entries?", 'info');
    else openCheckin();      // notifications blocked or unsupported: show the popup instead
}

function clientReminderTick() {
    if (!userSessionEmail || extrasLoadedFor !== userSessionEmail) return;
    const cfg = reminderConfig();
    if (!cfg.enabled) return;
    const now = new Date(), today = toYMD(now);
    if (cfg.ack === today || hasEntryToday()) return;
    const [h, m] = cfg.time.split(':').map(Number);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h || 0, m || 0);
    if (now < start) return;
    const key = 'reminder_last_' + userSessionEmail;
    let last = 0;
    try { last = Number(localStorage.getItem(key) || 0); } catch (e) { }
    if (last >= start.getTime() && now.getTime() - last < 3600 * 1000) return;     // once every hour
    try { localStorage.setItem(key, String(now.getTime())); } catch (e) { }
    fireReminder();
}

function startReminderLoop() {
    if (reminderTimer) return;
    reminderTimer = setInterval(clientReminderTick, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) clientReminderTick(); });
    clientReminderTick();
}

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/* ---------- settings form ---------- */
function fillReminderForm() {
    const cfg = reminderConfig();
    $('rem-enabled').checked = cfg.enabled;
    $('rem-time').value = cfg.time;
    $('rem-email').checked = EXTRA.settings.rem_email === 'yes';
    $('rem-email-to').value = EXTRA.settings.rem_email_to || '';
    updateNotifStatus();
}

$('btn-enable-notif').addEventListener('click', async () => {
    if (!('Notification' in window)) { updateNotifStatus(); return; }
    await Notification.requestPermission();
    updateNotifStatus();
    if (Notification.permission === 'granted') notify('Notifications enabled', 'You will now get reminders and alerts here.', 'test');
});
$('btn-test-notif').addEventListener('click', async () => {
    const ok = await notify('Expense Tracker', 'This is a test notification. It works!', 'test');
    if (!ok) showResultModal('warning', 'Notifications Off', 'Click "Enable notifications" first, and allow them in your browser.');
    else showToast('Test notification sent', 'success');
});
$('btn-save-rem').addEventListener('click', async () => {
    const time = $('rem-time').value || '21:00';
    const toAddr = $('rem-email-to').value.trim();
    if (toAddr && !isEmail(toAddr)) {
        showResultModal('error', 'Check Email Address', 'Please enter a valid email address, or leave the field empty to use your login email.');
        return;
    }
    showToast('Saving reminder settings...', 'info');
    await setSetting('rem_enabled', $('rem-enabled').checked ? 'yes' : 'no');
    await setSetting('rem_time', time);
    await setSetting('rem_email', $('rem-email').checked ? 'yes' : 'no');
    await setSetting('rem_email_to', toAddr);
    await setSetting('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata');
    if (location.protocol.startsWith('http')) await setSetting('app_url', location.href.split('?')[0].split('#')[0]);
    try { localStorage.removeItem('reminder_last_' + userSessionEmail); } catch (e) { }
    const emailNote = $('rem-email').checked ? ` Email reminders go to ${toAddr || userSessionEmail}.` : '';
    showResultModal('success', 'Settings Saved', `Daily reminder is ${$('rem-enabled').checked ? 'ON at ' + time : 'OFF'}.${emailNote}`);
    clientReminderTick();
});

$('btn-test-email').addEventListener('click', async () => {
    const typed = $('rem-email-to').value.trim();
    const toAddr = typed || userSessionEmail;
    if (!isEmail(toAddr)) {
        showResultModal('error', 'Check Email Address', 'Please enter a valid email address.');
        return;
    }
    showToast('Sending test email...', 'info');
    await setSetting('rem_email_to', typed);
    await new Promise(r => setTimeout(r, 1500));   // give the sheet time to save the address
    try {
        const res = await fetchJSONP(`${GOOGLE_SCRIPT_URL}?action=test_email&email=${encodeURIComponent(userSessionEmail)}&to=${encodeURIComponent(toAddr)}`);
        if (res && res.success) showResultModal('success', 'Test Email Sent', `A test email was sent to ${toAddr}. Check the inbox and spam folder.`);
        else showResultModal('error', 'Email Not Sent', (res && res.message) || 'Could not send the email.');
    } catch (e) {
        showResultModal('error', 'Email Not Sent', 'Could not reach the server. Redeploy the Apps Script and try again.');
    }
});

$('checkin-add-btn').addEventListener('click', () => { closeModal('checkin-modal'); openEntryModal(); });
$('checkin-done-btn').addEventListener('click', ackToday);
$('checkin-later-btn').addEventListener('click', () => closeModal('checkin-modal'));

/* =========================================================
   MONTHLY TARGET ALERTS (50% / 80% / 100%)
   ========================================================= */
window.checkBudgetAlerts = function () {
    if (extrasLoadedFor !== userSessionEmail || !EXTRA.budgets.length) return;
    if (!$('result-modal').classList.contains('hidden')) return;
    const ym = todayYM();
    const { byCat, total } = monthExpenseByCat(ym);
    let store = {};
    try { store = JSON.parse(localStorage.getItem('milestones') || '{}'); } catch (e) { }
    const sk = userSessionEmail + '|' + ym;
    const fired = store[sk] || [];
    const modalMsgs = []; let worst = 'warning';

    budgetsFor(ym).forEach(b => {
        const isTotal = b.category === '__TOTAL__';
        const spent = isTotal ? total : (byCat[b.category] || 0);
        const pct = b.limit ? spent / b.limit * 100 : 0;
        const levels = isTotal ? [50, 80, 100] : [80, 100];
        const crossed = levels.filter(l => pct >= l && !fired.includes(`${b.category}:${l}:${b.limit}`));
        if (!crossed.length) return;
        crossed.forEach(l => fired.push(`${b.category}:${l}:${b.limit}`));
        const top = Math.max(...crossed);
        const name = isTotal ? 'monthly target' : b.category + ' budget';
        let title, msg;
        if (top >= 100) {
            title = isTotal ? 'Monthly target reached!' : b.category + ' budget exceeded';
            msg = `You have used 100% of your ${name} (${inr0(spent)} of ${inr0(b.limit)}).` + (spent > b.limit ? ` Over by ${inr0(spent - b.limit)}.` : '');
            worst = 'error';
        } else if (top >= 80) {
            title = `80% of ${name} used`;
            msg = `Careful! ${inr0(spent)} of ${inr0(b.limit)} is spent. Only ${inr0(b.limit - spent)} left.`;
        } else {
            title = '50% of monthly target used';
            msg = `You have spent ${inr0(spent)} of ${inr0(b.limit)}. You are halfway through your target.`;
        }
        notify(title, msg, 'budget');
        if (top >= 80) modalMsgs.push(msg); else showToast(title, 'info');
    });

    store[sk] = fired;
    try { localStorage.setItem('milestones', JSON.stringify(store)); } catch (e) { }
    if (modalMsgs.length) showResultModal(worst, worst === 'error' ? 'Target Alert' : 'Budget Warning', modalMsgs.join(' '));
};

/* =========================================================
   GOAL CELEBRATION
   ========================================================= */
function confetti() {
    const wrap = document.createElement('div');
    wrap.className = 'confetti-wrap';
    const colors = ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#f43f5e'];
    for (let i = 0; i < 70; i++) {
        const s = document.createElement('i');
        s.style.left = Math.random() * 100 + '%';
        s.style.background = colors[i % colors.length];
        s.style.animationDelay = Math.random() * 0.7 + 's';
        s.style.animationDuration = 2 + Math.random() * 1.6 + 's';
        wrap.appendChild(s);
    }
    document.body.appendChild(wrap);
    setTimeout(() => wrap.remove(), 5000);
}

window.goalReached = function (g) {
    notify('🎉 Goal achieved!', `Congratulations! You saved ${inr0(g.target)} for "${g.name}".`, 'goal');
    showResultModal('success', 'Congratulations! 🎉', `You reached your "${g.name}" goal of ${inr0(g.target)}. Time to enjoy it!`);
    confetti();
};

/* =========================================================
   WIRING
   ========================================================= */
window.onExtrasLoaded = function () {
    renderSmart();
    fillReminderForm();
    startReminderLoop();
    handleLaunchParams();
};

const _refreshApp2 = window.refreshAppView;
window.refreshAppView = function () { _refreshApp2(); renderSmart(); };

const _switchTab2 = window.switchTab;
window.switchTab = function (name) {
    _switchTab2(name);
    const tb = $('filter-toolbar');
    if (tb) tb.classList.toggle('hidden', ['goals', 'recurring', 'smart'].includes(name));
    if (name === 'smart') { renderSmart(); fillReminderForm(); }
};

updateNotifStatus();
