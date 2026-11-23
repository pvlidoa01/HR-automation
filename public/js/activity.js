// Posts a message in the "Discussion and changes" panel without reloading the page,
// so changes being made in the review form (not saved yet) are kept.
const form = document.querySelector('.activity-form');
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
      status.textContent = 'Posted. Your changes to the review are still here, not saved yet.';
      status.className = 'small';
    } catch (err) {
      status.textContent = err.message || 'Could not post the message. Try again.';
      status.className = 'small err';
    } finally {
      button.disabled = false;
    }
  });

  function addToList(c) {
    const panel = form.closest('.activity');
    let list = panel.querySelector('[data-activity-list]');
    if (!list) {
      panel.querySelector('[data-activity-empty]')?.remove();
      list = document.createElement('ul');
      list.className = 'activity-list';
      list.setAttribute('data-activity-list', '');
      panel.appendChild(list);
    }
    const li = document.createElement('li');
    li.className = 'comment';
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
