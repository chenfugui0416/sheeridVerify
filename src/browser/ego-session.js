import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationError } from '../core/errors.js';
import { installDom } from './ego-dom.js';
import { sourceOf } from './ego-source.js';

// ego-browser runs each script in a fresh Node process with an empty environment
// and forwards console output to stderr, so nothing crosses the process boundary
// except the script text going in and one JSON file coming back.
const EGO_BIN = process.env.EGO_BIN || 'ego-browser';
const DOM_SOURCE = sourceOf(installDom);

function detailOf(text) {
  return String(text ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('[ego-browser:notice]'))
    .slice(-4)
    .join(' | ')
    .slice(0, 600);
}

export function runScript(script, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    // The CLI takes the script as -e; it never reads stdin.
    const child = spawn(EGO_BIN, ['nodejs', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AutomationError('EGO_ACTION_TIMEOUT', 'ego 浏览器执行超时，已终止本轮脚本'));
    }, timeoutMs);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', () => {});
    child.on('error', error => {
      clearTimeout(timer);
      reject(new AutomationError('EGO_UNAVAILABLE', '无法启动 ego-browser：' + error.message));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) { resolve({ stderr }); return; }
      const match = /EGO_[A-Z_]+/.exec(stderr);
      reject(new AutomationError(match ? match[0] : 'EGO_EXEC_FAILED', detailOf(stderr) || 'exit ' + code));
    });
  });
}

export function buildScript({ space, label, body, call, resultPath }) {
  return [
    'import { writeFile } from "node:fs/promises";',
    'const DATA = ' + JSON.stringify({ dom: DOM_SOURCE, body, call }) + ';',
    'const OUT = ' + JSON.stringify(resultPath) + ';',
    'const task = await taskSpace(' + JSON.stringify(space) + ');',
    'const page = task.page(' + JSON.stringify(label) + ');',
    'const result = await page.evaluate(runOps, DATA);',
    'await writeFile(OUT, JSON.stringify(result === undefined ? null : result));',
    'async function runOps(payload) {',
    '  const install = (new Function("return " + payload.dom))();',
    '  install();',
    '  const factory = (new Function("return " + payload.body))();',
    '  const ops = typeof factory === "function" && factory.length === 0 ? factory() : factory;',
    '  return await ops(payload.call);',
    '}',
  ].join('\n');
}

export async function runRound({ space, label, body, call, timeoutMs }) {
  const dir = mkdtempSync(join(tmpdir(), 'sheerid-ego-'));
  const resultPath = join(dir, 'result.json');
  try {
    await runScript(buildScript({ space, label, body, call, resultPath }), { timeoutMs });
    return JSON.parse(readFileSync(resultPath, 'utf8'));
  } catch (error) {
    if (error instanceof AutomationError) throw error;
    throw new AutomationError('EGO_EXEC_FAILED', detailOf(error?.message) || 'ego 轮次失败');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
