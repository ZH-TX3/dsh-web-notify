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
    this.title = title;
    this.options = options;
    this.closed = false;
    notifications.push(this);
  }
  close() {
    this.closed = true;
  }
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

let focused = 0;
const opened = [];
let module = null;
const window = {
  __ModuleLoader__: { load: (mod) => { module = mod; } },
  focus: () => { focused += 1; },
};

new Function('window', 'Notification', 'localStorage', 'document', source)(
  window,
  FakeNotification,
  localStorage,
  document,
);
if (!module) throw new Error('client.js did not register a module');

/** Build the plugin instance exactly as the shell would: factory(require) then apply(ctx). */
function boot({ withWorkspace = true } = {}) {
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

  const services = { sessions: { list } };
  if (withWorkspace) services.uiWorkspace = { openSession: (id) => opened.push(id) };

  const registrations = [];
  const cleanups = [];
  const ctx = {
    inject: plugin.inject,
    get: (name) => services[name],
    effect: (fn) => {
      const cleanup = fn();
      cleanups.push(cleanup);
      return () => cleanup?.();
    },
    slots: {
      inject: (name, fn) => fn(),
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };

  plugin.apply(ctx);

  return {
    inject: plugin.inject,
    push(next) {
      snapshot = { phase: 'ready', projectionsBySession: {}, ...next };
      for (const fn of subscribers) fn();
    },
    registrations,
    dispose() {
      for (const cleanup of cleanups) cleanup?.();
    },
  };
}

const checks = [];
function check(name, pass, detail = '') {
  checks.push({ name, pass, detail });
}

const runtime = boot();

check(
  'declares slots, sessions and uiWorkspace',
  runtime.inject.join(',') === 'slots,sessions,uiWorkspace',
  runtime.inject.join(','),
);
check(
  'registers one sidebar.footer.action bell',
  runtime.registrations.length === 1 && runtime.registrations[0].options.name === 'sidebar.footer.action',
);

const row = (running) => ({
  agentAvailable: true,
  sessionId: 's1',
  updatedAt: 0,
  running,
  blank: false,
  cwd: 'D:\\proj\\demo',
});
const projections = { s1: { values: { title: '实现 web 通知插件' }, state: 'ready', error: null } };

runtime.push({ ids: ['s1'], byId: { s1: row(false) }, projectionsBySession: projections });
check('idle session announces nothing', notifications.length === 0, `got ${notifications.length}`);

runtime.push({ ids: ['s1'], byId: { s1: row(true) }, projectionsBySession: projections });
check('turn start announces nothing', notifications.length === 0, `got ${notifications.length}`);

runtime.push({ ids: ['s1'], byId: { s1: row(false) }, projectionsBySession: projections });
check('turn end announces once', notifications.length === 1, `got ${notifications.length}`);
check('title carries the session title', notifications[0]?.title === '实现 web 通知插件', String(notifications[0]?.title));
check('body carries the completion line', notifications[0]?.options?.body === '✅ 对话已完成 · 📂 demo', String(notifications[0]?.options?.body));
check('tag is scoped to the session', notifications[0]?.options?.tag === 'dsh-web-notify:s1', String(notifications[0]?.options?.tag));

notifications[0].onclick();
check('click focuses the window', focused === 1, `got ${focused}`);
check('click opens the notified session', opened.join(',') === 's1', opened.join(','));
check('click closes the notification', notifications[0].closed === true);

runtime.push({ ids: ['s1'], byId: { s1: row(false) }, projectionsBySession: projections });
check('idle -> idle does not re-announce', notifications.length === 1, `got ${notifications.length}`);

runtime.push({
  ids: ['s2'],
  byId: { s2: { ...row(false), sessionId: 's2', origin: 'subagent', cwd: 'D:\\proj\\demo\\sub' } },
  projectionsBySession: {},
});
runtime.push({ ids: ['s2'], byId: { s2: { ...row(true), sessionId: 's2', origin: 'subagent' } }, projectionsBySession: {} });
runtime.push({ ids: ['s2'], byId: { s2: { ...row(false), sessionId: 's2', origin: 'subagent' } }, projectionsBySession: {} });
check('subagent turns stay silent', notifications.length === 1, `got ${notifications.length}`);

const untitled = { ...row(true), sessionId: 's3', cwd: 'D:/work/dsh-web-notify' };
runtime.push({ ids: ['s3'], byId: { s3: { ...untitled, running: false } }, projectionsBySession: {} });
runtime.push({ ids: ['s3'], byId: { s3: untitled }, projectionsBySession: {} });
runtime.push({ ids: ['s3'], byId: { s3: { ...untitled, running: false } }, projectionsBySession: {} });
check('untitled session falls back to the cwd basename', notifications[1]?.title === 'dsh-web-notify', String(notifications[1]?.title));
check('fallback body stays bare', notifications[1]?.options?.body === '✅ 对话已完成', String(notifications[1]?.options?.body));
check('second session gets its own tag', notifications[1]?.options?.tag === 'dsh-web-notify:s3', String(notifications[1]?.options?.tag));

permission = 'default';
runtime.push({ ids: ['s4'], byId: { s4: { ...row(true), sessionId: 's4' } }, projectionsBySession: {} });
runtime.push({ ids: ['s4'], byId: { s4: { ...row(false), sessionId: 's4' } }, projectionsBySession: {} });
check('ungranted permission blocks delivery', notifications.length === 2, `got ${notifications.length}`);
permission = 'granted';

runtime.dispose();
runtime.push({ ids: ['s5'], byId: { s5: { ...row(true), sessionId: 's5' } }, projectionsBySession: {} });
runtime.push({ ids: ['s5'], byId: { s5: { ...row(false), sessionId: 's5' } }, projectionsBySession: {} });
check('disposed runtime stops watching', notifications.length === 2, `got ${notifications.length}`);

const bare = boot({ withWorkspace: false });
bare.push({ ids: ['s6'], byId: { s6: { ...row(true), sessionId: 's6' } }, projectionsBySession: projections });
bare.push({ ids: ['s6'], byId: { s6: { ...row(false), sessionId: 's6' } }, projectionsBySession: projections });
const beforeClick = notifications.length;
notifications[beforeClick - 1]?.onclick();
check('works without the workspace service', notifications.length === beforeClick, `got ${notifications.length}`);
bare.dispose();

const Bell = runtime.registrations[0].component;
const element = Bell({ wide: true });
check('bell renders a button', element?.type === 'button');
check('bell exposes pressed state', element?.props?.['aria-pressed'] === true, String(element?.props?.['aria-pressed']));

const before = notifications.length;
await element.props.onClick();
check('clicking a granted bell toggles off', storage.get('dsh-web-notify:enabled') === 'off', String(storage.get('dsh-web-notify:enabled')));
runtime.push({ ids: ['s7'], byId: { s7: { ...row(true), sessionId: 's7' } }, projectionsBySession: {} });
runtime.push({ ids: ['s7'], byId: { s7: { ...row(false), sessionId: 's7' } }, projectionsBySession: {} });
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
