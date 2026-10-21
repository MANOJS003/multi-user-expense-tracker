/* =========================================================
   LIFE.JS - Life OS layer
   Activities + habits, unified heatmap, life score, achievements,
   insights, hardened transport (session token, retry, offline outbox),
   combined export. Load AFTER smart.js.
   Re-uses globals from script.js / features.js / smart.js.
   Everything is wrapped in an IIFE; inline handlers call window.L.*
   ========================================================= */
(function () {
    'use strict';

    const L = window.L = {};
    const launchTag = new URLSearchParams(location.search).get('notif');

    /* =========================================================
       1. TRANSPORT: session token, JSONP retry + timeout, offline outbox
       ========================================================= */
    const TOKEN_KEY = 'lifeos_token', OB_KEY = 'lifeos_outbox';
    const lsGet = (k, d = '') => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } };
    const lsSet = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { } };
    const tok = () => lsGet(TOKEN_KEY);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let cbSeq = 0, authDropped = false;

    function rawJsonp(url, timeoutMs) {
        return new Promise((resolve, reject) => {
            const cb = 'jsonp_' + Date.now().toString(36) + '_' + (++cbSeq);
            const script = document.createElement('script');
            let done = false;
            const finish = (fn, val) => {
                if (done) return; done = true;
                clearTimeout(timer); delete window[cb];
                if (script.parentNode) script.parentNode.removeChild(script);
                fn(val);
            };
            const timer = setTimeout(() => finish(reject, new Error('The server did not respond in time. Check your connection and the Apps Script deployment.')), timeoutMs);
            window[cb] = (data) => finish(resolve, data);
            script.onerror = () => finish(reject, new Error('Could not reach the Apps Script web app. Confirm "Who has access" is Anyone and GOOGLE_SCRIPT_URL is the current /exec URL.'));
            script.async = true;
            script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + cb;
            document.body.appendChild(script);
        });
    }

    function sessionExpired() {
        if (authDropped || !userSessionEmail) return;
        authDropped = true;
        lsSet(TOKEN_KEY, null);
        showToast('Your session expired. Sign in again to continue.', 'error');
        const out = $('logout-btn'); if (out) out.click();
        setTimeout(() => { authDropped = false; }, 1500);
    }

    // Only idempotent reads are retried; writes and emails are never replayed.
    const RETRYABLE = /[?&]action=(get|get_extras|get_life|auth)(&|$)/;
    window.fetchJSONP = async function (url, timeoutMs = 15000) {
        if (tok() && !/[?&]token=/.test(url)) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(tok());
        if (navigator.onLine === false) throw new Error('You are offline. Reconnect and try again.');
        const attempts = RETRYABLE.test(url) ? 2 : 1;
        let lastErr;
        for (let i = 0; i < attempts; i++) {
            try {
                const data = await rawJsonp(url, timeoutMs);
                if (data && data.token) lsSet(TOKEN_KEY, data.token);
                if (data && data.error && data.code === 'AUTH') { sessionExpired(); throw new Error(data.message || 'Session expired'); }
                return data;
            } catch (e) {
                lastErr = e;
                if (/Session expired|session has expired/i.test(e.message || '')) throw e;
                if (i < attempts - 1) await sleep(900 * (i + 1));
            }
        }
        throw lastErr;
    };

    const obRead = () => { try { return JSON.parse(lsGet(OB_KEY, '[]')); } catch (e) { return []; } };
    const obWrite = (a) => lsSet(OB_KEY, JSON.stringify(a.slice(-200)));
    const rawPost = (p) => fetch(GOOGLE_SCRIPT_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(p) });

    // POST responses are opaque (no-cors), so failed sends are queued and replayed when back online.
    window.sendToSheet = async function (payload) {
        payload.email = userSessionEmail;
        payload.token = tok();
        try { await rawPost(payload); }
        catch (err) {
            obWrite(obRead().concat(payload));
            showToast('You are offline. Changes will sync when you reconnect.', 'info');
        }
    };
    async function flushOutbox() {
        const q = obRead();
        if (!q.length || !userSessionEmail || navigator.onLine === false) return;
        obWrite([]);
        for (let i = 0; i < q.length; i++) {
            if (q[i].email !== userSessionEmail) continue;
            q[i].token = tok();
            try { await rawPost(q[i]); } catch (e) { obWrite(obRead().concat(q.slice(i))); break; }
        }
    }
    window.addEventListener('online', flushOutbox);

    /* =========================================================
       2. HELPERS + STATE
       ========================================================= */
    const num = (v) => Number(v) || 0;
    const pad2 = (n) => String(n).padStart(2, '0');
    const todayStr = () => toYMD(new Date());
    const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00'); d.setDate(d.getDate() + n); return toYMD(d); };
    const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);
    const fmtDay = (ymd, o) => new Date(ymd + 'T00:00:00').toLocaleDateString('en-IN', o || { day: 'numeric', month: 'short' });
    const fmtN = (n, d = 1) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: d });
    const sundayOf = (ymd) => addDays(ymd, -new Date(ymd + 'T00:00:00').getDay());
    const weekStartOf = (ymd) => { const d = new Date(ymd + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return toYMD(d); };
    const visible = (id) => { const el = $(id); return !!el && !el.classList.contains('hidden'); };
    const FUTURE_MSG = "Date can't be in the future. Pick today or an earlier date.";

    const DOMAINS = {
        money: { label: 'Money', rgb: '16 185 129', hex: '#10b981', icon: 'fa-wallet' },
        fitness: { label: 'Fitness', rgb: '244 63 94', hex: '#f43f5e', icon: 'fa-dumbbell' },
        learning: { label: 'Learning', rgb: '99 102 241', hex: '#6366f1', icon: 'fa-book-open' },
        wellness: { label: 'Wellness', rgb: '6 182 212', hex: '#06b6d4', icon: 'fa-leaf' },
        habit: { label: 'Habits', rgb: '245 158 11', hex: '#f59e0b', icon: 'fa-check-double' },
        custom: { label: 'Custom', rgb: '139 92 246', hex: '#8b5cf6', icon: 'fa-star' }
    };
    const CAT_DOMAIN = { Fitness: 'fitness', Learning: 'learning', Wellness: 'wellness', Habit: 'habit', Custom: 'custom' };
    const domOf = (a) => a.kind === 'HABIT' ? 'habit' : (CAT_DOMAIN[a.category] || 'custom');
    const isDone = (a) => a.kind === 'HABIT' && String(a.done) === 'yes';

    const S = { acts: [], habits: [], logs: new Map(), loaded: false, landed: false, hmFilter: 'all', hmDay: '', actShown: 15, showArchived: false, charts: {}, hIcon: 'fa-check', hColor: '#6366f1' };
    let memo = {};
    function bump() {
        memo = {}; S.logs = new Map();
        S.acts.forEach(a => { if (a.kind === 'HABIT') S.logs.set(a.ref + '|' + a.date, a); });
    }

    const normAct = (a) => ({ ...a, value: num(a.value), duration: num(a.duration), meta: (a.meta && typeof a.meta === 'object') ? a.meta : {} });
    const normHabit = (h) => ({ ...h, target: num(h.target) || 1, per_week: Math.min(7, Math.max(1, num(h.per_week) || 7)), active: h.active || 'yes', mode: h.mode === 'count' ? 'count' : 'check' });

    async function loadLife() {
        if (!userSessionEmail) return;
        try {
            const d = await fetchJSONP(`${GOOGLE_SCRIPT_URL}?action=get_life&email=${encodeURIComponent(userSessionEmail)}`);
            S.acts = (d.activities || []).map(normAct);
            S.habits = (d.habits || []).map(normHabit);
            S.loaded = true;
        } catch (e) {
            console.error('Life load failed', e);
            showToast('Could not load activities and habits. ' + (e.message || ''), 'error');
        }
        bump();
        if (!S.landed) { S.landed = true; switchTab('life'); }
        renderAll();
        flushOutbox();
        if (launchTag === 'habits') switchTab('habits');
    }

    /* =========================================================
       3. ACTIVITY CATALOG (drives the adaptive logger form)
       ========================================================= */
    const N = (k, label, unit, step) => ({ k, label, unit, step: step || 1, type: 'number' });
    const T = (k, label, ph) => ({ k, label, ph, type: 'text' });
    const SEL = (k, label, opts) => ({ k, label, opts, type: 'select' });
    const DUR = N('duration', 'Duration', 'min', 1);
    const CATALOG = {
        Fitness: { icon: 'fa-dumbbell', types: {
            Gym: { icon: 'fa-dumbbell', primary: 'sets', unit: 'sets', fields: [T('exercise', 'Focus', 'Chest, legs, full body'), N('sets', 'Sets', 'sets'), N('reps', 'Reps per set', 'reps'), N('weight', 'Top weight', 'kg', 0.5), DUR] },
            Running: { icon: 'fa-person-running', primary: 'distance', unit: 'km', fields: [N('distance', 'Distance', 'km', 0.01), DUR] },
            Cycling: { icon: 'fa-bicycle', primary: 'distance', unit: 'km', fields: [N('distance', 'Distance', 'km', 0.01), DUR] },
            Walking: { icon: 'fa-person-walking', primary: 'steps', unit: 'steps', fields: [N('steps', 'Steps', 'steps', 100), N('distance', 'Distance', 'km', 0.01), DUR] },
            Swimming: { icon: 'fa-person-swimming', primary: 'laps', unit: 'laps', fields: [N('laps', 'Laps', 'laps'), DUR] },
            Yoga: { icon: 'fa-spa', primary: 'duration', unit: 'min', fields: [DUR] }
        } },
        Learning: { icon: 'fa-book-open', types: {
            Coding: { icon: 'fa-code', primary: 'solved', unit: 'problems', fields: [N('solved', 'Problems solved', 'problems'), SEL('platform', 'Platform', ['LeetCode', 'HackerRank', 'Codeforces', 'CodeChef', 'Other']), SEL('difficulty', 'Difficulty', ['Easy', 'Medium', 'Hard', 'Mixed']), T('topic', 'Topic', 'Arrays, DP, graphs'), DUR] },
            Reading: { icon: 'fa-book', primary: 'pages', unit: 'pages', fields: [N('pages', 'Pages read', 'pages'), T('book', 'Book', 'Title'), DUR] },
            Study: { icon: 'fa-graduation-cap', primary: 'duration', unit: 'min', fields: [T('topic', 'Subject', 'Course or topic'), DUR] }
        } },
        Wellness: { icon: 'fa-leaf', types: {
            Meditation: { icon: 'fa-spa', primary: 'duration', unit: 'min', fields: [DUR] },
            Sleep: { icon: 'fa-bed', primary: 'hours', unit: 'hrs', fields: [N('hours', 'Hours slept', 'hrs', 0.25), SEL('quality', 'Quality (1-5)', ['1', '2', '3', '4', '5'])] },
            Water: { icon: 'fa-droplet', primary: 'glasses', unit: 'glasses', fields: [N('glasses', 'Glasses', 'glasses')] }
        } },
        Custom: { icon: 'fa-star', types: {
            Custom: { icon: 'fa-star', primary: 'amount', unit: '', fields: [T('name', 'What did you do?', 'e.g. Guitar practice'), N('amount', 'Amount', '', 0.01), T('unit', 'Unit', 'reps, pages, km'), DUR] }
        } }
    };
    const typeIcon = (a) => (CATALOG[a.category] && CATALOG[a.category].types[a.type] && CATALOG[a.category].types[a.type].icon) || (CATALOG[a.category] && CATALOG[a.category].icon) || 'fa-star';

    function summarize(a) {
        if (a.kind === 'HABIT') return isDone(a) ? (a.unit === 'count' ? 'Done · ' + fmtN(a.value, 0) : 'Done') : (a.unit === 'count' ? fmtN(a.value, 0) + ' so far' : 'Missed');
        const m = a.meta || {}, p = [];
        if (m.distance) p.push(fmtN(m.distance, 2) + ' km');
        if (m.steps) p.push(fmtN(m.steps, 0) + ' steps');
        if (m.sets) p.push(m.sets + (m.reps ? '×' + m.reps : ' sets') + (m.weight ? ' @ ' + m.weight + ' kg' : ''));
        if (m.exercise) p.push(m.exercise);
        if (m.laps) p.push(m.laps + ' laps');
        if (m.solved) p.push(m.solved + ' solved' + (m.difficulty ? ' (' + m.difficulty + ')' : '') + (m.platform ? ' on ' + m.platform : ''));
        if (m.topic) p.push(m.topic);
        if (m.pages) p.push(m.pages + ' pages' + (m.book ? ' of ' + m.book : ''));
        if (m.hours) p.push(m.hours + ' hrs' + (m.quality ? ', quality ' + m.quality + '/5' : ''));
        if (m.glasses) p.push(m.glasses + ' glasses');
        if (a.category === 'Custom' && m.amount) p.push(fmtN(m.amount, 2) + (a.unit ? ' ' + a.unit : ''));
        if (a.duration) p.push(a.duration + ' min');
        if (m.distance && a.duration) {
            if (a.type === 'Running') { const pace = a.duration / m.distance; p.push(Math.floor(pace) + ':' + pad2(Math.round((pace % 1) * 60) % 60) + '/km'); }
            else if (a.type === 'Cycling') p.push(fmtN(m.distance / (a.duration / 60), 1) + ' km/h');
        }
        return p.join(' · ') || '-';
    }

    /* =========================================================
       4. UNIFIED EVENT STREAM, STREAKS, HABIT MATH
       ========================================================= */
    function events() {
        if (memo.events) return memo.events;
        const ev = [];
        transactions.forEach(t => { const d = dOf(t); if (d) ev.push({ date: d, domain: 'money', pts: 1, kind: 'txn', ref: t }); });
        S.acts.forEach(a => {
            if (a.kind === 'HABIT') { if (isDone(a)) ev.push({ date: a.date, domain: 'habit', pts: 1, kind: 'habit', ref: a }); }
            else ev.push({ date: a.date, domain: domOf(a), pts: 1 + Math.min(2, a.duration / 45), kind: 'act', ref: a });
        });
        return (memo.events = ev);
    }

    function streaks() {
        if (memo.streaks) return memo.streaks;
        const t = todayStr(), days = new Set(events().map(e => e.date).filter(d => d <= t));
        let cur = 0, d = days.has(t) ? t : addDays(t, -1);
        while (days.has(d)) { cur++; d = addDays(d, -1); }
        let best = 0, run = 0, prev = '';
        [...days].sort().forEach(x => { run = prev && dayDiff(prev, x) === 1 ? run + 1 : 1; best = Math.max(best, run); prev = x; });
        return (memo.streaks = { cur, best, days });
    }

    const habitById = (id) => S.habits.find(h => h.id === id);
    const activeHabits = () => S.habits.filter(h => h.active !== 'no');
    const habitDone = (h, date) => { const l = S.logs.get(h.id + '|' + date); return !!l && String(l.done) === 'yes'; };
    function habitStreak(h) { const t = todayStr(); let d = habitDone(h, t) ? t : addDays(t, -1), n = 0; while (habitDone(h, d)) { n++; d = addDays(d, -1); } return n; }
    function habitWeek(h) { const t = todayStr(), s = sundayOf(t); let n = 0; for (let d = s; d <= t; d = addDays(d, 1)) if (habitDone(h, d)) n++; return n; }
    function habitRate(habits, from, to) {
        const t = todayStr(), end = to < t ? to : t;
        let done = 0, expected = 0;
        habits.forEach(h => {
            const c = h.created || from, start = c > from ? c : from;
            const days = dayDiff(start, end) + 1;
            if (days <= 0) return;
            expected += days * (h.per_week / 7);
            for (let i = 0; i < days; i++) if (habitDone(h, addDays(start, i))) done++;
        });
        return { done, expected, rate: expected > 0 ? Math.min(1, done / expected) : null };
    }

    /* ---------- Life score (0-100) = money 40 + activity 25 + habits 25 + balance 10 ---------- */
    function lifeScore() {
        if (!events().length) return null;
        const t = todayStr(), parts = [], tips = [];
        const fin = typeof computeScore === 'function' ? computeScore() : null;
        parts.push({ label: 'Money', pts: fin ? fin.total / 100 * 40 : 0, max: 40, note: fin ? `Savings score ${fin.total} of 100` : 'Add income and expenses to score this' });
        const since = addDays(t, -29);
        const activeDays = new Set(events().filter(e => e.domain !== 'money' && e.date >= since).map(e => e.date)).size;
        parts.push({ label: 'Activity consistency', pts: Math.min(1, activeDays / 15) * 25, max: 25, note: `${activeDays} active day(s) in the last 30` });
        const hr = habitRate(activeHabits(), addDays(t, -13), t);
        parts.push({ label: 'Habit follow-through', pts: hr.rate === null ? 0 : hr.rate * 25, max: 25, note: hr.rate === null ? 'Create a habit to unlock these points' : `${Math.round(hr.rate * 100)}% completed over 14 days` });
        const areas = new Set(events().filter(e => e.date >= addDays(t, -6)).map(e => e.domain));
        parts.push({ label: 'Balance', pts: Math.min(1, areas.size / 4) * 10, max: 10, note: `${areas.size} area(s) active this week` });
        if (!fin) tips.push('Log income and expenses so your money score can count.');
        if (activeDays < 15) tips.push('Log a workout, study session or habit on more days.');
        if (hr.rate === null) tips.push('Create one small daily habit.'); else if (hr.rate < 0.8) tips.push('Aim for 80% on your habits to earn most of those points.');
        if (areas.size < 3) tips.push('Touch at least three areas this week.');
        if (!tips.length) tips.push('Everything is on track. Keep the streak alive.');
        return { total: Math.round(parts.reduce((s, p) => s + p.pts, 0)), parts, tips };
    }

    /* ---------- monthly achievements (money badges from smart.js + life badges) ---------- */
    function monthLifeBadges(ym) {
        const acts = S.acts.filter(a => a.kind !== 'HABIT' && a.date.startsWith(ym));
        const sum = (type, key) => acts.filter(a => a.type === type).reduce((s, a) => s + num(a.meta[key]), 0);
        const out = [];
        if (sum('Coding', 'solved') >= 100) out.push({ icon: 'fas fa-code', name: 'Century Club', color: '#6366f1' });
        if (['Running', 'Cycling', 'Walking'].reduce((s, t) => s + sum(t, 'distance'), 0) >= 50) out.push({ icon: 'fas fa-road', name: 'Road Warrior', color: '#f43f5e' });
        if (sum('Reading', 'pages') >= 300) out.push({ icon: 'fas fa-book-open-reader', name: 'Bookworm', color: '#0ea5e9' });
        if (acts.filter(a => a.type === 'Gym').length >= 12) out.push({ icon: 'fas fa-dumbbell', name: 'Iron Regular', color: '#ef4444' });
        const from = ym + '-01', to = ym + '-' + pad2(daysIn(ym));
        const hr = habitRate(activeHabits(), from, to);
        if (hr.rate !== null && hr.rate >= 0.85 && hr.expected >= 5) out.push({ icon: 'fas fa-check-double', name: 'Habit Hero', color: '#f59e0b' });
        const monthEv = events().filter(e => e.date.startsWith(ym));
        const days = [...new Set(monthEv.map(e => e.date))].sort();
        let best = 0, run = 0, prev = '';
        days.forEach(x => { run = prev && dayDiff(prev, x) === 1 ? run + 1 : 1; best = Math.max(best, run); prev = x; });
        if (best >= 7) out.push({ icon: 'fas fa-fire', name: 'Iron Streak', color: '#f97316' });
        const per = (d) => new Set(monthEv.filter(e => e.domain === d).map(e => e.date)).size;
        if (['money', 'fitness', 'learning', 'habit'].every(d => per(d) >= 5)) out.push({ icon: 'fas fa-compass', name: 'All-Rounder', color: '#8b5cf6' });
        return out;
    }

    /* =========================================================
       5. RENDER: LIFE OVERVIEW
       ========================================================= */
    function renderAll() {
        if (visible('view-life')) renderLife();
        if (visible('view-activities')) renderActivities();
        if (visible('view-habits')) renderHabits();
    }

    function renderLife() {
        renderAlerts(); renderHero(); renderToday(); renderHeatmap(); renderWeek();
        renderInsights(); renderAchievements(); renderRecords(); renderPrefs();
    }

    function projection() {
        const ym = todayYM(), total = monthExpenseByCat(ym).total, ov = budgetsFor(ym).find(b => b.category === '__TOTAL__');
        const day = new Date().getDate(), dim = daysIn(ym);
        return { total, limit: ov ? ov.limit : 0, day, dim, projected: total / day * dim };
    }

    function renderAlerts() {
        const box = $('life-alerts'); if (!box) return;
        const p = projection(); let html = '';
        if (p.limit && p.day >= 5 && p.projected > p.limit) {
            const left = p.dim - p.day, room = p.limit - p.total;
            const advice = room <= 0 ? `You are already ${inr0(-room)} over your ${inr0(p.limit)} budget.`
                : left > 0 ? `To stay inside ${inr0(p.limit)}, keep spending under ${inr0(room / left)} a day for the next ${left} day(s).` : '';
            html = `<div class="life-alert"><i class="fas fa-triangle-exclamation"></i><div><b>On pace for ${inr0(p.projected)} this month.</b> ${esc(advice)}</div>
                <button type="button" onclick="switchTab('budgets')" class="text-xs font-semibold underline shrink-0">Review budget</button></div>`;
            const key = 'lifeos_proj_' + userSessionEmail + '_' + todayStr();
            if (!lsGet(key)) { lsSet(key, '1'); notify('Month-end spend alert', `On pace for ${inr0(p.projected)} against a ${inr0(p.limit)} budget.`, 'budget'); }
        }
        box.innerHTML = html;
    }

    function renderHero() {
        const box = $('life-hero'); if (!box) return;
        const sc = lifeScore(), st = streaks(), t = todayStr(), hrs = new Date().getHours();
        const greet = hrs < 12 ? 'Good morning' : hrs < 17 ? 'Good afternoon' : 'Good evening';
        const name = esc((userSessionEmail || '').split('@')[0]);
        const habits = activeHabits(), doneToday = habits.filter(h => habitDone(h, t)).length;
        const weekDays = new Set(events().filter(e => e.date >= addDays(t, -6)).map(e => e.date)).size;
        const todayN = events().filter(e => e.date === t).length;
        const mini = (icon, c, val, label) => `<div class="life-mini"><i class="fas ${icon}" style="color:${c}"></i><b>${val}</b><span>${label}</span></div>`;
        if (!sc) {
            box.innerHTML = `<div class="text-center py-6 text-xs text-gray-500 dark:text-gray-400"><div class="text-4xl mb-2"><i class="fas fa-seedling"></i></div>
                <div class="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1">${greet}, ${name}</div>
                Log an expense, a workout or a habit and your Life Score starts here.
                <div class="mt-4 flex flex-wrap justify-center gap-2"><button type="button" onclick="L.openActivity()" class="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs font-medium">Log activity</button>
                <button type="button" onclick="L.openHabit()" class="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-xs font-medium">New habit</button></div></div>`;
            return;
        }
        const g = gradeOf(sc.total);
        box.innerHTML = `<div class="flex flex-col sm:flex-row items-center gap-5">
            <div class="score-ring" style="--p:${sc.total};--c:${g.color}"><div><b>${sc.total}</b><small>/ 100</small></div></div>
            <div class="flex-1 w-full">
                <div class="text-xs text-gray-500 dark:text-gray-400">${greet}, ${name}</div>
                <div class="text-xl font-bold mb-3" style="color:${g.color}">Life Score: ${g.name}</div>
                ${sc.parts.map(p => `<div class="mb-2"><div class="flex justify-between text-[11px] mb-1"><span class="font-medium">${p.label}</span><span class="text-gray-500 dark:text-gray-400">${Math.round(p.pts)} / ${p.max}</span></div>
                    <div class="pbar" style="height:7px"><div class="pbar-fill" style="width:${p.pts / p.max * 100}%;background:linear-gradient(90deg,#6366f1,#06b6d4)"></div></div>
                    <div class="text-[10px] text-gray-400 mt-0.5">${esc(p.note)}</div></div>`).join('')}
            </div></div>
            <div class="life-minis mt-4">
                ${mini('fa-fire', '#f97316', st.cur, st.cur === 1 ? 'day streak' : 'day streak')}
                ${mini('fa-bolt', '#6366f1', todayN, 'logged today')}
                ${mini('fa-calendar-week', '#06b6d4', weekDays + '/7', 'active days')}
                ${mini('fa-check-double', '#f59e0b', habits.length ? doneToday + '/' + habits.length : '-', 'habits today')}
            </div>
            <div class="mt-4 text-[11px] bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-200 rounded-lg p-3"><b>Next step:</b> ${sc.tips.map(esc).join(' ')}</div>`;
    }

    function frequent() {
        const since = addDays(todayStr(), -45), by = {};
        S.acts.filter(a => a.kind !== 'HABIT' && a.date >= since).forEach(a => {
            const k = a.category + '|' + a.type, e = by[k] || (by[k] = { n: 0, last: a });
            e.n++; if (a.date >= e.last.date) e.last = a;
        });
        return Object.values(by).sort((x, y) => y.n - x.n).slice(0, 4);
    }

    function renderToday() {
        const box = $('life-today'); if (!box) return;
        const t = todayStr(), habits = activeHabits();
        const rows = habits.slice(0, 6).map(h => {
            const d = habitDone(h, t), log = S.logs.get(h.id + '|' + t);
            const count = h.mode === 'count';
            return `<div class="flex items-center gap-3 py-1.5">
                <button type="button" class="hb-check hb-sm ${d ? 'is-done' : ''}" style="--hc:${esc(h.color)}" aria-pressed="${d}" aria-label="${esc(h.name)}" onclick="L.toggleHabit('${esc(h.id)}','${t}',1)"><i class="fas ${d ? 'fa-check' : esc(h.icon)}"></i></button>
                <div class="min-w-0 flex-1"><div class="text-xs font-semibold truncate ${d ? 'line-through opacity-60' : ''}">${esc(h.name)}</div>
                <div class="text-[10px] text-gray-400">${count ? fmtN(log ? log.value : 0, 0) + ' of ' + h.target : habitStreak(h) + ' day streak'}</div></div></div>`;
        }).join('');
        const freq = frequent();
        box.innerHTML = `<div class="flex items-center justify-between mb-2"><h3 class="text-sm font-bold flex items-center gap-1.5"><i class="fas fa-list-check text-amber-500"></i>Today</h3>
            <button type="button" onclick="switchTab('habits')" class="text-[11px] text-blue-600 hover:underline">All habits</button></div>
            ${rows || `<div class="text-xs text-gray-500 dark:text-gray-400 py-3">No habits yet. A habit is something you tick off daily, like water, reading or a walk.<div class="mt-2"><button type="button" onclick="L.openHabit()" class="chip chip-btn">Create a habit</button></div></div>`}
            ${habits.length > 6 ? `<div class="text-[11px] text-gray-400">+${habits.length - 6} more on the Habits tab</div>` : ''}
            ${freq.length ? `<div class="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700"><div class="text-[11px] text-gray-500 dark:text-gray-400 mb-2">Log again</div>
                <div class="flex flex-wrap gap-2">${freq.map(f => `<button type="button" class="chip chip-btn" onclick="L.openActivity('${esc(f.last.id)}','dup')"><i class="fas ${typeIcon(f.last)}"></i>${esc(f.last.type === 'Custom' ? f.last.title : f.last.type)}</button>`).join('')}</div></div>` : ''}`;
    }

    /* ---------- the global heatmap: money + activities + habits in one grid ---------- */
    function dayMap(filter) {
        const m = {};
        events().forEach(e => {
            if (filter !== 'all' && e.domain !== filter) return;
            const o = m[e.date] || (m[e.date] = { pts: 0, items: [] });
            o.pts += e.pts; o.items.push(e);
        });
        return m;
    }
    const lvlOf = (pts) => pts <= 0 ? 0 : pts <= 2 ? 1 : pts <= 4 ? 2 : pts <= 7 ? 3 : 4;

    function renderHeatmap() {
        const box = $('life-heatmap'); if (!box) return;
        const f = S.hmFilter, today = new Date(); today.setHours(0, 0, 0, 0);
        const tStr = toYMD(today), start = new Date(today);
        start.setDate(start.getDate() - (52 * 7 + today.getDay()));
        const map = dayMap(f), rgb = f === 'all' ? '99 102 241' : DOMAINS[f].rgb;
        let cells = '', months = '', lastM = -1, total = 0, active = 0;
        for (let w = 0; w < 53; w++) {
            const first = new Date(start); first.setDate(start.getDate() + w * 7);
            if (first.getMonth() !== lastM) { lastM = first.getMonth(); months += `<span style="grid-column:${w + 1}">${first.toLocaleDateString('en-IN', { month: 'short' })}</span>`; }
            for (let d = 0; d < 7; d++) {
                const dt = new Date(start); dt.setDate(start.getDate() + w * 7 + d);
                const ds = toYMD(dt);
                if (ds > tStr) { cells += '<span class="lh-cell lh-future"></span>'; continue; }
                const o = map[ds], n = o ? o.items.length : 0;
                if (o) { total += n; active++; }
                const label = `${fmtDay(ds, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}: ${n ? n + ' logged' : 'nothing logged'}`;
                cells += `<button type="button" class="lh-cell l${lvlOf(o ? o.pts : 0)}${ds === S.hmDay ? ' sel' : ''}" data-d="${ds}" title="${esc(label)}" aria-label="${esc(label)}"></button>`;
            }
        }
        const chips = ['all', 'money', 'fitness', 'learning', 'wellness', 'habit'].map(k =>
            `<button type="button" class="chip chip-btn ${f === k ? 'chip-on' : ''}" onclick="L.hmFilter('${k}')">${k === 'all' ? 'Everything' : DOMAINS[k].label}</button>`).join('');
        const st = streaks();
        $('life-hm-filters').innerHTML = chips;
        $('life-hm-summary').textContent = `${total} logged across ${active} days in the past year · current streak ${st.cur} · best ${st.best}`;
        box.innerHTML = `<div class="lh" style="--rgb:${rgb}"><div class="lh-months">${months}</div><div class="lh-grid">${cells}</div></div>`;
        const sc = box.parentElement; if (sc && !sc.dataset.scrolled) { sc.scrollLeft = sc.scrollWidth; sc.dataset.scrolled = '1'; }
        renderHmDetail(map);
        $('life-hm-legend').style.setProperty('--rgb', rgb);
    }

    function renderHmDetail(map) {
        const box = $('life-hm-detail'); if (!box) return;
        if (!S.hmDay) { box.innerHTML = '<div class="text-[11px] text-gray-400 text-center py-2">Tap any square to see what you logged that day.</div>'; return; }
        const o = (map || dayMap(S.hmFilter))[S.hmDay];
        const head = `<b>${esc(fmtDay(S.hmDay, { weekday: 'long', day: 'numeric', month: 'long' }))}</b>`;
        if (!o) { box.innerHTML = `<div class="rounded-lg bg-indigo-50 dark:bg-indigo-900/20 p-3 text-xs">${head}<div class="text-gray-500 dark:text-gray-400 mt-1">Nothing logged on this day.</div></div>`; return; }
        const groups = {};
        o.items.forEach(e => (groups[e.domain] = groups[e.domain] || []).push(e));
        box.innerHTML = `<div class="rounded-lg bg-indigo-50 dark:bg-indigo-900/20 p-3 text-xs">${head}
            ${Object.keys(groups).map(d => `<div class="mt-2"><div class="font-semibold flex items-center gap-1.5" style="color:${DOMAINS[d].hex}"><i class="fas ${DOMAINS[d].icon}"></i>${DOMAINS[d].label}</div>
            <ul class="mt-1 space-y-0.5">${groups[d].map(e => {
                if (e.kind === 'txn') { const t = e.ref; return `<li class="flex justify-between gap-2 text-[11px]"><span class="truncate">${esc(t.category)}${t.description ? ' · ' + esc(t.description) : ''}</span><b class="shrink-0 ${t.type === 'INCOME' ? 'text-emerald-600' : 'text-rose-600'}">${t.type === 'INCOME' ? '+' : '-'}${inr(t.amount)}</b></li>`; }
                const a = e.ref; return `<li class="flex justify-between gap-2 text-[11px]"><span class="truncate">${esc(a.title || a.type)}</span><span class="text-gray-500 dark:text-gray-400 shrink-0 text-right">${esc(a.kind === 'HABIT' ? 'Done' : summarize(a))}</span></li>`;
            }).join('')}</ul></div>`).join('')}</div>`;
    }

    L.hmFilter = (k) => { S.hmFilter = k; S.hmDay = ''; renderHeatmap(); };
    document.addEventListener('click', (e) => {
        const c = e.target.closest && e.target.closest('#life-heatmap [data-d]');
        if (!c) return;
        S.hmDay = S.hmDay === c.dataset.d ? '' : c.dataset.d;
        renderHeatmap();
    });

    /* ---------- weekly review ---------- */
    function periodStats(from, to) {
        const ev = events().filter(e => e.date >= from && e.date <= to);
        const acts = S.acts.filter(a => a.kind !== 'HABIT' && a.date >= from && a.date <= to);
        return {
            days: new Set(ev.map(e => e.date)).size, sessions: acts.length,
            minutes: acts.reduce((s, a) => s + a.duration, 0),
            spent: transactions.filter(t => t.type === 'EXPENSE' && dOf(t) >= from && dOf(t) <= to).reduce((s, t) => s + num(t.amount), 0),
            habit: habitRate(activeHabits(), from, to)
        };
    }
    function deltaChip(cur, prev, lowerBetter) {
        if (!prev && !cur) return '<span class="text-gray-400">-</span>';
        if (!prev) return '<span class="text-gray-400">new</span>';
        const ch = (cur - prev) / prev * 100, good = lowerBetter ? ch <= 0 : ch >= 0;
        return `<span style="color:${Math.abs(ch) < 1 ? '#9ca3af' : good ? '#10b981' : '#f43f5e'}">${ch > 0 ? '+' : ''}${Math.round(ch)}%</span>`;
    }
    function renderWeek() {
        const box = $('life-week'); if (!box) return;
        const t = todayStr(), a = periodStats(addDays(t, -6), t), b = periodStats(addDays(t, -13), addDays(t, -7));
        const row = (label, cur, prev, fmt, low) => `<div class="flex items-center justify-between py-1.5 text-xs border-b border-gray-100 dark:border-gray-700 last:border-0"><span class="text-gray-500 dark:text-gray-400">${label}</span><span><b>${fmt(cur)}</b> <span class="text-[11px] ml-1">${deltaChip(cur, prev, low)}</span></span></div>`;
        const hp = a.habit.rate === null ? null : Math.round(a.habit.rate * 100);
        box.innerHTML = `<h3 class="text-sm font-bold mb-1 flex items-center gap-1.5"><i class="fas fa-calendar-check text-indigo-500"></i>Last 7 days</h3>
            <p class="text-[11px] text-gray-400 mb-2">Compared with the 7 days before</p>
            ${row('Active days', a.days, b.days, v => v + ' / 7')}
            ${row('Sessions logged', a.sessions, b.sessions, v => v)}
            ${row('Time moving or learning', a.minutes, b.minutes, v => v >= 60 ? Math.floor(v / 60) + ' h ' + (v % 60) + ' min' : v + ' min')}
            ${row('Money spent', a.spent, b.spent, inr0, true)}
            ${hp === null ? '' : `<div class="flex items-center justify-between py-1.5 text-xs"><span class="text-gray-500 dark:text-gray-400">Habits completed</span><b>${hp}%</b></div>`}`;
    }

    /* ---------- insights ---------- */
    function renderInsights() {
        const box = $('life-insights'); if (!box) return;
        const t = todayStr(), list = [], st = streaks();
        if (st.cur >= 2) list.push({ i: 'fa-fire', c: '#f97316', x: `${st.cur}-day streak. Your best is ${st.best}.` });
        // spending on workout days vs other days (last 60 days)
        const from = addDays(t, -59), workout = new Set(S.acts.filter(a => a.kind !== 'HABIT' && a.category === 'Fitness' && a.date >= from).map(a => a.date));
        if (workout.size >= 4 && 60 - workout.size >= 4) {
            let wSum = 0, oSum = 0;
            transactions.forEach(x => { const d = dOf(x); if (x.type !== 'EXPENSE' || d < from || d > t) return; (workout.has(d) ? (wSum += num(x.amount)) : (oSum += num(x.amount))); });
            const w = wSum / workout.size, o = oSum / (60 - workout.size);
            if (o > 0) { const p = Math.round(Math.abs(w - o) / o * 100); if (p >= 10) list.push({ i: 'fa-scale-balanced', c: '#6366f1', x: `You spend about ${inr0(w)} on workout days versus ${inr0(o)} on other days (${p}% ${w < o ? 'less' : 'more'}).` }); }
        }
        // a domain that has gone quiet
        ['fitness', 'learning', 'wellness'].forEach(d => {
            const recent = events().some(e => e.domain === d && e.date >= addDays(t, -6));
            const before = events().some(e => e.domain === d && e.date < addDays(t, -6) && e.date >= addDays(t, -36));
            if (!recent && before) list.push({ i: DOMAINS[d].icon, c: DOMAINS[d].hex, x: `No ${DOMAINS[d].label.toLowerCase()} logged in the last 7 days. One short session restarts the run.` });
        });
        const p = projection();
        if (p.limit && p.day >= 5 && p.projected <= p.limit) list.push({ i: 'fa-circle-check', c: '#10b981', x: `Month-end projection is ${inr0(p.projected)}, inside your ${inr0(p.limit)} budget.` });
        const risk = activeHabits().filter(h => habitStreak(h) >= 5 && !habitDone(h, t));
        if (risk.length) list.push({ i: 'fa-hourglass-half', c: '#f59e0b', x: `${risk[0].name} has a ${habitStreak(risk[0])}-day streak and is not ticked yet today.` });
        box.innerHTML = `<h3 class="text-sm font-bold mb-2 flex items-center gap-1.5"><i class="fas fa-lightbulb text-amber-500"></i>Insights</h3>` +
            (list.length ? list.slice(0, 5).map(x => `<div class="flex gap-2.5 py-2 text-xs border-b border-gray-100 dark:border-gray-700 last:border-0"><span class="stat-icon shrink-0" style="background:${x.c}22;color:${x.c}"><i class="fas ${x.i}"></i></span><span class="leading-relaxed">${esc(x.x)}</span></div>`).join('')
                : '<div class="text-xs text-gray-400 py-4 text-center">Insights appear after a week or two of logging.</div>');
    }

    function renderAchievements() {
        const box = $('life-achievements'); if (!box) return;
        const rows = [];
        for (let i = 0; i < 6; i++) {
            const ym = ymBack(i);
            if (!events().some(e => e.date.startsWith(ym))) continue;
            const badges = [...(typeof monthBadges === 'function' ? monthBadges(monthStats(ym), i === 0) : []), ...monthLifeBadges(ym)];
            rows.push(`<div class="py-2.5 border-b border-gray-100 dark:border-gray-700 last:border-0"><div class="text-xs font-semibold mb-1.5">${monthLabel(ym)}${i === 0 ? ' <span class="text-[10px] text-gray-400 font-normal">(in progress)</span>' : ''}</div>
                <div class="flex flex-wrap gap-1">${badges.map(badgeChip).join('') || '<span class="text-[10px] text-gray-400">No badges yet</span>'}</div></div>`);
        }
        box.innerHTML = `<h3 class="text-sm font-bold mb-1 flex items-center gap-1.5"><i class="fas fa-award text-violet-500"></i>Monthly achievements</h3>` +
            (rows.join('') || '<div class="text-xs text-gray-400 py-4 text-center">Badges for savings, streaks, reading, running and habits land here at the end of each month.</div>');
    }

    function records() {
        const acts = S.acts.filter(a => a.kind !== 'HABIT'), out = [];
        const best = (type, fn, better) => { let b = null; acts.filter(a => a.type === type).forEach(a => { const v = fn(a); if (v && (!b || better(v, b.v))) b = { v, a }; }); return b; };
        const run = best('Running', a => num(a.meta.distance), (x, y) => x > y);
        if (run) out.push({ i: 'fa-person-running', l: 'Longest run', v: fmtN(run.v, 2) + ' km', d: run.a.date });
        const pace = best('Running', a => num(a.meta.distance) >= 3 && a.duration ? a.duration / a.meta.distance : 0, (x, y) => x < y);
        if (pace) out.push({ i: 'fa-gauge-high', l: 'Best pace (3 km+)', v: Math.floor(pace.v) + ':' + pad2(Math.round((pace.v % 1) * 60) % 60) + ' /km', d: pace.a.date });
        const ride = best('Cycling', a => num(a.meta.distance), (x, y) => x > y);
        if (ride) out.push({ i: 'fa-bicycle', l: 'Longest ride', v: fmtN(ride.v, 1) + ' km', d: ride.a.date });
        const perDay = (type, key) => { const m = {}; acts.filter(a => a.type === type).forEach(a => m[a.date] = (m[a.date] || 0) + num(a.meta[key])); const e = Object.entries(m).sort((x, y) => y[1] - x[1])[0]; return e && e[1] > 0 ? e : null; };
        const code = perDay('Coding', 'solved'); if (code) out.push({ i: 'fa-code', l: 'Most problems in a day', v: fmtN(code[1], 0), d: code[0] });
        const read = perDay('Reading', 'pages'); if (read) out.push({ i: 'fa-book', l: 'Most pages in a day', v: fmtN(read[1], 0), d: read[0] });
        const lift = best('Gym', a => num(a.meta.weight), (x, y) => x > y);
        if (lift) out.push({ i: 'fa-dumbbell', l: 'Heaviest lift logged', v: fmtN(lift.v, 1) + ' kg', d: lift.a.date });
        return out;
    }
    function renderRecords() {
        const box = $('life-records'); if (!box) return;
        const r = records();
        box.innerHTML = `<h3 class="text-sm font-bold mb-1 flex items-center gap-1.5"><i class="fas fa-trophy text-amber-500"></i>Personal records</h3>` +
            (r.length ? r.map(x => `<div class="flex items-center justify-between gap-2 py-2 text-xs border-b border-gray-100 dark:border-gray-700 last:border-0"><span class="flex items-center gap-2"><i class="fas ${x.i} w-4 text-center text-gray-400"></i>${x.l}</span><span class="text-right"><b>${esc(x.v)}</b><span class="block text-[10px] text-gray-400">${fmtDay(x.d, { day: 'numeric', month: 'short', year: 'numeric' })}</span></span></div>`).join('')
                : '<div class="text-xs text-gray-400 py-4 text-center">Log a run, a reading session or a coding day and your records show up here.</div>');
    }

    function renderPrefs() {
        const box = $('life-prefs'); if (!box) return;
        const s = EXTRA.settings || {};
        box.innerHTML = `<h3 class="text-sm font-bold mb-3 flex items-center gap-1.5"><i class="fas fa-sliders text-gray-400"></i>Life OS reminders</h3>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label class="flex items-center justify-between gap-3 text-xs"><span><b>Evening habit nudge</b><br><span class="text-gray-500 dark:text-gray-400">Notifies you at your reminder time if habits are still open</span></span><input type="checkbox" class="chk" ${s.habit_nudge === 'no' ? '' : 'checked'} onchange="L.pref('habit_nudge',this.checked)"></label>
                <label class="flex items-center justify-between gap-3 text-xs"><span><b>Weekly digest email</b><br><span class="text-gray-500 dark:text-gray-400">Sunday summary of spending, activity and habits (needs the digest trigger)</span></span><input type="checkbox" class="chk" ${s.digest_email === 'yes' ? 'checked' : ''} onchange="L.pref('digest_email',this.checked)"></label>
            </div>`;
    }
    L.pref = async (key, on) => { await setSetting(key, on ? 'yes' : 'no'); if (key === 'digest_email') setSetting('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata'); showToast('Preference saved', 'success'); };

    /* =========================================================
       6. ACTIVITIES TAB
       ========================================================= */
    function renderActivities() {
        const cat = $('act-filter-cat');
        if (cat && !cat.options.length) cat.innerHTML = '<option value="ALL">All categories</option>' + Object.keys(CATALOG).map(c => `<option>${c}</option>`).join('');
        const mi = $('act-filter-month'); if (mi) mi.max = todayYM();
        renderActSummary(); renderActChart(); renderActTable();
    }

    function renderActSummary() {
        const box = $('act-summary'); if (!box) return;
        const t = todayStr(), ws = weekStartOf(t);
        const acts = S.acts.filter(a => a.kind !== 'HABIT' && a.date >= ws && a.date <= t);
        const sum = (k) => acts.reduce((s, a) => s + num(a.meta[k]), 0);
        const km = sum('distance');
        const cards = [
            { i: 'fa-bolt', c: '#6366f1', l: 'Sessions this week', v: acts.length, s: 'since Monday' },
            { i: 'fa-clock', c: '#06b6d4', l: 'Active time', v: Math.floor(acts.reduce((s, a) => s + a.duration, 0) / 60) + 'h ' + acts.reduce((s, a) => s + a.duration, 0) % 60 + 'm', s: 'across all categories' },
            { i: 'fa-road', c: '#f43f5e', l: 'Distance', v: fmtN(km, 1) + ' km', s: 'run, ride and walk' },
            { i: 'fa-code', c: '#8b5cf6', l: 'Problems solved', v: fmtN(sum('solved'), 0), s: 'coding practice' },
            { i: 'fa-book', c: '#0ea5e9', l: 'Pages read', v: fmtN(sum('pages'), 0), s: 'reading' }
        ];
        box.innerHTML = cards.map(c => `<div class="stat-card rounded-xl border border-gray-200 dark:border-gray-700 p-4"><div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><span class="stat-icon" style="background:${c.c}22;color:${c.c}"><i class="fas ${c.i}"></i></span>${c.l}</div><div class="text-xl font-bold mt-2">${esc(c.v)}</div><div class="text-[11px] text-gray-400 mt-0.5">${c.s}</div></div>`).join('');
    }

    function renderActChart() {
        const cv = $('act-week-chart'); if (!cv || typeof Chart === 'undefined') return;
        const t = todayStr(), cur = weekStartOf(t), weeks = [];
        for (let i = 7; i >= 0; i--) weeks.push(addDays(cur, -7 * i));
        const doms = ['fitness', 'learning', 'wellness', 'custom'];
        const sets = doms.map(d => ({
            label: DOMAINS[d].label, backgroundColor: DOMAINS[d].hex, borderRadius: 4,
            data: weeks.map(w => S.acts.filter(a => a.kind !== 'HABIT' && domOf(a) === d && a.date >= w && a.date <= addDays(w, 6)).reduce((s, a) => s + a.duration, 0))
        }));
        const tc = document.documentElement.classList.contains('dark') ? '#cbd5e1' : '#475569';
        if (S.charts.week) S.charts.week.destroy();
        S.charts.week = new Chart(cv.getContext('2d'), {
            type: 'bar',
            data: { labels: weeks.map(w => fmtDay(w)), datasets: sets },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: tc } } },
                scales: { x: { stacked: true, ticks: { color: tc } }, y: { stacked: true, beginAtZero: true, ticks: { color: tc }, title: { display: true, text: 'Minutes', color: tc } } } }
        });
    }

    function filteredActs() {
        const cat = ($('act-filter-cat') || {}).value || 'ALL', q = (($('act-filter-q') || {}).value || '').toLowerCase(), ym = ($('act-filter-month') || {}).value || '';
        return S.acts.filter(a => a.kind !== 'HABIT')
            .filter(a => cat === 'ALL' || a.category === cat)
            .filter(a => !ym || a.date.startsWith(ym))
            .filter(a => !q || (a.title + ' ' + a.type + ' ' + summarize(a) + ' ' + (a.notes || '')).toLowerCase().includes(q))
            .sort((x, y) => y.date.localeCompare(x.date) || String(y.id).localeCompare(String(x.id)));
    }

    function renderActTable() {
        const body = $('act-tbody'); if (!body) return;
        const rows = filteredActs(), shown = rows.slice(0, S.actShown);
        if (!rows.length) {
            body.innerHTML = `<tr><td colspan="5" class="px-4 py-10 text-center text-gray-400 text-xs"><div class="text-3xl mb-2"><i class="fas fa-person-running"></i></div>${S.acts.some(a => a.kind !== 'HABIT') ? 'No activities match these filters.' : 'Nothing logged yet. Tap <b>Log activity</b> to record a run, a gym session or a coding day.'}</td></tr>`;
            $('act-more').innerHTML = ''; return;
        }
        body.innerHTML = shown.map(a => `<tr class="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition">
            <td class="px-4 py-3 font-mono text-[11px]">${esc(a.date)}</td>
            <td class="px-4 py-3"><span class="badge-chip" style="background:${DOMAINS[domOf(a)].hex}22;color:${DOMAINS[domOf(a)].hex}"><i class="fas ${typeIcon(a)}"></i>${esc(a.category)}</span></td>
            <td class="px-4 py-3 font-medium">${esc(a.title || a.type)}</td>
            <td class="px-4 py-3 text-gray-500 dark:text-gray-400 max-w-[260px] truncate" title="${esc(summarize(a))}">${esc(summarize(a))}</td>
            <td class="px-4 py-3 text-center whitespace-nowrap">
                <button onclick="L.openActivity('${esc(a.id)}')" title="Edit" class="p-1 text-blue-600 rounded mr-1"><i class="fas fa-edit"></i></button>
                <button onclick="L.openActivity('${esc(a.id)}','dup')" title="Repeat" class="p-1 text-violet-600 rounded mr-1"><i class="fas fa-copy"></i></button>
                <button onclick="L.deleteActivity('${esc(a.id)}')" title="Delete" class="p-1 text-rose-600 rounded"><i class="fas fa-trash-alt"></i></button></td></tr>`).join('');
        $('act-more').innerHTML = rows.length > shown.length ? `<button type="button" onclick="L.showMore()" class="pg-btn">Show ${Math.min(15, rows.length - shown.length)} more (${rows.length - shown.length} left)</button>` : `<span class="text-[11px] text-gray-400">${rows.length} ${rows.length === 1 ? 'activity' : 'activities'}</span>`;
    }
    L.showMore = () => { S.actShown += 15; renderActTable(); };
    L.refilter = () => { S.actShown = 15; renderActivities(); };

    L.deleteActivity = async (id) => {
        const ok = await showConfirmModal('Delete activity?', 'This entry will be removed permanently.', 'Yes, delete', 'fas fa-trash-alt');
        if (!ok) return;
        S.acts = S.acts.filter(a => a.id !== id); bump(); renderAll();
        showToast('Activity deleted', 'info');
        sendToSheet({ action: 'act_delete', id });
    };

    /* =========================================================
       7. ACTIVITY LOGGER MODAL (fields adapt to category + type)
       ========================================================= */
    function fieldHTML(f, v) {
        const id = 'af-' + f.k, val = v === undefined || v === null ? '' : esc(v);
        let input;
        if (f.type === 'select') input = `<select id="${id}" class="fld"><option value="">-</option>${f.opts.map(o => `<option ${String(v) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
        else if (f.type === 'text') input = `<input id="${id}" type="text" maxlength="80" value="${val}" placeholder="${esc(f.ph || '')}" class="fld">`;
        else input = `<input id="${id}" type="number" inputmode="decimal" min="0" step="${f.step}" value="${val}" placeholder="0" class="fld">`;
        return `<div class="${f.type === 'text' ? 'col-span-2' : ''}"><label class="lbl" for="${id}">${esc(f.label)}${f.unit ? ' <span class="text-gray-400">(' + esc(f.unit) + ')</span>' : ''}</label>${input}</div>`;
    }

    function fillTypes(selected) {
        const cat = $('act-category').value, sel = $('act-type');
        if (cat === 'Habit') {
            const hs = activeHabits();
            sel.innerHTML = hs.length ? hs.map(h => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join('') : '<option value="">No habits yet</option>';
        } else sel.innerHTML = Object.keys(CATALOG[cat].types).map(t => `<option>${t}</option>`).join('');
        if (selected) sel.value = selected;
    }

    function buildFields(a) {
        const cat = $('act-category').value, type = $('act-type').value, box = $('act-fields');
        if (cat === 'Habit') {
            const h = habitById(type);
            if (!h) { box.innerHTML = '<div class="col-span-2 text-xs text-gray-500 dark:text-gray-400">Create a habit first, then log it here or tick it on the Habits tab. <button type="button" class="text-blue-600 underline" onclick="closeModal(\'act-modal\');L.openHabit()">New habit</button></div>'; return; }
            const log = S.logs.get(h.id + '|' + ($('act-date').value || todayStr()));
            box.innerHTML = h.mode === 'count'
                ? `<div class="col-span-2"><label class="lbl" for="af-habitcount">Count so far <span class="text-gray-400">(target ${h.target})</span></label><input id="af-habitcount" type="number" min="0" step="1" value="${log ? log.value : ''}" class="fld"></div>`
                : `<label class="col-span-2 flex items-center justify-between gap-3 text-xs"><span><b>Completed</b><br><span class="text-gray-500 dark:text-gray-400">Mark ${esc(h.name)} as done for this date</span></span><input id="af-habitdone" type="checkbox" class="chk" ${!log || String(log.done) === 'yes' ? 'checked' : ''}></label>`;
            return;
        }
        const def = CATALOG[cat].types[type]; if (!def) { box.innerHTML = ''; return; }
        const vals = a ? { ...a.meta, duration: a.duration || '' } : {};
        if (a && cat === 'Custom') { vals.name = a.title; vals.unit = a.unit; vals.amount = a.meta.amount !== undefined ? a.meta.amount : a.value; }
        box.innerHTML = def.fields.map(f => fieldHTML(f, vals[f.k])).join('');
    }

    function collect(cat, type) {
        const def = CATALOG[cat].types[type], meta = {}; let duration = 0, title = type;
        for (const f of def.fields) {
            const el = $('af-' + f.k); if (!el) continue;
            let v = el.value.trim();
            if (f.type === 'number') {
                if (v === '') v = 0; else { v = parseFloat(v); if (isNaN(v) || v < 0) return { error: `${f.label} must be a number, zero or higher.` }; }
                if (f.k === 'duration') { if (v > 1440) return { error: 'Duration cannot be more than 24 hours.' }; duration = v; continue; }
                if (v) meta[f.k] = v;
            } else if (v) meta[f.k] = v;
        }
        let value = num(meta[def.primary]), unit = def.unit;
        if (cat === 'Custom') { title = meta.name || 'Custom activity'; unit = meta.unit || ''; }
        if (!value && duration) { value = duration; unit = 'min'; }
        if (!value && !duration) return { error: 'Enter at least one amount, such as distance, count or duration.' };
        return { meta, duration, value, unit, title };
    }

    L.onCat = () => { fillTypes(); buildFields(); };
    L.onType = () => buildFields();
    L.onDate = () => { if ($('act-category').value === 'Habit') buildFields(); };

    L.openActivity = (id, mode) => {
        applyMax();
        const a = id ? S.acts.find(x => x.id === id) : null;
        const edit = a && mode !== 'dup';
        $('act-id').value = edit ? a.id : '';
        $('act-modal-title').textContent = edit ? 'Edit activity' : mode === 'dup' ? 'Repeat activity' : 'Log activity';
        $('act-date').value = edit ? a.date : todayStr();
        $('act-category').innerHTML = Object.keys(CATALOG).map(c => `<option>${c}</option>`).join('') + '<option>Habit</option>';
        $('act-category').value = a ? a.category : (S.lastCat || 'Fitness');
        $('act-category').disabled = !!edit;
        fillTypes(a ? a.type : null);
        $('act-type').disabled = !!edit;
        buildFields(a);
        $('act-notes').value = a ? a.notes || '' : '';
        openModal('act-modal');
    };

    $('act-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const dateEl = $('act-date'), date = dateEl.value;
        if (!date || date > todayStr()) { showToast(FUTURE_MSG, 'error'); dateEl.focus(); return; }
        const cat = $('act-category').value, type = $('act-type').value;
        S.lastCat = cat;
        if (cat === 'Habit') {
            const h = habitById(type); if (!h) { showToast('Choose a habit first.', 'error'); return; }
            const v = h.mode === 'count' ? Math.max(0, parseInt($('af-habitcount').value) || 0) : ($('af-habitdone').checked ? 1 : 0);
            closeModal('act-modal'); setHabitValue(h, date, v, true); return;
        }
        const r = collect(cat, type);
        if (r.error) { showToast(r.error, 'error'); return; }
        const id = $('act-id').value;
        const a = { id: id || uid('a'), date, kind: 'ACTIVITY', category: cat, type, title: r.title, value: r.value, unit: r.unit, duration: r.duration, done: '', ref: '', meta: r.meta, notes: $('act-notes').value.trim().slice(0, 300) };
        S.acts = S.acts.filter(x => x.id !== a.id).concat(a);
        bump(); closeModal('act-modal'); renderAll();
        showToast(id ? 'Activity updated' : 'Activity logged', 'success');
        sendToSheet({ action: 'act_save', ...a });
        celebrateStreak();
    });

    function celebrateStreak() {
        const st = streaks().cur, key = 'lifeos_ms_' + userSessionEmail;
        if ([3, 7, 14, 30, 60, 100, 200, 365].includes(st) && lsGet(key) !== st + '|' + todayStr()) {
            lsSet(key, st + '|' + todayStr());
            showToast(`${st}-day streak! Keep it going.`, 'success');
            if (st >= 7 && typeof confetti === 'function') confetti();
        }
    }

    /* =========================================================
       8. HABITS
       ========================================================= */
    const HABIT_ICONS = ['fa-check', 'fa-dumbbell', 'fa-book', 'fa-code', 'fa-droplet', 'fa-bed', 'fa-person-running', 'fa-leaf', 'fa-apple-whole', 'fa-pen', 'fa-music', 'fa-sun'];
    const HABIT_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#f43f5e', '#06b6d4', '#8b5cf6'];
    const sendTimers = {};

    function setHabitValue(h, date, value, fromForm) {
        if (date > todayStr()) { showToast(FUTURE_MSG, 'error'); return; }
        S.acts = S.acts.filter(a => !(a.kind === 'HABIT' && a.ref === h.id && a.date === date));
        const done = h.mode === 'count' ? value >= h.target : value > 0;
        if (value > 0) S.acts.push({ id: 'hl_' + h.id + '_' + date, date, kind: 'HABIT', category: 'Habit', type: h.name, title: h.name, value, unit: h.mode === 'count' ? 'count' : '', duration: 0, done: done ? 'yes' : 'no', ref: h.id, meta: {}, notes: '' });
        bump(); renderAll();
        const key = h.id + '|' + date;
        clearTimeout(sendTimers[key]);
        sendTimers[key] = setTimeout(() => sendToSheet({ action: 'habit_toggle', habit_id: h.id, name: h.name, date, value, done: done ? 'yes' : 'no' }), 500);
        if (fromForm) showToast('Habit updated', 'success');
        if (done && date === todayStr()) {
            const hs = activeHabits();
            if (hs.length > 1 && hs.every(x => habitDone(x, date))) { showToast('Every habit done today. Nice work.', 'success'); if (typeof confetti === 'function') confetti(); }
            celebrateStreak();
        }
    }

    L.toggleHabit = (id, date, delta) => {
        const h = habitById(id); if (!h) return;
        const cur = S.logs.get(id + '|' + date);
        if (h.mode === 'count') setHabitValue(h, date, Math.max(0, num(cur && cur.value) + (delta || 1)));
        else setHabitValue(h, date, cur && isDone(cur) ? 0 : 1);
    };

    function renderHabits() {
        const box = $('habit-list'); if (!box) return;
        const t = todayStr(), list = S.habits.filter(h => S.showArchived ? h.active === 'no' : h.active !== 'no');
        $('habit-archive-btn').textContent = S.showArchived ? 'Show active habits' : 'Show archived';
        const hr = habitRate(activeHabits(), addDays(t, -29), t);
        $('habit-summary').textContent = activeHabits().length ? `${activeHabits().filter(h => habitDone(h, t)).length} of ${activeHabits().length} done today${hr.rate === null ? '' : ' · ' + Math.round(hr.rate * 100) + '% over 30 days'}` : 'Small daily actions, tracked and counted in your Life Score';
        if (!list.length) {
            box.innerHTML = `<div class="md:col-span-2 lg:col-span-3 rounded-xl border border-gray-200 dark:border-gray-700 p-8 text-center text-xs text-gray-500 dark:text-gray-400"><div class="text-4xl mb-2"><i class="fas fa-check-double"></i></div>${S.showArchived ? 'No archived habits.' : 'No habits yet. Start with one you can do in under five minutes.'}</div>`;
            return;
        }
        box.innerHTML = list.map(h => {
            const d = habitDone(h, t), log = S.logs.get(h.id + '|' + t), id = esc(h.id), count = h.mode === 'count';
            const r30 = habitRate([h], addDays(t, -29), t), wk = habitWeek(h);
            const sun = sundayOf(t);
            const dots = [0, 1, 2, 3, 4, 5, 6].map(i => {
                const ds = addDays(sun, i), on = habitDone(h, ds), future = ds > t, isToday = ds === t;
                const lbl = fmtDay(ds, { weekday: 'short' });
                const full = fmtDay(ds, { weekday: 'long', day: 'numeric', month: 'short' });
                return `<button type="button" class="hb-dot ${on ? 'is-on' : ''} ${isToday ? 'is-today' : ''}" style="--hc:${esc(h.color)}" ${future ? 'disabled' : `onclick="L.toggleHabit('${id}','${ds}',1)"`} title="${esc(full)}${future ? ' (not yet)' : ''}" aria-label="${esc(full)} ${future ? 'not yet' : on ? 'done' : 'not done'}" aria-pressed="${on}">${lbl}</button>`;
            }).join('');
            const ctrl = count
                ? `<div class="hb-step"><button type="button" aria-label="Decrease" onclick="L.toggleHabit('${id}','${t}',-1)"><i class="fas fa-minus"></i></button><span><b>${fmtN(log ? log.value : 0, 0)}</b>/${h.target}</span><button type="button" aria-label="Increase" onclick="L.toggleHabit('${id}','${t}',1)"><i class="fas fa-plus"></i></button></div>`
                : `<button type="button" class="hb-check ${d ? 'is-done' : ''}" style="--hc:${esc(h.color)}" aria-pressed="${d}" aria-label="Mark ${esc(h.name)} ${d ? 'not done' : 'done'} today" onclick="L.toggleHabit('${id}','${t}',1)"><i class="fas fa-check"></i></button>`;
            return `<div class="rounded-xl border border-gray-200 dark:border-gray-700 p-4 ${h.active === 'no' ? 'opacity-60' : ''}">
                <div class="flex items-center justify-between gap-3">
                    <div class="flex items-center gap-3 min-w-0"><span class="hb-icon" style="--hc:${esc(h.color)}"><i class="fas ${esc(h.icon)}"></i></span>
                        <div class="min-w-0"><div class="font-bold text-sm truncate">${esc(h.name)}</div><div class="text-[11px] text-gray-500 dark:text-gray-400">${count ? 'Target ' + h.target + ' a day' : 'Once a day'} · ${h.per_week} day(s) a week</div></div></div>
                    ${h.active === 'no' ? '' : ctrl}</div>
                <div class="hb-dots mt-3">${dots}</div>
                <div class="grid grid-cols-3 gap-2 mt-3 text-center">
                    <div><div class="text-base font-bold"><i class="fas fa-fire text-orange-500 text-xs"></i> ${habitStreak(h)}</div><div class="text-[10px] text-gray-400">day streak</div></div>
                    <div><div class="text-base font-bold">${wk}/${h.per_week}</div><div class="text-[10px] text-gray-400">this week</div></div>
                    <div><div class="text-base font-bold">${r30.rate === null ? '-' : Math.round(r30.rate * 100) + '%'}</div><div class="text-[10px] text-gray-400">30 days</div></div></div>
                <div class="text-right text-[11px] mt-3"><button onclick="L.openHabit('${id}')" class="text-blue-600 hover:underline">Edit</button> ·
                    <button onclick="L.archiveHabit('${id}')" class="text-amber-600 hover:underline">${h.active === 'no' ? 'Restore' : 'Archive'}</button> ·
                    <button onclick="L.deleteHabit('${id}')" class="text-rose-500 hover:underline">Delete</button></div></div>`;
        }).join('');
    }
    L.toggleArchived = () => { S.showArchived = !S.showArchived; renderHabits(); };

    function paintHabitPickers() {
        $('habit-icons').innerHTML = HABIT_ICONS.map(i => `<button type="button" class="hb-pick ${S.hIcon === i ? 'is-sel' : ''}" aria-label="${i.replace('fa-', '')}" onclick="L.pickIcon('${i}')"><i class="fas ${i}"></i></button>`).join('');
        $('habit-colors').innerHTML = HABIT_COLORS.map(c => `<button type="button" class="hb-swatch ${S.hColor === c ? 'is-sel' : ''}" style="background:${c}" aria-label="Colour ${c}" onclick="L.pickColor('${c}')"></button>`).join('');
    }
    L.pickIcon = (i) => { S.hIcon = i; paintHabitPickers(); };
    L.pickColor = (c) => { S.hColor = c; paintHabitPickers(); };
    L.onHabitMode = () => { $('habit-target-wrap').classList.toggle('hidden', $('habit-mode').value !== 'count'); };

    L.openHabit = (id) => {
        const h = id ? habitById(id) : null;
        $('habit-modal-title').textContent = h ? 'Edit habit' : 'New habit';
        $('habit-id').value = h ? h.id : '';
        $('habit-name').value = h ? h.name : '';
        $('habit-mode').value = h ? h.mode : 'check';
        $('habit-target').value = h ? h.target : 8;
        $('habit-perweek').value = h ? h.per_week : 7;
        S.hIcon = h ? h.icon : 'fa-check'; S.hColor = h ? h.color : '#6366f1';
        paintHabitPickers(); L.onHabitMode();
        openModal('habit-modal'); setTimeout(() => $('habit-name').focus(), 80);
    };

    $('habit-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const name = $('habit-name').value.trim().slice(0, 40);
        if (!name) { showToast('Give the habit a name.', 'error'); return; }
        const id = $('habit-id').value, old = id ? habitById(id) : null;
        const h = normHabit({ id: id || uid('h'), name, icon: S.hIcon, color: S.hColor, mode: $('habit-mode').value, target: parseInt($('habit-target').value) || 1, per_week: parseInt($('habit-perweek').value) || 7, active: old ? old.active : 'yes', created: old ? old.created : todayStr() });
        S.habits = S.habits.filter(x => x.id !== h.id).concat(h);
        bump(); closeModal('habit-modal'); renderAll();
        showToast('Habit saved', 'success');
        sendToSheet({ action: 'habit_save', ...h });
    });

    L.archiveHabit = (id) => {
        const h = habitById(id); if (!h) return;
        h.active = h.active === 'no' ? 'yes' : 'no'; bump(); renderAll();
        showToast(h.active === 'no' ? h.name + ' archived' : h.name + ' restored', 'info');
        sendToSheet({ action: 'habit_save', ...h });
    };
    L.deleteHabit = async (id) => {
        const h = habitById(id); if (!h) return;
        const ok = await showConfirmModal('Delete habit?', `"${h.name}" and all of its history will be removed. Archive it instead to keep the history.`, 'Yes, delete', 'fas fa-trash-alt');
        if (!ok) return;
        S.habits = S.habits.filter(x => x.id !== id);
        S.acts = S.acts.filter(a => !(a.kind === 'HABIT' && a.ref === id));
        bump(); renderAll(); showToast('Habit deleted', 'info');
        sendToSheet({ action: 'habit_delete', id });
    };

    /* =========================================================
       9. QUICK ADD + DATE RESTRICTIONS + SHORTCUTS
       ========================================================= */
    L.quickAdd = () => openModal('quick-modal');
    L.go = (name) => { closeModal('quick-modal'); switchTab(name); };
    L.quick = (what) => {
        closeModal('quick-modal');
        if (what === 'money') openEntryModal(); else if (what === 'activity') L.openActivity(); else L.go('habits');
    };

    function applyMax() {
        const today = todayStr(), ym = today.slice(0, 7);
        const d = $('act-date'); if (d) { d.max = today; if (d.value > today) d.value = today; }
        const m = $('act-filter-month'); if (m) { m.max = ym; if (m.value > ym) m.value = ym; }
    }
    const _rdm = window.refreshDateMaxes;
    window.refreshDateMaxes = function (notify) { _rdm(notify); applyMax(); };

    document.addEventListener('keydown', (e) => {
        const tag = (e.target.tagName || '').toLowerCase();
        if (['input', 'textarea', 'select'].includes(tag) || e.ctrlKey || e.metaKey || e.altKey || $('app-section').classList.contains('hidden')) return;
        if (e.key === 'l' || e.key === 'L') { e.preventDefault(); L.openActivity(); }
        else if (e.key === 'h' || e.key === 'H') { e.preventDefault(); switchTab('habits'); }
        else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); switchTab('life'); }
    });

    /* =========================================================
       10. COMBINED EXPORT (CSV / Excel / PDF) with period selection
       ========================================================= */
    function periodRange(period) {
        const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
        switch (period) {
            case 'this_month': return { from: toYMD(new Date(y, m, 1)), to: toYMD(new Date(y, m + 1, 0)), label: 'This_Month' };
            case 'last_month': return { from: toYMD(new Date(y, m - 1, 1)), to: toYMD(new Date(y, m, 0)), label: 'Last_Month' };
            case 'last_6_months': return { from: toYMD(new Date(y, m - 6, d)), to: toYMD(now), label: 'Last_6_Months' };
            case 'last_year': return { from: toYMD(new Date(y - 1, m, d)), to: toYMD(now), label: 'Last_Year' };
            case 'current_filter':
                if (currentFilterMode === 'month') { const ym = $('filter-month-input').value || todayYM(); return { from: ym + '-01', to: ym + '-' + pad2(daysIn(ym)), label: 'Filtered' }; }
                if (currentFilterMode === 'range') return { from: $('filter-from-date').value || '0000-01-01', to: $('filter-to-date').value || '9999-12-31', label: 'Filtered' };
                return { from: '0000-01-01', to: '9999-12-31', label: 'All_Data' };
            default: return { from: '0000-01-01', to: '9999-12-31', label: 'All_Data' };
        }
    }

    function lifeData(ds, range) {
        const inR = (d) => d >= range.from && d <= range.to;
        const acts = S.acts.filter(a => a.kind !== 'HABIT' && inR(a.date)).sort((a, b) => a.date.localeCompare(b.date));
        const logs = S.acts.filter(a => a.kind === 'HABIT' && inR(a.date)).sort((a, b) => a.date.localeCompare(b.date));
        const txns = ds === 'everything' ? transactions.filter(t => inR(dOf(t))).sort((a, b) => dOf(a).localeCompare(dOf(b))) : [];
        const unified = [];
        txns.forEach(t => unified.push({ Date: dOf(t), Area: 'Money', Category: t.category, Item: t.description || t.type, Details: t.type, 'Amount (₹)': (t.type === 'INCOME' ? 1 : -1) * num(t.amount), Minutes: '' }));
        acts.forEach(a => unified.push({ Date: a.date, Area: DOMAINS[domOf(a)].label, Category: a.category, Item: a.title || a.type, Details: summarize(a), 'Amount (₹)': '', Minutes: a.duration || '' }));
        logs.forEach(a => unified.push({ Date: a.date, Area: 'Habits', Category: 'Habit', Item: a.title, Details: summarize(a), 'Amount (₹)': '', Minutes: '' }));
        unified.sort((a, b) => a.Date.localeCompare(b.Date));
        return { acts, logs, txns, unified };
    }

    const _updCount = window.updateExportCount, _confirmExport = window.confirmExport;
    window.updateExportCount = function () {
        const ds = $('export-dataset') ? $('export-dataset').value : 'money';
        if (ds === 'money') return _updCount();
        const d = lifeData(ds, periodRange($('export-period').value));
        $('export-count').textContent = `${d.unified.length} rows will be exported`;
    };

    window.confirmExport = function () {
        const ds = $('export-dataset') ? $('export-dataset').value : 'money';
        if (ds === 'money') return _confirmExport();
        const range = periodRange($('export-period').value), d = lifeData(ds, range);
        if (!d.unified.length) { showToast('No data available to export for the selected period.', 'error'); return; }
        closeExportModal();
        const user = getActiveUserSession().name || 'User', file = `${user}_LifeOS_${range.label}_${toYMD(new Date())}`;
        if (pendingExportFormat === 'excel') lifeExcel(d, ds, file, range);
        else if (pendingExportFormat === 'pdf') lifePDF(d, file, user);
        else lifeCSV(d.unified, file);
        showToast(`Exported ${d.unified.length} rows`, 'success');
    };

    function lifeCSV(rows, file) {
        const safe = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
        const cols = ['Date', 'Area', 'Category', 'Item', 'Details', 'Amount (₹)', 'Minutes'];
        const lines = [cols.map(safe).join(',')].concat(rows.map(r => cols.map(c => typeof r[c] === 'number' ? r[c] : safe(r[c])).join(',')));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
        a.download = file + '.csv'; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    function lifeExcel(d, ds, file, range) {
        const wb = XLSX.utils.book_new(), add = (name, rows, cols) => { const ws = XLSX.utils.json_to_sheet(rows); ws['!cols'] = cols.map(w => ({ wch: w })); XLSX.utils.book_append_sheet(wb, ws, name); };
        const inc = d.txns.filter(t => t.type === 'INCOME').reduce((s, t) => s + num(t.amount), 0), exp = d.txns.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + num(t.amount), 0);
        const hr = habitRate(activeHabits(), range.from < '2000' ? addDays(todayStr(), -365) : range.from, range.to);
        const summary = [['Life OS summary', ''], ['Period', range.label.replace(/_/g, ' ')], ['Sessions logged', d.acts.length], ['Minutes active', d.acts.reduce((s, a) => s + a.duration, 0)], ['Habit check-ins', d.logs.filter(isDone).length], ['Habit completion', hr.rate === null ? '-' : Math.round(hr.rate * 100) + '%']];
        if (ds === 'everything') summary.push(['Income (₹)', inc], ['Expenses (₹)', exp], ['Savings rate', inc ? Math.round((inc - exp) / inc * 100) + '%' : '-']);
        const sws = XLSX.utils.aoa_to_sheet(summary); sws['!cols'] = [{ wch: 22 }, { wch: 20 }]; XLSX.utils.book_append_sheet(wb, sws, 'Summary');
        add('Life Log', d.unified, [12, 10, 14, 26, 44, 14, 9]);
        add('Activities', d.acts.map(a => ({ Date: a.date, Category: a.category, Type: a.type, Title: a.title, Value: a.value, Unit: a.unit, Minutes: a.duration, Details: summarize(a), Notes: a.notes || '' })), [12, 12, 12, 24, 9, 10, 9, 44, 30]);
        add('Habit Log', d.logs.map(a => ({ Date: a.date, Habit: a.title, Done: isDone(a) ? 'Yes' : 'Partial', Count: a.unit === 'count' ? a.value : '' })), [12, 24, 9, 9]);
        if (ds === 'everything') add('Transactions', d.txns.map(t => ({ Date: dOf(t), Type: t.type, Category: t.category, Description: t.description || '', 'Amount (₹)': num(t.amount) })), [12, 10, 18, 30, 13]);
        XLSX.writeFile(wb, file + '.xlsx');
    }

    function lifePDF(d, file, user) {
        const { jsPDF } = window.jspdf, doc = new jsPDF({ orientation: 'landscape' });
        doc.setFontSize(18); doc.text(`Life OS report - ${user}`, 14, 18);
        doc.setFontSize(10); doc.setTextColor(100);
        doc.text(`Generated ${new Date().toLocaleDateString()} | ${d.acts.length} sessions | ${d.acts.reduce((s, a) => s + a.duration, 0)} active minutes | ${d.logs.filter(isDone).length} habit check-ins`, 14, 25);
        doc.autoTable({
            startY: 31, theme: 'striped', styles: { fontSize: 8 }, headStyles: { fillColor: [99, 102, 241] },
            head: [['Date', 'Area', 'Category', 'Item', 'Details', 'Amount (Rs)']],
            body: d.unified.map(r => [r.Date, r.Area, r.Category, r.Item, r.Details, r['Amount (₹)'] === '' ? '' : Number(r['Amount (₹)']).toFixed(2)]),
            columnStyles: { 0: { cellWidth: 24 }, 1: { cellWidth: 22 }, 2: { cellWidth: 28 }, 3: { cellWidth: 55 }, 4: { cellWidth: 100 }, 5: { cellWidth: 30, halign: 'right' } }
        });
        doc.save(file + '.pdf');
    }

    /* =========================================================
       11. WIRING INTO THE EXISTING APP
       ========================================================= */
    /* ---------- grouped nav: Life | Money | Health | Habits ---------- */
    const TAB_GROUP = { dashboard: 'money', analytics: 'money', smart: 'money', budgets: 'money', goals: 'money', recurring: 'money', activities: 'health', habits: 'habits' };
    const groups = () => document.querySelectorAll('#tab-nav .nav-group');
    function closeGroups(except) {
        groups().forEach(g => {
            if (g === except) return;
            g.classList.remove('open');
            g.querySelector('.nav-group-btn').setAttribute('aria-expanded', 'false');
        });
    }
    function markGroup(name) {
        groups().forEach(g => g.querySelector('.nav-group-btn').classList.toggle('nav-group-active', g.dataset.group === TAB_GROUP[name]));
    }
    document.querySelectorAll('#tab-nav .nav-group-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();                       // keeps the mobile drawer open while a group expands
            const g = btn.closest('.nav-group'), open = !g.classList.contains('open');
            closeGroups(g);
            g.classList.toggle('open', open);
            btn.setAttribute('aria-expanded', String(open));
        });
    });
    // picking an item closes its dropdown; clicking anywhere else or pressing Esc does too
    document.querySelectorAll('#tab-nav .nav-panel').forEach(p => p.addEventListener('click', (e) => { if (e.target.closest('button')) closeGroups(); }));
    document.addEventListener('click', (e) => { if (!e.target.closest('#tab-nav .nav-group')) closeGroups(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGroups(); });

    const _switchTab = window.switchTab;
    window.switchTab = function (name) {
        _switchTab(name);
        markGroup(name);
        closeGroups();
        const tb = $('filter-toolbar');
        if (tb) tb.classList.toggle('hidden', ['goals', 'recurring', 'smart', 'life', 'activities', 'habits'].includes(name));
        if (name === 'life') renderLife();
        if (name === 'activities') renderActivities();
        if (name === 'habits') renderHabits();
    };

    const _refreshAppView = window.refreshAppView;
    window.refreshAppView = function () { _refreshAppView(); bump(); renderAll(); };

    const _onExtrasLoaded = window.onExtrasLoaded;
    window.onExtrasLoaded = function () { if (_onExtrasLoaded) _onExtrasLoaded(); loadLife(); };

    $('logout-btn').addEventListener('click', () => {
        S.acts = []; S.habits = []; S.loaded = false; S.landed = false; S.hmDay = '';
        bump(); lsSet(TOKEN_KEY, null);
        document.querySelectorAll('#life-heatmap').forEach(el => { if (el.parentElement) delete el.parentElement.dataset.scrolled; });
    });
    $('theme-toggle').addEventListener('click', () => setTimeout(() => { if (visible('view-activities')) renderActChart(); }, 60));

    // evening nudge for habits that are still open
    function habitNudgeTick() {
        if (!userSessionEmail || !S.loaded || (EXTRA.settings || {}).habit_nudge === 'no') return;
        const open = activeHabits().filter(h => !habitDone(h, todayStr()));
        if (!open.length) return;
        const [hh, mm] = ((EXTRA.settings || {}).rem_time || '21:00').split(':').map(Number), now = new Date();
        if (now < new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh || 0, mm || 0)) return;
        const key = 'lifeos_nudge_' + userSessionEmail + '_' + todayStr();
        if (lsGet(key)) return;
        lsSet(key, '1');
        const body = open.slice(0, 3).map(h => h.name).join(', ') + (open.length > 3 ? ` and ${open.length - 3} more` : '');
        notify('Life OS: habits still open', body, 'habits').then(ok => { if (!ok) showToast('Habits still open today: ' + body, 'info'); });
    }
    setInterval(habitNudgeTick, 60000);
    if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'notif-click' && e.data.tag === 'habits') switchTab('habits'); });

    bump();
    applyMax();
})();