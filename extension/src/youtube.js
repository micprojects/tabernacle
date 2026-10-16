export const YOUTUBE_ORIGINS = [
  'https://www.youtube.com/*',
  'https://youtube.com/*',
  'https://m.youtube.com/*',
  'https://music.youtube.com/*',
];
export const YOUTUBE_SESSION_KEY = 'tabernacle.youtube.v1';

export function isYouTubeDomain(domain) {
  return ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(domain);
}

export function youtubeVideoId(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!isYouTubeDomain(host)) return null;
    const id =
      host === 'youtu.be'
        ? url.pathname.slice(1)
        : url.pathname === '/watch'
          ? url.searchParams.get('v')
          : /^\/(?:shorts|live|embed)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch {
    return null;
  }
}

export function youtubePageLabel(value) {
  try {
    const url = new URL(value);
    if (url.pathname === '/playlist') return 'Playlist';
    if (url.pathname === '/results') return 'Search';
    if (/^\/(?:@|channel\/|c\/|user\/)/.test(url.pathname)) return 'Channel';
  } catch {
    // Keep non-video tabs usable even when a URL is unavailable.
  }
  return 'YouTube page';
}

export function videoTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const value = Math.floor(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = String(value % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export function normaliseVideoData(value, videoId) {
  if (!value || value.videoId !== videoId) return null;
  const duration = Number.isFinite(value.duration) && value.duration > 0 ? value.duration : null;
  const position =
    Number.isFinite(value.position) && value.position >= 0
      ? duration
        ? Math.min(duration, value.position)
        : value.position
      : null;
  return {
    videoId,
    channel: typeof value.channel === 'string' ? value.channel.trim().slice(0, 200) : '',
    duration,
    position,
    paused: value.paused !== false,
    ended: value.ended === true,
    live: value.live === true,
  };
}

export function videoInProgress(data) {
  return Boolean(
    data &&
    data.position > 0 &&
    !data.ended &&
    !data.live &&
    (!data.duration || data.position < data.duration),
  );
}

// Runs in an isolated world in an already-loaded tab. It only reads DOM/media
// properties: it never starts playback, seeks, reloads or reads account data.
export function readYouTubePlayer(expectedId) {
  const pathId = /^\/(?:shorts|live|embed)\/([^/]+)/.exec(location.pathname)?.[1];
  const id = location.pathname === '/watch' ? new URL(location.href).searchParams.get('v') : pathId;
  if (id !== expectedId) return null;
  const watch = document.querySelector('ytd-watch-flexy');
  if (watch?.getAttribute('video-id') && watch.getAttribute('video-id') !== id) return null;
  const canonical = document.querySelector('link[rel="canonical"]')?.href;
  if (
    canonical &&
    location.pathname === '/watch' &&
    new URL(canonical).searchParams.get('v') !== id
  )
    return null;
  const activeShort = document.querySelector('ytd-reel-video-renderer[is-active]');
  if (activeShort?.getAttribute('video-id') && activeShort.getAttribute('video-id') !== id)
    return null;
  const root = activeShort || document;
  const channel =
    root
      .querySelector(
        '#owner ytd-channel-name a, ytd-video-owner-renderer ytd-channel-name a, .ytReelChannelBarViewModelChannelName, .ytm-channel-info a, ytm-slim-owner-renderer a',
      )
      ?.textContent?.trim() || '';
  const video = root.querySelector('video.html5-main-video') || root.querySelector('video');
  if (!video || !video.readyState || document.querySelector('.ad-showing, .ad-interrupting'))
    return { videoId: id, channel };
  return {
    videoId: id,
    channel,
    duration: Number.isFinite(video.duration) ? video.duration : null,
    position: video.currentTime,
    paused: video.paused,
    ended: video.ended,
    live:
      video.duration === Infinity ||
      Boolean(document.querySelector('.ytp-live-badge:not([disabled])')),
  };
}

export function createYouTubeService({ api, fetcher = globalThis.fetch, now = Date.now } = {}) {
  const data = new Map();
  const metadata = new Map();
  const hydrated = new Map();
  const pending = new Map();
  const savedValues = new Map();
  let allowed = false;
  let running = false;
  let epoch = 0;
  let abort = new AbortController();

  function access(value) {
    if (allowed && !value) {
      epoch++;
      abort.abort();
      abort = new AbortController();
      for (const [id, value] of data) data.set(id, { ...value, current: false });
    }
    allowed = value;
    return allowed;
  }

  function peek(tab) {
    const videoId = youtubeVideoId(tab.url);
    const cached = data.get(tab.id);
    const record = cached?.videoId === videoId ? cached : null;
    const meta = metadata.get(videoId);
    return videoId
      ? {
          videoId,
          ...meta?.value,
          ...record,
          channel: record?.channel || meta?.value?.channel || '',
          duration: record?.duration ?? meta?.value?.duration ?? null,
          // A restored/discarded observation is a position, not evidence of playback.
          paused: tab.discarded || !record?.current || record.paused !== false,
          current: !tab.discarded && record?.current === true,
        }
      : null;
  }

  async function hydrate(tab) {
    const videoId = youtubeVideoId(tab.url);
    if (!videoId || hydrated.get(tab.id) === videoId) return;
    hydrated.set(tab.id, videoId);
    try {
      const saved = await api?.sessions?.getTabValue(tab.id, YOUTUBE_SESSION_KEY);
      // Firefox may copy session values when duplicating a tab. Membership's
      // durable identity distinguishes a restore from a newly duplicated tab.
      if (tab.treeId && saved?.treeId !== tab.treeId) return;
      const value = normaliseVideoData(saved, videoId);
      if (value)
        savedValues.set(
          tab.id,
          JSON.stringify({ ...value, ...(tab.treeId ? { treeId: tab.treeId } : {}) }),
        );
      if (value && !data.has(tab.id)) data.set(tab.id, { ...value, current: false });
    } catch {
      // Session data can disappear while a tab is closing.
    }
  }

  async function publicMetadata(videoId, signal) {
    const cached = metadata.get(videoId);
    if (
      cached &&
      cached.expires > now() &&
      (cached.promise || cached.failed || cached.value?.channel)
    )
      return cached.promise || cached.value;
    const entry = { expires: now() + 300_000, value: cached?.value };
    entry.promise = (async () => {
      try {
        const url = new URL('https://www.youtube.com/oembed');
        url.searchParams.set('url', `https://www.youtube.com/watch?v=${videoId}`);
        url.searchParams.set('format', 'json');
        const response = await fetcher(url.href, {
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        });
        if (!response.ok) {
          entry.failed = true;
          return null;
        }
        const value = await response.json();
        entry.value = {
          ...entry.value,
          channel: typeof value.author_name === 'string' ? value.author_name.slice(0, 200) : '',
        };
        entry.expires = now() + 86_400_000;
        return entry.value;
      } catch {
        entry.failed = true;
        if (signal.aborted) metadata.delete(videoId);
        return null;
      } finally {
        delete entry.promise;
      }
    })();
    metadata.set(videoId, entry);
    if (metadata.size > 200) metadata.delete(metadata.keys().next().value);
    return entry.promise;
  }

  async function read(tab) {
    if (!running || !allowed || !youtubeVideoId(tab.url)) return;
    const videoId = youtubeVideoId(tab.url);
    const token = epoch;
    await hydrate(tab);
    let current;
    try {
      current = await api.tabs.get(tab.id);
      if (youtubeVideoId(current.url) !== videoId || token !== epoch) return;
      if (!current.discarded && current.status !== 'loading') {
        const result = await api.scripting.executeScript({
          target: { tabId: tab.id },
          func: readYouTubePlayer,
          args: [videoId],
        });
        const value = normaliseVideoData(result[0]?.result, videoId);
        if (token !== epoch || youtubeVideoId((await api.tabs.get(tab.id)).url) !== videoId) return;
        if (value) {
          const previous = peek(tab);
          const observed = value.position !== null;
          const merged = {
            ...previous,
            ...value,
            current: observed,
            channel: value.channel || previous?.channel || '',
            duration: value.duration ?? previous?.duration ?? null,
            position: value.position ?? previous?.position ?? null,
          };
          data.set(tab.id, merged);
          if (value.duration || value.channel) {
            const entry = metadata.get(videoId) || { expires: now() + 86_400_000 };
            entry.value = {
              ...entry.value,
              ...(value.channel ? { channel: value.channel } : {}),
              ...(value.duration && !value.live ? { duration: value.duration } : {}),
            };
            metadata.set(videoId, entry);
            if (metadata.size > 200) metadata.delete(metadata.keys().next().value);
          }
        }
      } else if (data.has(tab.id)) data.set(tab.id, { ...data.get(tab.id), current: false });
    } catch {
      // Revoked permission, a closing tab or a restricted page must not break the list.
    }
    if (token !== epoch) return;
    if (!peek(tab)?.channel) {
      const meta = await publicMetadata(videoId, abort.signal);
      if (token !== epoch) return;
      if (meta) data.set(tab.id, { ...peek(tab), ...meta });
    }
    const value = peek(tab);
    if (value && token === epoch) {
      try {
        const saved = {
          ...normaliseVideoData(value, videoId),
          ...(tab.treeId ? { treeId: tab.treeId } : {}),
        };
        const encoded = JSON.stringify(saved);
        if (savedValues.get(tab.id) !== encoded) {
          await api?.sessions?.setTabValue(tab.id, YOUTUBE_SESSION_KEY, saved);
          savedValues.set(tab.id, encoded);
        }
      } catch {
        /* Tab closed. */
      }
    }
  }

  return {
    peek,
    hydrate,

    async permission() {
      return access(
        Boolean(await api?.permissions?.contains({ origins: YOUTUBE_ORIGINS }).catch(() => false)),
      );
    },

    async allow() {
      return access(Boolean(await api?.permissions?.request({ origins: YOUTUBE_ORIGINS })));
    },

    setActive(active) {
      if (running === active) return;
      running = active;
      epoch++;
      abort.abort();
      abort = new AbortController();
      if (!active) for (const [id, value] of data) data.set(id, { ...value, current: false });
    },

    read(tab) {
      const key = `${tab.id}:${youtubeVideoId(tab.url)}`;
      if (!pending.has(key))
        pending.set(
          key,
          read(tab).finally(() => pending.delete(key)),
        );
      return pending.get(key);
    },

    prune(tabs) {
      const ids = new Map(tabs.map((tab) => [tab.id, youtubeVideoId(tab.url)]));
      for (const [id, value] of data) if (ids.get(id) !== value.videoId) data.delete(id);
      for (const [id, videoId] of hydrated) if (ids.get(id) !== videoId) hydrated.delete(id);
      for (const id of savedValues.keys()) if (!ids.has(id)) savedValues.delete(id);
    },
  };
}
