import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { ScreenshotBrowser } from '../../scripts/screenshot-browser.js';
import { waitForStableObservation } from '../../scripts/memory/native-settlement.js';

const browser = new ScreenshotBrowser();
const size = { width: 340, height: 820 };
try {
  await mkdir('test-results', { recursive: true });
  await browser.open(
    {
      window: { width: 1100, height: 900 },
      sidebarWidth: size.width,
      capture: { sourceSize: size },
    },
    'test-results/firefox-tree-motion.log',
  );
  await browser.chrome(() => Services.prefs.setIntPref('ui.prefersReducedMotion', 0));
  const fixture = await browser.evaluate(async () => {
    window.motionErrors = [];
    addEventListener('error', (event) => motionErrors.push(event.message));
    addEventListener('unhandledrejection', (event) => motionErrors.push(event.reason?.message));
    window.motionSend = async (type, args = {}) => {
      const { id: windowId } = await browser.windows.getCurrent();
      const result = await browser.runtime.sendMessage({
        type: `tabernacle:${type}`,
        windowId,
        ...args,
      });
      if (!result.ok) throw new Error(result.error);
      return result.data;
    };
    const outer = (await motionSend('createGroup', { name: 'Outer' })).createdGroupId;
    const inner = (await motionSend('createGroup', { name: 'Inner', parentId: outer }))
      .createdGroupId;
    const rootTab = (await motionSend('newTab', { groupId: null })).createdTabId;
    const hiddenTab = (await motionSend('newTab', { groupId: inner })).createdTabId;
    await motionSend('toggleGroup', { id: inner });

    // Hold the outgoing subtree until the optimistic fold and its acknowledgement
    // have both rendered. Finishing before that misses the stale-wrapper bug.
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (this.matches('.branch, .tab-branch')) animation.pause();
      return animation;
    };
    return { outer, inner, rootTab, hiddenTab };
  });

  const read = () => browser.evaluate(() => motionSend('snapshot'));
  const waitForRow = (id, kind = 'tab') =>
    browser.driver.wait(
      () =>
        browser.evaluate((key) => {
          if (motionErrors.length) throw new Error(motionErrors.join('\n'));
          return Boolean(document.querySelector(`[data-key="${key}"]`));
        }, `${kind}:${id}`),
      5000,
      `${kind}:${id} must appear in the sidebar`,
    );
  const fold = (id) =>
    browser.evaluate(
      (id) =>
        document
          .querySelector(`[data-key="group:${id}"]`)
          .dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })),
      id,
    );

  const finish = async () => {
    await browser.evaluate(() =>
      document.getAnimations().forEach((animation) => animation.finish()),
    );
    await browser.driver.wait(
      () => browser.evaluate(() => !document.querySelector('[data-tree-motion]')),
      5000,
    );
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    await waitForRow(fixture.inner, 'group');
    await browser.evaluate((id) => motionSend('activateTab', { id }), fixture.hiddenTab);
    await fold(fixture.outer);
    await waitForStableObservation(
      () =>
        browser.evaluate(async (id) => {
          const state = await motionSend('snapshot');
          return {
            collapsed: state.view.collapsed.includes(id),
            animating: Boolean(document.querySelector('[data-tree-motion]')),
            revision: state.revision,
          };
        }, fixture.outer),
      {
        matches: (value) => value.collapsed && value.animating,
        intervalMs: 150,
        label: 'acknowledged animated folder fold',
      },
    );
    await finish();
    assert.equal(await browser.evaluate(() => document.getElementById('reveal').hidden), false);
    await browser.evaluate(
      (id) => document.querySelector(`[data-key="tab:${id}"] .label`).click(),
      fixture.rootTab,
    );
    await browser.driver.wait(
      () =>
        browser.evaluate(
          (id) =>
            document.querySelector(`[data-key="tab:${id}"]`)?.getAttribute('aria-selected') ===
              'true' && document.getElementById('reveal').hidden,
          fixture.rootTab,
        ),
      5000,
      'Clicking a visible tab must update selection and clear the hidden-tab notice',
    );

    for (const selector of ['#new-tab', '.new-tab-action[data-key="new-tab:null"]']) {
      const before = (await read()).tabs.length;
      await browser.evaluate((selector) => document.querySelector(selector).click(), selector);
      await browser.driver.wait(async () => (await read()).tabs.length === before + 1, 5000);
      const active = (await read()).tabs.find((tab) => tab.active);
      await waitForRow(active.id);
      assert.equal(await browser.evaluate(() => document.getElementById('reveal').hidden), true);
    }
    await fold(fixture.outer);
    await waitForRow(fixture.inner, 'group');
    await finish();
    assert.equal(
      (await read()).tabs.find((tab) => tab.id === fixture.hiddenTab).groupId,
      fixture.inner,
    );
    assert.deepEqual(await browser.evaluate(() => motionErrors), []);
    assert.equal(
      await browser.evaluate(() => {
        const toast = document.getElementById('toast');
        return !toast.hidden && toast.classList.contains('error');
      }),
      false,
    );
  }
  await fold(fixture.inner);
  await finish();
  await waitForRow(fixture.hiddenTab);
  console.log('✓ Native animated folder folds preserve selection, new tabs and nested membership');
} finally {
  await browser.close();
}
