/**
 * Headless self-test: loads client.js the way the browser module loader does,
 * with a fake window/React/Notification/localStorage, then drives session-list
 * snapshots and Remote Event waterfalls and asserts what the plugin announces.
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
function boot({ withWorkspace = true, withRemote = true, scopeOf } = {}) {
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

  const handlers = new Map();
  const remote = withRemote
    ? {
        $on: (event, fn) => {
          handlers.set(event, fn);
          return () => handlers.delete(event);
        },
      }
    : undefined;

  const services = {
    sessions: { list, ...(scopeOf === undefined ? {} : { scopeOf }) },
    ...(withRemote ? { remote } : {}),
  };
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
    handlers,
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

const agent = { scoped: 's1' };
const runtime = boot({ scopeOf: (ctx) => (ctx === agent ? 's1' : undefined) });

check(
  'declares slots, sessions and uiWorkspace',
  runtime.inject.join(',') === 'slots,sessions,uiWorkspace',
  runtime.inject.join(','),
);
check(
  'registers one sidebar.footer.action bell',
  runtime.registrations.length === 1 && runtime.registrations[0].options.name === 'sidebar.footer.action',
);
check(
  'subscribes to both attention waterfalls',
  runtime.handlers.has('approval/request') && runtime.handlers.has('user-questions/request'),
  [...runtime.handlers.keys()].join(','),
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
check('done tag is per session and kind', notifications[0]?.options?.tag === 'dsh-web-notify:s1:done', String(notifications[0]?.options?.tag));

notifications[0].onclick();
check('click focuses the window', focused === 1, `got ${focused}`);
check('click opens the notified session', opened.join(',') === 's1', opened.join(','));
check('click closes the notification', notifications[0].closed === true);

runtime.push({ ids: ['s1'], byId: { s1: row(false) }, projectionsBySession: projections });
check('idle -> idle does not re-announce', notifications.length === 1, `got ${notifications.length}`);

// ── approval waterfall ─────────────────────────────────────────────────────
let nextCalls = 0;
const next = () => {
  nextCalls += 1;
  return Promise.resolve('next-marker');
};

const approval = runtime.handlers.get('approval/request');
check('approval handler runs before the chain', (await approval.call(agent, { toolName: 'Bash' }, next)) === 'next-marker');
check('approval hands the request on exactly once', nextCalls === 1, `got ${nextCalls}`);
check('approval notification is delivered', notifications.length === 2, `got ${notifications.length}`);
check('approval names the tool', notifications[1]?.options?.body === '🔐 需要授权 · Bash', String(notifications[1]?.options?.body));
check('approval reuses the cached session title', notifications[1]?.title === '实现 web 通知插件', String(notifications[1]?.title));
check('approval tag is per kind', notifications[1]?.options?.tag === 'dsh-web-notify:s1:approval', String(notifications[1]?.options?.tag));

notifications[1].onclick();
check('approval click opens the session', opened.join(',') === 's1,s1', opened.join(','));

// ── question waterfall ─────────────────────────────────────────────────────
await runtime.handlers
  .get('user-questions/request')
  .call(agent, { questions: [{ id: 'q1', header: '选哪个', question: '要 A 还是 B？' }] }, next);
check('question hands the request on', nextCalls === 2, `got ${nextCalls}`);
check('question notification is delivered', notifications.length === 3, `got ${notifications.length}`);
check('question prefers the header', notifications[2]?.options?.body === '❓ 需要回答 · 选哪个', String(notifications[2]?.options?.body));

await runtime.handlers
  .get('user-questions/request')
  .call(agent, { questions: [{ id: 'q2', question: '这行代码要改吗？' }] }, next);
check('question falls back to the text', notifications[3]?.options?.body === '❓ 需要回答 · 这行代码要改吗？', String(notifications[3]?.options?.body));

const longText = 'x'.repeat(120);
await runtime.handlers.get('user-questions/request').call(agent, { questions: [{ id: 'q3', question: longText }] }, next);
check('long question text is truncated', String(notifications[4]?.options?.body).endsWith('…'), String(notifications[4]?.options?.body));

// ── an unknown scope must not break the waterfalls ──────────────────────────
const before = notifications.length;
await approval.call({ scoped: 'other' }, { toolName: 'Write' }, next);
check('unscoped approval still reaches the next handler', nextCalls === 5, `got ${nextCalls}`);
check('unscoped approval carries no session', notifications.length === before + 1 && notifications.at(-1)?.title === '会话', String(notifications.at(-1)?.title));

const explosive = boot({
  scopeOf: () => {
    throw new Error('scope unavailable');
  },
});
await explosive.handlers
  .get('approval/request')
  .call(agent, { toolName: 'Bash' }, next);
check('a throwing scope still hands the request on', nextCalls === 6, `got ${nextCalls}`);
explosive.dispose();

// ── other sessions, permissions, disposal ──────────────────────────────────
runtime.push({
  ids: ['s2'],
  byId: { s2: { ...row(false), sessionId: 's2', origin: 'subagent', cwd: 'D:\\proj\\demo\\sub' } },
  projectionsBySession: {},
});
runtime.push({ ids: ['s2'], byId: { s2: { ...row(true), sessionId: 's2', origin: 'subagent' } }, projectionsBySession: {} });
runtime.push({ ids: ['s2'], byId: { s2: { ...row(false), sessionId: 's2', origin: 'subagent' } }, projectionsBySession: {} });
check('subagent turns stay silent', notifications.length === before + 1, `got ${notifications.length}`);

const untitled = { ...row(true), sessionId: 's3', cwd: 'D:/work/dsh-web-notify' };
runtime.push({ ids: ['s3'], byId: { s3: { ...untitled, running: false } }, projectionsBySession: {} });
runtime.push({ ids: ['s3'], byId: { s3: untitled }, projectionsBySession: {} });
runtime.push({ ids: ['s3'], byId: { s3: { ...untitled, running: false } }, projectionsBySession: {} });
check('untitled session falls back to the cwd basename', notifications.at(-1)?.title === 'dsh-web-notify', String(notifications.at(-1)?.title));
check('fallback body stays bare', notifications.at(-1)?.options?.body === '✅ 对话已完成', String(notifications.at(-1)?.options?.body));

permission = 'default';
const muted = notifications.length;
runtime.push({ ids: ['s4'], byId: { s4: { ...row(true), sessionId: 's4' } }, projectionsBySession: {} });
runtime.push({ ids: ['s4'], byId: { s4: { ...row(false), sessionId: 's4' } }, projectionsBySession: {} });
check('ungranted permission blocks delivery', notifications.length === muted, `got ${notifications.length}`);
permission = 'granted';

runtime.dispose();
const disposed = notifications.length;
runtime.push({ ids: ['s5'], byId: { s5: { ...row(true), sessionId: 's5' } }, projectionsBySession: {} });
runtime.push({ ids: ['s5'], byId: { s5: { ...row(false), sessionId: 's5' } }, projectionsBySession: {} });
check('disposed runtime stops watching', notifications.length === disposed, `got ${notifications.length}`);
check('disposal unsubscribes the waterfalls', runtime.handlers.size === 0, [...runtime.handlers.keys()].join(','));

const bare = boot({ withWorkspace: false, withRemote: false });
bare.push({ ids: ['s6'], byId: { s6: { ...row(true), sessionId: 's6' } }, projectionsBySession: projections });
bare.push({ ids: ['s6'], byId: { s6: { ...row(false), sessionId: 's6' } }, projectionsBySession: projections });
notifications.at(-1)?.onclick();
check('works without the workspace or remote service', notifications.at(-1)?.closed === true);
bare.dispose();

const Bell = runtime.registrations[0].component;
const element = Bell({ wide: true });
check('bell renders a button', element?.type === 'button');
check('bell exposes pressed state', element?.props?.['aria-pressed'] === true, String(element?.props?.['aria-pressed']));

const beforeBell = notifications.length;
await element.props.onClick();
check('clicking a granted bell toggles off', storage.get('dsh-web-notify:enabled') === 'off', String(storage.get('dsh-web-notify:enabled')));
runtime.push({ ids: ['s7'], byId: { s7: { ...row(true), sessionId: 's7' } }, projectionsBySession: {} });
runtime.push({ ids: ['s7'], byId: { s7: { ...row(false), sessionId: 's7' } }, projectionsBySession: {} });
check('disabled plugin delivers nothing', notifications.length === beforeBell, `got ${notifications.length}`);

await element.props.onClick();
check('second click re-enables', storage.get('dsh-web-notify:enabled') === 'on', String(storage.get('dsh-web-notify:enabled')));

let failed = 0;
for (const { name, pass, detail } of checks) {
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass || !detail ? '' : `  (${detail})`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
