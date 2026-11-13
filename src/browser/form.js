import { setTimeout as delay } from 'node:timers/promises';
import { AutomationError } from '../core/errors.js';

// Element operations expressed directly against the ego round protocol. Every
// helper takes the page plus a target description and resolves it inside the
// browser; nothing here holds a DOM handle across calls.
function abortable(signal) {
  if (signal?.aborted) throw new AutomationError('CANCELLED', '任务已取消');
}

export function target(selector, extra = {}) {
  return { selfSelector: selector, ...extra };
}

async function firstMatch(page, targets, { signal } = {}) {
  for (const selector of targets) {
    abortable(signal);
    if (page.isClosed()) throw new AutomationError('PAGE_CLOSED', '浏览器页面已关闭');
    const count = await page.round({ op: 'count', ...target(selector, { visibleOnly: true }) });
    if (count > 1) {
      throw new AutomationError('AMBIGUOUS_FIELD', '字段 ' + selector + ' 匹配到多个元素，请收紧选择器');
    }
    if (count === 1) return selector;
  }
  return null;
}

// Poll one shared deadline rather than multiplying the timeout by field count.
// With settleMs the matches must stay ready, painted and unmoved that long.
export async function waitForFields(page, selectors, names, {
  timeoutMs, signal, assertPage, enabledOnly = [], onPending, settleMs = 0,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastReport = 0;
  let lastPending = '';
  let readySince = 0;
  let lastLayout = '';
  let pending = [...names];
  do {
    abortable(signal);
    if (page.isClosed()) throw new AutomationError('PAGE_CLOSED', '等待表单期间浏览器页面已关闭');
    if (assertPage && !await assertPage()) {
      pending = [...names];
      readySince = 0;
    } else {
      pending = [];
      const layout = [];
      for (const name of names) {
        abortable(signal);
        if (Date.now() >= deadline) { pending.push(name); continue; }
        const selector = await firstMatch(page, selectors[name], { signal });
        if (!selector) { pending.push(name); continue; }
        const state = await page.round({ op: 'state', ...target(selector) });
        if (!state) { pending.push(name); continue; }
        const ready = enabledOnly.includes(name) ? state.enabled : state.editable;
        if (!ready || state.busy) { pending.push(name); continue; }
        if (settleMs > 0) {
          const painted = await page.round({ op: 'painted', ...target(selector) });
          if (!painted?.signature) { pending.push(name + ':' + (painted?.code ?? 'UNKNOWN')); continue; }
          layout.push(name + '=' + painted.signature);
        }
      }
      if (pending.length === 0) {
        const signature = layout.join(';');
        if (!readySince || signature !== lastLayout) { readySince = Date.now(); lastLayout = signature; }
        if (Date.now() - readySince >= settleMs) return;
        pending = ['<settling>'];
      } else {
        readySince = 0;
      }
    }
    const signature = pending.join(',');
    if (signature !== lastPending || Date.now() - lastReport >= 10000) {
      onPending?.([...pending]);
      lastPending = signature;
      lastReport = Date.now();
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(200, remaining), undefined, { signal });
  } while (Date.now() < deadline);
  abortable(signal);
  if (assertPage && !await assertPage()) {
    throw new AutomationError('UNEXPECTED_PAGE', '等待结束后仍未进入指定验证会话，请检查登录、跳转或链接状态');
  }
  throw new AutomationError('FORM_NOT_READY', '表单等待超时，以下字段未出现或不可操作：' + pending.join(', ') + '。请检查页面加载状态及对应选择器');
}

export async function visibleField(page, selectors, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (page.isClosed()) throw new AutomationError('PAGE_CLOSED', '浏览器页面已关闭');
    const selector = await firstMatch(page, selectors);
    if (selector) return selector;
    await delay(150);
  } while (Date.now() < deadline && !page.isClosed());
  throw new AutomationError('FIELD_NOT_FOUND', '找不到字段 ' + name + '，请检查页面状态与选择器');
}

export async function setField(page, selector, value, { timeoutMs = 15000, signal, interaction, labels = [], onPending } = {}) {
  abortable(signal);
  const tag = await page.round({ op: 'tag', ...target(selector) });
  if (tag !== 'select') {
    if (interaction) await interaction.typeText(page, selector, value);
    else await page.round({ op: 'fill', ...target(selector), value: String(value) });
    await page.round({ op: 'blur', ...target(selector) });
    return;
  }
  // Native selects may use padded or unpadded values, or translated labels.
  const deadline = Date.now() + timeoutMs;
  let nextReport = 0;
  do {
    abortable(signal);
    const options = await page.round({ op: 'options', ...target(selector) });
    const input = String(value);
    const enabled = options.filter(option => !option.disabled);
    const exactValue = enabled.filter(option => option.value === input);
    const exact = exactValue.length ? exactValue
      : enabled.filter(option => option.text === input || labels.includes(option.text));
    const numeric = /^\d+$/.test(input)
      ? enabled.filter(option => /^\d+$/.test(option.value) && Number(option.value) === Number(input))
      : [];
    const matches = exact.length ? exact : numeric;
    if (matches.length > 1) throw new AutomationError('AMBIGUOUS_OPTION', '下拉选项不唯一，请检查配置值');
    if (matches.length === 1) {
      await page.round({ op: 'select', ...target(selector), value: matches[0].value });
      return;
    }
    if (Date.now() >= nextReport) { onPending?.(); nextReport = Date.now() + 10000; }
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(200, remaining), undefined, { signal });
  } while (Date.now() < deadline);
  throw new AutomationError('OPTION_NOT_FOUND', '等待下拉选项超时，请检查选项是否加载完成及配置值是否匹配');
}

// Native selects and custom comboboxes behave differently. A custom control only
// commits when a real option is clicked, so filling its text alone is not enough.
export async function selectChoice(page, selector, {
  value, label, labels = [label], searchText, timeoutMs, signal, field,
  allowLocationSuffix = false, normalizeLabelSeparators = false, retrySearch = false,
  interaction, assertReady, onPending, isSelectionCommitted,
}) {
  abortable(signal);
  await assertReady?.();
  const tag = await page.round({ op: 'tag', ...target(selector) });
  if (tag === 'select') {
    await setField(page, selector, value ?? label, { timeoutMs, signal, labels, onPending });
    return;
  }
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let sawOptions = false;
  let sawMatch = false;
  let selectionAttempted = false;
  let searchRetried = false;
  let commitLabels = labels;
  let committedSince = 0;
  let lastClickAt = 0;
  let nextReport = 0;
  let phase = 'OPTIONS_LOADING';

  const patternFor = text => {
    const escaped = String(text).trim().split(/\s+/)
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    return '^' + escaped + '$';
  };
  // Options live either in a listbox referenced by aria-controls or anywhere in the
  // page as role=option; both are searched so an asynchronously attached menu works.
  const optionTarget = () => {
    const scope = commitLabels.map(patternFor).join('|');
    return { selfSelector: 'loc=role:option', visibleOnly: true, namePattern: '^(?:' + scope + ')$' };
  };
  const findCandidate = async () => {
    let count = await page.round({ op: 'count', ...optionTarget() });
    if (count === 0 && allowLocationSuffix) {
      count = await page.round({ op: 'count', selfSelector: 'loc=role:option', visibleOnly: true, namePattern: patternFor(label) });
    }
    if (count > 1) {
      throw new AutomationError('AMBIGUOUS_OPTION', '字段 ' + field + ' 匹配到多个候选项；学校请在 organization.optionText 中填写含城市/州的完整名称');
    }
    sawMatch = sawMatch || count === 1;
    return count === 1;
  };

  await page.round({ op: 'focus', ...target(selector) });
  await page.round({ op: 'open', ...target(selector) });
  if (searchText !== undefined && searchText !== '' && tag === 'input') {
    if (interaction) await interaction.typeText(page, selector, searchText);
    else await page.round({ op: 'fill', ...target(selector), value: searchText });
  }

  do {
    abortable(signal);
    await assertReady?.();
    if (selectionAttempted) {
      const committed = await isSelectionCommitted?.({ labels: commitLabels, timeoutMs: Math.min(750, remaining()) });
      if (committed) {
        committedSince = committedSince || Date.now();
        if (Date.now() - committedSince >= 300) return;
      } else {
        committedSince = 0;
        if (Date.now() - lastClickAt < 1000) {
          await delay(Math.min(200, remaining()), undefined, { signal });
          continue;
        }
      }
    }
    const total = await page.round({ op: 'count', selfSelector: 'loc=role:option', visibleOnly: true });
    sawOptions = sawOptions || total > 0;
    if (await findCandidate()) {
      await interaction?.beforeOption(field);
      if (Date.now() >= deadline) break;
      selectionAttempted = true;
      lastClickAt = Date.now();
      phase = 'OPTION_CLICK_PENDING';
      await page.round({ op: 'clickOption', ...optionTarget() });
      commitLabels = [...labels];
      committedSince = 0;
    } else if (retrySearch && !searchRetried && !selectionAttempted && tag === 'input') {
      // A menu whose results never arrived usually needs the query re-issued once.
      searchRetried = true;
      phase = 'SEARCH_RETRIGGERED';
      onPending?.(phase);
      await page.round({ op: 'fill', ...target(selector), value: searchText });
    }
    if (Date.now() >= nextReport) { onPending?.(phase); nextReport = Date.now() + 10000; }
    if (Date.now() < deadline) await delay(Math.min(200, remaining()), undefined, { signal });
  } while (Date.now() < deadline);
  if (selectionAttempted) {
    throw new AutomationError('OPTION_NOT_COMMITTED', '字段 ' + field + ' 在等待期限内未能确认选中成功，已停止后续填写；请检查页面选中状态或校验提示');
  }
  if (sawMatch) {
    throw new AutomationError('OPTION_NOT_SELECTABLE', '字段 ' + field + ' 的匹配选项在等待期限内持续刷新、被遮挡或不可点击，已停止填写');
  }
  throw new AutomationError(sawOptions ? 'OPTION_LABEL_MISMATCH' : 'OPTION_NOT_FOUND',
    sawOptions
      ? '字段 ' + field + ' 未出现唯一、稳定且可点击的匹配选项；请检查页面语言、配置名称及加载状态'
      : '字段 ' + field + ' 等待候选项超时；请检查网络、搜索内容和页面语言，未继续填写后续字段');
}
