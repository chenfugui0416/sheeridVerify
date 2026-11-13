import { createHash } from 'node:crypto';
import { AutomationError } from '../core/errors.js';
import { runRound, runScript } from './ego-session.js';
import { sourceOf } from './ego-source.js';
import { pageDispatch } from './ego-ops.js';
import { locatorFor } from './ego-locator.js';

const DISPATCH = sourceOf(pageDispatch);

// ego keeps the browser in a persistent task space, so a page is addressed by
// name and every interaction is one round trip. The space name is derived from
// the verification link, letting a restarted process resume the same browser.
export function spaceFor(config) {
  const digest = createHash('sha1')
    .update(String(config.url) + '|' + Boolean(config.browser.headless))
    .digest('hex')
    .slice(0, 12);
  return 'sheerid-verify-' + digest;
}

function createPage({ space, label, timeoutMs }) {
  let closed = false;
  const page = {
    space,
    label,
    round(call, options = {}) {
      if (closed) throw new AutomationError('PAGE_CLOSED', '浏览器页面已关闭');
      return runRound({
        space, label, body: DISPATCH, call,
        timeoutMs: Math.max(1000, Math.min(options.timeoutMs ?? timeoutMs, 60000)),
      });
    },
    isClosed: () => closed,
    close: () => { closed = true; },
    async url() {
      const value = await page.round({ op: 'url' });
      return String(value ?? '');
    },
    async evaluate(fn, arg) {
      return page.round({ op: 'evaluate', source: String(fn), arg: arg === undefined ? null : arg });
    },
    async waitForLoadState(_state, options = {}) {
      const deadline = Date.now() + Math.min(options.timeout ?? 15000, 15000);
      do {
        const ready = await page.round({ op: 'ready' });
        if (ready === 'complete') return;
        await new Promise(resolve => setTimeout(resolve, 200));
      } while (Date.now() < deadline);
      const error = new AutomationError('LOAD_TIMEOUT', '等待页面 load 事件超时');
      error.name = 'TimeoutError';
      throw error;
    },
    locator(selector) {
      return locatorFor(page, { selfSelector: selector });
    },
    getByRole(role, options = {}, parent) {
      const base = parent ? { ...parent, parentSelector: parent.selfSelector } : {};
      return locatorFor(page, {
        ...base,
        selfSelector: 'loc=role:' + role,
        namePattern: options.name instanceof RegExp ? options.name.source : (options.name || null),
      });
    },
    getByText(text, options = {}, parent) {
      const base = parent ? { ...parent, parentSelector: parent.selfSelector } : {};
      return locatorFor(page, {
        ...base,
        selfSelector: 'text=' + (text instanceof RegExp ? String(text.source) : String(text)),
        exact: Boolean(options.exact),
      });
    },
    on() {},
    removeListener() {},
  };
  return page;
}

export async function createSession(config) {
  const space = spaceFor(config);
  const label = 'p1';
  try {
    await runScript([
      'const task = await taskSpace(' + JSON.stringify(space) + ');',
      'const page = task.page(' + JSON.stringify(label) + ') || await task.newPage();',
      'await page.goto(' + JSON.stringify(String(config.url)) + ', { timeout: ' + config.timeouts.navigationMs + ' });',
    ].join('\n'), { timeoutMs: config.timeouts.navigationMs + 30000 });
  } catch (error) {
    throw error instanceof AutomationError ? error
      : new AutomationError('NAVIGATION_FAILED', '无法在 ego 浏览器中打开验证页面');
  }
  const page = createPage({ space, label, timeoutMs: config.timeouts.actionMs });
  const browser = { isConnected: () => !page.isClosed() };
  return { page, browser, isConnected: () => !page.isClosed(), close: async () => { page.close(); } };
}

export function waitForSessionClose({ page }, signal) {
  return new Promise(resolve => {
    const finish = () => {
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted || page.isClosed()) finish();
  });
}
