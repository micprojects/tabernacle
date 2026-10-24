import { icon } from './icons.js';
import {
  captureTarget,
  matchesTarget,
  duplicateGroups,
  suggestedDuplicates,
  inCollection,
  sourceUrl,
  viewedAge,
} from './tab-collection.js';
import { createFolderIndex } from './folder-index.js';

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
};

export function batchSummary(result, verb) {
  const parts = [
    `${verb} ${result.completed.length} ${result.completed.length === 1 ? 'tab' : 'tabs'}.`,
  ];
  if (result.skipped.length)
    parts.push(`${result.skipped.length} changed or closed and were skipped.`);
  if (result.failed.length) parts.push(`${result.failed.length} could not be updated. Try again.`);
  return parts.join(' ');
}

export function createCollectionDialogs({ showDialog, getState, request, onChange, onNotice }) {
  let refresh = () => {};

  const submitButton = () => document.getElementById('dialog-submit');

  function closeCollection(scope, tabs) {
    const targets = tabs.map(captureTarget);
    const count = `${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`;
    const pinned = tabs.filter((tab) => tab.pinned).length;
    showDialog({
      title: 'Close these tabs?',
      description: `Close ${count} from these results in this window.${pinned ? ` This includes ${pinned} pinned ${pinned === 1 ? 'tab' : 'tabs'}.` : ''} Other tabs and folders will stay.`,
      input: false,
      submit: `Close ${count}`,

      onSubmit: async () => {
        const next = await request('closeTabSet', { scope, targets });
        onChange(next);
        onNotice(batchSummary(next.batchResult, 'Closed'), Boolean(next.batchResult.failed.length));
      },
    });
    document.getElementById('dialog-icon').replaceChildren(icon('close'));
    submitButton().disabled = !targets.length;
    document.getElementById('dialog-cancel').focus();
  }

  function reviewDuplicates(scope, tabs) {
    const groups = duplicateGroups(tabs);
    const initial = groups.flat().map(captureTarget);
    const selected = new Set(groups.flatMap(suggestedDuplicates));
    const automatic = new Set(selected);
    const nodes = new Map();
    const content = element('div', 'duplicate-review');
    const list = element('div', 'duplicate-groups');
    const note = element('p', 'duplicate-note');
    content.append(list, note);
    let currentGroups = [],
      busy = false;

    const updateSelection = () => {
      if (busy) return;
      const allSelected = currentGroups.some((group) => group.every((tab) => selected.has(tab.id)));
      note.textContent = !currentGroups.length
        ? 'No exact duplicates in these tabs.'
        : allSelected
          ? 'Keep at least one copy of each page.'
          : 'Review the suggested copies to close. Keep at least one copy of each page.';
      submitButton().textContent = `Close ${selected.size} ${selected.size === 1 ? 'tab' : 'tabs'}`;
      submitButton().disabled = !selected.size || allSelected;
    };

    const update = () => {
      if (busy) return;
      const state = getState();
      const folders = createFolderIndex(state);
      const byId = new Map(state.tabs.map((tab) => [tab.id, tab]));
      const candidates = initial
        .filter(
          (target) =>
            matchesTarget(byId.get(target.id), target) &&
            inCollection(state, byId.get(target.id), scope, folders),
        )
        .map((target) => byId.get(target.id));
      currentGroups = duplicateGroups(candidates);
      const alive = new Set(currentGroups.flat().map((tab) => tab.id));
      for (const id of selected) if (!alive.has(id)) selected.delete(id);
      for (const tab of candidates)
        if (automatic.has(tab.id) && (tab.active || tab.pinned || tab.audible))
          selected.delete(tab.id);
      const previousFocus = document.activeElement;
      const focusIndex = [...list.querySelectorAll('input')].indexOf(previousFocus);
      const scroll = content.scrollTop;
      const fragments = [];
      for (const group of currentGroups) {
        const block = element('fieldset', 'duplicate-group');
        block.append(element('legend', '', sourceUrl(group[0])));
        for (const tab of group) {
          if (!nodes.has(tab.id)) {
            const row = element('label', 'duplicate-copy');
            const check = element('input', '');
            check.type = 'checkbox';
            check.addEventListener('change', () => {
              automatic.delete(tab.id);
              if (check.checked) selected.add(tab.id);
              else selected.delete(tab.id);
              // State refreshes and submission revalidate the reviewed targets.
              // A selection change only needs to update the summary and keeper warning.
              updateSelection();
            });
            const copy = element('span', '');
            const title = element('span', 'duplicate-title');
            const details = element('span', 'duplicate-details');
            copy.append(title, details);
            row.append(check, copy);
            nodes.set(tab.id, { row, check, title, details });
          }
          const item = nodes.get(tab.id);
          item.check.checked = selected.has(tab.id);
          item.check.setAttribute('aria-label', `Close ${tab.title || sourceUrl(tab)}`);
          item.title.textContent = tab.title || sourceUrl(tab);
          item.title.title = item.title.textContent;
          item.details.textContent = [
            ['Home', ...folders.path(tab.groupId).map((group) => group.name)].join(' / '),
            tab.container?.name || 'No container',
            tab.pinned ? 'Pinned' : '',
            tab.active ? 'Current tab' : '',
            tab.audible ? 'Playing audio' : '',
            viewedAge(tab.lastAccessed) || 'Last viewed unknown',
          ]
            .filter(Boolean)
            .join(' · ');
          item.details.title =
            item.details.textContent +
            (Number.isFinite(tab.lastAccessed) && tab.lastAccessed > 0
              ? `\n${new Date(tab.lastAccessed).toLocaleString()}`
              : '');
          block.append(item.row);
        }
        fragments.push(block);
      }
      list.replaceChildren(...fragments);
      content.scrollTop = scroll;
      if (focusIndex >= 0 && !previousFocus.isConnected)
        (
          [...list.querySelectorAll('input')][
            Math.min(focusIndex, list.querySelectorAll('input').length - 1)
          ] || document.getElementById('dialog-cancel')
        ).focus({ preventScroll: true });
      if (previousFocus?.isConnected && content.contains(previousFocus))
        previousFocus.focus({ preventScroll: true });
      updateSelection();
    };

    showDialog({
      title: 'Review duplicates',
      input: false,
      content,
      submit: 'Close tabs',

      cleanup: () => {
        refresh = () => {};
      },

      onSubmit: async () => {
        update();
        if (submitButton().disabled) throw new Error('Keep at least one copy of each page.');
        busy = true;
        try {
          const reviewed = new Set(currentGroups.flat().map((tab) => tab.id));
          const next = await request('closeDuplicateTabs', {
            scope,
            targets: initial.filter((target) => reviewed.has(target.id) && selected.has(target.id)),
            keepers: initial.filter(
              (target) => reviewed.has(target.id) && !selected.has(target.id),
            ),
          });
          onChange(next);
          onNotice(
            batchSummary(next.batchResult, 'Closed'),
            Boolean(next.batchResult.failed.length),
          );
        } finally {
          busy = false;
        }
      },
    });
    document.getElementById('dialog-icon').replaceChildren(icon('copy'));
    refresh = update;
    update();
    document.getElementById('dialog-cancel').focus();
  }

  return { closeCollection, reviewDuplicates, refresh: () => refresh() };
}
