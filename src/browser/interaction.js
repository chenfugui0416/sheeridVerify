import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Human-paced input. ego drives the same browser the user sees, so typing goes
// through the real keyboard rather than assigning .value, and each keystroke is
// separated by the configured random delay.
const sample = range => randomInt(range.min, range.max + 1);

function validateRange(name, range) {
  if (
    !range
    || !Number.isSafeInteger(range.min)
    || !Number.isSafeInteger(range.max)
    || range.min < 0
    || range.max < range.min
  ) {
    throw new TypeError('Invalid delay range: ' + name);
  }
}

export function createInteraction(config, { signal, log = () => {} } = {}) {
  for (const key of ['fieldDelayMs', 'submitDelayMs', 'keyDelayMs']) validateRange(key, config[key]);

  const checkAbort = () => { signal?.throwIfAborted(); };

  const pause = async (range, stage, field) => {
    checkAbort();
    const durationMs = sample(range);
    log('interaction_delay', { stage, field, durationMs });
    if (durationMs > 0) await delay(durationMs, undefined, { signal });
  };

  return {
    beforeField: field => pause(config.fieldDelayMs, 'fill', field),
    beforeOption: field => pause(config.fieldDelayMs, 'select_option', field),
    beforeSubmit: () => pause(config.submitDelayMs, 'submit', 'submit'),

    // Types one character at a time so the page sees genuine key events. The
    // caller clears the field first, because filling over a value would keep the
    // old text in a control the page does not treat as a text input.
    async typeText(page, selector, value, options = {}) {
      const { field = 'input', clear = true } = options;
      checkAbort();
      const target = { selfSelector: selector };
      await page.round({ op: 'focus', ...target });
      if (clear) await page.round({ op: 'fill', ...target, value: '' });
      const characters = Array.from(String(value ?? '').replace(/\r\n?/g, '\n'));
      for (let index = 0; index < characters.length; index++) {
        checkAbort();
        const character = characters[index];
        if (character === '\n') {
          await page.round({ op: 'press', ...target, key: 'Enter' });
        } else {
          await page.round({ op: 'insert', ...target, text: character });
        }
        if (index < characters.length - 1) await pause(config.keyDelayMs, 'type', field);
      }
      log('interaction_typed', { field, characterCount: characters.length });
    },
  };
}
