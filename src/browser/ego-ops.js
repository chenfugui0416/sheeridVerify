// The page-side operation table. The Node side serializes one operation per
// round; this function resolves its target, performs the read or action, and
// returns a JSON-safe value. Elements are addressed by selector on every round
// because a DOM handle cannot outlive the evaluate() call that created it.
//
// Target description accepted by every operation:
//   selfSelector   CSS, loc=role:<role>, loc=css:<css>, or text=<text>
//   parentSelector narrows the search to the descendants of a matched element
//   visibleOnly    drop hidden matches before counting or acting
//   namePattern    accessible-name filter used by getByRole
//   textPattern    text filter used by getByText
export function pageDispatch() {
  const dom = window.__sheeridEgoDom__;
  const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\  const nameOf = node =>');
  const nameOf = node => dom.norm(node.getAttribute('aria-label')
    || node.getAttribute('name')
    || node.getAttribute('placeholder')
    || (node.tagName === 'INPUT' ? '' : node.innerText || node.textContent));
  const all = selector => {
    try { return dom.all(selector); } catch { return []; }
  };
  const byRole = (selector) => {
    const match = /^loc=role:([a-z]+)(.*)$/i.exec(selector);
    if (!match) return null;
    const role = match[1].toLowerCase();
    const nodes = [];
    for (const node of document.querySelectorAll('*')) {
      if (matchesRole(node, role)) nodes.push(node);
    }
    return nodes;
  };
  // Browsers expose implicit ARIA roles for native elements; a bare <input
  // has no role attribute, so map the handful this project queries.
  const IMPLICIT = {
    textbox: node => node.tagName === 'INPUT'
      && !['checkbox', 'radio', 'button', 'submit', 'hidden', 'file', 'password'].includes((node.type || 'text').toLowerCase()),
    button: node => node.tagName === 'BUTTON'
      || (node.tagName === 'INPUT' && ['button', 'submit'].includes((node.type || '').toLowerCase())),
    combobox: node => node.tagName === 'SELECT'
      || (node.tagName === 'INPUT' && ['text', ''].includes((node.type || '').toLowerCase())
        && node.getAttribute('aria-expanded') !== null),
    option: node => node.tagName === 'OPTION',
    listbox: node => node.tagName === 'SELECT' || node.tagName === 'UL',
    checkbox: node => node.tagName === 'INPUT' && (node.type || '').toLowerCase() === 'checkbox',
    link: node => node.tagName === 'A' && node.hasAttribute('href'),
    heading: node => /^H[1-6]$/.test(node.tagName),
  };
  const matchesRole = (node, role) => {
    const explicit = (node.getAttribute('role') || '').toLowerCase();
    if (explicit === role) return true;
    if (explicit) return false;
    const implicit = IMPLICIT[role];
    return implicit ? implicit(node) : node.tagName.toLowerCase() === role;
  };
  const resolve = selector => {
    if (!selector) return [document];
    const css = all(selector);
    if (css.length) return css;
    const roles = byRole(selector);
    if (roles) return roles;
    if (selector.startsWith('loc=css:')) return all(selector.slice(8));
    if (selector.startsWith('text=')) {
      const pattern = selector.slice(5);
      // The suffix is a regular expression so a caller can pass either a literal
      // phrase or a case-insensitive alternation from the app's own config.
      let test;
      try { test = new RegExp(pattern, 'i'); } catch { test = new RegExp(escapeRe(pattern), 'i'); }
      return dom.all('*').filter(node => test.test(dom.norm(node.innerText || node.textContent)));
    }
    return [];
  };
  const targets = input => {
    const parents = input.parentSelector ? resolve(input.parentSelector) : null;
    let found = input.selfSelector
      ? (parents
        ? parents.flatMap(parent => resolve(input.selfSelector).filter(node => parent === node || parent.contains(node)))
        : resolve(input.selfSelector))
      : (parents || [document]);
    if (input.namePattern) {
      const pattern = new RegExp(input.namePattern, 'i');
      found = found.filter(node => pattern.test(nameOf(node)));
    }
    if (input.textPattern) {
      const pattern = new RegExp(input.textPattern, input.exact ? '' : 'i');
      found = found.filter(node => pattern.test(dom.norm(node.innerText || node.textContent)));
    }
    return input.visibleOnly ? found.filter(dom.isVisible) : found;
  };
  const single = input => {
    const found = targets(input);
    if (found.length > 1) {
      const error = new Error('matched ' + found.length + ' elements');
      error.kind = 'ambiguous';
      throw error;
    }
    return found[0] || null;
  };
  const need = input => {
    const node = single(input);
    if (!node) {
      const error = new Error('no element matched');
      error.kind = 'missing';
      throw error;
    }
    return node;
  };
  const ops = {
    // Page-level reads. `ready` reports whether the load event already fired so
    // waitForLoadState can poll instead of blocking a whole round on a slow page.
    url: () => location.href,
    title: () => document.title,
    ready: () => document.readyState,
    closed: () => false,
    evaluate: input => {
      const fn = new Function('return (' + input.source + ')')();
      return fn(input.arg === undefined ? null : input.arg);
    },
    count: input => targets(input).length,
    texts: input => targets(input).map(node => dom.norm(node.innerText || node.textContent)),
    first: input => { const node = single(input); return node ? dom.norm(node.innerText || node.textContent) : null; },
    state: input => { const node = single(input); return node ? dom.readState(node) : null; },
    painted: input => { const node = single(input); return node ? dom.isPainted(node) : null; },
    attribute: input => { const node = single(input); return node ? node.getAttribute(input.name) : null; },
    tag: input => { const node = single(input); return node ? node.tagName.toLowerCase() : null; },
    // Runs a function the caller supplied against one matched element. The source
    // arrives as text and is rebuilt here, because the callback cannot close over
    // Node-side state.
    evaluateNode: input => {
      const node = need(input);
      const fn = new Function('return (' + input.source + ')')();
      return fn(node, input.arg === undefined ? null : input.arg);
    },
    evaluateAll: input => {
      const fn = new Function('return (' + input.source + ')')();
      return fn(targets(input), input.arg === undefined ? null : input.arg);
    },
  };
  // Mutating operations. Each one performs its own micro-wait so a caller does not
  // have to wrap a single action in another round trip.
  const act = {
    fill: input => {
      const node = need(input);
      node.focus();
      node.value = String(input.value ?? '');
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    blur: input => { const node = need(input); if (node.blur) node.blur(); return true; },
    focus: input => { const node = need(input); if (node.focus) node.focus(); return true; },
    select: input => {
      const node = need(input);
      node.value = String(input.value ?? '');
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return node.value;
    },
    check: input => {
      const node = need(input);
      if (!node.checked) node.click();
      return Boolean(node.checked);
    },
    // Opening a combobox must not toggle it closed again if it is already expanded.
    open: input => {
      const node = need(input);
      if (node.getAttribute('aria-expanded') === 'true') return false;
      node.click();
      return true;
    },
    clickOption: input => {
      const node = need(input);
      node.click();
      return true;
    },
    // A single character typed into a focused control. input.insertText semantics
    // without the native key path: value plus a real input event, so controlled
    // React inputs update as they would for a user.
    insert: input => {
      const node = need(input);
      node.focus();
      const text = String(input.text ?? '');
      if ('value' in node) {
        const start = node.selectionStart ?? String(node.value).length;
        const end = node.selectionEnd ?? start;
        node.value = String(node.value).slice(0, start) + text + String(node.value).slice(end);
        const caret = start + text.length;
        try { node.setSelectionRange(caret, caret); } catch { /* not a text control */ }
      } else if (node.isContentEditable) {
        node.textContent = String(node.textContent || '') + text;
      }
      node.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      return node.value ?? null;
    },
    click: input => { const node = need(input); node.click(); return true; },
    press: input => {
      const node = need(input);
      const key = String(input.key || '');
      const kind = key === 'Enter' ? 'keydown' : 'keypress';
      node.focus();
      const init = { key: key, bubbles: true, cancelable: true };
      node.dispatchEvent(new KeyboardEvent(kind, init));
      node.dispatchEvent(new KeyboardEvent('keyup', { key: key, bubbles: true, cancelable: true }));
      if (key === 'Enter' && node.form && typeof node.form.requestSubmit === 'function' && input.submit) node.form.requestSubmit();
      return true;
    },
    options: input => {
      const node = need(input);
      return Array.from(node.options || []).map(option => ({
        value: option.value,
        text: dom.norm(option.textContent),
        disabled: Boolean(option.disabled || (option.parentElement && option.parentElement.disabled)),
      }));
    },
  };
  Object.assign(ops, act);
  return function dispatch(call) {
    const fn = ops[call.op];
    if (!fn) throw new Error('unknown ego op: ' + call.op);
    return fn(call);
  };
}
