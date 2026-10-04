import { icon } from './icons.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function closedTime(timestamp) {
  if (!timestamp) return '';
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

export function createRecentlyClosed({ trigger, getState, beforeOpen, restore, favicon }) {
  const popup = el('section', 'recently-closed');
  popup.id = 'recently-closed';
  popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-labelledby', 'recently-closed-title');
  const heading = el('div', 'recently-closed-heading');
  const title = el('h2', '', 'Recently closed');
  title.id = 'recently-closed-title';
  const dismiss = el('button', 'icon-button');
  dismiss.type = 'button';
  dismiss.title = 'Close recently closed tabs';
  dismiss.setAttribute('aria-label', dismiss.title);
  dismiss.append(icon('close'));
  heading.append(icon('history'), title, dismiss);
  const list = el('div', 'recently-closed-list');
  const empty = el('p', 'recently-closed-empty');
  empty.setAttribute('role', 'status');
  popup.append(heading, list, empty);
  document.body.append(popup);
  let renderKey, timer;

  function position() {
    if (popup.hidden) return;
    const rect = trigger.getBoundingClientRect();
    popup.style.maxHeight = `${Math.max(0, (rect.top - 16) / 2)}px`;
    popup.style.left = `${Math.max(8, Math.min(rect.right - popup.offsetWidth, innerWidth - popup.offsetWidth - 8))}px`;
    popup.style.top = `${Math.max(8, rect.top - popup.offsetHeight - 8)}px`;
  }

  function close(restoreFocus = false) {
    if (popup.hidden) return;
    popup.hidden = true;
    clearInterval(timer);
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function render() {
    if (popup.hidden) return;
    const { recentlyClosed: tabs = [], recentlyClosedError } = getState();
    const key = JSON.stringify([tabs, recentlyClosedError, Math.floor(Date.now() / 60_000)]);
    if (key !== renderKey) {
      renderKey = key;
      const focused = document.activeElement;
      const sessionId = focused?.dataset.sessionId;
      const scroll = list.scrollTop;
      list.replaceChildren();
      for (const tab of tabs) {
        const row = el('button', 'recently-closed-row');
        row.type = 'button';
        row.dataset.sessionId = tab.sessionId;
        row.title = [tab.title, tab.url].filter(Boolean).join('\n');
        row.setAttribute('aria-label', `Reopen ${tab.title}`);
        const time = el('time', 'recently-closed-time', closedTime(tab.closedAt));
        if (tab.closedAt) {
          const date = new Date(tab.closedAt);
          time.dateTime = date.toISOString();
          time.title = date.toLocaleString();
        }
        row.append(favicon(tab), el('span', 'recently-closed-label', tab.title), time);
        row.addEventListener('click', () => {
          close(true);
          restore(tab.sessionId);
        });
        list.append(row);
      }
      empty.hidden = tabs.length > 0;
      empty.textContent = recentlyClosedError
        ? `Could not load recently closed tabs. ${recentlyClosedError}`
        : 'No recently closed tabs.';
      list.scrollTop = scroll;
      if (sessionId) {
        const matching = [...list.children].find((row) => row.dataset.sessionId === sessionId);
        (matching || list.firstElementChild || dismiss).focus({ preventScroll: true });
      }
    }
    position();
  }

  function open() {
    if (!getState()) return;
    beforeOpen();
    popup.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    render();
    (list.firstElementChild || dismiss).focus({ preventScroll: true });
    timer = setInterval(render, 60_000);
  }

  trigger.append(icon('history'));
  trigger.addEventListener('click', () => (popup.hidden ? open() : close(true)));
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
      if (event.key === 'ArrowUp') (list.lastElementChild || dismiss).focus();
    }
  });
  dismiss.addEventListener('click', () => close(true));
  popup.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const rows = [...list.querySelectorAll('button')];
    const index = rows.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = rows[(index + 1) % rows.length];
    else if (event.key === 'ArrowUp') next = index <= 0 ? rows.at(-1) : rows[index - 1];
    else if (event.key === 'Home') next = rows[0];
    else if (event.key === 'End') next = rows.at(-1);
    else return;
    event.preventDefault();
    event.stopPropagation();
    next?.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!popup.contains(event.target) && !trigger.contains(event.target)) close();
  });
  document.addEventListener('focusin', (event) => {
    if (!popup.contains(event.target) && !trigger.contains(event.target)) close();
  });
  window.addEventListener('resize', position);
  window.addEventListener('blur', () => close());
  window.addEventListener('pagehide', () => close(), { once: true });
  return { open, close, render, isOpen: () => !popup.hidden };
}
