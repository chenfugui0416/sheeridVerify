import { AutomationError } from '../core/errors.js';

// A locator is a selector description, not an element handle: ego resolves it
// inside the browser on every round. The methods here are the subset of the
// Playwright locator API this project calls.
export function locatorFor(page, describe) {
  const self = {
    describe,
    page: () => page,
    filter({ visible = false } = {}) {
      return visible && !describe.visibleOnly
        ? locatorFor(page, { ...describe, visibleOnly: true })
        : self;
    },
    locator(selector) {
      return locatorFor(page, {
        ...describe,
        parentSelector: describe.selfSelector,
        selfSelector: selector,
        visibleOnly: describe.visibleOnly,
      });
    },
    getByRole(role, options = {}) {
      return page.getByRole(role, options, describe);
    },
    getByText(text, options = {}) {
      return page.getByText(text, options, describe);
    },
    count: () => page.round({ op: 'count', ...describe }),
    or: other => locatorFor(page, { ...describe, alternative: other.describe }),
    isEnabled: async (options = {}) => {
      const state = await page.round({ op: 'state', ...describe }, options).catch(empty);
      return Boolean(state && state.enabled);
    },
    isEditable: async (options = {}) => {
      const state = await page.round({ op: 'state', ...describe }, options).catch(empty);
      return Boolean(state && state.editable);
    },
    inputValue: async (options = {}) => {
      const state = await page.round({ op: 'state', ...describe }, options).catch(empty);
      return state ? state.value : '';
    },
    getAttribute: (name, options = {}) =>
      page.round({ op: 'attribute', name, ...describe }, options).catch(empty),
    innerText: async (options = {}) => {
      const item = await page.round({ op: 'first', ...describe }, options).catch(empty);
      return item ? item.text : '';
    },
    allTextContents: (options = {}) =>
      page.round({ op: 'texts', ...describe }, options).catch(() => []),
    evaluate: (fn, arg, options = {}) =>
      page.round({ op: 'evaluateNode', source: String(fn), arg: arg ?? null, ...describe }, options).catch(empty),
    evaluateAll: (fn, arg, options = {}) =>
      page.round({ op: 'evaluateAll', source: String(fn), arg: arg ?? null, ...describe }, options).catch(() => []),
    click: (options = {}) => page.round({ op: 'click', ...describe }, options),
    fill: (value, options = {}) => page.round({ op: 'fill', value: String(value), ...describe }, options),
    focus: (options = {}) => page.round({ op: 'focus', ...describe }, options),
    blur: (options = {}) => page.round({ op: 'blur', ...describe }, options),
    check: (options = {}) => page.round({ op: 'check', ...describe }, options),
    press: (key, options = {}) => page.round({ op: 'press', key, ...describe }, options),
    pressSequentially: (text, options = {}) => page.round({ op: 'insert', text, ...describe }, options),
    selectOption: (value, options = {}) =>
      page.round({ op: 'select', value: String(options?.label ?? value), ...describe }, options),
  };
  return self;
}

// A wait for an element that is not there yet resolves to null rather than
// throwing, which is what callers such as count() === 0 rely on.
function empty(error) {
  if (error instanceof AutomationError && (error.code === 'EGO_EXEC_FAILED' || error.code === 'EGO_ACTION_TIMEOUT')) {
    return null;
  }
  throw error;
}
