# dsh-web-notify

DSH 的「对话完成」浏览器桌面通知插件。

参考 Claude Code 的 `notify.py` hook 行为，但把通知点从进程级 toast 搬到 Web 端：会话从运行中变回空闲的那一刻，浏览器弹一条系统通知 —— 标题固定 `✅ 对话已完成`，正文是会话标题（没有标题就用工作目录名）。点通知回到页面。

## 行为

- 监听 `ctx.sessions.list`，按 `sessionId` 记录 `running`，`true → false` 才通知，不会因为列表刷新重复弹。
- `origin: 'subagent'` 的子会话不通知，避免一次主对话结束弹一串。
- 插件加载时已经在跑的会话也会被记录，因此中途打开页面照样能收到完成通知。
- 通知开关存 `localStorage`（键 `dsh-web-notify:enabled`），默认开。
- 浏览器通知权限只在点铃铛时申请（浏览器要求用户手势），权限被拒时铃铛提示去站点设置里允许。

## 安装

```bash
# 以 bundle 方式装进当前 profile
dsh plugin install /path/to/dsh-web-notify
```

或让 agent 调 `plugin_manager`：

```
action: install_bundle
target: D:\ds\plugins\dsh-web-notify
```

装好后侧边栏底部（设置按钮旁边）多一个铃铛：

| 状态 | 含义 |
| --- | --- |
| 铃铛实心、不透明 | 通知开着 |
| 铃铛带斜杠、半透明 | 通知关着 |
| 浏览器不支持 / 权限被拒 | tooltip 里写明原因 |

## 结构

```
package.json         # bundle 清单：patch + dsh.client（web，注入 renderer/session-controller）
cordis.patch.yml     # 只 insert 自己这一行，不改宿主组合
index.js             # Host 半边：空实现
client.js            # Client 半边：监听会话 running + 侧边栏铃铛
scripts/selftest.mjs # 无浏览器自测：假 window/React/Notification 驱动快照
```

## 自测

```bash
node scripts/selftest.mjs
```

覆盖：注册槽位、空闲不弹、开跑不弹、结束弹一次、重复快照不重复、子会话静默、cwd 兜底、权限未授予不发、dispose 后停表、铃铛点击开/关与持久化。

## 已知限制

- 只有 Notification API 一条通路，没做 service worker / Web Push —— 页面关掉就收不到。需要后台推送得先有 PWA 与推送服务。
- 只在页面已加载时工作，不监听 Host 端的 `turn/end` 事件，所以「断线期间的完成」不补发。
