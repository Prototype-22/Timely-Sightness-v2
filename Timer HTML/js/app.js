/* ═══════════════════════════════════════════════════════
   Timely — Time Tracker · app.js
   ═══════════════════════════════════════════════════════ */

// ── State ────────────────────────────────────────────────
let state = {
  entries: [],       // {id, task, client, transporteur, period, description, start, end}
  clients: [],
  transporteurs: [],
  todos: [],         // {id, text, completed, createdAt}
  timer: {
    running: false,
    startEpoch: null,
    tickInterval: null,
    elapsed: 0,       // ms while paused
  },
  prefs: {
    username: '',
    pfp: null,        // base64 data URL
    theme: 'system',
    timeFormat: 'hhmm',
    dateFormat: 'dmy',
    weekStart: 1,     // 1=Mon, 0=Sun
    countdownDays: [], // array of numbers 0=Sun..6=Sat
    countdownHour: 16,
    countdownMinute: 20,
  },
  calendar: {
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
    selectedDate: null,
  },
  report: {
    filtered: [],
    applied: false,
  },
  editingEntryId: null,
};

// ── Persist ──────────────────────────────────────────────
function save() {
  localStorage.setItem('timely_state', JSON.stringify({
    entries: state.entries,
    clients: state.clients,
    transporteurs: state.transporteurs,
    prefs: state.prefs,
    todos: state.todos,
  }));
}

function load() {
  try {
    const raw = localStorage.getItem('timely_state');
    if (!raw) return;
    const saved = JSON.parse(raw);
    state.entries = (saved.entries || []).map(e => ({
      ...e,
      start: e.start ? new Date(e.start) : null,
      end:   e.end   ? new Date(e.end)   : null,
    }));
    state.clients       = saved.clients       || [];
    state.transporteurs = saved.transporteurs || [];
    state.todos         = saved.todos         || [];
    if (saved.prefs) state.prefs = { ...state.prefs, ...saved.prefs };
  } catch(e) { console.warn('Load failed', e); }
}

// Firebase sync removed


// ── Helpers ──────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

function msToHHMMSS(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function msToDisplay(ms, fmt) {
  fmt = fmt || state.prefs.timeFormat;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (fmt === 'jh') {
    const jh = ms / 3600000 / 8;
    return jh.toFixed(2) + ' JH';
  }
  if (fmt === 'hhdec') {
    const dec = (h + m / 60).toFixed(2);
    return dec + 'h';
  }
  return `${h}h ${pad(m)}m`;
}

function msToJH(ms) {
  const jh = ms / 3600000 / 8;
  return jh.toFixed(2) + ' JH';
}

function formatDate(d, fmt) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  fmt = fmt || state.prefs.dateFormat;
  const day = pad(date.getDate());
  const mon = pad(date.getMonth() + 1);
  const yr  = date.getFullYear();
  if (fmt === 'mdy') return `${mon}/${day}/${yr}`;
  if (fmt === 'ymd') return `${yr}-${mon}-${day}`;
  return `${day}/${mon}/${yr}`;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

// ── Countdown helpers ───────────────────────────────────
function getNextCountdownTarget(days) {
  if (!days || !days.length) return null;
  const now = new Date();
  const targetHour = (state.prefs.countdownHour != null) ? state.prefs.countdownHour : 16;
  const targetMin = (state.prefs.countdownMinute != null) ? state.prefs.countdownMinute : 20;
  // check next 14 days
  for (let i = 0; i < 14; i++) {
    const cand = new Date(now);
    cand.setDate(now.getDate() + i);
    cand.setHours(targetHour, targetMin, 0, 0);
    const dow = cand.getDay(); // 0=Sun
    if (days.includes(dow) && cand > now) return cand;
  }
  return null;
}

function loadCountdownUI() {
  const container = document.getElementById('countdown-days');
  if (!container) return;
  container.innerHTML = '';
  const order = [1,2,3,4,5,6,0]; // Mon..Sun
  const labels = {0:'Sun',1:'Mon',2:'Tue',3:'Wed',4:'Thu',5:'Fri',6:'Sat'};
  order.forEach(d => {
    const id = 'cd-day-' + d;
    const wrapper = document.createElement('label');
    wrapper.style.marginRight = '8px';
    wrapper.style.display = 'inline-flex';
    wrapper.style.alignItems = 'center';
    wrapper.innerHTML = `<input type="checkbox" id="${id}" data-day="${d}" style="margin-right:6px"/> ${labels[d]}`;
    container.appendChild(wrapper);
    const cb = wrapper.querySelector('input');
    if (state.prefs.countdownDays && state.prefs.countdownDays.includes(d)) cb.checked = true;
  });
  // set time input to current prefs
  const timeInput = document.getElementById('countdown-time-input');
  if (timeInput) {
    const hh = pad(state.prefs.countdownHour != null ? state.prefs.countdownHour : 16);
    const mm = pad(state.prefs.countdownMinute != null ? state.prefs.countdownMinute : 20);
    timeInput.value = `${hh}:${mm}`;
  }
  updateCountdown();
  updateCountdownSubtitle();
}

function updateCountdown() {
  const disp = document.getElementById('countdown-display');
  const label = document.getElementById('countdown-next-label');
  const labelEdit = document.getElementById('countdown-next-label-edit');
  if (!disp) return;
  const days = state.prefs.countdownDays || [];
  if (!days.length) {
    disp.textContent = '--:--:--';
    if (label) label.textContent = 'No days selected';
    if (labelEdit) labelEdit.textContent = '';
    updateCountdownSubtitle();
    return;
  }
  const target = getNextCountdownTarget(days);
  if (!target) {
    disp.textContent = '--:--:--';
    if (label) label.textContent = 'No upcoming target';
    if (labelEdit) labelEdit.textContent = '';
    updateCountdownSubtitle();
    return;
  }
  const now = new Date();
  const diff = target - now;
  if (diff <= 0) {
    disp.textContent = '00:00:00';
    const rel = relativeLabelForTarget(target);
    if (label) label.textContent = `${rel} ${pad(target.getHours())}:${pad(target.getMinutes())}`;
    if (labelEdit) labelEdit.textContent = `${rel} ${pad(target.getHours())}:${pad(target.getMinutes())}`;
    updateCountdownSubtitle();
    return;
  }
  disp.textContent = msToHHMMSS(diff);
  const rel = relativeLabelForTarget(target);
  if (label) label.textContent = `${rel} ${pad(target.getHours())}:${pad(target.getMinutes())}`;
  if (labelEdit) labelEdit.textContent = `${rel} ${pad(target.getHours())}:${pad(target.getMinutes())}`;
  updateCountdownSubtitle();
}

function relativeLabelForTarget(target) {
  const now = new Date();
  if (isSameDay(now, target)) return 'Today';
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (isSameDay(tomorrow, target)) return 'Tomorrow';
  return target.toLocaleDateString('default', { weekday: 'long' });
}

function dayLabels(days) {
  if (!days || !days.length) return '';
  const order = [1,2,3,4,5,6,0];
  const names = {0:'Sun',1:'Mon',2:'Tue',3:'Wed',4:'Thu',5:'Fri',6:'Sat'};
  return order.filter(d => days.includes(d)).map(d => names[d]).join(', ');
}

function updateCountdownSubtitle() {
  const el = document.getElementById('countdown-sub');
  if (!el) return;
  const hh = pad(state.prefs.countdownHour != null ? state.prefs.countdownHour : 16);
  const mm = pad(state.prefs.countdownMinute != null ? state.prefs.countdownMinute : 20);
  const days = state.prefs.countdownDays || [];
  if (!days.length) {
    el.textContent = `Countdown to ${hh}:${mm} — no days selected`;
  } else {
    const labels = dayLabels(days);
    el.textContent = `Countdown to ${hh}:${mm} on ${labels}`;
  }
}

function saveCountdownPrefsFromUI() {
  const container = document.getElementById('countdown-days');
  if (!container) return;
  const checkboxes = container.querySelectorAll('input[type="checkbox"]');
  const sel = [];
  checkboxes.forEach(cb => { if (cb.checked) sel.push(parseInt(cb.dataset.day,10)); });
  state.prefs.countdownDays = sel;
  // read time input if present
  const t = document.getElementById('countdown-time-input');
  if (t && t.value) {
    const parts = t.value.split(':');
    const h = parseInt(parts[0],10);
    const m = parseInt(parts[1],10);
    if (!isNaN(h) && !isNaN(m)) {
      state.prefs.countdownHour = h;
      state.prefs.countdownMinute = m;
    }
  }
  save();
  updateCountdown();
  updateCountdownSubtitle();
}

function clearCountdownPrefs() {
  state.prefs.countdownDays = [];
  save();
  loadCountdownUI();
  updateCountdownSubtitle();
}

function startCountdownInterval() {
  if (state.countdownInterval) clearInterval(state.countdownInterval);
  state.countdownInterval = setInterval(updateCountdown, 1000);
}

function enterCountdownEditMode() {
  const view = document.getElementById('countdown-view-mode');
  const edit = document.getElementById('countdown-edit-mode');
  if (view) view.style.display = 'none';
  if (edit) edit.style.display = 'block';
  loadCountdownUI();
}

function exitCountdownEditMode() {
  const view = document.getElementById('countdown-view-mode');
  const edit = document.getElementById('countdown-edit-mode');
  if (view) view.style.display = 'block';
  if (edit) edit.style.display = 'none';
  loadCountdownUI();
  updateCountdown();
}

function startOfWeek(d, startDay) {
  const copy = new Date(d);
  const day = copy.getDay();
  const diff = (day - startDay + 7) % 7;
  copy.setDate(copy.getDate() - diff);
  copy.setHours(0,0,0,0);
  return copy;
}

function entryDuration(e) {
  if (!e.start || !e.end) return 0;
  return new Date(e.end) - new Date(e.start);
}

function totalMs(entries) {
  return entries.reduce((sum, e) => sum + entryDuration(e), 0);
}

function colorForClient(name) {
  const colors = ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#06b6d4','#ec4899'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function todayEntries() {
  const now = new Date();
  return state.entries.filter(e => e.start && isSameDay(new Date(e.start), now));
}

function weekEntries() {
  const sw = startOfWeek(new Date(), state.prefs.weekStart);
  const ew = new Date(sw); ew.setDate(ew.getDate() + 7);
  return state.entries.filter(e => {
    if (!e.start) return false;
    const d = new Date(e.start);
    return d >= sw && d < ew;
  });
}

function monthEntries() {
  const now = new Date();
  return state.entries.filter(e => {
    if (!e.start) return false;
    const d = new Date(e.start);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
}

// ── Render helpers ────────────────────────────────────────
function renderEntryCard(e) {
  const dur = entryDuration(e);
  const color = e.client ? colorForClient(e.client) : 'var(--accent)';
  const meta = [e.client, e.transporteur, e.period].filter(Boolean).join(' · ');
  const card = document.createElement('div');
  card.className = 'entry-card';
  card.dataset.id = e.id;
  card.innerHTML = `
    <div class="entry-color-bar" style="background:${color}"></div>
    <div class="entry-info">
      <div class="entry-task">${e.task || '(no task)'}</div>
      <div class="entry-meta">${formatDate(e.start)} ${meta ? '· ' + meta : ''} ${e.description ? '· ' + e.description : ''}</div>
    </div>
    <div class="entry-duration">${msToDisplay(dur)}</div>
    <div class="entry-jh">${msToJH(dur)}</div>
  `;
  card.addEventListener('click', () => openEditModal(e.id));
  return card;
}

function renderEntriesTo(container, entries) {
  container.innerHTML = '';
  if (!entries.length) {
    container.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>
      <p>No entries here.</p>
    </div>`;
    return;
  }
  entries.slice().reverse().forEach(e => container.appendChild(renderEntryCard(e)));
}

// ── Overview ──────────────────────────────────────────────
function updateOverview() {
  const today = totalMs(todayEntries());
  const week  = totalMs(weekEntries());
  const month = totalMs(monthEntries());

  document.getElementById('stat-today').textContent = msToDisplay(today, 'hhmm');
  document.getElementById('stat-week').textContent  = msToDisplay(week, 'hhmm');
  document.getElementById('stat-month').textContent = msToDisplay(month, 'hhmm');
  document.getElementById('stat-jh').textContent    = msToJH(today);

  const recent = state.entries.slice(-10).reverse();
  renderEntriesTo(document.getElementById('overview-entries'), recent);
}

// ── Timer ─────────────────────────────────────────────────
function getTimerMs() {
  if (state.timer.running) {
    return state.timer.elapsed + (Date.now() - state.timer.startEpoch);
  }
  return state.timer.elapsed;
}

function tickTimer() {
  const ms = getTimerMs();
  const display = document.getElementById('timer-display');
  if (display) display.textContent = msToHHMMSS(ms);
}

function startTimer() {
  state.timer.running = true;
  state.timer.startEpoch = Date.now();
  state.timer.tickInterval = setInterval(tickTimer, 500);
  document.getElementById('timer-display').classList.add('running');
  document.querySelector('.timer-card').classList.add('running');
  const btn = document.getElementById('timer-toggle-btn');
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Stop`;
  btn.classList.remove('btn-primary');
  btn.style.background = '#dc2626';
  btn.style.borderColor = '#dc2626';
  updateTimerClearButtonState();
}

function stopTimer() {
  clearInterval(state.timer.tickInterval);
  const elapsed = state.timer.elapsed + (Date.now() - state.timer.startEpoch);
  state.timer.running = false;
  state.timer.elapsed = 0;
  state.timer.startEpoch = null;

  // Save entry
  const start = new Date(Date.now() - elapsed);
  const end   = new Date();
  const entry = {
    id: uid(),
    task:         document.getElementById('timer-task').value.trim(),
    client:       document.getElementById('timer-client').value,
    transporteur: document.getElementById('timer-transporteur').value,
    period:       document.getElementById('timer-period').value.trim(),
    description:  document.getElementById('timer-description').value.trim(),
    start,
    end,
  };
  state.entries.push(entry);
  save();

  // Reset UI
  document.getElementById('timer-display').textContent = '00:00:00';
  document.getElementById('timer-display').classList.remove('running');
  document.querySelector('.timer-card').classList.remove('running');
  resetTimerBtn();
  updateTimerPage();
  updateOverview();
  updateTimerClearButtonState();
}

function discardTimer() {
  clearInterval(state.timer.tickInterval);
  state.timer.running = false;
  state.timer.elapsed = 0;
  state.timer.startEpoch = null;
  document.getElementById('timer-display').textContent = '00:00:00';
  document.getElementById('timer-display').classList.remove('running');
  document.querySelector('.timer-card').classList.remove('running');
  resetTimerBtn();
  updateTimerClearButtonState();
}

function clearTimerFields() {
  // Only allow clearing when timer is not running
  if (state.timer.running) return;

  // ensure no interval remains
  if (state.timer.tickInterval) clearInterval(state.timer.tickInterval);
  state.timer.elapsed = 0;
  state.timer.startEpoch = null;

  // Clear input fields
  const ids = ['timer-task','timer-client','timer-transporteur','timer-period','timer-description'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = '';
  });

  // Reset display/UI
  const display = document.getElementById('timer-display');
  if (display) display.textContent = '00:00:00';
  display && display.classList.remove('running');
  const card = document.querySelector('.timer-card');
  if (card) card.classList.remove('running');
  resetTimerBtn();
  updateTimerPage();
  updateTimerClearButtonState();
}

function resetTimerBtn() {
  const btn = document.getElementById('timer-toggle-btn');
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start`;
  btn.classList.add('btn-primary');
  btn.style.background = '';
  btn.style.borderColor = '';
}

function updateTimerClearButtonState() {
  const b = document.getElementById('timer-clear-btn');
  if (!b) return;
  if (state.timer.running) {
    b.disabled = true;
    b.title = 'Stop the timer to clear fields';
  } else {
    b.disabled = false;
    b.title = 'Clear all timer fields';
  }
}

function updateTimerPage() {
  renderEntriesTo(document.getElementById('timer-entries'), todayEntries());
}

function updateManualPage() {
  renderEntriesTo(document.getElementById('manual-entries'), todayEntries());
  // Default manual start/end to today's date/time when empty
  const startEl = document.getElementById('manual-start');
  const endEl = document.getElementById('manual-end');
  const now = new Date();
  if (startEl && !startEl.value) startEl.value = toDatetimeLocal(now);
  if (endEl && !endEl.value) {
    const later = new Date(now);
    later.setHours(later.getHours() + 1);
    endEl.value = toDatetimeLocal(later);
  }
}

// ── Todos ───────────────────────────────────────────────
function renderTodoItem(t) {
  const div = document.createElement('div');
  div.className = 'entry-card';
  div.dataset.id = t.id;
  div.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex:1">
      <input type="checkbox" class="todo-toggle" data-id="${t.id}" ${t.completed ? 'checked' : ''} />
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(t.text)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${new Date(t.createdAt).toLocaleString()}</div>
      </div>
    </div>
    <div style="flex-shrink:0">
      <button class="btn btn-ghost btn-sm todo-delete" data-id="${t.id}" title="Delete" style="color:var(--color-danger)">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
      </button>
    </div>
  `;
  return div;
}

function updateTodosPage() {
  const container = document.getElementById('todo-list');
  if (!container) return;
  container.innerHTML = '';
  if (!state.todos.length) {
    container.innerHTML = `<div class="empty-state"><p>No todos yet.</p></div>`;
    return;
  }
  state.todos.slice().reverse().forEach(t => container.appendChild(renderTodoItem(t)));
}

function addTodo() {
  const v = document.getElementById('todo-input').value.trim();
  if (!v) return;
  const todo = { id: uid(), text: v, completed: false, createdAt: Date.now() };
  state.todos.push(todo);
  save();
  document.getElementById('todo-input').value = '';
  updateTodosPage();
}

function toggleTodo(id, checked) {
  const idx = state.todos.findIndex(t => t.id === id);
  if (idx === -1) return;
  state.todos[idx].completed = !!checked;
  save();
  updateTodosPage();
}

function deleteTodo(id) {
  state.todos = state.todos.filter(t => t.id !== id);
  save();
  updateTodosPage();
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Calendar ──────────────────────────────────────────────
function buildCalendar() {
  const { year, month, selectedDate } = state.calendar;
  const wsDay = state.prefs.weekStart;
  const today = new Date();

  // month label
  document.getElementById('calendar-month-label').textContent =
    new Date(year, month, 1).toLocaleString('default', { month: 'long', year: 'numeric' });

  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';

  // Day names row
  const dayNames = wsDay === 1
    ? ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
    : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  const headerRow = document.createElement('div');
  headerRow.className = 'cal-header-row';
  dayNames.forEach(d => {
    const cell = document.createElement('div');
    cell.className = 'cal-day-name';
    cell.textContent = d;
    headerRow.appendChild(cell);
  });
  grid.appendChild(headerRow);

  // Body
  const body = document.createElement('div');
  body.className = 'cal-body';

  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth  = new Date(year, month + 1, 0);

  // Days to prepend from prev month
  let startDow = firstOfMonth.getDay(); // 0=Sun
  let pad = (startDow - wsDay + 7) % 7;

  const firstCell = new Date(firstOfMonth);
  firstCell.setDate(firstCell.getDate() - pad);

  // Always show 6 weeks = 42 cells
  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(firstCell);
    cellDate.setDate(cellDate.getDate() + i);

    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    if (cellDate.getMonth() !== month) cell.classList.add('other-month');
    if (isSameDay(cellDate, today)) cell.classList.add('today');
    if (selectedDate && isSameDay(cellDate, selectedDate)) cell.classList.add('selected');

    const num = document.createElement('div');
    num.className = 'cal-num';
    num.textContent = cellDate.getDate();
    cell.appendChild(num);

    // dots for entries
    const dayMs = new Date(cellDate); dayMs.setHours(0,0,0,0);
    const dayEnd = new Date(dayMs); dayEnd.setDate(dayEnd.getDate() + 1);
    const dayEntries = state.entries.filter(e => {
      if (!e.start) return false;
      const s = new Date(e.start);
      return s >= dayMs && s < dayEnd;
    });

    if (dayEntries.length) {
      const dots = document.createElement('div');
      dots.className = 'cal-dot-row';
      const max = Math.min(dayEntries.length, 4);
      for (let j = 0; j < max; j++) {
        const dot = document.createElement('div');
        dot.className = 'cal-dot';
        const client = dayEntries[j].client;
        if (client) dot.style.background = colorForClient(client);
        dots.appendChild(dot);
      }
      cell.appendChild(dots);
    }

    const cd = new Date(cellDate);
    cell.addEventListener('click', () => {
      state.calendar.selectedDate = cd;
      buildCalendar();
      showCalDayDetail(cd);
    });

    body.appendChild(cell);
  }

  grid.appendChild(body);

  if (selectedDate) showCalDayDetail(selectedDate);
}

function showCalDayDetail(date) {
  document.getElementById('cal-detail-title').textContent =
    date.toLocaleDateString('default', { weekday: 'long', day: 'numeric', month: 'long' });

  const dayMs = new Date(date); dayMs.setHours(0,0,0,0);
  const dayEnd = new Date(dayMs); dayEnd.setDate(dayEnd.getDate() + 1);
  const entries = state.entries.filter(e => {
    if (!e.start) return false;
    const s = new Date(e.start);
    return s >= dayMs && s < dayEnd;
  });

  renderEntriesTo(document.getElementById('cal-day-entries'), entries);
}

// ── Report ────────────────────────────────────────────────
function applyReportFilter() {
  const from = document.getElementById('report-from').value;
  const to   = document.getElementById('report-to').value;
  const client = document.getElementById('report-client').value;
  const trans  = document.getElementById('report-transporteur').value;

  let filtered = state.entries.filter(e => e.start && e.end);

  if (from) {
    const f = new Date(from); f.setHours(0,0,0,0);
    filtered = filtered.filter(e => new Date(e.start) >= f);
  }
  if (to) {
    const t = new Date(to); t.setHours(23,59,59,999);
    filtered = filtered.filter(e => new Date(e.start) <= t);
  }
  if (client) filtered = filtered.filter(e => e.client === client);
  if (trans)  filtered = filtered.filter(e => e.transporteur === trans);

  // Apply sorting if configured
  state.report.filtered = sortReportEntries(filtered);
  state.report.applied = true;
  renderReport(state.report.filtered);
}

function sortReportEntries(entries) {
  if (!entries || !entries.slice) return entries;
  const sort = state.report.sort || { field: 'start', dir: 'desc' };
  const dir = sort.dir === 'asc' ? 1 : -1;
  const cmp = (a, b) => {
    if (sort.field === 'duration') {
      const va = entryDuration(a);
      const vb = entryDuration(b);
      return (va - vb) * dir;
    }
    if (sort.field === 'client') {
      const va = (a.client || '').toLowerCase();
      const vb = (b.client || '').toLowerCase();
      return va < vb ? -1 * dir : va > vb ? 1 * dir : 0;
    }
    if (sort.field === 'task') {
      const va = (a.task || '').toLowerCase();
      const vb = (b.task || '').toLowerCase();
      return va < vb ? -1 * dir : va > vb ? 1 * dir : 0;
    }
    // default: sort by start timestamp
    const sa = a.start ? new Date(a.start).getTime() : 0;
    const sb = b.start ? new Date(b.start).getTime() : 0;
    return (sa - sb) * dir;
  };
  return entries.slice().sort(cmp);
}

function setReportSortUI() {
  const sel = document.getElementById('report-sort-field');
  const dirBtn = document.getElementById('report-sort-dir');
  if (!state.report.sort) state.report.sort = { field: 'start', dir: 'desc' };
  if (sel) sel.value = state.report.sort.field || 'start';
  if (dirBtn) dirBtn.textContent = state.report.sort.dir === 'asc' ? '▴' : '▾';
}

// helpers for report range presets
function dateToInput(d) {
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function setReportRange(preset) {
  const now = new Date();
  let from = null, to = null;
  if (preset === 'this_week') {
    const sw = startOfWeek(now, state.prefs.weekStart);
    from = sw;
    to = new Date(sw); to.setDate(to.getDate() + 6);
  } else if (preset === 'last_week') {
    const sw = startOfWeek(now, state.prefs.weekStart);
    sw.setDate(sw.getDate() - 7);
    from = sw;
    to = new Date(sw); to.setDate(to.getDate() + 6);
  } else if (preset === 'this_month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  } else if (preset === 'this_year') {
    from = new Date(now.getFullYear(), 0, 1);
    to = new Date(now.getFullYear(), 11, 31);
  } else {
    // custom — do not change dates
    return;
  }

  document.getElementById('report-from').value = dateToInput(from);
  document.getElementById('report-to').value   = dateToInput(to);
  // Do not auto-apply the filter when changing the preset range.
  // The user must click the Apply button to update the report.
}

function renderReport(entries) {
  const total = totalMs(entries);
  document.getElementById('rep-total-h').textContent = msToDisplay(total, 'hhmm');
  document.getElementById('rep-total-jh').textContent = msToJH(total);
  document.getElementById('rep-entries').textContent = entries.length;
  const uniqueClients = new Set(entries.map(e => e.client).filter(Boolean));
  document.getElementById('rep-clients').textContent = uniqueClients.size;

  const tbody = document.getElementById('report-tbody');
  tbody.innerHTML = '';

  // Group entries by client · transporteur · task · period
  const groups = new Map();
  const keyFor = e => `${e.client||''}|||${e.transporteur||''}|||${e.task||''}|||${e.period||''}`;

  entries.slice().reverse().forEach(e => {
    const key = keyFor(e);
    if (!groups.has(key)) groups.set(key, { entries: [], total: 0 });
    const g = groups.get(key);
    g.entries.push(e);
    g.total += entryDuration(e);
  });

  groups.forEach((g, key) => {
    // If only one entry in this group, render it as a normal single row.
    if (g.entries.length <= 1) {
      const e = g.entries[0];
      const dur = entryDuration(e);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formatDate(e.start)}</td>
        <td>${e.client || '—'}</td>
        <td>${e.transporteur || '—'}</td>
        <td>${e.task || '—'}</td>
        <td>${e.period || '—'}</td>
        <td>${msToDisplay(dur, 'hhmm')}</td>
        <td>${msToJH(dur)}</td>
        <td style="text-align:right">
            <button class="btn btn-ghost btn-sm row-edit" data-id="${e.id}" title="Edit entry" style="margin-right:8px">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 17.25V21h3.75L21 6.75 17.25 3 3 17.25z"/></svg>
            </button>
            <button class="btn btn-ghost btn-sm row-duplicate" data-id="${e.id}" title="Duplicate entry" style="margin-right:8px">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7h9v9H3z"/><path d="M11 3h9v9h-9z"/></svg>
            </button>
            <button class="btn btn-ghost btn-sm row-delete" data-id="${e.id}" title="Delete entry" style="color:var(--color-danger)">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
        </td>
      `;
      tbody.appendChild(tr);
      return;
    }

    const first = g.entries[0];
    const summaryTr = document.createElement('tr');
    summaryTr.className = 'group-summary';
    summaryTr.dataset.group = key;
    summaryTr.innerHTML = `
      <td>
        <button class="group-toggle" data-group="${key}" aria-expanded="false">▸</button>
        ${formatDate(first.start)}
      </td>
      <td>${first.client || '—'}</td>
      <td>${first.transporteur || '—'}</td>
      <td>${first.task || '—'}</td>
      <td>${first.period || '—'}</td>
      <td>${msToDisplay(g.total, 'hhmm')}</td>
      <td>${msToJH(g.total)}</td>
      <td style="text-align:right">
        <button class="btn btn-ghost btn-sm group-delete" data-group="${key}" title="Delete group" style="color:var(--color-danger)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>
      </td>
    `;
    tbody.appendChild(summaryTr);

    // child rows (individual entries) — hidden by default
    g.entries.forEach(e => {
      const dur = entryDuration(e);
      const tr = document.createElement('tr');
      tr.className = 'group-child';
      tr.dataset.parentGroup = key;
      tr.style.display = 'none';
      tr.innerHTML = `
        <td>${formatDate(e.start)} ${e.start ? ' ' + toTimeString(e.start) : ''} - ${e.end ? toTimeString(e.end) : ''}</td>
        <td>${e.client || '—'}</td>
        <td>${e.transporteur || '—'}</td>
        <td>${e.task || '—'}</td>
        <td>${e.period || '—'}</td>
        <td>${msToDisplay(dur, 'hhmm')}</td>
        <td>${msToJH(dur)}</td>
        <td style="text-align:right">
          <button class="btn btn-ghost btn-sm row-edit" data-id="${e.id}" title="Edit entry" style="margin-right:8px">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 17.25V21h3.75L21 6.75 17.25 3 3 17.25z"/></svg>
          </button>
          <button class="btn btn-ghost btn-sm row-duplicate" data-id="${e.id}" title="Duplicate entry" style="margin-right:8px">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7h9v9H3z"/><path d="M11 3h9v9h-9z"/></svg>
          </button>
          <button class="btn btn-ghost btn-sm row-delete" data-id="${e.id}" title="Delete entry" style="color:var(--color-danger)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  });
}

// helper: time string HH:MM for a Date or date-like
function toTimeString(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function deleteGroupByKey(key) {
  if (!confirm('Delete all entries in this group?')) return;
  const parts = key.split('|||');
  const [client, transporteur, task, period] = parts.map(p => p || '');
  state.entries = state.entries.filter(e => {
    const mClient = e.client || '';
    const mTrans  = e.transporteur || '';
    const mTask   = e.task || '';
    const mPeriod = e.period || '';
    return !(mClient === client && mTrans === transporteur && mTask === task && mPeriod === period);
  });
  save();
  applyReportFilter();
  refreshAll();
}

function deleteEntryById(id) {
  if (!confirm('Delete this entry?')) return;
  state.entries = state.entries.filter(e => e.id !== id);
  save();
  applyReportFilter();
  refreshAll();
}

function duplicateEntryById(id) {
  const orig = state.entries.find(e => e.id === id);
  if (!orig) return;
  // compute duration if present
  const dur = orig.start && orig.end ? (new Date(orig.end) - new Date(orig.start)) : 0;
  const now = new Date();
  const newEntry = {
    id: uid(),
    task: orig.task,
    client: orig.client,
    transporteur: orig.transporteur,
    period: orig.period,
    description: orig.description,
    start: new Date(now),
    end: new Date(now.getTime() + dur),
  };
  state.entries.push(newEntry);
  save();
  applyReportFilter();
  refreshAll();
}

function deleteAllEntries() {
  if (!confirm('Delete ALL entries? This cannot be undone.')) return;
  state.entries = [];
  save();
  applyReportFilter();
  refreshAll();
}

// ── Export ────────────────────────────────────────────────
function exportCSV() {
  const entries = state.report.applied ? state.report.filtered : state.entries;
  const rows = [['Date','Client','Transporteur','Task','Period','Description','Duration (h)','JH']];
  entries.forEach(e => {
    const dur = entryDuration(e);
    rows.push([
      formatDate(e.start),
      e.client || '',
      e.transporteur || '',
      e.task || '',
      e.period || '',
      e.description || '',
      (dur / 3600000).toFixed(4),
      (dur / 3600000 / 8).toFixed(4),
    ]);
  });
    const csv = '\uFEFF' + rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
    const filename = `${exportTimestamp()}.csv`;
    downloadFile(csv, filename, 'text/csv;charset=utf-8');
}

function exportXLSX() {
    const entries = state.report.applied ? state.report.filtered : state.entries;
    const individualRows = getExportRows();
    const groupedRows = getGroupedExportRows(entries);
    const filename = `${exportTimestamp()}.xlsx`;
    if (typeof XLSX === 'undefined') {
      // Fallback to CSV with both sections concatenated
      const csvInd = '\uFEFF' + individualRows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
      const csvGrp = groupedRows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\r\n');
      const csv = csvInd + '\r\n\r\n' + 'Grouped Summary\r\n' + csvGrp;
      downloadFile(csv, `${exportTimestamp()}.csv`, 'text/csv;charset=utf-8');
      return;
    }
    const ws1 = XLSX.utils.aoa_to_sheet(individualRows);
    const ws2 = XLSX.utils.aoa_to_sheet(groupedRows);
    ws1['!cols'] = [
      { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 18 }, { wch: 12 }, { wch: 28 }, { wch: 13 }, { wch: 10 }, { wch: 10 }, { wch: 8 }
    ];
    ws2['!cols'] = [ { wch: 18 }, { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 8 }, { wch: 13 }, { wch: 10 } ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, 'Individual Entries');
    XLSX.utils.book_append_sheet(wb, ws2, 'Grouped Summary');
    XLSX.writeFile(wb, filename);
}

function getGroupedExportRows(entries) {
  const rows = [["Client","Transporteur","Task","Period","Count","Duration (h)","JH"]];
  const groups = new Map();
  const keyFor = e => `${e.client||''}|||${e.transporteur||''}|||${e.task||''}|||${e.period||''}`;
  entries.forEach(e => {
    const key = keyFor(e);
    if (!groups.has(key)) groups.set(key, { entries: [], total: 0 });
    const g = groups.get(key);
    g.entries.push(e);
    g.total += entryDuration(e);
  });
  groups.forEach((g, key) => {
    const parts = key.split('|||');
    const client = parts[0] || '';
    const transporteur = parts[1] || '';
    const task = parts[2] || '';
    const period = parts[3] || '';
    const durH = (g.total / 3600000);
    const jh = durH / 8;
    rows.push([client, transporteur, task, period, g.entries.length, parseFloat(durH.toFixed(4)), parseFloat(jh.toFixed(4))]);
  });
  return rows;
}

  function exportTimestamp() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `timely_${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  }

  function getExportRows() {
    const entries = state.report.applied ? state.report.filtered : state.entries;
    const rows = [["Date","Start","End","Client","Transporteur","Task","Period","Description","Duration (h)","JH"]];
    const pad = n => String(n).padStart(2, '0');
    const fmtTime = d => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
    entries.forEach(e => {
      const s = e.start ? new Date(e.start) : null;
      const t = e.end ? new Date(e.end) : null;
      const dur = (s && t) ? ((t - s) / 3600000) : 0;
      rows.push([
        formatDate(s),
        fmtTime(s),
        fmtTime(t),
        e.client || '',
        e.transporteur || '',
        e.task || '',
        e.period || '',
        e.description || '',
        parseFloat(dur.toFixed(4)),
        parseFloat((dur / 8).toFixed(4)),
      ]);
    });
    return rows;
  }
function downloadFile(content, filename, mime) {
  const a = document.createElement('a');
  const blob = new Blob([content], { type: mime });
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Edit modal ────────────────────────────────────────────
function openEditModal(id) {
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  state.editingEntryId = id;

  populateSelect('edit-client', state.clients, e.client);
  populateSelect('edit-transporteur', state.transporteurs, e.transporteur);

  document.getElementById('edit-task').value = e.task || '';
  document.getElementById('edit-period').value = e.period || '';
  document.getElementById('edit-description').value = e.description || '';
  document.getElementById('edit-start').value = toDatetimeLocal(new Date(e.start));
  document.getElementById('edit-end').value   = e.end ? toDatetimeLocal(new Date(e.end)) : '';

  document.getElementById('edit-modal-backdrop').style.display = 'flex';
}

function toDatetimeLocal(d) {
  if (!d) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function closeEditModal() {
  document.getElementById('edit-modal-backdrop').style.display = 'none';
  state.editingEntryId = null;
}

function saveEdit() {
  const id = state.editingEntryId;
  const idx = state.entries.findIndex(x => x.id === id);
  if (idx === -1) return;
  state.entries[idx] = {
    ...state.entries[idx],
    client:       document.getElementById('edit-client').value,
    transporteur: document.getElementById('edit-transporteur').value,
    task:         document.getElementById('edit-task').value.trim(),
    period:       document.getElementById('edit-period').value.trim(),
    description:  document.getElementById('edit-description').value.trim(),
    start:        new Date(document.getElementById('edit-start').value),
    end:          new Date(document.getElementById('edit-end').value),
  };
  save();
  closeEditModal();
  refreshAll();
}

function saveManualEntry() {
  const startStr = document.getElementById('manual-start').value;
  const endStr   = document.getElementById('manual-end').value;
  if (!startStr || !endStr) {
    alert('Please provide both start and end times.');
    return;
  }
  const start = new Date(startStr);
  const end   = new Date(endStr);
  if (isNaN(start) || isNaN(end) || end <= start) {
    alert('End time must be after start time.');
    return;
  }

  const entry = {
    id: uid(),
    task:         document.getElementById('manual-task').value.trim(),
    client:       document.getElementById('manual-client').value,
    transporteur: document.getElementById('manual-transporteur').value,
    period:       document.getElementById('manual-period').value.trim(),
    description:  document.getElementById('manual-description').value.trim(),
    start,
    end,
  };
  state.entries.push(entry);
  save();
  // clear inputs
  ['manual-start','manual-end','manual-task','manual-period','manual-description'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  populateDropdowns();
  updateManualPage();
  updateOverview();
  navigate('manual');
}

function clearManualFields() {
  const startEl = document.getElementById('manual-start');
  const endEl = document.getElementById('manual-end');
  const now = new Date();
  if (startEl) startEl.value = toDatetimeLocal(now);
  if (endEl) { const later = new Date(now); later.setHours(later.getHours() + 1); endEl.value = toDatetimeLocal(later); }
  const ids = ['manual-client','manual-transporteur','manual-task','manual-period','manual-description'];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  updateManualPage();
}

function deleteEntry() {
  const id = state.editingEntryId;
  if (!id) return;
  if (!confirm('Delete this entry?')) return;
  state.entries = state.entries.filter(e => e.id !== id);
  save();
  closeEditModal();
  refreshAll();
}

// ── Settings ──────────────────────────────────────────────
function loadSettingsUI() {
  document.getElementById('settings-username').value = state.prefs.username;
  updateAvatarUI();
  setSegment('theme-control',      state.prefs.theme);
  setSegment('format-control',     state.prefs.timeFormat);
  setSegment('dateformat-control', state.prefs.dateFormat);
  setSegment('weekstart-control',  String(state.prefs.weekStart));
  renderTags('clients-list',       state.clients, 'client');
  renderTags('transporteurs-list', state.transporteurs, 'transporteur');
  renderMenuSettingsUI();
}

function saveSettings() {
  state.prefs.username    = document.getElementById('settings-username').value.trim();
  state.prefs.theme       = getSegment('theme-control');
  state.prefs.timeFormat  = getSegment('format-control');
  state.prefs.dateFormat  = getSegment('dateformat-control');
  state.prefs.weekStart   = parseInt(getSegment('weekstart-control'));
  // Save menu settings from UI into prefs
  saveMenuSettingsFromUI();
  applyTheme();
  updateProfileUI();
  save();

  // Apply any menu changes immediately
  applyMenuFromPrefs();

  const fb = document.getElementById('save-feedback');
  fb.textContent = 'Saved!';
  fb.classList.add('visible');
  setTimeout(() => fb.classList.remove('visible'), 2000);
}

function applyTheme() {
  document.body.dataset.theme = state.prefs.theme;
}

function setSegment(id, value) {
  const ctrl = document.getElementById(id);
  if (!ctrl) return;
  ctrl.querySelectorAll('.seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === value);
  });
}

function getSegment(id) {
  const ctrl = document.getElementById(id);
  if (!ctrl) return '';
  const active = ctrl.querySelector('.seg-btn.active');
  return active ? active.dataset.value : '';
}

function renderTags(containerId, items, type) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  items.forEach(item => {
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.innerHTML = `${item} <button class="tag-remove" data-type="${type}" data-value="${item}" title="Remove">×</button>`;
    container.appendChild(tag);
  });
}

// ── Main menu settings ─────────────────────────────────
const DEFAULT_MENU = [
  { page: 'overview', label: 'Overview', visible: true },
  { page: 'timer',    label: 'Timer',    visible: true },
  { page: 'countdown',label: 'Countdown',visible: true },
  { page: 'manual',   label: 'Manual',   visible: true },
  { page: 'calendar', label: 'Calendar', visible: true },
  { page: 'report',   label: 'Report',   visible: true },
  { page: 'todos', label: 'ToDos', visible: true },
];

function getMenuPrefs() {
  return (state.prefs.menu && Array.isArray(state.prefs.menu)) ? state.prefs.menu : DEFAULT_MENU.slice();
}

function applyMenuFromPrefs() {
  const menu = getMenuPrefs();
  const nav = document.querySelector('.sidebar-nav');
  if (!nav) return;
  // append in order and set visibility
  const pagesSeen = new Set();
  menu.forEach(it => {
    const el = nav.querySelector(`.nav-item[data-page="${it.page}"]`);
    if (el) {
      el.style.display = it.visible === false ? 'none' : '';
      nav.appendChild(el);
      pagesSeen.add(it.page);
    }
  });
  // hide any remaining nav items not in menu
  nav.querySelectorAll('.nav-item[data-page]').forEach(el => {
    const p = el.dataset.page;
    if (!pagesSeen.has(p)) el.style.display = 'none';
  });
}

function renderMenuSettingsUI() {
  const container = document.getElementById('menu-settings-list');
  if (!container) return;
  const menu = getMenuPrefs();
  container.innerHTML = '';
  menu.forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'menu-setting-item';
    row.dataset.page = it.page;
    row.innerHTML = `
      <input type="checkbox" class="menu-visible" ${it.visible ? 'checked' : ''} />
      <div class="label">${it.label}</div>
      <div class="controls">
        <button class="btn btn-ghost btn-ico menu-up" title="Move up">▲</button>
        <button class="btn btn-ghost btn-ico menu-down" title="Move down">▼</button>
      </div>
    `;
    container.appendChild(row);
  });
}

function saveMenuSettingsFromUI() {
  const container = document.getElementById('menu-settings-list');
  if (!container) return;
  const items = Array.from(container.children).map(row => {
    return { page: row.dataset.page, label: row.querySelector('.label').textContent.trim(), visible: !!row.querySelector('.menu-visible').checked };
  });
  state.prefs.menu = items;
}

function moveMenuRow(row, dir) {
  const container = row.parentElement;
  if (!container) return;
  if (dir === 'up' && row.previousElementSibling) container.insertBefore(row, row.previousElementSibling);
  if (dir === 'down' && row.nextElementSibling) container.insertBefore(row.nextElementSibling, row);
}


function removeTag(type, value) {
  if (type === 'client') {
    state.clients = state.clients.filter(c => c !== value);
    renderTags('clients-list', state.clients, 'client');
  } else {
    state.transporteurs = state.transporteurs.filter(t => t !== value);
    renderTags('transporteurs-list', state.transporteurs, 'transporteur');
  }
  save();
  populateDropdowns();
}

function addClient() {
  const v = document.getElementById('add-client-input').value.trim();
  if (v && !state.clients.includes(v)) {
    state.clients.push(v);
    document.getElementById('add-client-input').value = '';
    renderTags('clients-list', state.clients, 'client');
    save();
    populateDropdowns();
  }
}

function addTransporteur() {
  const v = document.getElementById('add-transporteur-input').value.trim();
  if (v && !state.transporteurs.includes(v)) {
    state.transporteurs.push(v);
    document.getElementById('add-transporteur-input').value = '';
    renderTags('transporteurs-list', state.transporteurs, 'transporteur');
    save();
    populateDropdowns();
  }
}

function populateSelect(id, items, selected) {
  const sel = document.getElementById(id);
  sel.innerHTML = '<option value="">—</option>';
  items.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item;
    opt.textContent = item;
    if (item === selected) opt.selected = true;
    sel.appendChild(opt);
  });
}

function populateDropdowns() {
  populateSelect('timer-client',       state.clients, '');
  populateSelect('timer-transporteur', state.transporteurs, '');
  populateSelect('manual-client',      state.clients, '');
  populateSelect('manual-transporteur',state.transporteurs, '');
  populateSelect('report-client',      state.clients, '');
  populateSelect('report-transporteur', state.transporteurs, '');
  // Prepend "all" option for report
  ['report-client','report-transporteur'].forEach(id => {
    const sel = document.getElementById(id);
    if (sel) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = 'All';
      sel.prepend(opt);
    }
  });
  // also populate task suggestions datalist and wire autofill
  populateTaskSuggestions();
}

function populateTaskSuggestions() {
  // gather unique tasks
  const tasks = Array.from(new Set(state.entries.map(e => (e.task || '').trim()).filter(Boolean)));
  let dl = document.getElementById('task-suggestions');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'task-suggestions';
    document.body.appendChild(dl);
  }
  dl.innerHTML = '';
  tasks.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    dl.appendChild(opt);
  });

  // attach datalist to task inputs and wire change handler for autofill
  ['timer-task','manual-task','edit-task'].forEach(id => {
    const inp = document.getElementById(id);
    if (!inp) return;
    inp.setAttribute('list', 'task-suggestions');
    // when user selects a suggestion (change), attempt to autofill other fields
    inp.removeEventListener('change', onTaskChange);
    inp.addEventListener('change', onTaskChange);
  });
}

function onTaskChange(e) {
  const val = (e.target.value || '').trim();
  if (!val) return;
  autofillFromTask(val, e.target.id);
}

function autofillFromTask(task, sourceInputId) {
  // find most recent entry matching task
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const e = state.entries[i];
    if ((e.task || '').trim() === task) {
      // map target fields depending on source
      const map = {
        'timer-task': {client: 'timer-client', transporteur: 'timer-transporteur', period: 'timer-period', description: 'timer-description'},
        'manual-task': {client: 'manual-client', transporteur: 'manual-transporteur', period: 'manual-period', description: 'manual-description'},
        'edit-task':   {client: 'edit-client', transporteur: 'edit-transporteur', period: 'edit-period', description: 'edit-description'},
      };
      const targets = map[sourceInputId] || map['timer-task'];
      // only set if empty
      if (targets.client) fillSelectIfEmpty(targets.client, e.client);
      if (targets.transporteur) fillSelectIfEmpty(targets.transporteur, e.transporteur);
      if (targets.period) fillIfEmpty(targets.period, e.period);
      if (targets.description) fillIfEmpty(targets.description, e.description);
      break;
    }
  }
}

function fillIfEmpty(id, value) {
  if (!value) return;
  const el = document.getElementById(id);
  if (!el) return;
  if (!el.value || String(el.value).trim() === '') el.value = value;
}

function fillSelectIfEmpty(id, value) {
  if (!value) return;
  const sel = document.getElementById(id);
  if (!sel) return;
  if (!sel.value || String(sel.value).trim() === '') {
    // if option exists, select it; otherwise add it
    let opt = Array.from(sel.options).find(o => o.value === value);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = value; opt.textContent = value;
      sel.appendChild(opt);
    }
    sel.value = value;
  }
}

function updateProfileUI() {
  const name = state.prefs.username || '?';
  const initials = name.split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase() || '?';

  ['profile-avatar-sidebar', 'settings-avatar'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (state.prefs.pfp) {
      el.innerHTML = `<img src="${state.prefs.pfp}" alt="pfp" />`;
    } else {
      el.textContent = initials;
    }
  });

  document.getElementById('profile-name-sidebar').textContent = state.prefs.username || 'Your Name';
}

function updateAvatarUI() {
  const el = document.getElementById('settings-avatar');
  if (!el) return;
  const name = state.prefs.username || '?';
  const initials = name.split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase() || '?';
  if (state.prefs.pfp) {
    el.innerHTML = `<img src="${state.prefs.pfp}" alt="pfp" />`;
  } else {
    el.textContent = initials;
  }
}

// ── Report defaults ───────────────────────────────────────
function setReportDefaults() {
  // Default the report to the current week and apply the filter so the
  // Report page shows this week's entries immediately when opened.
  setReportRange('this_week');
  const sel = document.getElementById('report-range');
  if (sel) sel.value = 'this_week';
  // Apply the filter to render the report straight away.
  applyReportFilter();
}

// ── Navigation ────────────────────────────────────────────
function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');
  document.querySelectorAll(`[data-page="${page}"]`).forEach(n => n.classList.add('active'));

  if (page === 'overview') updateOverview();
  if (page === 'timer')    updateTimerPage();
  if (page === 'manual')   updateManualPage();
  if (page === 'todos')    updateTodosPage();
  if (page === 'calendar') buildCalendar();
  if (page === 'countdown') { loadCountdownUI(); startCountdownInterval(); }
  if (page === 'report')   { setReportDefaults(); }
  if (page === 'settings') loadSettingsUI();
}

function refreshAll() {
  const activePage = document.querySelector('.page.active');
  if (!activePage) return;
  const id = activePage.id.replace('page-', '');
  navigate(id);
}

// ── Init & Events ─────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  load();
  applyTheme();
  // Apply saved menu order & visibility before wiring nav handlers
  applyMenuFromPrefs();
  populateDropdowns();
  updateProfileUI();
  navigate('overview');

  // Nav clicks
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      navigate(item.dataset.page);
    });
  });

  // Sidebar profile click → go to settings
  document.getElementById('sidebar-profile').addEventListener('click', () => navigate('settings'));

  // Quick start from overview
  document.getElementById('quick-start-btn').addEventListener('click', () => navigate('timer'));
  const quickManual = document.getElementById('quick-manual-btn');
  if (quickManual) quickManual.addEventListener('click', () => navigate('manual'));

  // Timer buttons
  document.getElementById('timer-toggle-btn').addEventListener('click', () => {
    if (state.timer.running) stopTimer();
    else startTimer();
  });
  document.getElementById('timer-discard-btn').addEventListener('click', discardTimer);
  // Clear all timer fields
  const clearBtn = document.getElementById('timer-clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', clearTimerFields);
  // Manual page add
  const manualAdd = document.getElementById('manual-add-btn');
  if (manualAdd) manualAdd.addEventListener('click', saveManualEntry);
  const manualClear = document.getElementById('manual-clear-btn');
  if (manualClear) manualClear.addEventListener('click', clearManualFields);
  // Todos
  const todoAdd = document.getElementById('todo-add-btn');
  if (todoAdd) todoAdd.addEventListener('click', addTodo);
  const todoInput = document.getElementById('todo-input');
  if (todoInput) todoInput.addEventListener('keydown', e => { if (e.key === 'Enter') addTodo(); });
  const todoList = document.getElementById('todo-list');
  if (todoList) todoList.addEventListener('click', e => {
    const del = e.target.closest('.todo-delete');
    if (del) return deleteTodo(del.dataset.id);
    const tog = e.target.closest('.todo-toggle');
    if (tog) return toggleTodo(tog.dataset.id, tog.checked);
  });

  // Calendar nav
  document.getElementById('cal-prev').addEventListener('click', () => {
    state.calendar.month--;
    if (state.calendar.month < 0) { state.calendar.month = 11; state.calendar.year--; }
    buildCalendar();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    state.calendar.month++;
    if (state.calendar.month > 11) { state.calendar.month = 0; state.calendar.year++; }
    buildCalendar();
  });
  document.getElementById('cal-today').addEventListener('click', () => {
    const now = new Date();
    state.calendar.year  = now.getFullYear();
    state.calendar.month = now.getMonth();
    state.calendar.selectedDate = now;
    buildCalendar();
    showCalDayDetail(now);
  });

  // Report
  document.getElementById('report-filter-btn').addEventListener('click', applyReportFilter);
  document.getElementById('export-csv-btn').addEventListener('click', exportCSV);
  document.getElementById('export-xlsx-btn').addEventListener('click', exportXLSX);
  const reportDeleteAll = document.getElementById('report-delete-all-btn');
  if (reportDeleteAll) reportDeleteAll.addEventListener('click', deleteAllEntries);
  const reportRange = document.getElementById('report-range');
  if (reportRange) reportRange.addEventListener('change', () => setReportRange(reportRange.value));
  // Report sort controls
  if (!state.report.sort) state.report.sort = { field: 'start', dir: 'desc' };
  setReportSortUI();
  const reportSortField = document.getElementById('report-sort-field');
  const reportSortDir = document.getElementById('report-sort-dir');
  if (reportSortField) reportSortField.addEventListener('change', e => {
    state.report.sort.field = e.target.value;
    setReportSortUI();
    applyReportFilter();
  });
  if (reportSortDir) reportSortDir.addEventListener('click', () => {
    state.report.sort.dir = state.report.sort.dir === 'asc' ? 'desc' : 'asc';
    setReportSortUI();
    applyReportFilter();
  });

  // Delegate clicks in report table (row delete, group toggle, group delete)
  const reportTbody = document.getElementById('report-tbody');
  if (reportTbody) reportTbody.addEventListener('click', e => {
    const rowEdit = e.target.closest('.row-edit');
    if (rowEdit) return openEditModal(rowEdit.dataset.id);
    const rowDup = e.target.closest('.row-duplicate');
    if (rowDup) return duplicateEntryById(rowDup.dataset.id);
    const rowDel = e.target.closest('.row-delete');
    if (rowDel) return deleteEntryById(rowDel.dataset.id);

    const grpToggle = e.target.closest('.group-toggle');
    if (grpToggle) {
      const key = grpToggle.dataset.group;
      const expanded = grpToggle.getAttribute('aria-expanded') === 'true';
      const children = reportTbody.querySelectorAll(`tr.group-child[data-parent-group="${key}"]`);
      children.forEach(r => r.style.display = expanded ? 'none' : '');
      grpToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      grpToggle.textContent = expanded ? '▸' : '▾';
      return;
    }

    const grpDel = e.target.closest('.group-delete');
    if (grpDel) return deleteGroupByKey(grpDel.dataset.group);
  });

  // Settings
  document.getElementById('save-settings-btn').addEventListener('click', saveSettings);
  document.getElementById('add-client-btn').addEventListener('click', addClient);
  document.getElementById('add-transporteur-btn').addEventListener('click', addTransporteur);

  // Menu settings interaction (reorder / visibility)
  const menuSettings = document.getElementById('menu-settings-list');
  if (menuSettings) {
    menuSettings.addEventListener('click', e => {
      const up = e.target.closest('.menu-up');
      const down = e.target.closest('.menu-down');
      if (up) { const row = up.closest('.menu-setting-item'); moveMenuRow(row, 'up'); return; }
      if (down) { const row = down.closest('.menu-setting-item'); moveMenuRow(row, 'down'); return; }
    });
    menuSettings.addEventListener('change', e => {
      if (e.target && e.target.matches('.menu-visible')) {
        // toggle visibility immediately in UI; saving occurs on Save settings
        const row = e.target.closest('.menu-setting-item');
        if (row) row.querySelector('.label').style.opacity = e.target.checked ? '1' : '0.5';
      }
    });
  }

  document.getElementById('add-client-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addClient();
  });
  document.getElementById('add-transporteur-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addTransporteur();
  });

  // Tag removal delegation
  document.getElementById('clients-list').addEventListener('click', e => {
    const btn = e.target.closest('.tag-remove');
    if (btn) removeTag(btn.dataset.type, btn.dataset.value);
  });
  document.getElementById('transporteurs-list').addEventListener('click', e => {
    const btn = e.target.closest('.tag-remove');
    if (btn) removeTag(btn.dataset.type, btn.dataset.value);
  });

  // Segmented controls
  document.querySelectorAll('.segmented-control').forEach(ctrl => {
    ctrl.addEventListener('click', e => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      ctrl.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Profile photo
  document.getElementById('upload-pfp-btn').addEventListener('click', () => {
    document.getElementById('pfp-input').click();
  });
  document.getElementById('pfp-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      state.prefs.pfp = ev.target.result;
      updateAvatarUI();
      updateProfileUI();
      save();
    };
    reader.readAsDataURL(file);
  });

  // Firebase controls removed

  // Ensure Clear All button matches current timer state
  updateTimerClearButtonState();

  // Countdown: save / clear / checkbox delegation
  const cdSave = document.getElementById('countdown-save-btn');
  if (cdSave) cdSave.addEventListener('click', () => { saveCountdownPrefsFromUI(); exitCountdownEditMode(); });
  const cdClear = document.getElementById('countdown-clear-btn');
  if (cdClear) cdClear.addEventListener('click', clearCountdownPrefs);
  const cdDays = document.getElementById('countdown-days');
  if (cdDays) cdDays.addEventListener('change', e => {
    if (e.target && e.target.matches('input[type="checkbox"]')) saveCountdownPrefsFromUI();
  });

  const cdEdit = document.getElementById('countdown-edit-btn');
  if (cdEdit) cdEdit.addEventListener('click', enterCountdownEditMode);
  const cdCancel = document.getElementById('countdown-cancel-btn');
  if (cdCancel) cdCancel.addEventListener('click', () => { loadCountdownUI(); exitCountdownEditMode(); });

  // Start countdown interval if page is active
  startCountdownInterval();

  // Edit modal
  document.getElementById('edit-modal-close').addEventListener('click', closeEditModal);
  document.getElementById('edit-save-btn').addEventListener('click', saveEdit);
  document.getElementById('edit-delete-btn').addEventListener('click', deleteEntry);
  document.getElementById('edit-modal-backdrop').addEventListener('click', e => {
    if (e.target === document.getElementById('edit-modal-backdrop')) closeEditModal();
  });
});
