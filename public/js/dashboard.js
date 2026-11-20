// HR / CEO dashboard: filters for the reviews table, and a live refresh every minute.
const REFRESH_MS = 60_000;
const FILTERS = ['q', 'manager', 'dept', 'status'];
const params = new URLSearchParams(location.search);
const storeKey = `dash-filters:${location.pathname}`;

function readStored() {
  try { return JSON.parse(sessionStorage.getItem(storeKey) || '{}'); } catch { return {}; }
}
function store(state) {
  try { sessionStorage.setItem(storeKey, JSON.stringify(state)); } catch { /* private mode */ }
}

// Filters come from the address (links like ?manager=…) or from earlier on this tab.
const fromUrl = FILTERS.some((k) => params.has(k));
const state = Object.fromEntries(FILTERS.map((k) => [k, (fromUrl ? params.get(k) : readStored()[k]) || '']));

function syncInputs() {
  for (const el of document.querySelectorAll('[data-filter]')) {
    const v = state[el.dataset.filter] || '';
    if (el.tagName === 'SELECT' && v && ![...el.options].some((o) => o.value === v || o.text === v)) el.add(new Option(v, v));
    el.value = v;
  }
}

function apply() {
  const rows = [...document.querySelectorAll('tr[data-row]')];
  if (!rows.length && !document.getElementById('filters')) return;
  const q = state.q.trim().toLowerCase();
  let shown = 0;
  for (const tr of rows) {
    const d = tr.dataset;
    const ok = (!q || d.q.includes(q))
      && (!state.manager || d.manager === state.manager)
      && (!state.dept || d.dept === state.dept)
      && (!state.status
        || (state.status === 'request' ? d.request === '1' : state.status === 'new' ? d.new === '1' : d.status === state.status));
    tr.hidden = !ok;
    if (ok) shown += 1;
  }
  const empty = document.getElementById('f-empty');
  if (empty) empty.hidden = shown > 0 || !rows.length;
  const count = document.getElementById('f-count');
  if (count) count.textContent = FILTERS.some((k) => state[k]) ? `Showing ${shown} of ${rows.length}` : `${rows.length} reviews`;
  for (const b of document.querySelectorAll('[data-set-status]')) b.classList.toggle('active', b.dataset.setStatus === state.status);
  store(state);
  const url = new URL(location.href);
  for (const k of FILTERS) { if (state[k]) url.searchParams.set(k, state[k]); else url.searchParams.delete(k); }
  history.replaceState(null, '', url);
}

document.addEventListener('input', (e) => {
  const key = e.target.dataset?.filter;
  if (key) { state[key] = e.target.value; apply(); }
});
document.addEventListener('change', (e) => {
  const key = e.target.dataset?.filter;
  if (key) { state[key] = e.target.value; apply(); }
});
document.getElementById('filters')?.addEventListener('submit', (e) => e.preventDefault());
document.getElementById('f-clear')?.addEventListener('click', () => {
  for (const k of FILTERS) state[k] = '';
  syncInputs();
  apply();
});
document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-set-status]');
  if (!card) return;
  const value = state.status === card.dataset.setStatus ? '' : card.dataset.setStatus;
  if (card.hasAttribute('data-go-reviews')) {
    // On the Managers / Organisation views: go to the reviews table with that status.
    location.href = `${location.pathname}?status=${encodeURIComponent(card.dataset.setStatus)}`;
    return;
  }
  state.status = value;
  syncInputs();
  apply();
});

// ---- Live refresh: reload the counts and the table/tree in place, keeping filters and open branches.
const statusEl = document.getElementById('live-status');
function busy() {
  const live = [...document.querySelectorAll('[data-live]')];
  return live.some((el) => el.querySelector('details.inline-menu[open], input:checked')
    || el.contains(document.activeElement) && document.activeElement !== document.body);
}
async function refresh() {
  if (document.hidden || busy()) return;
  try {
    const res = await fetch(location.href, { headers: { Accept: 'text/html' }, credentials: 'same-origin' });
    if (!res.ok || res.redirected) throw new Error(String(res.status));
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    if (busy()) return;
    const openKeys = new Set([...document.querySelectorAll('details.org-children[open]')].map((d) => d.dataset.key));
    for (const el of document.querySelectorAll('[data-live]')) {
      const fresh = doc.getElementById(el.id);
      if (fresh) el.innerHTML = fresh.innerHTML;
    }
    for (const d of document.querySelectorAll('details.org-children')) if (openKeys.has(d.dataset.key)) d.open = true;
    apply();
    if (statusEl) {
      statusEl.textContent = `Live · updated ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
      statusEl.classList.remove('stale');
    }
  } catch {
    if (statusEl) { statusEl.textContent = 'Live · could not update, retrying'; statusEl.classList.add('stale'); }
  }
}

syncInputs();
apply();
if (statusEl) {
  statusEl.textContent = `Live · updated ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
