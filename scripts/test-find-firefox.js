import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { ScreenshotBrowser } from './screenshot-browser.js';

// Use Firefox's own Finder against the actual sidebar and extension tabs.
// New Tab already rebuilds on visible refresh; its first Find Again can lose
// selection. Fresh Find must still discover the complete rendered collection.
const sourceRoot = resolve('.');
const output = resolve('test-results/find-firefox/report.json');
const expectRelease = true;
const browser = new ScreenshotBrowser();
const observations = [];
const report = { sourceRoot, status: 'running', observations, failures: [] };
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(
    `<!doctype html><title>SavedNeedle ${request.url}</title><p>Local lifecycle fixture</p>`,
  );
});
await mkdir(dirname(output), { recursive: true });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
process.chdir(sourceRoot);
const wait = (work, message) => browser.driver.wait(work, 15000, message);

// Use the sidebar's existing one-shot bridge, and the same document-bound
// mechanism for extension tabs. Do not attach DevTools or activate hidden tabs.
async function evaluateTarget(target, fn, ...args) {
  if (target === 'sidebar') return browser.evaluate(fn, ...args);
  if (!target.startsWith(browser.sidebarUrl.slice(0, browser.sidebarUrl.lastIndexOf('/') + 1)))
    throw new Error('Evaluation target is outside the installed extension');
  const values = JSON.stringify(JSON.stringify(args));
  const expression = `(async()=>{try{return JSON.stringify({ok:true,value:await (${fn.toString()})(...JSON.parse(${values}))??null})}catch(error){return JSON.stringify({ok:false,error:String(error)+'\\n'+(error?.stack||'')})}})()`;
  const json = await browser.chrome(
    async (id, expression, url) => {
      const tab = gBrowser.browsers.find((tab) => tab.currentURI.spec === url);
      const global = tab?.browsingContext?.currentWindowGlobal;
      if (!global || global.documentURI.spec !== url)
        throw new Error('Missing extension document: ' + url);
      const innerWindowId = global.innerWindowId;
      const name = `TabernacleFindTest:${id}`;
      const script = `(async()=>{try{
        const compiled=await ChromeUtils.compileScript(
          ${JSON.stringify('data:text/javascript,' + encodeURIComponent(expression))},
          {hasReturnValue:true,filename:'tabernacle-find-test'});
        if(content.document.documentURI!==${JSON.stringify(url)} ||
           content.windowGlobalChild.innerWindowId!==${JSON.stringify(innerWindowId)})
          throw new Error('Document changed before evaluation');
        const json=await compiled.executeInGlobal(content,{reportExceptions:false});
        sendAsyncMessage(${JSON.stringify(name)},{json});
      }catch(error){sendAsyncMessage(${JSON.stringify(name)},{error:String(error)+'\\n'+(error?.stack||'')})}})();`;
      const manager = tab.messageManager;
      return new Promise((resolve, reject) => {
        let finished = false;

        const finish = (error, value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          try {
            manager.removeMessageListener(name, listener);
          } catch {
            // Navigation may already have discarded the document.
          }
          if (error) reject(error);
          else resolve(value);
        };

        const listener = (message) => {
          const current = tab.browsingContext?.currentWindowGlobal;
          if (current?.innerWindowId !== innerWindowId || current.documentURI.spec !== url)
            finish(new Error('Document changed during evaluation'));
          else if (message.data.error) finish(new Error(message.data.error));
          else finish(null, message.data.json);
        };

        const timeout = setTimeout(() => finish(new Error('Target evaluation timed out')), 15000);
        try {
          manager.addMessageListener(name, listener);
          manager.loadFrameScript(
            'data:application/javascript,' + encodeURIComponent(script),
            false,
            false,
          );
        } catch (error) {
          finish(error);
        }
      });
    },
    crypto.randomUUID(),
    expression,
    target,
  );
  const result = JSON.parse(json);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const selectPage = (url) =>
  browser.chrome((url) => {
    const tab = gBrowser.browsers.find((tab) => tab.currentURI.spec === url);
    if (!tab) throw new Error('No tab at ' + url);
    gBrowser.selectedTab = gBrowser.getTabForBrowser(tab);
  }, url);

const selection = (target) =>
  evaluateTarget(target, () => {
    const value = getSelection();
    const range = value?.rangeCount ? value.getRangeAt(0) : null;
    const element =
      range?.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range?.startContainer.parentElement;
    return {
      text: value?.toString(),
      collapsed: value?.isCollapsed,
      key:
        element?.closest('[data-key]')?.dataset.key ||
        element?.closest('.later-row')?.dataset.id ||
        null,
      connected: Boolean(range?.startContainer.isConnected),
    };
  });

async function armResume(target, name) {
  await evaluateTarget(
    target,
    (name) => {
      const activity = name === 'activity';
      const node = document.getElementById(activity ? 'activity-results' : 'new-tab-content');
      window.lifecycleResumeRendered = false;
      const observer = new MutationObserver(() => {
        if (document.hidden) return;
        if (activity && node.getAttribute('aria-busy') !== 'false') return;
        window.lifecycleResumeRendered = true;
        observer.disconnect();
      });
      observer.observe(
        node,
        activity
          ? { attributes: true, attributeFilter: ['aria-busy'] }
          : { childList: true, subtree: true },
      );
    },
    name,
  );
}

async function find(target, needle, again = false) {
  return browser.chrome(
    async (target, needle, again) => {
      const panel = document
        .getElementById('sidebar')
        .contentDocument.getElementById('webext-panels-browser');
      const tab = target === 'sidebar' ? panel : gBrowser.selectedBrowser;
      if (target !== 'sidebar' && tab.currentURI.spec !== target)
        throw new Error('Find targeted the wrong page');
      // Normal Firefox Find is attached to gBrowser's selected tab. The sidebar
      // has no native Find bar; use its native Finder directly for discovery only.
      const bar = target === 'sidebar' ? null : await gBrowser.getFindBar();
      const finder = tab.finder;
      if (!finder?.addResultListener) throw new Error('Firefox Finder is unavailable on ' + target);
      if (bar) {
        bar.open(bar.FIND_NORMAL);
        bar.toggleHighlight(true);
      } else finder.onHighlightAllChange(true);
      return new Promise((resolve, reject) => {
        const seen = {};
        const timer = setTimeout(
          () => finish(new Error('Native Find timed out: ' + JSON.stringify(seen))),
          10000,
        );

        const finish = (error) => {
          clearTimeout(timer);
          finder.removeResultListener(listener);
          if (error) reject(error);
          else resolve(seen);
        };

        const complete = () => {
          if (seen.find && seen.matches && seen.highlight) finish();
        };

        const listener = {
          onFindResult(data) {
            if (data.searchString !== needle) return;
            seen.find = { result: data.result, searchString: data.searchString };
            complete();
          },

          onMatchesCountResult(data) {
            if (data.searchString !== needle) return;
            seen.matches = { total: data.total, current: data.current, limit: data.limit };
            complete();
          },

          onHighlightFinished(data) {
            if (data.searchString !== needle) return;
            seen.highlight = { found: data.found, highlight: data.highlight };
            complete();
          },

          onCurrentSelection() {},
        };
        finder.addResultListener(listener);
        if (bar) {
          if (again) bar.onFindAgainCommand(false);
          else {
            const field = bar.getElement('findbar-textbox');
            field.value = needle;
            field.dispatchEvent(
              new InputEvent('input', { bubbles: true, inputType: 'insertText', data: needle }),
            );
          }
        } else if (again) finder.findAgain(needle, false, false, false);
        else finder.fastFind(needle, false, false);
      });
    },
    target,
    needle,
    again,
  );
}

// Firefox 158's generic find-result notification reports a match-count object
// without a highlight result. Read settled highlight completion from the same
// native Highlight All operation invoked by the normal Find bar control.
async function highlight(target, needle) {
  return browser.chrome(
    async (target, needle) => {
      const panel = document
        .getElementById('sidebar')
        .contentDocument.getElementById('webext-panels-browser');
      const tab = target === 'sidebar' ? panel : gBrowser.selectedBrowser;
      const finder = tab.finder;
      const bar = target === 'sidebar' ? null : await gBrowser.getFindBar();
      return new Promise((resolve, reject) => {
        const events = [];
        const timer = setTimeout(
          () => finish(new Error('Native Highlight All timed out: ' + JSON.stringify(events))),
          10000,
        );

        function finish(error, result) {
          clearTimeout(timer);
          finder.removeResultListener(listener);
          error ? reject(error) : resolve(result);
        }

        const listener = {
          onHighlightFinished(data) {
            if (data.searchString !== needle) return;
            events.push({ highlight: data.highlight, found: data.found });
            if (data.highlight === true && data.found === true) finish(null, { ...data, events });
          },

          onFindResult() {},

          onMatchesCountResult() {},

          onCurrentSelection() {},
        };
        finder.addResultListener(listener);
        if (bar) {
          bar.toggleHighlight(false);
          bar.toggleHighlight(true);
        } else {
          finder.highlight(false, needle, false);
          finder.highlight(true, needle, false);
        }
      });
    },
    target,
    needle,
  );
}

const findbarState = () =>
  browser.chrome(async () => {
    const bar = await gBrowser.getFindBar();
    const matches = bar.getElement('found-matches');
    return {
      query: bar.getElement('findbar-textbox').value,
      highlight: bar.getElement('highlight').checked,
      hidden: bar.hidden,
      countHidden: matches.hidden,
      count: JSON.parse(matches.getAttribute('data-l10n-args') || 'null'),
    };
  });

async function discoverEveryRow(target, needle, count) {
  const first = await find(target, needle);
  first.automaticHighlight = first.highlight;
  first.highlight = await highlight(target, needle);
  assert.equal(first.matches.total, count, 'Fresh native Find discovers every rendered record');
  assert.equal(first.highlight.found, true, 'Native highlight finds rendered text');
  const keys = new Set();
  for (let i = 0; i < count; i++) {
    const current = await selection(target);
    assert.equal(current.text, needle);
    assert(
      current.connected && current.key,
      'Current native Find selection is in a connected result',
    );
    keys.add(current.key);
    const result = await find(target, needle, true);
    assert.equal(result.matches.total, count);
  }
  assert.equal(keys.size, count, 'Find Again visits every record, including offscreen records');
  return { first, keys: [...keys] };
}

async function check(name, work) {
  const entry = { name };
  observations.push(entry);
  try {
    Object.assign(entry, await work());
    entry.passed = true;
  } catch (error) {
    entry.passed = false;
    entry.error = error.stack || error.message;
    report.failures.push({ name, error: entry.error });
  }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ name, passed: entry.passed, error: entry.error }));
}

try {
  report.environment = await browser.open(
    {
      window: { width: 1100, height: 800 },
      sidebarWidth: 330,
      capture: { sourceSize: { width: 330, height: 600 } },
    },
    output + '.firefox.log',
  );
  await browser.chrome(() => Services.prefs.setBoolPref('findbar.highlightAll', true));
  const fixture = await browser.evaluate(async (port) => {
    const { id: windowId } = await browser.windows.getCurrent();

    const send = async (type, args = {}) => {
      const response = await browser.runtime.sendMessage({
        type: 'tabernacle:' + type,
        windowId,
        ...args,
      });
      if (!response.ok) throw new Error(response.error);
      return response.data;
    };

    const count = 12;
    for (let i = 0; i < count; i++) {
      const id = (
        await send('createGroup', { name: 'LifecycleNeedle ' + String(i).padStart(2, '0') })
      ).createdGroupId;
      await send('enterGroup', { id });
    }
    await send('enterGroup', { id: null });
    const root = browser.runtime.getURL('');
    const activity = root + 'activity.html#folder';
    const newTab = root + 'new-tab.html';
    const control = 'http://127.0.0.1:' + port + '/control';
    await browser.tabs.create({ windowId, url: control, active: true });
    await browser.tabs.create({ windowId, url: activity, active: false });
    await browser.tabs.create({ windowId, url: newTab, active: false });
    return { count, activity, newTab, control };
  }, server.address().port);
  report.fixture = fixture;
  await wait(
    () =>
      browser.evaluate(
        (count) => document.querySelectorAll('#tree .group-row').length === count,
        fixture.count,
      ),
    'Main tree fixture',
  );
  await check('actual-sidebar-full-dom', async () => {
    const before = await discoverEveryRow('sidebar', 'LifecycleNeedle', fixture.count);
    await browser.evaluate(() => document.getElementById('later-toggle').click());
    await wait(
      () => browser.evaluate(() => !document.getElementById('later-view').hidden),
      'Open Later',
    );
    const inactiveRows = await browser.evaluate(
      () => document.querySelectorAll('#tree .row').length,
    );
    await browser.evaluate(() => document.getElementById('later-close').click());
    await wait(
      () =>
        browser.evaluate(
          (count) => document.querySelectorAll('#tree .group-row').length === count,
          fixture.count,
        ),
      'Main tree rebuilt',
    );
    const after = await discoverEveryRow('sidebar', 'LifecycleNeedle', fixture.count);
    return {
      mechanism: 'Native Finder on actual sidebar browser; no sidebar Find UI exists',
      inactiveRows,
      before,
      after,
    };
  });
  await check('saved-rows-find-refresh', async () => {
    const ids = await browser.evaluate(async () => {
      const { id: windowId } = await browser.windows.getCurrent();
      const ids = [];
      for (let i = 0; i < 30; i++) {
        const tab = await browser.tabs.create({
          windowId,
          active: false,
          discarded: true,
          title: `PaneNeedle ${i}`,
          url: `https://find-fixture.invalid/saved/${i}`,
        });
        const response = await browser.runtime.sendMessage({
          type: 'tabernacle:saveForLater',
          windowId,
          id: tab.id,
        });
        if (!response.ok) throw new Error(response.error);
        ids.push(tab.id);
      }
      document.getElementById('later-toggle').click();
      return ids;
    });
    await wait(
      () => browser.evaluate(() => document.querySelectorAll('.later-row').length === 30),
      'Complete saved rows',
    );
    const discovery = await discoverEveryRow('sidebar', 'PaneNeedle', ids.length);
    const before = await selection('sidebar');
    await browser.evaluate(
      (id) =>
        new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            observer.disconnect();
            clearTimeout(timer);
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          });
          const timer = setTimeout(() => {
            observer.disconnect();
            reject(new Error('Saved metadata refresh did not render'));
          }, 10000);
          observer.observe(document.querySelector('.later-tools [role="status"]'), {
            childList: true,
          });
          browser.tabs.update(id, { muted: true }).catch((error) => {
            observer.disconnect();
            clearTimeout(timer);
            reject(error);
          });
        }),
      ids[0],
    );
    const after = await selection('sidebar');
    assert.deepEqual(after, before, 'Unchanged saved text keeps the native Find selection');
    const next = await find('sidebar', 'PaneNeedle', true);
    assert.equal(next.matches.total, ids.length);
    const selected = await selection('sidebar');
    assert.equal(selected.text, 'PaneNeedle');
    assert.notEqual(selected.key, before.key, 'Find Again moves to the next saved result');
    await browser.evaluate(() => document.getElementById('later-close').click());
    return { discovery, before, after, next: selected };
  });
  for (const [name, target, selector] of [
    ['activity', fixture.activity, '.item-button'],
    ['new-tab', fixture.newTab, '.folder'],
  ]) {
    await check(name + '-normal-find-resume', async () => {
      await selectPage(target);
      await wait(
        () =>
          evaluateTarget(
            target,
            () => !document.hidden && Boolean(document.querySelector('[data-key]')),
          ),
        'Visible ' + name,
      );
      if (name === 'new-tab')
        await evaluateTarget(target, () => document.getElementById('all-folders').click());
      await wait(
        () =>
          evaluateTarget(
            target,
            (selector, count) => document.querySelectorAll(selector).length === count,
            selector,
            fixture.count,
          ),
        'Complete ' + name + ' records',
      );
      const before = {
        discovery: await discoverEveryRow(target, 'LifecycleNeedle', fixture.count),
        selection: await selection(target),
        bar: await findbarState(),
      };
      await writeFile(
        output + '.' + name + '-before.png',
        await browser.driver.takeScreenshot(),
        'base64',
      );
      await selectPage(fixture.control);
      await wait(() => evaluateTarget(target, () => document.hidden), 'Actual hidden document');
      const hiddenRows = await evaluateTarget(
        target,
        (selector) => document.querySelectorAll(selector).length,
        selector,
      );
      await armResume(target, name);
      await selectPage(target);
      await wait(
        () =>
          evaluateTarget(
            target,
            (selector, count) =>
              !document.hidden &&
              window.lifecycleResumeRendered &&
              document.querySelectorAll(selector).length === count,
            selector,
            fixture.count,
          ),
        'Resumed rows',
      );
      const passive = { selection: await selection(target), bar: await findbarState() };
      await writeFile(
        output + '.' + name + '-resumed.png',
        await browser.driver.takeScreenshot(),
        'base64',
      );
      const again = await find(target, 'LifecycleNeedle', true);
      assert.equal(
        again.matches.total,
        fixture.count,
        'Find Again refreshes all matches immediately after resume',
      );
      const againSelection = await selection(target);
      // Compare this explicitly with baseline. New Tab already replaces rows on
      // ordinary visible refresh, so its first Find Again can retain no selection.
      const againSelectsCurrentDOM = againSelection.text === 'LifecycleNeedle';
      const expectedNextKey =
        before.discovery.keys[
          (before.discovery.keys.indexOf(before.selection.key) + 1) % fixture.count
        ];
      const againFollowsOrder = againSelectsCurrentDOM && againSelection.key === expectedNextKey;
      const passiveSelectionPreserved =
        passive.selection.text === before.selection.text &&
        passive.selection.key === before.selection.key &&
        passive.selection.connected &&
        !passive.selection.collapsed;
      assert(passiveSelectionPreserved, name + ' keeps the current native Find selection');
      if (name === 'activity')
        assert(againFollowsOrder, 'Activity Find Again advances to the same next record');
      const after = await discoverEveryRow(target, 'LifecycleNeedle', fixture.count);
      assert.equal(passive.bar.query, before.bar.query, 'Find query survives switching tabs');
      assert.equal(
        passive.bar.highlight,
        before.bar.highlight,
        'Highlight-all preference survives',
      );
      assert.equal(passive.bar.count?.total, before.bar.count?.total, 'Find match count survives');
      await evaluateTarget(target, () => getSelection().removeAllRanges());
      await selectPage(fixture.control);
      await wait(() => evaluateTarget(target, () => document.hidden), 'Hidden without selection');
      const noSelectionHiddenRows = await evaluateTarget(
        target,
        (selector) => document.querySelectorAll(selector).length,
        selector,
      );
      if (expectRelease) assert.equal(noSelectionHiddenRows, 0, 'Unselected hidden rows release');
      await armResume(target, name);
      await selectPage(target);
      await wait(
        () =>
          evaluateTarget(
            target,
            (selector, count) =>
              !document.hidden &&
              window.lifecycleResumeRendered &&
              document.querySelectorAll(selector).length === count,
            selector,
            fixture.count,
          ),
        'Rows resume without selection',
      );
      const disposalSelection = await evaluateTarget(
        target,
        (selector) => {
          const range = document.createRange();
          range.selectNodeContents(document.querySelector(selector));
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          return getSelection().toString();
        },
        selector,
      );
      assert(disposalSelection.length > 0, 'Pagehide exercises a selected result');
      await evaluateTarget(target, () => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      const disposedRows = await evaluateTarget(
        target,
        (selector) => document.querySelectorAll(selector).length,
        selector,
      );
      if (expectRelease) assert.equal(disposedRows, 0, 'Pagehide releases even selected rows');
      return {
        before,
        hiddenRows,
        passive,
        again,
        againSelection,
        againSelectsCurrentDOM,
        againFollowsOrder,
        expectedNextKey,
        noSelectionHiddenRows,
        disposedRows,
        disposalSelection,
        after,
        passiveSelectionPreserved,
        note: 'Passive selection/highlight screenshots are baseline-comparison evidence; fresh Find/Find Again all-record discovery is asserted.',
      };
    });
  }
  for (const [name, original, selector] of [
    ['activity', fixture.activity, '.item-button'],
    ['new-tab', fixture.newTab, '.folder'],
  ]) {
    await check(name + '-back-forward', async () => {
      const address = new URL(original);
      address.searchParams.set('lifecycle-navigation', 'true');
      const target = address.href;
      const control = fixture.control + '?return=' + name;
      const tabId = await browser.evaluate(
        async (url) => (await browser.tabs.create({ url, active: true })).id,
        target,
      );
      await wait(
        () =>
          evaluateTarget(
            target,
            (selector) => !document.hidden && document.querySelectorAll(selector).length > 0,
            selector,
          ).catch(() => false),
        'Fresh navigation document',
      );
      const before = await evaluateTarget(
        target,
        (selector) => {
          window.lifecycleDocumentToken = Math.random();
          window.addEventListener(
            'pagehide',
            (event) => {
              sessionStorage.setItem(
                'lifecycle-pagehide',
                JSON.stringify({ persisted: event.persisted }),
              );
            },
            { once: true },
          );
          return {
            token: window.lifecycleDocumentToken,
            rows: document.querySelectorAll(selector).length,
          };
        },
        selector,
      );
      await browser.evaluate(async (id, url) => browser.tabs.update(id, { url }), tabId, control);
      await wait(
        () => browser.chrome((url) => gBrowser.selectedBrowser.currentURI.spec === url, control),
        'Navigated away',
      );
      await browser.evaluate(async (id) => {
        if (typeof browser.tabs.goBack !== 'function')
          throw new Error('Firefox tabs.goBack is unavailable');
        await browser.tabs.goBack(id);
      }, tabId);
      await wait(
        () =>
          evaluateTarget(
            target,
            (selector) => !document.hidden && document.querySelectorAll(selector).length > 0,
            selector,
          ).catch(() => false),
        'Back navigation restores usable rows',
      );
      const after = await evaluateTarget(
        target,
        (selector) => ({
          token: window.lifecycleDocumentToken || null,
          rows: document.querySelectorAll(selector).length,
          pagehide: JSON.parse(sessionStorage.getItem('lifecycle-pagehide')),
        }),
        selector,
      );
      assert.equal(after.rows, before.rows, 'Back navigation keeps the initial collection');
      return { before, after, reusedDocument: after.token === before.token };
    });
  }
  report.status = report.failures.length ? 'failed' : 'completed';
} catch (error) {
  report.status = 'failed';
  report.failures.push({ name: 'setup', error: error.stack || error.message });
} finally {
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  await new Promise((done) => server.close(done));
}
process.exitCode = report.status === 'completed' ? 0 : 1;
