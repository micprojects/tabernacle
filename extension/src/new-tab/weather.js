import { MODEL_KEY } from '../model.js';
import { normalizeNewTab } from './preferences.js';

export const WEATHER_ACCESS = {
  origins: ['https://geocoding-api.open-meteo.com/*', 'https://api.open-meteo.com/*'],
  data_collection: ['locationInfo'],
};
const cacheKey = 'tabernacle.weather.v1';
const maxAge = 30 * 60_000;

export function weatherLabel(code) {
  if (code === 0) return 'Clear';
  if ([1, 2].includes(code)) return 'Partly cloudy';
  if (code === 3) return 'Cloudy';
  if ([45, 48].includes(code)) return 'Fog';
  if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow';
  if ([95, 96, 99].includes(code)) return 'Thunderstorms';
  return 'Weather';
}

export function createWeatherService(api, fetcher = fetch) {
  const active = new Set();
  let inFlight;
  let epoch = 0;
  let failedAt = 0;

  function cancel() {
    epoch++;
    failedAt = 0;
    for (const controller of active) controller.abort();
    active.clear();
    inFlight = undefined;
  }

  api.permissions?.onRemoved?.addListener(cancel);
  api.storage.onChanged?.addListener((changes, area) => {
    const signature = (model) =>
      JSON.stringify([
        model?.newTab?.enabled,
        model?.newTab?.weatherEnabled,
        model?.newTab?.location,
      ]);
    if (
      area === 'local' &&
      changes[MODEL_KEY] &&
      signature(changes[MODEL_KEY].oldValue) !== signature(changes[MODEL_KEY].newValue)
    )
      cancel();
  });

  async function access() {
    if (!(await api.permissions.contains(WEATHER_ACCESS)))
      throw new Error('Allow weather access in Settings → New tab.');
  }

  async function json(url) {
    const controller = new AbortController();
    active.add(controller);
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetcher(url, {
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error('Weather is unavailable. Try again later.');
      const data = await response.json();
      if (!data || typeof data !== 'object')
        throw new Error('Weather data is unavailable. Try again later.');
      return data;
    } catch {
      throw new Error('Weather is unavailable. Check your connection and try again later.');
    } finally {
      clearTimeout(timer);
      active.delete(controller);
    }
  }

  async function preferences() {
    const prefs = normalizeNewTab((await api.storage.local.get(MODEL_KEY))[MODEL_KEY]?.newTab);
    if (!prefs.enabled || !prefs.weatherEnabled || !prefs.location) return null;
    await access();
    return prefs;
  }

  return {
    async locations(query) {
      await access();
      if (typeof query !== 'string' || query.trim().length < 2 || query.length > 100)
        throw new Error('Enter a town or city with at least two characters.');
      const version = epoch;
      const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
      url.search = new URLSearchParams({
        name: query.trim(),
        count: '5',
        language: 'en',
        format: 'json',
      });
      const data = await json(url.href);
      if (version !== epoch) throw new Error('Weather settings changed. Try again.');
      return (Array.isArray(data.results) ? data.results : []).slice(0, 5).flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const location = normalizeNewTab({
          location: {
            name: [item.name, item.admin1, item.country].filter(Boolean).join(', ').slice(0, 160),
            latitude: item.latitude,
            longitude: item.longitude,
          },
        }).location;
        return location ? [location] : [];
      });
    },

    async current() {
      const version = epoch;
      const prefs = await preferences();
      if (!prefs || version !== epoch) return null;
      const key = `${prefs.location.latitude},${prefs.location.longitude}`;
      const saved = (await api.storage.local.get(cacheKey))[cacheKey];
      const cached =
        saved?.key === key &&
        [saved.temperature, saved.high, saved.low].every(
          (value) => Number.isFinite(value) && value > -150 && value < 150,
        ) &&
        Number.isInteger(saved.code) &&
        Number.isFinite(saved.fetchedAt) &&
        saved.fetchedAt > 0 &&
        saved.fetchedAt <= Date.now()
          ? saved
          : null;
      if (version !== epoch) return null;
      if (cached && Date.now() - cached.fetchedAt < maxAge) return cached;
      if (inFlight?.key === key) return inFlight.promise;
      if (Date.now() - failedAt < 60_000) {
        if (cached) return { ...cached, stale: true };
        throw new Error('Weather is unavailable. Try again in a minute.');
      }
      const promise = (async () => {
        try {
          const url = new URL('https://api.open-meteo.com/v1/forecast');
          url.search = new URLSearchParams({
            latitude: String(prefs.location.latitude),
            longitude: String(prefs.location.longitude),
            current: 'temperature_2m,weather_code',
            daily: 'temperature_2m_max,temperature_2m_min',
            forecast_days: '1',
            timezone: 'auto',
            timeformat: 'unixtime',
          });
          const data = await json(url.href);
          const result = {
            key,
            temperature: data.current?.temperature_2m,
            code: data.current?.weather_code,
            high: data.daily?.temperature_2m_max?.[0],
            low: data.daily?.temperature_2m_min?.[0],
            fetchedAt: Date.now(),
          };
          if (
            ![result.temperature, result.high, result.low].every(
              (value) => Number.isFinite(value) && value > -150 && value < 150,
            ) ||
            !Number.isInteger(result.code)
          )
            throw new Error('Weather data is incomplete. Try again later.');
          const latest = await preferences();
          if (version !== epoch || !latest) return null;
          await api.storage.local.set({ [cacheKey]: result });
          failedAt = 0;
          return result;
        } catch (error) {
          if (version !== epoch) return null;
          failedAt = Date.now();
          if (cached) return { ...cached, stale: true };
          throw error;
        } finally {
          if (inFlight?.promise === promise) inFlight = undefined;
        }
      })();
      inFlight = { key, promise };
      return promise;
    },
  };
}
