// Match hostnames, never a domain mentioned in a title, path or query string.
export function normaliseDomain(value) {
  if (typeof value !== 'string' || !value || /[\s/@?#\\]/u.test(value)) return null;
  // DNS names and IPv4 addresses; bracketed IPv6 addresses are also valid hosts.
  if (value.includes(':') && !/^\[[\da-f:.]+\]$/i.test(value)) return null;
  try {
    const { hostname } = new URL(`https://${value}`);
    const domain = hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^www\./, '');
    if (!domain || domain.length > 253) return null;
    if (
      !domain.startsWith('[') &&
      !domain.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
    )
      return null;
    return domain;
  } catch {
    return null;
  }
}

export function domainFromUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? normaliseDomain(url.hostname) : null;
  } catch {
    return null;
  }
}

export function matchesDomain(tab, domain, query = '') {
  const host = domainFromUrl(tab.url);
  return Boolean(
    host &&
    (host === domain || host.endsWith(`.${domain}`)) &&
    `${tab.title || ''} ${tab.url || ''}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
}

const titles = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function byTime(a, b, key, direction) {
  const left = Number.isFinite(a[key]) && a[key] > 0 ? a[key] : null;
  const right = Number.isFinite(b[key]) && b[key] > 0 ? b[key] : null;
  // Unknown dates follow dated tabs. Ties retain the full tree's reading order.
  if (left === null || right === null) return Number(left === null) - Number(right === null);
  return (left - right) * direction;
}

// Start in the full tree's reading order (pins first), ignoring folds and folder
// scope. Sorting affects only this projection, never the underlying tab tree.
export function domainResults(index, domain, query = '', sort = 'newest') {
  const ordered = [...index.byId.values()]
    .filter((tab) => tab.pinned)
    .sort((a, b) => a.index - b.index);
  const pending = [{ groupId: null }];
  while (pending.length) {
    const item = pending.pop();
    if (item.tab) {
      ordered.push(item.tab);
      const children = index.children.get(item.tab.id) || [];
      for (let i = children.length - 1; i >= 0; i--) pending.push({ tab: children[i] });
    } else {
      const tabs = index.roots.get(item.groupId) || [];
      for (let i = tabs.length - 1; i >= 0; i--) pending.push({ tab: tabs[i] });
      const groups = index.groupChildren.get(item.groupId) || [];
      for (let i = groups.length - 1; i >= 0; i--) pending.push({ groupId: groups[i].id });
    }
  }
  const results = ordered.filter((tab) => matchesDomain(tab, domain, query));
  switch (sort) {
    case 'tree':
      return results;
    case 'title':
      return results.sort((a, b) => titles.compare(a.title || a.url || '', b.title || b.url || ''));
    case 'viewed':
      return results.sort((a, b) => byTime(a, b, 'lastAccessed', -1));
    case 'oldest':
      return results.sort((a, b) => byTime(a, b, 'openedAt', 1));
    default:
      return results.sort((a, b) => byTime(a, b, 'openedAt', -1));
  }
}
