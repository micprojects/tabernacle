import { domainResults } from '../domain-filter.js';
import { createTreeIndex } from './index.js';
import { savedSearchResults, matchesText } from '../tab-collection.js';

const emptyChildren = Object.freeze([]);

// Inspection-only metadata is derived on demand. Row builders already own the
// rendered labels and ARIA attributes, so retaining a second object per field
// would duplicate that data for every tab and insertion action.
const rowPrototype = {
  children: emptyChildren,

  get aria() {
    return {
      role: 'treeitem',
      level: this.depth + 1,
      ...(this.disclosure ? { expanded: this.expanded } : {}),
      ...(this.kind === 'tab' ? { selected: Boolean(this.tab.active) } : {}),
    };
  },

  get target() {
    if (this.kind !== 'new-tab') return { kind: this.kind, id: this.id };
    return this.parentTab
      ? { kind: 'newChildTab', id: this.parentTab.id }
      : { kind: 'newTab', groupId: this.groupId };
  },

  get label() {
    if (this.kind !== 'new-tab') return undefined;
    return this.parentTab
      ? `New child tab of ${this.parentTab.title || 'New tab'}`
      : this.groupName !== undefined
        ? `New tab in ${this.groupName}`
        : 'New tab';
  },

  get drop() {
    if (this.kind !== 'new-tab') return undefined;
    return {
      kind: this.parentTab ? 'tab' : 'inside',
      id: this.parentTab?.id ?? this.groupId,
    };
  },
};

const record = (fields) => Object.assign(Object.create(rowPrototype), fields);

// Keep one current collection, not a history of snapshots or query results.
// Callers clear on accepted state, in-place changes and view release.
export function createDomainTreeProjector() {
  let cached = null;
  return {
    project(state, { domain, query = '', sort = 'newest' } = {}) {
      if (typeof domain !== 'string' || !domain) throw new TypeError('A domain is required');
      if (!cached || cached.state !== state || cached.domain !== domain || cached.sort !== sort) {
        const index = cached?.state === state ? cached.index : createTreeIndex(state);
        const tabs = Object.freeze(domainResults(index, domain, '', sort));
        cached = { state, index, domain, sort, tabs };
      }
      return projectTree(state, cached.index, { query, domain, sort }, cached.tabs);
    },

    clear() {
      cached = null;
    },
  };
}

// The existing index owns hierarchy, promotion of children of pinned tabs and
// ordering. This projection never edits it. Logical rows include folded and
// filtered-out items; visible rows are a separate rendering/navigation view.
// The state-bound domain projector may supply its owned, sorted collection.
export function projectTree(
  state,
  index,
  { query = '', domain = null, sort = 'newest' } = {},
  domainCollection = null,
) {
  query = query.trim().toLowerCase();
  const collapsed = new Set(state.view.collapsed);

  const build = (includeHidden) => {
    const roots = [];
    const logicalRows = [];
    const byKey = new Map();

    const add = (row, destination) => {
      destination.push(row);
      logicalRows.push(row);
      byKey.set(row.key, row);
      return row;
    };

    const flatTab = (tab, mode) =>
      record({
        key: `tab:${tab.id}`,
        kind: 'tab',
        id: tab.id,
        tab,
        depth: 0,
        parentKey: null,
        mode,
        expanded: true,
        disclosure: false,
        stats: { descendants: 0, active: tab.active },
        matchesFilter: true,
        visible: true,
      });
    let domainTabs = [];
    if (domain) {
      domainTabs = domainCollection ?? domainResults(index, domain, '', sort);
      for (const tab of domainTabs) {
        const row = flatTab(tab, 'domain');
        row.matchesFilter = matchesText(tab, query);
        row.visible = row.matchesFilter;
        add(row, roots);
      }
    } else {
      const pending = [];

      const children = (groupId, destination, depth, parentKey, visible, ancestorMatch) => {
        if (!query)
          pending.push({ kind: 'new-tab', groupId, destination, depth, parentKey, visible });
        const tabs = index.roots.get(groupId) || [];
        for (let i = tabs.length - 1; i >= 0; i--)
          pending.push({
            kind: 'tab',
            tab: tabs[i],
            destination,
            depth,
            parentKey,
            visible,
            ancestorMatch,
          });
        const groups = index.groupChildren.get(groupId) || [];
        for (let i = groups.length - 1; i >= 0; i--)
          pending.push({
            kind: 'group',
            group: groups[i],
            destination,
            depth,
            parentKey,
            visible,
            ancestorMatch,
          });
      };

      children(
        state.view.scopeId,
        roots,
        0,
        state.view.scopeId === null ? null : `group:${state.view.scopeId}`,
        true,
        false,
      );
      while (pending.length) {
        const item = pending.pop();
        const { destination, depth, parentKey } = item;
        if (item.kind === 'new-tab') {
          const parentTabId = item.parentTab?.id ?? null;
          const group = index.groups.get(item.groupId);
          add(
            record({
              key:
                parentTabId === null ? `new-tab:${item.groupId}` : `new-child-tab:${parentTabId}`,
              kind: 'new-tab',
              id: parentTabId ?? item.groupId,
              groupId: item.groupId,
              parentTab: item.parentTab || null,
              depth,
              parentKey,
              mode: 'tree',
              groupName: group?.name,
              visible: item.visible,
              matchesFilter: true,
            }),
            destination,
          );
          continue;
        }
        const group = item.group;
        const tab = item.tab;
        const stats = group ? index.groupStats.get(group.id) : index.tabStats.get(tab.id);
        const ownMatch = group ? group.name.toLowerCase().includes(query) : stats.match;
        const matchesFilter =
          !query ||
          item.ancestorMatch ||
          (group ? stats.match : stats.match || stats.descendantMatch);
        const expanded = Boolean(query) || (group ? !collapsed.has(group.id) : !tab.collapsed);
        const id = group?.id ?? tab.id;
        const disclosure = Boolean(group || stats.descendants);
        const row = add(
          record({
            key: `${item.kind}:${id}`,
            kind: item.kind,
            id,
            ...(group ? { group } : { tab }),
            depth,
            parentKey,
            mode: 'tree',
            expanded,
            disclosure,
            stats,
            matchesFilter: Boolean(matchesFilter),
            visible: Boolean(item.visible && matchesFilter),
          }),
          destination,
        );
        const visible = row.visible && expanded;
        const ancestorMatch = item.ancestorMatch || (Boolean(query) && ownMatch);
        if (!includeHidden && !visible) continue;
        if (group || stats.descendants) row.children = [];
        if (group) children(group.id, row.children, depth + 1, row.key, visible, ancestorMatch);
        else if (stats.descendants) {
          if (!query)
            pending.push({
              kind: 'new-tab',
              groupId: tab.groupId,
              parentTab: tab,
              destination: row.children,
              depth: depth + 1,
              parentKey: row.key,
              visible,
            });
          const nested = index.children.get(tab.id) || [];
          for (let i = nested.length - 1; i >= 0; i--)
            pending.push({
              kind: 'tab',
              tab: nested[i],
              destination: row.children,
              depth: depth + 1,
              parentKey: row.key,
              visible,
              ancestorMatch,
            });
        }
      }
    }
    return { roots, logicalRows, byKey, domainTabs };
  };

  const shown = build(false);
  const { roots, byKey, domainTabs } = shown;
  const saved = domain
    ? []
    : savedSearchResults(state, query, state.view.scopeId, index.folders).map((tab) =>
        record({
          key: `tab:${tab.id}`,
          kind: 'tab',
          id: tab.id,
          tab,
          depth: 0,
          parentKey: null,
          mode: 'saved',
          expanded: true,
          disclosure: false,
          stats: { descendants: 0, active: tab.active },
          matchesFilter: true,
          visible: true,
        }),
      );
  for (const row of saved) byKey.set(row.key, row);
  const tabPins = new Map(state.tabs.filter((tab) => tab.pinned).map((tab) => [tab.treeId, tab]));
  const folderPins = new Map((state.folderPins || []).map((pin) => [pin.id, pin]));
  const pins = domain
    ? []
    : (state.pins || []).map((pin) => {
        const tab = pin.kind === 'tab' ? tabPins.get(pin.id) : null;
        return {
          kind: tab ? 'pin-tab' : 'pin-group',
          key: tab ? `tab:${tab.id}` : `pin:group:${pin.id}`,
          id: tab?.id ?? pin.id,
          ...(tab ? { tab } : { group: folderPins.get(pin.id) }),
          target: { kind: pin.kind, id: tab?.id ?? pin.id },
        };
      });
  for (const row of pins) byKey.set(row.key, row);
  const visibleRows =
    !saved.length && shown.logicalRows.every((row) => row.visible)
      ? shown.logicalRows
      : [...shown.logicalRows.filter((row) => row.visible), ...saved];
  // Hidden hierarchy stays in the authoritative index. Materialise its records
  // only for an explicit logical/action inspection, never for a folded render.
  const logicalRows = () => build(true).logicalRows;
  const matchingRows = () =>
    query || domain ? visibleRows : logicalRows().filter((row) => row.matchesFilter);
  const lookup = (key) => byKey.get(key) || logicalRows().find((row) => row.key === key);
  return {
    get source() {
      return state;
    },

    set source(next) {
      state = next;
    },

    index,
    query,
    domain,
    sort,
    roots,
    hierarchy: index,
    materializedRows: shown.logicalRows.length + saved.length + pins.length,
    materializedByKey: byKey,

    get logicalRows() {
      return logicalRows();
    },

    get matchingRows() {
      return matchingRows();
    },

    visibleRows,
    visibleKeys: { has: (key) => Boolean(byKey.get(key)?.visible) },
    byKey: { get: lookup, has: (key) => Boolean(lookup(key)) },
    pins,
    saved,
    domainTabs,

    // These targets come from the complete matching collection, never a DOM
    // slice or collapsed/navigation subset. Controller protections still apply.
    get filterTabIds() {
      return matchingRows()
        .filter((row) => row.kind === 'tab')
        .map((row) => row.id);
    },

    get closeTabIds() {
      return matchingRows()
        .filter((row) => row.kind === 'tab' && !row.tab.pinned)
        .map((row) => row.id);
    },
  };
}
