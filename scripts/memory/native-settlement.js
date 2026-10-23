import assert from 'node:assert/strict';

// This reads the established authoritative index, not a renderer or DOM subset.
// A nonempty search expands matching paths; ordinary navigation honours folds.
export function expectedSidebar(state, index, searchTabOrder, query = '') {
  query = query.trim().toLowerCase();
  const ids = [];
  if (query && searchTabOrder) ids.push(...searchTabOrder(state, query));
  else {
    const collapsed = new Set(state.view.collapsed);
    const pending = [{ groupId: state.view.scopeId, match: !query }];
    while (pending.length) {
      const item = pending.pop();
      if (item.tab) {
        const stats = index.tabStats?.get(item.tab.id);
        if (query && !item.match && !stats.match && !stats.descendantMatch) continue;
        ids.push(item.tab.id);
        if (query || !item.tab.collapsed)
          for (const tab of [...(index.children.get(item.tab.id) || [])].reverse())
            pending.push({ tab, match: item.match || stats?.match });
      } else {
        for (const tab of [...(index.roots.get(item.groupId) || [])].reverse())
          pending.push({ tab, match: item.match });
        for (const group of [...(index.groupChildren.get(item.groupId) || [])].reverse()) {
          if (query ? item.match || index.groupStats.get(group.id).match : !collapsed.has(group.id))
            pending.push({
              groupId: group.id,
              match: item.match || (Boolean(query) && group.name.toLowerCase().includes(query)),
            });
        }
      }
    }
  }
  const byId = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const byTreeId = new Map(state.tabs.map((tab) => [tab.treeId, tab]));
  return {
    rows: ids.map((id) => ({ id, title: byId.get(id).title || 'New tab' })),
    pins: (state.pins || [])
      .filter((pin) => pin.kind === 'tab')
      .map((pin) => {
        const tab = byTreeId.get(pin.id);
        assert(tab, 'Pinned target is absent from the authoritative snapshot.');
        return { id: tab.id, labelPrefix: `${tab.title || 'New tab'}, pinned` };
      }),
  };
}

export function snapshotMatchesNative(snapshot, nativeTabs, windowId) {
  if (snapshot.windowId !== undefined && snapshot.windowId !== windowId) return false;
  if (snapshot.tabs.length !== nativeTabs.length) return false;
  const nativeById = new Map(nativeTabs.map((tab) => [tab.id, tab]));
  return (
    nativeById.size === nativeTabs.length &&
    new Set(snapshot.tabs.map((tab) => tab.id)).size === nativeTabs.length &&
    snapshot.tabs.every((tab) => {
      const native = nativeById.get(tab.id);
      return (
        native &&
        native.windowId === windowId &&
        tab.windowId === windowId &&
        tab.title === native.title
      );
    })
  );
}

export function sidebarMatches(observed, expected) {
  return Boolean(
    observed.ready &&
    !observed.errorToast &&
    !observed.duplicateRows?.length &&
    observed.pendingImages === 0 &&
    observed.brokenImages === 0 &&
    observed.fontsLoaded &&
    observed.query === expected.query &&
    Object.entries(expected.visibility || {}).every(([key, value]) => observed[key] === value) &&
    JSON.stringify(observed.rows) === JSON.stringify(expected.rows) &&
    observed.pins.length === expected.pins.length &&
    observed.pins.every(
      (pin, i) =>
        pin.id === expected.pins[i].id && pin.label.startsWith(expected.pins[i].labelPrefix),
    ),
  );
}

// Deliberately uses host timers: rAF may stop in hidden/minimised documents.
export async function waitForStableObservation(
  read,
  {
    matches = () => true,
    timeoutMs = 15000,
    intervalMs = 100,
    stableSamples = 3,
    now = Date.now,
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    progress = () => {},
    label = 'native sidebar',
  } = {},
) {
  const started = now();
  let previous;
  let stable = 0;
  let observation;
  let samples = 0;
  do {
    observation = await read();
    samples++;
    const signature = JSON.stringify(observation);
    stable = matches(observation) ? (signature === previous ? stable + 1 : 1) : 0;
    previous = signature;
    progress({ label, samples, stable, elapsedMs: now() - started });
    if (stable >= stableSamples)
      return { observation, samples, stableSamples: stable, elapsedMs: now() - started };
    await wait(intervalMs);
  } while (now() - started < timeoutMs);
  const error = new Error(
    `${label} did not reach the expected stable state within ${timeoutMs}ms.`,
  );
  error.observation = observation;
  throw error;
}

export async function measureSettledNative(settle, collectMemory) {
  const settled = await settle();
  const beforeCollection = await collectMemory(false);
  const afterCollection = await collectMemory(true);
  const after = await settled.read();
  assert(settled.matches(after), 'Sidebar contents changed while memory reporters ran.');
  return {
    settled: settled.summary,
    beforeCollection,
    afterCollection,
    dom: settled.compact(after),
  };
}

export async function sidebarTargets(browser) {
  return browser.chrome(() =>
    [...Services.wm.getEnumerator('navigator:browser')]
      .map((win) => {
        const box = win.document.getElementById('sidebar-box');
        const panel = win.document
          .getElementById('sidebar')
          ?.contentDocument?.getElementById('webext-panels-browser');
        const global = panel?.browsingContext?.currentWindowGlobal;
        const uri = global?.documentURI.spec || null;
        return {
          windowKey: win.windowGlobalChild.innerWindowId,
          target:
            uri?.startsWith('moz-extension:') && uri.endsWith('/sidebar.html')
              ? global.innerWindowId
              : null,
          uri,
          hidden:
            !box ||
            box.hidden ||
            win.getComputedStyle(box).display === 'none' ||
            win.getComputedStyle(box).visibility === 'hidden',
          open: Boolean(win.SidebarController.isOpen),
          minimised: win.windowState === win.STATE_MINIMIZED,
        };
      })
      .sort((a, b) => a.windowKey - b.windowKey),
  );
}

export async function evaluateSidebarTarget(browser, target, fn, ...args) {
  const expression = `(async()=>{try{return JSON.stringify({ok:true,value:await (${fn.toString()})(...${JSON.stringify(args)})??null})}catch(error){return JSON.stringify({ok:false,error:error.stack||error.message})}})()`;
  const json = await browser.chrome(
    async (target, expression) => {
      const response = await window.tabernacleScreenshotCommands.scriptCommand.execute(expression, {
        innerWindowID: target,
      });
      if (response.exceptionMessage) throw new Error(String(response.exceptionMessage));
      const promise = response.result;
      let stringFront;
      try {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const { promiseState } = await promise.getPromiseState();
          if (promiseState.state === 'fulfilled') {
            const value = promiseState.value;
            if (typeof value === 'string') return value;
            stringFront = value;
            return await value.string();
          }
          if (promiseState.state === 'rejected')
            throw new Error('Sidebar target evaluation rejected');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('Sidebar target evaluation timed out');
      } finally {
        // Firefox's longStringSpec exposes release; SimpleStringFront implements
        // it too. Free the resolved string actor as well as its parent promise.
        try {
          await stringFront?.release();
        } finally {
          await promise.release();
        }
      }
    },
    target,
    expression,
  );
  const result = JSON.parse(json);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

export async function observeSidebar({ traverse = false } = {}) {
  let completeRows;
  const duplicateRows = new Set();
  if (traverse) {
    const tree = document.getElementById('tree');
    const saved = { top: tree.scrollTop, left: tree.scrollLeft };
    const records = new Map();

    const collect = async (top) => {
      tree.scrollTop = top;
      // Both baseline and candidate traverse the same viewport positions.
      // A real scroll event also updates a virtual renderer before observation.
      tree.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const origin = tree.getBoundingClientRect().top;
      for (const row of tree.querySelectorAll('.tab-row')) {
        const bounds = row.getBoundingClientRect();
        if (bounds.bottom <= origin || bounds.top >= origin + tree.clientHeight) continue;
        const id = Number(row.dataset.id);
        const position = bounds.top - origin + tree.scrollTop;
        if (records.has(id) && Math.abs(records.get(id).position - position) > 0.5)
          duplicateRows.add(id);
        records.set(id, {
          id,
          title: row.querySelector('.label')?.textContent ?? null,
          position,
        });
      }
    };

    try {
      const step = Math.max(1, tree.clientHeight - 60);
      const maximum = Math.max(0, tree.scrollHeight - tree.clientHeight);
      for (let top = 0; top < maximum; top += step) await collect(top);
      await collect(maximum);
      completeRows = [...records.values()]
        .sort((a, b) => a.position - b.position)
        .map(({ id, title }) => ({ id, title }));
    } finally {
      tree.scrollTop = saved.top;
      tree.scrollLeft = saved.left;
      tree.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    }
  }
  return {
    ready: Boolean(document.getElementById('tree')) && document.readyState === 'complete',
    duplicateRows: [...duplicateRows],
    rows:
      completeRows ||
      [...document.querySelectorAll('#tree .tab-row')].map((row) => ({
        id: Number(row.dataset.id),
        title: row.querySelector('.label')?.textContent ?? null,
      })),
    pins: [...document.querySelectorAll('#pinned-tabs .pinned-tab:not(.pinned-folder)')].map(
      (row) => ({
        id: Number(row.dataset.key?.slice(4)),
        label: row.getAttribute('aria-label') || '',
      }),
    ),
    elements: document.querySelectorAll('*').length,
    tabRows: document.querySelectorAll('#tree .tab-row').length,
    images: document.images.length,
    pendingImages: [...document.images].filter((image) => !image.complete).length,
    brokenImages: [...document.images].filter((image) => image.complete && !image.naturalWidth)
      .length,
    fontsLoaded: document.fonts.status === 'loaded',
    errorToast: document.querySelector('#toast.error:not([hidden])')?.textContent || null,
    query: document.getElementById('search')?.value || '',
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    focused: document.hasFocus(),
  };
}

export function validateNativeVariation(
  variation,
  { sourceSha256, harnessSha256, fixture, environment },
) {
  const fail = (message) => assert(false, `Invalid native A/A baseline: ${message}`);
  if (variation.status !== 'completed' || variation.kind !== 'native-comparison')
    fail('report is incomplete.');
  if (variation.harness?.sha256 !== harnessSha256) fail('settlement harness differs.');
  if (JSON.stringify(variation.environment) !== JSON.stringify(environment))
    fail('machine or Node runtime differs.');
  if (['tabs', 'windows', 'seed'].some((key) => variation.fixture?.[key] !== fixture[key]))
    fail('fixture topology differs.');
  if (!Array.isArray(variation.runs) || variation.runs.length < 10)
    fail('at least five complete A/A pairs are required.');
  const pairs = new Map();
  const first = variation.runs[0].result;
  if (!first?.fixture?.sha256 || !first?.environment?.firefox)
    fail('fixture fingerprint or Firefox version is absent.');
  for (const run of variation.runs) {
    if (run.source?.sha256 !== sourceSha256 || run.result?.source?.sha256 !== sourceSha256)
      fail('source fingerprint differs.');
    if (run.guard?.status !== 'completed' || run.result?.status !== 'completed')
      fail('a sample did not complete.');
    if (run.result.harness?.sha256 !== harnessSha256) fail('a worker used a different harness.');
    if (
      run.result.fixture?.sha256 !== first.fixture.sha256 ||
      run.result.environment?.firefox !== first.environment.firefox
    )
      fail('worker fixture or Firefox version differs.');
    if (!['baseline', 'candidate'].includes(run.role) || !Number.isSafeInteger(run.pair))
      fail('invalid role or pair.');
    const roles = pairs.get(run.pair) || [];
    roles.push(run.role);
    pairs.set(run.pair, roles);
  }
  if (
    pairs.size < 5 ||
    [...pairs.values()].some(
      (roles) => roles.length !== 2 || !roles.includes('baseline') || !roles.includes('candidate'),
    )
  )
    fail('pairs must contain exactly one sample per role.');
  return { fixtureSha256: first.fixture.sha256, firefox: first.environment.firefox };
}

export function completeNativePhase(runs, name, expectedCount, metric) {
  return (
    runs.length === expectedCount &&
    runs.every((run) => {
      const phase = run.phases.find((item) => item.name === name);
      return (
        run.guard?.status === 'completed' &&
        run.result?.status === 'completed' &&
        phase &&
        phase.supported !== false &&
        Number.isFinite(metric(phase))
      );
    })
  );
}

export function sendNativeResult(result, send = process.send.bind(process)) {
  return new Promise((resolve, reject) => {
    send({ type: 'result', result }, (error) => (error ? reject(error) : resolve()));
  });
}
