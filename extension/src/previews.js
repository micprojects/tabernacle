export function createTabPreviews({ getTab, canShow, getBottom = () => innerHeight }) {
  const card = document.createElement('div');
  card.id = 'tab-preview';
  card.className = 'tab-preview';
  card.setAttribute('role', 'tooltip');
  card.hidden = true;
  const title = document.createElement('strong');
  title.className = 'preview-title';
  const url = document.createElement('div');
  url.className = 'preview-url';
  const container = document.createElement('div');
  container.className = 'preview-container';
  const audio = document.createElement('div');
  audio.className = 'preview-audio';
  card.append(title, url, container, audio);
  document.body.append(card);
  const events = new AbortController();
  let anchor, originalTitle, openTimer, leaveTimer;

  function hide() {
    clearTimeout(openTimer);
    clearTimeout(leaveTimer);
    card.hidden = true;
    if (anchor) {
      anchor.removeAttribute('aria-describedby');
      if (originalTitle !== null) anchor.title = originalTitle;
    }
    anchor = null;
  }

  function place() {
    if (!anchor?.isConnected) return hide();
    const rect = anchor.getBoundingClientRect();
    const bottom = Math.min(innerHeight, getBottom()) - 8;
    card.style.maxHeight = `${Math.max(0, bottom - 8)}px`;
    const width = card.offsetWidth,
      height = card.offsetHeight;
    card.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
    const below = rect.bottom + 8;
    card.style.top = `${Math.max(
      8,
      Math.min(below + height <= bottom ? below : rect.top - height - 8, bottom - height),
    )}px`;
  }

  function schedule(node, id) {
    if (anchor === node) {
      clearTimeout(leaveTimer);
      return;
    }
    hide();
    if (!canShow()) return;
    anchor = node;
    originalTitle = node.getAttribute('title');
    node.removeAttribute('title'); // Avoid a second native text tooltip on top.
    openTimer = setTimeout(() => {
      const tab = getTab(id);
      if (!tab || !node.isConnected || !canShow()) return hide();
      title.textContent = tab.title || 'New tab';
      url.textContent = tab.url || '';
      container.textContent = tab.container ? `Container: ${tab.container.name}` : '';
      container.hidden = !tab.container;
      audio.textContent = tab.audioDescription || '';
      audio.hidden = !audio.textContent;
      card.hidden = false;
      node.setAttribute('aria-describedby', card.id);
      place();
    }, 550);
  }

  function leave() {
    if (card.hidden) return hide();
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(hide, 120);
  }

  function bind(node, tab) {
    node.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'touch') schedule(node, tab.id);
    });
    node.addEventListener('pointerleave', leave);
    node.addEventListener('focus', () => {
      if (node.matches(':focus-visible')) schedule(node, tab.id);
    });
    node.addEventListener('blur', hide);
  }

  card.addEventListener('pointerenter', () => clearTimeout(leaveTimer));
  card.addEventListener('pointerleave', leave);
  for (const type of ['pointerdown', 'contextmenu', 'dragstart', 'keydown'])
    document.addEventListener(type, hide, { capture: true, signal: events.signal });
  document.addEventListener(
    'scroll',
    (event) => {
      if (!card.contains(event.target)) hide();
    },
    { capture: true, signal: events.signal },
  );
  for (const type of ['resize', 'blur'])
    window.addEventListener(type, hide, { signal: events.signal });
  window.addEventListener(
    'pagehide',
    () => {
      hide();
      events.abort();
      card.remove();
    },
    { once: true },
  );
  return { bind, hide };
}
