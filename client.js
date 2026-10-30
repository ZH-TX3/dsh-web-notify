window.__ModuleLoader__.load({
  id: '@local/dsh-web-notify',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STORAGE_KEY = 'dsh-web-notify:enabled';
    const NOTIFY_BODY = '✅ 对话已完成';
    const supported = typeof Notification !== 'undefined';

    /** Set by apply(): opens the notified Session through the workspace service. */
    const opener = { current: null };

    /** Last seen Session titles, so approval and question notifications can name the session. */
    const titles = new Map();

    function readEnabled() {
      try {
        return globalThis.localStorage?.getItem(STORAGE_KEY) !== 'off';
      } catch {
        return true;
      }
    }

    function writeEnabled(value) {
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, value ? 'on' : 'off');
      } catch {
        /* storage unavailable: keep the in-memory value */
      }
    }

    const state = {
      enabled: readEnabled(),
      permission: supported ? Notification.permission : 'unsupported',
      listeners: new Set(),
    };

    function notifyListeners() {
      for (const listener of state.listeners) {
        try {
          listener();
        } catch {
          /* a broken listener must not starve the rest */
        }
      }
    }

    function setEnabled(value) {
      state.enabled = value;
      writeEnabled(value);
      notifyListeners();
    }

    function setPermission(value) {
      state.permission = value;
      notifyListeners();
    }

    function tail(path) {
      if (typeof path !== 'string' || path === '') return '';
      const parts = path.split(/[\\/]/).filter(Boolean);
      return parts[parts.length - 1] ?? path;
    }

    /** Session title from the list projections; the cwd basename is the fallback. */
    function titleOf(snapshot, id, row) {
      const projected = snapshot?.projectionsBySession?.[id]?.values?.title;
      if (typeof projected === 'string' && projected.trim() !== '') return projected.trim();
      const project = tail(row?.cwd);
      return project === '' ? '会话' : project;
    }

    function excerpt(text, max = 60) {
      const flat = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
    }

    function openSession(id) {
      try {
        window.focus();
      } catch {
        /* focus may be denied outside a gesture */
      }
      const open = opener.current;
      if (!open) return;
      try {
        open(id);
      } catch {
        /* navigation failures must not break the click handler */
      }
    }

    /** One notification per kind and Session; the click jumps back to that Session. */
    function deliver(id, kind, body, title) {
      if (!state.enabled || !supported) return;
      if (Notification.permission !== 'granted') return;
      try {
        const notification = new Notification(title || titles.get(id) || '会话', {
          body,
          tag: `dsh-web-notify:${id ?? 'unknown'}:${kind}`,
          renotify: true,
        });
        notification.onclick = () => {
          if (id) openSession(id);
          notification.close();
        };
      } catch {
        /* notification construction can throw on some platforms */
      }
    }

    function Bell(props) {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        const listener = () => bump((n) => n + 1);
        state.listeners.add(listener);
        return () => {
          state.listeners.delete(listener);
        };
      }, []);

      const granted = state.permission === 'granted';
      const on = granted && state.enabled;
      const hint =
        state.permission === 'unsupported'
          ? '当前浏览器不支持通知'
          : state.permission === 'denied'
            ? '浏览器已拒绝通知权限，请在站点设置里允许'
            : !granted
              ? '点击开启桌面通知'
              : state.enabled
                ? '桌面通知已开启，点击关闭'
                : '桌面通知已关闭，点击开启';

      async function onClick() {
        if (!supported) return;
        if (Notification.permission === 'denied') {
          setPermission('denied');
          return;
        }
        if (Notification.permission !== 'granted') {
          let result = 'denied';
          try {
            result = await Notification.requestPermission();
          } catch {
            result = 'denied';
          }
          setPermission(result);
          if (result === 'granted') setEnabled(true);
          return;
        }
        setEnabled(!state.enabled);
      }

      const icon = h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto' },
        },
        h('path', { d: 'M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8' }),
        h('path', { d: 'M13.7 21a2 2 0 0 1-3.4 0' }),
        on ? null : h('path', { d: 'M3 3l18 18' }),
      );

      return h(
        'button',
        {
          type: 'button',
          onClick,
          title: hint,
          'aria-label': hint,
          'aria-pressed': on,
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: props.wide ? 'flex-start' : 'center',
            gap: 8,
            width: props.wide ? '100%' : 32,
            height: 32,
            padding: props.wide ? '0 8px' : 0,
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            opacity: on ? 1 : 0.62,
            cursor: 'pointer',
            font: 'inherit',
            fontSize: 13,
          },
        },
        icon,
        props.wide
          ? h(
              'span',
              {
                style: {
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                },
              },
              '桌面通知',
            )
          : null,
      );
    }

    function apply(ctx) {
      const sessions = ctx.get('sessions');
      const list = sessions?.list;
      const workspace = ctx.get('uiWorkspace');
      if (workspace && typeof workspace.openSession === 'function') {
        opener.current = (id) => workspace.openSession(id);
      }
      if (!list) return;

      const running = new Map();

      function scan(snapshot) {
        const ids = Array.isArray(snapshot?.ids) ? snapshot.ids : [];
        const byId = snapshot?.byId ?? {};
        const seen = new Set();

        for (const id of ids) {
          const row = byId[id];
          if (!row || row.origin === 'subagent') continue;
          seen.add(id);

          const title = titleOf(snapshot, id, row);
          if (title !== '会话') titles.set(id, title);

          const was = running.get(id);
          if (row.running) {
            running.set(id, true);
            continue;
          }

          running.set(id, false);
          if (was === true) {
            const project = tail(row.cwd);
            deliver(
              id,
              'done',
              project !== '' && project !== title ? `${NOTIFY_BODY} · 📂 ${project}` : NOTIFY_BODY,
              title,
            );
          }
        }

        for (const id of running.keys()) {
          if (!seen.has(id)) running.delete(id);
        }
      }

      ctx.effect(() => {
        scan(list.getSnapshot());
        return list.subscribe(() => scan(list.getSnapshot()));
      }, 'web-notify: watch session turns');

      // Both are Host waterfalls: notify first, then always hand the request on.
      const remote = ctx.get('remote');
      if (remote && typeof remote.$on === 'function') {
        ctx.effect(() => {
          const offApproval = remote.$on('approval/request', function (request, next) {
            try {
              const id = sessions.scopeOf?.(this);
              const tool = excerpt(request?.toolName, 40);
              deliver(id, 'approval', tool === '' ? '🔐 需要授权' : `🔐 需要授权 · ${tool}`);
            } catch {
              /* a notification must never break the approval waterfall */
            }
            return next();
          });

          const offQuestion = remote.$on('user-questions/request', function (request, next) {
            try {
              const id = sessions.scopeOf?.(this);
              const first = request?.questions?.[0];
              const asked = excerpt(first?.header || first?.question || '', 60);
              deliver(id, 'question', asked === '' ? '❓ 需要回答' : `❓ 需要回答 · ${asked}`);
            } catch {
              /* a notification must never break the question waterfall */
            }
            return next();
          });

          return () => {
            offApproval();
            offQuestion();
          };
        }, 'web-notify: attention events');
      }

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'web-notify-bell',
            order: -10,
            label: () => '桌面通知',
          },
          Bell,
        ),
      );
    }

    return { inject: ['slots', 'sessions', 'uiWorkspace'], apply };
  },
});
