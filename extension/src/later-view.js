import { createYouTubeView } from './youtube-view.js';
import { youtubeVideoId, youtubeTitle } from './youtube.js';
import { groupPath } from './model.js';
import { icon } from './icons.js';
import { reconcileChildren } from './dom.js';
import { domainFromUrl } from './domain-filter.js';
import { groupById, isSavedForLater } from './model.js';
import { laterAge, laterCategory, laterFilters, laterResults } from './later.js';
import { articleUrl } from './article.js';
import { createArticleService } from './article-service.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label, iconName, className) {
  const node = element('button', className);
  node.type = 'button';
  node.title = label;
  node.setAttribute('aria-label', label);
  if (iconName) node.append(icon(iconName));
  return node;
}

export function createLaterView({
  root,
  onOpen,
  onClose,
  onActivate,
  onReturn,
  onCloseTab,
  onMenu,
  onActions,
  onRead,
  onError = () => {},
  onNotice = () => {},
  api = globalThis.browser,
}) {
  const pane = element('section', 'later-view');
  pane.id = 'later-view';
  pane.hidden = true;
  pane.setAttribute('aria-labelledby', 'later-title');
  const heading = element('div', 'later-heading');
  const title = element('h1', '', 'Saved for Later');
  title.id = 'later-title';
  const dismiss = button('Close Saved for Later', 'close', 'later-dismiss');
  dismiss.id = 'later-close';
  heading.append(icon('later'), title, dismiss);
  const searchWrap = element('div', 'later-search');
  const search = element('input');
  search.id = 'later-search';
  search.type = 'search';
  search.placeholder = 'Search saved tabs';
  search.setAttribute('aria-label', 'Search saved tabs');
  searchWrap.append(icon('search'), search);
  const filters = element('div', 'later-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter saved tabs');
  const filterButtons = new Map();
  let category = 'all';
  for (const [key, label] of Object.entries(laterFilters)) {
    const control = button(label);
    control.textContent = label;
    control.addEventListener('click', () => {
      category = key;
      render();
    });
    filterButtons.set(key, control);
    filters.append(control);
  }
  const tools = element('div', 'later-tools');
  const count = element('span');
  count.setAttribute('role', 'status');
  const sort = element('select');
  sort.setAttribute('aria-label', 'Sort saved tabs');
  for (const [value, label] of [
    ['newest', 'Newest added'],
    ['oldest', 'Oldest added'],
  ]) {
    const option = element('option', '', label);
    option.value = value;
    sort.append(option);
  }
  const actions = button('Saved tabs actions', 'more', 'icon-button');
  actions.setAttribute('aria-haspopup', 'menu');
  actions.addEventListener('click', (event) =>
    onActions?.(
      event,
      visibleIds
        .map((id) => state.tabs.find((tab) => tab.id === id))
        .filter(Boolean)
        .map((tab) => ({ ...tab, articlePreview: articles.peek(tab) })),
      { kind: 'later', category, query: search.value },
    ),
  );
  tools.append(count, sort, actions);
  const previewOptions = element('details', 'later-preview-options');
  previewOptions.hidden = !api?.scripting || !api?.permissions;
  const previewSummary = element('summary');
  previewSummary.append(element('span', '', 'Article previews'));
  const previewStatus = element('span', 'later-preview-status');
  previewSummary.append(previewStatus);
  const previewHelp = element('p');
  const previewAccess = button('Enable previews on all sites', null, 'later-preview-access');
  previewAccess.disabled = true;
  previewOptions.append(previewSummary, previewHelp, previewAccess);
  const content = element('div', 'later-content');
  const list = element('ul', 'later-list');
  list.setAttribute('aria-label', 'Saved tabs');
  const empty = element('div', 'later-empty');
  const emptyTitle = element('h2');
  const emptyText = element('p');
  empty.append(icon('later'), emptyTitle, emptyText);
  const videoAccess = element('div', 'later-video-access');
  const videoAllow = button('Allow YouTube access');
  videoAllow.textContent = 'Allow YouTube access';
  videoAccess.append(element('span', '', 'Show channels and observed progress.'), videoAllow);
  videoAccess.hidden = true;
  content.append(list, empty);
  pane.append(heading, searchWrap, filters, previewOptions, videoAccess, tools, content);
  root.prepend(pane);
  const trigger = button('Saved for Later', 'later');
  trigger.id = 'later-toggle';
  trigger.disabled = true;
  trigger.setAttribute('aria-controls', pane.id);
  trigger.setAttribute('aria-expanded', 'false');
  root.querySelector('#domains-toggle').before(trigger);
  const fold = root.querySelector('#tree-toggle');
  const rows = new Map();
  const articles = createArticleService({ api });
  let videoAllowed = false;
  const youtube = createYouTubeView({
    tree: list,
    scrollRoot: content,
    api,
    onChange: () => youtube.mount(),

    onPermission: (allowed) => {
      videoAllowed = allowed;
      updateVideoAccess();
    },
  });

  function videoEnabled() {
    return !pane.hidden && state?.siteEnhancementsEnabled !== false && state?.youtubeMode !== false;
  }

  function updateVideoAccess() {
    videoAccess.hidden =
      !videoEnabled() ||
      videoAllowed ||
      !visibleIds.some((id) => youtubeVideoId(state.tabs.find((tab) => tab.id === id)?.url));
  }

  videoAllow.addEventListener('click', () =>
    youtube.allow().catch(() => onError('Could not enable YouTube access. Try again.')),
  );
  const visible = new Set();
  let state, savedFocus, timer, articleTimer;
  let reading = false;
  let readAgain = false;
  let visibleIds = [];
  let allAccess = false;
  let accessRevision = 0;
  let changingAccess = false;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(Number(entry.target.dataset.id));
        else visible.delete(Number(entry.target.dataset.id));
      }
      readVisible();
    },
    { root: content, rootMargin: '80px 0px' },
  );

  async function readVisible() {
    if (pane.hidden || !state || document.hidden) return;
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    const queue = state.tabs.filter(
      (tab) =>
        visible.has(tab.id) &&
        isSavedForLater(tab) &&
        !['videos', 'documents'].includes(laterCategory(tab)),
    );
    try {
      await Promise.all(
        [0, 1].map(async () => {
          while (queue.length && !pane.hidden) await articles.read(queue.shift());
        }),
      );
    } finally {
      reading = false;
      render();
      if (readAgain) {
        readAgain = false;
        readVisible();
      }
    }
  }

  async function refreshAccess() {
    const revision = ++accessRevision;
    try {
      const allowed = await articles.hasAllAccess();
      if (revision !== accessRevision) return;
      allAccess = allowed;
      previewStatus.textContent = allowed ? 'All sites' : 'Set up';
      previewHelp.textContent = allowed
        ? 'All-site access is enabled for Tabernacle. Article previews are processed on your device. You can remove this access below.'
        : 'Show excerpts, authors and reading times. Allow access to all websites once; previews are processed on your device.';
      previewAccess.textContent = allowed ? 'Remove all-site access' : 'Enable on all sites';
      previewAccess.setAttribute(
        'aria-label',
        allowed ? 'Remove all-site access' : 'Enable previews on all sites',
      );
      previewAccess.title = previewAccess.getAttribute('aria-label');
      previewAccess.disabled = changingAccess;
    } catch {
      if (revision !== accessRevision) return;
      previewStatus.textContent = 'Unavailable';
      previewHelp.textContent = 'Could not check site access. Close Saved for Later and try again.';
      previewAccess.disabled = true;
    }
  }

  previewAccess.addEventListener('click', async () => {
    if (changingAccess) return;
    const removing = allAccess;
    changingAccess = true;
    previewAccess.disabled = true;
    try {
      const changed = await (removing ? articles.removeAllAccess() : articles.allowAll());
      if (!changed) {
        if (removing) onError('Could not remove all-site access. Try again.');
        else onNotice('Previews were not enabled. You can still use Reader View.');
      } else {
        onNotice(removing ? 'All-site access removed.' : 'Article previews enabled on all sites.');
      }
      previewOptions.open = false;
      if (!pane.hidden && document.activeElement === previewAccess) previewSummary.focus();
      render();
      readVisible();
    } catch {
      onError('Could not change site access. Try again.');
    } finally {
      changingAccess = false;
      await refreshAccess();
    }
  });

  function refreshPermissions() {
    articles.refreshPermissions();
    youtube.refreshPermission();
    refreshAccess();
    render();
    readVisible();
  }

  api?.permissions?.onAdded?.addListener(refreshPermissions);
  api?.permissions?.onRemoved?.addListener(refreshPermissions);

  function close({ restoreFocus = true } = {}) {
    if (pane.hidden) return;
    clearInterval(timer);
    clearInterval(articleTimer);
    youtube.prepare([], false);
    pane.hidden = true;
    articles.configure(state.tabs.filter(isSavedForLater), false);
    observer.disconnect();
    visible.clear();
    root.classList.remove('later-open');
    trigger.setAttribute('aria-expanded', 'false');
    onClose();
    if (restoreFocus)
      (savedFocus?.isConnected ? savedFocus : trigger).focus({ preventScroll: true });
  }

  function makeRow(id) {
    const row = element('li', 'later-row');
    row.dataset.id = id;
    const open = button('Open saved tab', null, 'later-open-tab');
    const favicon = element('span', 'later-favicon');
    const copy = element('span', 'later-copy');
    const label = element('span', 'later-label');
    const domain = element('span', 'later-domain');
    const details = element('span', 'later-article-details');
    const excerpt = element('span', 'later-excerpt');
    copy.append(label, domain, details, excerpt);
    open.append(favicon, copy);
    const main = element('div', 'later-main');
    const articleActions = element('div', 'later-article-actions');
    const read = button('Read in Reader View', null, 'later-read');
    articleActions.append(read);
    main.append(open, articleActions);
    const side = element('div', 'later-side');
    const actions = element('div', 'later-row-actions');
    const restore = button('Return to original folder', 'group');
    const remove = button('Close tab', 'closeSmall');
    const time = element('time', 'later-time');
    actions.append(restore, remove);
    side.append(actions, time);
    row.append(main, side);
    const item = {
      row,
      open,
      copy,
      favicon,
      label,
      domain,
      restore,
      remove,
      time,
      read,
      articleActions,
      details,
      excerpt,
    };
    open.addEventListener('click', () => onActivate(id));

    async function run(control, action) {
      if (control.getAttribute('aria-disabled') === 'true') return;
      control.setAttribute('aria-disabled', 'true');
      try {
        await action(id);
      } catch {
        onError('Could not update this tab. Try again.');
      } finally {
        control.removeAttribute('aria-disabled');
      }
    }

    restore.addEventListener('click', () => run(restore, onReturn));
    remove.addEventListener('click', () => run(remove, onCloseTab));
    read.addEventListener('click', () =>
      run(read, async () => {
        const tab = state.tabs.find((tab) => tab.id === id);
        if (!tab) return;
        // Capture permitted details before Firefox replaces the document with Reader View.
        await articles.read(tab);
        await onRead(id, !tab.isInReaderMode, articleUrl(tab.url));
      }),
    );
    row.addEventListener('mousedown', (event) => {
      if (event.button === 1) event.preventDefault();
    });
    row.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      run(remove, onCloseTab);
    });

    function context(event) {
      event.preventDefault();
      event.stopPropagation();
      open.focus({ preventScroll: true });
      const rect = open.getBoundingClientRect();
      onMenu(
        id,
        event.type === 'keydown' ? rect.left : event.clientX,
        event.type === 'keydown' ? rect.bottom : event.clientY,
      );
    }

    row.addEventListener('contextmenu', context);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) context(event);
      if (event.key === 'Delete' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        run(remove, onCloseTab);
      }
    });
    return item;
  }

  function render() {
    if (pane.hidden || !state) return;
    const saved = state.tabs.filter(isSavedForLater);
    articles.configure(saved, true);
    youtube.prepare(
      saved.filter((tab) => youtubeVideoId(tab.url)),
      videoEnabled(),
    );
    const entries = laterResults(
      saved.map((tab) => ({ ...tab, articlePreview: articles.peek(tab) })),
      {
        category,
        query: search.value,
        sort: sort.value,
      },
    );
    visibleIds = entries.map((tab) => tab.id);
    updateVideoAccess();
    const total = state.tabs.filter(isSavedForLater).length;
    const focused = document.activeElement;
    const oldRows = [...list.children];
    const focusedIndex = oldRows.findIndex((row) => row.contains(focused));
    const alive = new Set();
    for (const tab of entries) {
      alive.add(tab.id);
      if (!rows.has(tab.id)) {
        rows.set(tab.id, makeRow(tab.id));
        observer.observe(rows.get(tab.id).row);
      }
      const item = rows.get(tab.id);
      const data = tab.articlePreview;
      const source = articleUrl(tab.url) || tab.url;
      const video = videoEnabled() && youtubeVideoId(tab.url);
      const label = video
        ? youtubeTitle(tab.title)
        : data?.title || tab.title || source || 'New tab';
      item.label.textContent = label;
      item.open.setAttribute('aria-label', label);
      item.open.title = source || label;
      if (tab.active) item.open.setAttribute('aria-current', 'true');
      else item.open.removeAttribute('aria-current');
      item.row.classList.toggle('active', Boolean(tab.active));
      const kind = laterCategory(tab);
      item.domain.textContent = [
        domainFromUrl(source) || (tab.url?.startsWith('file:') ? 'Local file' : 'Browser tab'),
        kind === 'videos' ? 'Video' : kind === 'documents' ? 'Document' : null,
        tab.isInReaderMode ? 'Reader View' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      item.details.textContent = data
        ? [
            data.byline,
            data.published
              ? new Date(`${data.published}T12:00:00`).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })
              : '',
            `${data.minutes} min read`,
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
      item.details.hidden = !data;
      item.details.title = data
        ? `Estimated reading time · Preview saved ${new Date(data.readAt).toLocaleString()}`
        : '';
      item.excerpt.textContent = data?.excerpt || '';
      item.excerpt.hidden = !data?.excerpt;
      item.open.setAttribute(
        'aria-description',
        [item.domain.textContent, item.details.textContent, item.excerpt.textContent]
          .filter(Boolean)
          .join('. '),
      );
      item.read.hidden = !onRead || !(tab.isInReaderMode || tab.isArticle);
      item.read.disabled = Boolean(tab.discarded || tab.status === 'loading');
      item.read.textContent = tab.isInReaderMode ? 'View original' : 'Read';
      item.read.title = tab.isInReaderMode ? 'View original page' : 'Read in Reader View';
      item.read.setAttribute('aria-label', item.read.title);
      item.articleActions.hidden = item.read.hidden;
      item.row.classList.toggle('has-article', Boolean(data) || !item.articleActions.hidden);
      item.row.classList.toggle('has-article-actions', !item.articleActions.hidden);
      const folder = groupById(state, tab.groupId)?.name || 'Home';
      item.restore.title = `Return to ${tab.pinned ? 'pinned tabs' : folder}`;
      item.restore.setAttribute('aria-label', item.restore.title);
      item.time.textContent = laterAge(tab.savedForLaterAt);
      item.time.dateTime = new Date(tab.savedForLaterAt).toISOString();
      item.time.title = `Added ${new Date(tab.savedForLaterAt).toLocaleString()}`;
      const folderPath = ['Home', ...groupPath(state, tab.groupId).map((group) => group.name)].join(
        ' / ',
      );
      const videoKey = video
        ? JSON.stringify([video, tab.title, folderPath, youtube.duplicateCount(tab)])
        : null;
      if (videoKey !== item.videoKey) {
        item.videoKey = videoKey;
        item.row.classList.toggle('youtube-row', Boolean(video));
        if (video) {
          item.row.dataset.videoId = video;
          item.open.replaceChildren(...youtube.content(tab, `Folder: ${folderPath}`));
        } else {
          delete item.row.dataset.videoId;
          item.open.replaceChildren(item.favicon, item.copy);
        }
      }
      if (item.url !== tab.favIconUrl || !item.favicon.childNodes.length) {
        item.url = tab.favIconUrl;
        let image = icon('globe');
        if (
          typeof item.url === 'string' &&
          /^(https?:|data:image\/|moz-extension:)/i.test(item.url)
        ) {
          image = element('img');
          image.alt = '';
          image.draggable = false;
          image.referrerPolicy = 'no-referrer';
          image.src = item.url;
          image.addEventListener('error', () => image.replaceWith(icon('globe')), { once: true });
        }
        item.favicon.replaceChildren(image);
      }
    }
    for (const id of rows.keys())
      if (!alive.has(id)) {
        observer.unobserve(rows.get(id).row);
        visible.delete(id);
        rows.delete(id);
      }
    reconcileChildren(
      list,
      entries.map((tab) => rows.get(tab.id).row),
    );
    youtube.mount();
    for (const [key, control] of filterButtons)
      control.setAttribute('aria-pressed', String(key === category));
    count.textContent = `${entries.length === total ? total : `${entries.length} of ${total}`} ${total === 1 ? 'tab' : 'tabs'}`;
    empty.hidden = Boolean(entries.length);
    emptyTitle.textContent = total ? 'No matching tabs' : 'Nothing saved for later';
    emptyText.textContent = total
      ? 'Try another filter or search.'
      : 'Right-click a tab and choose Save for later.';
    if (focusedIndex >= 0 && !focused.isConnected) {
      const next = entries[Math.min(focusedIndex, entries.length - 1)];
      (next ? rows.get(next.id).open : search).focus({ preventScroll: true });
    }
  }

  function open() {
    if (!state || !pane.hidden) return;
    savedFocus = document.activeElement;
    onOpen();
    pane.hidden = false;
    root.classList.add('later-open');
    trigger.setAttribute('aria-expanded', 'true');
    fold.disabled = true;
    render();
    refreshAccess();
    for (const { row } of rows.values()) observer.observe(row);
    dismiss.focus({ preventScroll: true });
    timer = setInterval(render, 60_000);
    articleTimer = setInterval(readVisible, 15_000);
  }

  dismiss.addEventListener('click', () => close());
  trigger.addEventListener('click', () => (pane.hidden ? open() : close()));
  search.addEventListener('input', render);
  sort.addEventListener('change', render);
  pane.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input, select'))
      return;
    const buttons = [...list.querySelectorAll('.later-open-tab')];
    const row = event.target.closest('.later-row');
    const position = buttons.findIndex((button) => button.closest('li') === row);
    let target;
    if (event.key === 'ArrowDown') target = buttons[Math.min(position + 1, buttons.length - 1)];
    else if (event.key === 'ArrowUp') target = buttons[Math.max(position - 1, 0)];
    else if (event.key === 'Home') target = buttons[0];
    else if (event.key === 'End') target = buttons.at(-1);
    if (target) {
      event.preventDefault();
      target.focus();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (
      event.key !== 'Escape' ||
      pane.hidden ||
      document.querySelector('dialog[open], #menu:not([hidden])')
    )
      return;
    event.preventDefault();
    close();
  });
  document.addEventListener(
    'click',
    (event) => {
      if (!trigger.contains(event.target) && event.target.closest('footer'))
        close({ restoreFocus: false });
    },
    true,
  );
  window.addEventListener(
    'pagehide',
    () => {
      clearInterval(timer);
      clearInterval(articleTimer);
      articles.configure([], false);
      youtube.prepare([], false);
      observer.disconnect();
      api?.permissions?.onAdded?.removeListener(refreshPermissions);
      api?.permissions?.onRemoved?.removeListener(refreshPermissions);
    },
    { once: true },
  );
  return {
    open,
    close,

    focusSearch() {
      search.focus();
      search.select();
    },

    get isOpen() {
      return !pane.hidden;
    },

    closeFilter: () =>
      pane.hidden
        ? null
        : { later: true, category, query: search.value, sort: sort.value, tabIds: visibleIds },

    update(next) {
      state = next;
      articles.configure(state.tabs.filter(isSavedForLater), !pane.hidden);
      trigger.disabled = false;
      render();
      readVisible();
      return !pane.hidden;
    },

    focusTab(id) {
      category = 'all';
      search.value = '';
      open();
      render();
      rows.get(id)?.open.focus();
    },
  };
}
