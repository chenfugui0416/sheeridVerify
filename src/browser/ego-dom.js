export function installDom() {
  const RUNTIME = '__sheeridEgoDom__';
  if (window[RUNTIME]) return true;
  const BS = String.fromCharCode(92);
  const DQ = String.fromCharCode(34);
  const SQ = String.fromCharCode(39);
  const TEXT_IS = ':' + 'text-is' + BS + '(' + '(' + DQ + '.*?' + DQ + '|' + SQ + '.*?' + SQ + ')' + BS + ')$';
  const HAS_TEXT = ':' + 'has-text' + BS + '(' + '(' + DQ + '.*?' + DQ + '|' + SQ + '.*?' + SQ + ')' + BS + ')$';
  const GENERATED = 'button, input, select, textarea, a, [role="button"], [role="checkbox"], '
    + '[role="combobox"], [role="option"], [role="textbox"], [role="listbox"], '
    + '[role="link"], [role="radio"], [role="switch"], [role="heading"]';
  const norm = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  const lower = text => norm(text).toLowerCase();
  const unquote = raw => raw.slice(1, -1).replace(new RegExp(BS + BS + '(.)', 'g'), '$1');
  const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, BS + '$&');
  const deepAll = (root, base, out) => {
    out.push(...root.querySelectorAll(base));
    for (const node of root.querySelectorAll('*')) {
      if (node.shadowRoot) deepAll(node.shadowRoot, base, out);
    }
    return out;
  };
  const all = base => deepAll(document, base || '*', []);
  const styleOf = node => getComputedStyle(node);
  const isVisible = node => {
    if (!node || !node.isConnected) return false;
    if (node.checkVisibility && !node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  // Playwright treats a partially faded element as visible. This project waits for
  // real paint and an uncovered centre, so keep the stricter check.
  const isPainted = node => {
    if (!isVisible(node)) return { code: 'NOT_VISIBLE' };
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return { code: 'NO_SIZE' };
    for (let cursor = node; cursor; cursor = cursor.parentElement) {
      const style = styleOf(cursor);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.95) {
        return { code: 'NOT_PAINTED' };
      }
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) {
      const top = document.elementFromPoint(x, y);
      const owner = (node.parentElement && node.parentElement.parentElement) || node.parentElement;
      const inside = !!top && (top === node || node.contains(top) || (owner && owner.contains(top)));
      if (!inside) return { code: 'COVERED' };
    }
    return { signature: [rect.left, rect.top, rect.width, rect.height].map(Math.round).join(',') };
  };
  const readState = node => {
    const tag = node.tagName.toLowerCase();
    const type = node instanceof HTMLInputElement ? node.type : '';
    const toggle = type === 'checkbox' || type === 'radio';
    return {
      tag, type,
      visible: isVisible(node),
      enabled: toggle || !(node.disabled || !!node.closest('fieldset[disabled]')),
      // Text-like controls only: a checkbox or radio reports no editability,
      // which is what waitForFields' isEditable check expects.
      editable: (tag === 'input' && !toggle && !node.readOnly && !node.disabled)
        || (tag === 'textarea' && !node.readOnly && !node.disabled)
        || (tag !== 'select' && node.isContentEditable === true),
      busy: !!node.closest('[aria-busy="true"]'),
      expanded: node.getAttribute('aria-expanded'),
      invalid: node.getAttribute('aria-invalid'),
      ariaBusy: node.getAttribute('aria-busy'),
      value: 'value' in node ? String(node.value ?? '') : '',
      readonly: node.readOnly === true,
      checked: node.checked === true,
      formValid: !node.form || node.form.checkValidity(),
      controls: node.getAttribute('aria-controls') || node.getAttribute('aria-owns'),
      label: node.getAttribute('aria-label') || node.getAttribute('name') || '',
      text: norm(node.innerText || node.textContent),
    };
  };
  window[RUNTIME] = {
    GENERATED, norm, lower, unquote, escapeRe, deepAll, all, isVisible, isPainted, readState,
    byCss: selector => all(selector),
    byRole: (role, name) => all('[role="' + role + '"]').concat(all(role)),
    byText: (pattern, exact) => {
      const test = new RegExp(pattern, 'i');
      return all('*').filter(node => test.test(norm(node.innerText || node.textContent)) );
    },
    text: (node) => norm(node.innerText || node.textContent),
  };
  return true;
}
