import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceOf } from '../src/browser/ego-source.js';
import { installDom } from '../src/browser/ego-dom.js';
import { pageDispatch } from '../src/browser/ego-ops.js';
import { spaceFor } from '../src/browser/session.js';

test('sourceOf wraps a declaration so new Function returns it', () => {
  // new Function() evaluates a body: a bare declaration there defines nothing and
  // returns undefined, which silently produced an uncallable page helper.
  const source = sourceOf(installDom);
  assert.match(source, /^\(function\(\)\{/);
  assert.match(source, /return installDom;/);
  const factory = new Function('return ' + source);
  assert.equal(typeof factory(), 'function');
});

test('sourceOf returns a factory for an arrow function', () => {
  // The wrapper always evaluates to something callable; for an arrow that value is
  // the arrow itself, not its result.
  const factory = new Function('return ' + sourceOf(() => 42))();
  assert.equal(typeof factory, 'function');
  assert.equal(factory(), 42);
});

test('sourceOf strips the module export keyword', () => {
  const source = sourceOf(pageDispatch);
  assert.ok(!source.includes('export function'));
  assert.match(source, /function pageDispatch/);
});

test('a task space name is stable per verification link and headless mode', () => {
  const base = { url: 'https://services.sheerid.com/verify/a/?verificationId=b', browser: { headless: false } };
  assert.equal(spaceFor(base), spaceFor({ ...base }));
  assert.notEqual(spaceFor(base), spaceFor({ ...base, browser: { headless: true } }));
  assert.notEqual(spaceFor(base), spaceFor({ ...base, url: base.url + 'x' }));
  assert.match(spaceFor(base), /^sheerid-verify-[0-9a-f]{12}$/);
});
