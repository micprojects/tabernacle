import { icon } from './icons.js';
import {
  createYouTubeService,
  youtubeVideoId,
  youtubePageLabel,
  videoTime,
  videoInProgress,
} from './youtube.js';

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createYouTubeView({ tree, onChange, onPermission }) {
  const service = createYouTubeService({ api: globalThis.browser });
  let active = false;
  let tabs = [];
  let duplicates = new Map();
  let timer;
  let busy = false;
  let epoch = 0;
  const visible = new Set();
  const watched = new Set();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      tick();
    },
    { root: tree, rootMargin: '100px 0px' },
  );

  function paint(row, tab) {
    const id = youtubeVideoId(tab.url);
    if (!id) return;
    const value = service.peek(tab);
    row.querySelector('.youtube-channel').textContent = value?.channel || 'Channel unavailable';
    const duration = row.querySelector('.youtube-duration');
    duration.textContent = value?.live ? 'Live' : videoTime(value?.duration);
    duration.hidden = !duration.textContent;
    const status = row.querySelector('.youtube-status');
    const position = row.querySelector('.youtube-position');
    const progress = row.querySelector('.youtube-progress');
    const known = Number.isFinite(value?.position);
    position.textContent = known
      ? value.live
        ? 'Live stream'
        : `${videoTime(value.position)}${value.duration ? ` / ${videoTime(value.duration)}` : ''}`
      : 'Progress unknown';
    status.textContent = known
      ? !value.current
        ? 'Last seen'
        : value.ended
          ? 'Finished'
          : !value.paused
            ? 'Playing'
            : 'Paused'
      : '';
    progress.hidden = !known || !value.duration || value.live;
    if (!progress.hidden) {
      progress.max = value.duration;
      progress.value = value.position;
      progress.setAttribute('aria-label', `Video progress: ${position.textContent}`);
    }
  }

  function loadImage(row) {
    const image = row.querySelector('img[data-src]');
    if (image) {
      image.src = image.dataset.src;
      delete image.dataset.src;
    }
  }

  async function tick() {
    if (!active || busy || document.hidden) return;
    busy = true;
    const token = epoch;
    const queue = [...visible].filter((row) => row.isConnected);
    for (const row of queue) loadImage(row);
    await Promise.all(
      [0, 1].map(async () => {
        while (active && token === epoch && queue.length) {
          const row = queue.shift();
          const tab = tabs.find((tab) => tab.id === Number(row.dataset.id));
          if (!tab) continue;
          await service.read(tab);
          if (active && token === epoch && row.isConnected && row.classList.contains('youtube-row'))
            paint(row, tab);
        }
      }),
    );
    busy = false;
    if (active && token === epoch) onChange();
  }

  return {
    details: service.peek,

    matches(tab, filter) {
      if (filter === 'progress') return videoInProgress(service.peek(tab));
      if (filter === 'duplicates') return (duplicates.get(youtubeVideoId(tab.url)) || 0) > 1;
      return true;
    },

    prepare(nextTabs, enabled) {
      tabs = nextTabs;
      service.prune(tabs);
      duplicates = new Map();
      for (const tab of tabs) {
        const id = youtubeVideoId(tab.url);
        if (id) duplicates.set(id, (duplicates.get(id) || 0) + 1);
      }
      if (active === enabled) return;
      active = enabled;
      epoch++;
      service.setActive(active);
      clearInterval(timer);
      if (!active) {
        observer.disconnect();
        watched.clear();
        visible.clear();
        return;
      }
      const token = epoch;
      service.permission().then((allowed) => {
        if (active && token === epoch) {
          onPermission(allowed);
          tick();
        }
      });
      // Session reads do not wake sleeping tabs. Only visible rows read players.
      const queue = [...tabs];
      Promise.all(
        [0, 1].map(async () => {
          while (active && token === epoch && queue.length) await service.hydrate(queue.shift());
        }),
      ).then(() => {
        if (active && token === epoch) onChange();
      });
      timer = setInterval(tick, 5000);
    },

    duplicateCount(tab) {
      return duplicates.get(youtubeVideoId(tab.url)) || 0;
    },

    content(tab, folder) {
      const id = youtubeVideoId(tab.url);
      const media = element('span', 'youtube-thumbnail');
      media.setAttribute('aria-hidden', 'true');
      media.append(
        id
          ? element('span', 'youtube-play-icon', '▶')
          : icon(youtubePageLabel(tab.url) === 'Playlist' ? 'list' : 'globe'),
      );
      if (id) {
        const image = element('img', '');
        image.alt = '';
        image.hidden = true;
        image.draggable = false;
        image.referrerPolicy = 'no-referrer';
        image.dataset.src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
        image.addEventListener(
          'load',
          () => {
            image.hidden = false;
          },
          { once: true },
        );
        image.addEventListener('error', () => image.remove(), { once: true });
        media.append(image);
        const duration = element('span', 'youtube-duration');
        duration.hidden = true;
        media.append(duration);
      }
      const copy = element('span', 'youtube-copy');
      copy.append(
        element('span', 'label', (tab.title || 'YouTube').replace(/\s+[-–—|]\s+YouTube$/i, '')),
      );
      const meta = element('span', 'youtube-meta');
      meta.append(
        element('span', 'youtube-channel', id ? 'Channel unavailable' : youtubePageLabel(tab.url)),
      );
      if ((duplicates.get(id) || 0) > 1) {
        const duplicate = element('span', 'youtube-duplicate', 'Duplicate');
        duplicate.title = `${duplicates.get(id)} tabs show this video`;
        meta.append(duplicate);
      }
      copy.append(meta);
      const location = element('span', 'youtube-folder', folder.replace('Folder: ', ''));
      location.title = folder;
      copy.append(location);
      if (id) {
        const playback = element('span', 'youtube-playback');
        playback.append(
          element('span', 'youtube-position', 'Progress unknown'),
          element('span', 'youtube-status'),
        );
        const progress = element('progress', 'youtube-progress');
        progress.hidden = true;
        copy.append(playback, progress);
      }
      return [media, copy];
    },

    mount() {
      if (!active) return;
      const rows = new Set(tree.querySelectorAll('.youtube-row[data-video-id]'));
      for (const row of watched)
        if (!rows.has(row)) {
          observer.unobserve(row);
          watched.delete(row);
          visible.delete(row);
        }
      for (const row of rows) {
        const tab = tabs.find((tab) => tab.id === Number(row.dataset.id));
        if (tab) paint(row, tab);
        if (visible.has(row)) loadImage(row);
        if (!watched.has(row)) {
          watched.add(row);
          observer.observe(row);
        }
      }
    },

    async allow() {
      const allowed = await service.allow();
      onPermission(allowed);
      tick();
      return allowed;
    },

    refreshPermission() {
      service.permission().then((allowed) => {
        if (active) {
          onPermission(allowed);
          tick();
        }
      });
    },
  };
}
