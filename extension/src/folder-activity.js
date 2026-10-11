// Expansion activity is separate from entered folders so the original history
// panel keeps its existing contents. Only deliberate expansions are recorded.
export function recordExpansions(view, ids, now = Date.now()) {
  const expanded = new Set(ids);
  if (!expanded.size) return;
  view.recentExpandedFolders = [
    ...[...expanded].map((id) => ({ id, expandedAt: now })),
    ...(view.recentExpandedFolders ?? []).filter(({ id }) => !expanded.has(id)),
  ].slice(0, 100);
}

export function normalizeExpansions(groups, entries) {
  const valid = new Set(groups.map(({ id }) => id));
  const seen = new Set();
  return (Array.isArray(entries) ? entries : [])
    .filter(
      (entry) => valid.has(entry?.id) && Number.isFinite(entry.expandedAt) && entry.expandedAt > 0,
    )
    .sort((a, b) => b.expandedAt - a.expandedAt)
    .filter(({ id }) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, 100)
    .map(({ id, expandedAt }) => ({ id, expandedAt }));
}
