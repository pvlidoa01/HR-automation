// "Discussion and changes" panel:
// - All / Messages / Changes toggle (All by default, not remembered).
// - Posting a message without reloading the page, so unsaved changes in the review form are kept.
const panel = document.getElementById('activity');
if (panel) {
  const toggle = panel.querySelector('[data-activity-filter]');
  const emptyNote = panel.querySelector('[data-filter-empty]');
  const EMPTY = { comment: 'No messages yet.', change: 'No changes logged yet.' };
  let show = 'all';

  function applyFilter() {
    const items = panel.querySelectorAll('[data-activity-list] > li[data-kind]');
    let visible = 0;
    items.forEach((li) => {
      const on = show === 'all' || li.dataset.kind === show;
      li.hidden = !on;
      if (on) visible += 1;
    });
    toggle.querySelectorAll('button').forEach((b) => {
      const active = b.dataset.show === show;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    // The panel's own "Nothing yet" text covers the case with no items at all.
    emptyNote.hidden = !(items.length && !visible);
    emptyNote.textContent = EMPTY[show] || '';
  }

  function updateCounts() {
    const items = [...panel.querySelectorAll('[data-activity-list] > li[data-kind]')];
    const n = { all: items.length, comment: 0, change: 0 };
    items.forEach((li) => { n[li.dataset.kind] = (n[li.dataset.kind] || 0) + 1; });
    toggle.querySelectorAll('[data-count]').forEach((el) => { el.textContent = n[el.dataset.count] ?? 0; });
  }

  toggle.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-show]');
    if (!b) return;
    show = b.dataset.show;
    applyFilter();
  });

  const form = panel.querySelector('.activity-form');
  if (form) {
    const status = form.querySelector('[data-activity-status]');
    const button = form.querySelector('button[type=submit]');
    const textarea = form.querySelector('textarea');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!textarea.value.trim()) { textarea.focus(); return; }
      button.disabled = true;
      status.textContent = 'Posting…';
      status.className = 'small muted';
      try {
        const res = await fetch(form.action, {
          method: 'POST',
          headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(new FormData(form)),
          credentials: 'same-origin',
        });
        const data = await res.json().catch(() => ({ ok: false, error: 'Could not post the message. Try again.' }));
        if (!data.ok) throw new Error(data.error || 'Could not post the message. Try again.');
        addToList(data.comment);
        textarea.value = '';
        if (show === 'change') show = 'all'; // so the new message is visible
        updateCounts();
        applyFilter();
        status.textContent = 'Posted. Your changes to the review are still here, not saved yet.';
        status.className = 'small';
      } catch (err) {
        status.textContent = err.message || 'Could not post the message. Try again.';
        status.className = 'small err';
      } finally {
        button.disabled = false;
      }
    });
  }

  function addToList(c) {
    let list = panel.querySelector('[data-activity-list]');
    if (!list) {
      panel.querySelector('[data-activity-empty]')?.remove();
      list = document.createElement('ul');
      list.className = 'activity-list';
      list.setAttribute('data-activity-list', '');
      const script = panel.querySelector('script');
      if (script) script.before(list); else panel.appendChild(list);
    }
    const li = document.createElement('li');
    li.className = 'comment';
    li.dataset.kind = 'comment';
    const head = document.createElement('div');
    head.className = 'activity-head';
    const who = document.createElement('strong');
    who.textContent = c.user_name || 'You';
    const when = document.createElement('span');
    when.className = 'muted small';
    when.textContent = c.atLabel || '';
    head.append(who, ' ', when);
    const body = document.createElement('div');
    body.className = 'activity-body';
    body.textContent = c.body;
    li.append(head, body);
    list.prepend(li);
  }
}
