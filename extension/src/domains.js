import { domainFromUrl, normaliseDomain } from './domain-filter.js';
import { isSavedForLater } from './model.js';

export function normaliseDomainPins(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(normaliseDomain).filter(Boolean))];
}

// Only offer hosts present in this window. Include their child hosts in the
// count, just as the existing domain filter does, without guessing base domains.
export function listDomains(tabs, pins = []) {
  const hosts = new Map();
  for (const tab of tabs) {
    if (isSavedForLater(tab)) continue;
    const domain = domainFromUrl(tab.url);
    if (!domain) continue;
    let entry = hosts.get(domain);
    if (!entry) {
      entry = { domain, count: 0, ownCount: 0, source: tab };
      hosts.set(domain, entry);
    }
    entry.count++;
    entry.ownCount++;
    if (!entry.source.favIconUrl && tab.favIconUrl) entry.source = tab;
  }
  for (const entry of hosts.values()) {
    let parent = entry.domain;
    while (parent.includes('.')) {
      parent = parent.slice(parent.indexOf('.') + 1);
      const ancestor = hosts.get(parent);
      if (ancestor) ancestor.count += entry.ownCount;
    }
  }
  const pinned = new Set(pins);
  return [...hosts.values()]
    .filter(({ count }) => count > 1)
    .map(({ ownCount, ...entry }) => ({ ...entry, pinned: pinned.has(entry.domain) }))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.count - a.count ||
        a.domain.localeCompare(b.domain),
    );
}
