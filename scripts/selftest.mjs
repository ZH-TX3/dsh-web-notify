/**
 * Headless self-test: loads client.js the way the browser module loader does,
 * with a fake window/React/Notification/localStorage, then drives session-list
 * snapshots and asserts what the plugin announces.
 *
 * Run: node scripts/selftest.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../client.js'), 'utf8');

const notifications = [];
let permission = 'granted';

class FakeNotification {
  static get permission() {
    return permission;
  }
  static requestPermission = async () => 'granted';
  constructor(title, options) {
    notifications.push({ title, options });
  }
  close() {}
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: () => [0, () => {}],
  useEffect: () => {},
};

const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
};
const document = { hasFocus: () => true, visibilityState: 'visible' };
globalThis.localStorage = localStorage;

let module = null;
const window = { __ModuleLoader__: { load: (mod) => { module = mod; }, focus() {} } };

new Function('window', 'Notification', 'localStorage', 'document', source)(
  window,
  FakeNotification,
  localStorage,
  document,
);
if (!module) throw new Error('client.js did not register a module');

/**
 * Build the plugin instance exactly as the shell would: factory(require) then
 * apply(ctx) with the slots/sessions services present.
 */
function boot() {
  const plugin = module.factory((id) => {
    if (id === 'react') return React;
    throw new Error(`unexpected require: ${id}`);
  });

  let snapshot = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} };
  const subscribers = new Set();
  const list = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };

  const registrations = [];
  const cleanups = [];
  const ctx = {
    inject: plugin.inject,
    get: (name) => (name === 'sessions' ? { list } : undefined),
    effect: (fn, label) => {
      const cleanup = fn();
      cleanups.push({ label, cleanup });
      return () => cleanup?.();
    },
    slots: {
      inject: (name, fn) => {
        const effect = fn();
        return () => effect?.();
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };

  plugin.apply(ctx);

  return {
    push(next) {
      snapshot = { phase: 'ready', projectionsBySession: {}, ...next };
      for (const fn of subscribers) fn();
    },
    registrations,
    dispose() {
      for (const { cleanup } of cleanups) cleanup?.();
    },
  };
}

const checks = [];
function check(name, pass, detail = '') {
  checks.push({ name, pass, detail });
}

const runtime = boot();

check('registers one sidebar.footer.action bell', runtime.registrations.length === 1
  && runtime.registrations[0].options.name === 'sidebar.footer.action');

const row = (running) => ({ agentAvailable: true, sessionId: 's1', updatedAt: 0, running, blank: false, cwd: 'D:\\proj\\demo' });
const projections = { s1: { values: { title: '实现 web 通知插件' }, state: 'ready', error: null } };

runtime.push({ ids: ['s1'], byId: { s1: row(false) }, projectionsBySession: projections });
check('idle session announces nothing', notifications.length === 0, `got ${notifications.length}`);

runtime.push({ ids: ['s1'], byId: { s1: row(true) }, projectionsBySession: projections });
check('turn start announces nothing', notifications.length === 0, `got ${notifications.length}`);

runtime.push({ ids: ['s1'], byId: { s1: row(false) }, projectionsBySession: projections });
check('turn end announces once', notifications.length === 1, `got ${notifications.length}`);
check('uses the session title as body', notifications[0]?.options?.body === '实现 web 通知插件', String(notifications[0]?.options?.body));
check('title is the completion line', notifications[0]?.title === '✅ 对话已完成', String(notifications[0]?.title));

runtime.push({ ids: ['s1'], byId: { s1: row(false) }, projectionsBySession: projections });
check('idle -> idle does not re-announce', notifications.length === 1, `got ${notifications.length}`);

runtime.push({
  ids: ['s2'],
  byId: { s2: { ...row(false), sessionId: 's2', origin: 'subagent', cwd: 'D:\\proj\\demo\\sub' } },
  projectionsBySession: {},
});
runtime.push({
  ids: ['s2'],
  byId: { s2: { ...row(true), sessionId: 's2', origin: 'subagent' } },
  projectionsBySession: {},
});
runtime.push({
  ids: ['s2'],
  byId: { s2: { ...row(false), sessionId: 's2', origin: 'subagent' } },
  projectionsBySession: {},
});
check('subagent turns stay silent', notifications.length === 1, `got ${notifications.length}`);

runtime.push({ ids: ['s3'], byId: { s3: { ...row(false), sessionId: 's3', cwd: 'D:/work/dsh-web-notify' } }, projectionsBySession: {} });
runtime.push({ ids: ['s3'], byId: { s3: { ...row(true), sessionId: 's3', cwd: 'D:/work/dsh-web-notify' } }, projectionsBySession: {} });
runtime.push({ ids: ['s3'], byId: { s3: { ...row(false), sessionId: 's3', cwd: 'D:/work/dsh-web-notify' } }, projectionsBySession: {} });
check('falls back to the cwd basename', notifications[1]?.options?.body === 'dsh-web-notify', String(notifications[1]?.options?.body));

permission = 'default';
runtime.push({ ids: ['s4'], byId: { s4: { ...row(true), sessionId: 's4' } }, projectionsBySession: {} });
runtime.push({ ids: ['s4'], byId: { s4: { ...row(false), sessionId: 's4' } }, projectionsBySession: {} });
check('ungranted permission blocks delivery', notifications.length === 2, `got ${notifications.length}`);
permission = 'granted';

runtime.dispose();
runtime.push({ ids: ['s5'], byId: { s5: { ...row(true), sessionId: 's5' } }, projectionsBySession: {} });
runtime.push({ ids: ['s5'], byId: { s5: { ...row(false), sessionId: 's5' } }, projectionsBySession: {} });
check('disposed runtime stops watching', notifications.length === 2, `got ${notifications.length}`);

const Bell = runtime.registrations[0].component;
const element = Bell({ wide: true });
check('bell renders a button', element?.type === 'button');
check('bell exposes pressed state', element?.props?.['aria-pressed'] === true, String(element?.props?.['aria-pressed']));

const before = notifications.length;
await element.props.onClick();
check('clicking a granted bell toggles off', storage.get('dsh-web-notify:enabled') === 'off', String(storage.get('dsh-web-notify:enabled')));
runtime.push({ ids: ['s6'], byId: { s6: { ...row(true), sessionId: 's6' } }, projectionsBySession: {} });
runtime.push({ ids: ['s6'], byId: { s6: { ...row(false), sessionId: 's6' } }, projectionsBySession: {} });
check('disabled plugin delivers nothing', notifications.length === before, `got ${notifications.length}`);

await element.props.onClick();
check('second click re-enables', storage.get('dsh-web-notify:enabled') === 'on', String(storage.get('dsh-web-notify:enabled')));

let failed = 0;
for (const { name, pass, detail } of checks) {
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass || !detail ? '' : `  (${detail})`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
