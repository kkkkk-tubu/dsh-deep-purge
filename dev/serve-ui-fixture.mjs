// 面板 UI 冒烟测试：起一个假后端（返回 fixture JSON），把 lib/ui.js 加载进真实 Chromium，
// 检查按钮/浮层/列表/预演/删除确认是否都能正常渲染，不报 JS 错误。
// 运行：ELECTRON_RUN_AS_NODE=1 & 'E:\DSH\DeepSeek Harness.exe' serve-ui-fixture.mjs
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI = fs.readFileSync(path.join(HERE, 'lib', 'ui.js'), 'utf8')
const CLIENT = fs.readFileSync(path.join(HERE, 'lib', 'client.js'), 'utf8')

const now = Date.now()
const LIST = {
  ok: true,
  ms: 34,
  totals: { count: 4, registered: 3, orphan: 1, diskBytes: 39105138 },
  sessions: [
    { id: 'session-aaaaaaaa-1111-4a4a-8b8b-000000000001', title: '如何分享对话', workspace: '日常', registered: true, archived: false, pinned: false, hasDir: true, hasProjCache: true, dirs: 1, files: 1, diskBytes: 5124979, lastWrite: now - 120000 },
    { id: 'session-bbbbbbbb-2222-4a4a-8b8b-000000000002', title: '帮我找找给学习通刷课刷题的东西', workspace: '日常', registered: true, archived: false, pinned: false, hasDir: true, hasProjCache: true, dirs: 1, files: 1, diskBytes: 13823, lastWrite: now - 86400000 * 2 },
    { id: 'session-cccccccc-3333-4a4a-8b8b-000000000003', title: '毕业论文实验三', workspace: '李溢华毕业论文', registered: true, archived: true, pinned: true, hasDir: true, hasProjCache: true, dirs: 2, files: 5, diskBytes: 22020096, lastWrite: now - 86400000 * 5 },
    { id: 'session-dddddddd-4444-4a4a-8b8b-000000000004', title: '(无标题)', workspace: '—', registered: false, archived: false, pinned: false, hasDir: true, hasProjCache: false, dirs: 1, files: 1, diskBytes: 4096, lastWrite: now - 86400000 * 30 },
  ],
}

const PREVIEW = {
  ok: true,
  dryRun: true,
  totals: { count: 2, diskBytes: 6198882, biliBytes: 5410300, bridgeBytes: 777862 },
  sessions: [
    { id: 'session-bbbbbbbb-2222-4a4a-8b8b-000000000002', workspace: '日常', archived: false, pinned: false, dirs: ['C:\\Users\\19906\\.dsh\\sessions\\--D-QQ--\\session-bbbbbbbb-2222-4a4a-8b8b-000000000002'], diskBytes: 13823, projCache: true, biliRows: 1, biliBytes: 13800, ledgerHits: 1, bridgeFiles: 5, bridgeBytes: 2350 },
    { id: 'session-cccccccc-3333-4a4a-8b8b-000000000003', workspace: '李溢华毕业论文', archived: true, pinned: true, dirs: ['C:\\Users\\19906\\.dsh\\sessions\\--D-thesis--\\session-cccccccc-3333-4a4a-8b8b-000000000003', 'C:\\Users\\19906\\.dsh\\sessions\\--D-thesis2--\\session-cccccccc-3333-4a4a-8b8b-000000000003'], diskBytes: 6185059, projCache: true, biliRows: 1, biliBytes: 5396500, ledgerHits: 2, bridgeFiles: 1332, bridgeBytes: 775512 },
  ],
}

const EXECUTE = {
  ok: true,
  dispatched: true,
  helperTask: 'DshSessionCleanupHelper-20261028-100000',
  helperLog: 'C:\\Users\\19906\\.dsh\\session-delete-helper-20261028-100000.log',
  restartExe: 'E:\\DSH\\DeepSeek Harness.exe',
  quitIn: 25,
  sessions: ['session-bbbbbbbb-2222-4a4a-8b8b-000000000002', 'session-cccccccc-3333-4a4a-8b8b-000000000003'],
}

// 这个 fixture 复刻的是「插件装上以后」的真实布局：
//   左栏 = 导航条目（client.js 注册的 sidebar.panellist，只渲染图标，
//          文字由宿主的 PanelRow 用 label 画，这里手写一个等价按钮）
//   中栏 = main 槽位（client.js 注册的 PurgePage，把 DOM 容器交给
//          window.__DSH_DEEP_PURGE__.mount()）
// 同时用一个极简 __ModuleLoader__ 把 lib/client.js 真跑一遍，
// 这样测的是「bundle 能注册 + 页面能挂载 + 列表/预演/删除能用」整条链。
const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>会话清理面板 · UI fixture</title>
<style>
/* 复刻 DSH 浅色主题的 design token（真值取自 @deepseek-ai/dsh-client-ui-theme
   的 design-platform.css / design-semantic.css），只为让 fixture 的明暗环境
   和用户真实界面一致——之前 fixture 是深色，掩盖了「硬编码深色字压白底」的问题。 */
:root{
  --dsw-static-neutral-bluish-00:#fff; --dsw-static-neutral-bluish-50:#f9fafb;
  --dsw-static-neutral-bluish-60:#f5f6f7; --dsw-static-neutral-bluish-100:#ebeef2;
  --dsw-static-neutral-bluish-150:#e9ecf2; --dsw-static-neutral-bluish-200:#e1e5ee;
  --dsw-static-neutral-bluish-600:#81858c; --dsw-static-neutral-bluish-700:#61666b;
  --dsw-static-neutral-bluish-800:#353638; --dsw-static-neutral-bluish-1000:#0f1115;
  --dsw-static-red-600:#ec1313; --dsw-static-green-500:#22c55e;
  --dsw-alias-bg-base:#fff; --dsw-alias-bg-layer-1:#fff; --dsw-alias-bg-layer-2:#fff;
  --dsw-alias-bg-module-platform:#f5f6f7;
  --dsw-alias-label-primary:#0f1115; --dsw-alias-label-secondary:#61666b;
  --dsw-alias-label-tertiary:#81858c;
  --dsw-alias-border-l1:#0000000a; --dsw-alias-border-l2:#0000001a;
  --dsw-alias-border-l3:#0000001f; --dsw-alias-border-l4:#00000029;
  --dsw-alias-interactive-bg-hover:#2631480f;
  --dsw-alias-interactive-bg-hover-danger:#ec13130d;
  --dsw-alias-state-error-primary:#ec1313; --dsw-alias-link:#4176e6;
}
/* 深色主题：真值取自 dsh-client-ui-theme 的 body[data-ds-dark-theme] 段。
   深色 token 必须挂到 html 上（:root 与 html[data-...] 同为标签选择器时后写的赢，
   两层都写 :root 会互相覆盖），这样 html 与 body 的底色才一致。 */
html[data-ds-dark-theme]{
  --dsw-static-neutral-bluish-50:#141518; --dsw-static-neutral-bluish-60:#1a1c20;
  --dsw-static-neutral-bluish-100:#26282d; --dsw-static-neutral-bluish-150:#2b2e34;
  --dsw-static-neutral-bluish-200:#33363d; --dsw-static-neutral-bluish-600:#7d828c;
  --dsw-static-neutral-bluish-700:#9ba0aa; --dsw-static-neutral-bluish-800:#c3c8d2;
  --dsw-static-neutral-bluish-1000:#f5f7fa;
  --dsw-alias-bg-base:#141518; --dsw-alias-bg-layer-1:#1a1c20; --dsw-alias-bg-layer-2:#1f2227;
  --dsw-alias-bg-module-platform:#1a1c20;
  --dsw-alias-label-primary:#f5f7fa; --dsw-alias-label-secondary:#a8aeb8;
  --dsw-alias-label-tertiary:#7d828c;
  --dsw-alias-border-l1:#ffffff0f; --dsw-alias-border-l2:#ffffff1f;
  --dsw-alias-border-l3:#ffffff29; --dsw-alias-border-l4:#fff3;
  --dsw-alias-interactive-bg-hover:#ffffff14;
  --dsw-alias-interactive-bg-hover-danger:#f25a5a26;
  --dsw-alias-state-error-primary:#f25a5a; --dsw-alias-link:#4d93f8;
}
html,body{margin:0;height:100%;background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font:400 13px/1.6 system-ui;overflow:hidden}
#frame{display:flex;height:100%}
.side{width:230px;flex:none;background:var(--dsw-static-neutral-bluish-60);
  border-right:1px solid var(--dsw-alias-border-l2);
  display:flex;flex-direction:column;padding:10px 8px;gap:2px}
.side .grp{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:8px 8px 4px}
.navrow{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;
  border:0;background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;cursor:pointer;text-align:left}
.navrow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.navrow[aria-current="page"]{background:#4176e61f;color:var(--dsw-alias-label-primary);
  font-weight:600}
.navrow svg{flex:none}
#main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;
  background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l2)}
#main[hidden]{display:none}
#empty{padding:40px;color:var(--dsw-alias-label-tertiary)}
</style></head>
<body>
<div id="frame">
  <div class="side">
    <div class="grp">工作区</div>
    <button class="navrow" type="button">日常</button>
    <button class="navrow" type="button">李溢华毕业论文</button>
    <div class="grp">导航</div>
    <button class="navrow" type="button" id="nav-plugins">插件</button>
    <button class="navrow" type="button" id="nav-purge" aria-current="page">
      <span id="nav-purge-glyph"></span><span>会话清理</span>
    </button>
  </div>
  <div id="main"></div>
</div>
<script>
try{localStorage.setItem('dsh.sessions.current',JSON.stringify({sessionId:'session-aaaaaaaa-1111-4a4a-8b8b-000000000001'}))}catch(e){}

// ---- 极简 __ModuleLoader__：解析 react 与 primitives（照前端种子表）----
var __slots = {};
window.__ModuleLoader__ = { load: function (decl) {
  var React = {
    createElement: function (type, props) {
      var kids = Array.prototype.slice.call(arguments, 2);
      if (typeof type === 'function') {
        var p = props || {};
        kids.forEach(function (k, i) { p['child' + i] = k });
        return type(p);
      }
      return { type: type, props: props || {}, children: kids };
    },
    useRef: function (v) { return { current: v } },
    useEffect: function (fn) { window.__pendingEffect = fn },
  };
  // 平台种子表里的 UI 基础件替身：形状对齐 dsh-web-frontend 的真实导出
  var primitives = {
    MenuItemButton: function (props) { return React.createElement('menuitem-shaped', props) },
    IconTrashOutlineRegular: function (props) { return React.createElement('trash-icon', props) },
  };
  var exports = decl.factory(function (spec) {
    if (spec === 'react') return React;
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error('unsupported require: ' + spec);
  });
  window.__PURGE_EXPORTS__ = exports;
} };

// ---- 极简 slots 服务：记下注册，验证三个槽位都对 ----
var ctx = {
  slots: {
    inject: function (name, cb) {
      var d = cb();
      return typeof d === 'function' ? d : function () {};
    },
    register: function (options, component) {
      __slots[options.name + '|' + (options.id || options.key || '')] =
        { options: options, component: component };
      return function () { delete __slots[options.name] };
    },
  },
  get: function (n) { return n === 'layout' ? { selectPanel: function (id) { window.__SELECTED__ = id } } : undefined },
  effect: function (fn) { window.__dispose = fn() },
};
</script>
<script src="/dsh-deep-purge/client.js"></script>
<script src="/dsh-deep-purge/ui.js"></script>
<script>
(function () {
  var log = [];
  window.__FIXTURE_LOG__ = log;
  try {
    window.__PURGE_EXPORTS__.apply(ctx);
    log.push('apply ok');
  } catch (e) { log.push('apply FAILED: ' + e.message) }

  var navKey = 'sidebar.panellist|deep-purge';
  var mainKey = 'main|deep-purge';
  var menuKey = 'sidebar.workspaces.session.menu.item|deep-purge';
  log.push('nav slot: ' + (__slots[navKey] ? __('已注册 order=' + __slots[navKey].options.order) : 'MISSING'));
  log.push('main slot: ' + (__slots[mainKey] ? '已注册' : 'MISSING'));
  log.push('menu slot: ' + (__slots[menuKey] ? '已注册 order=' + __slots[menuKey].options.order : 'MISSING'));

  function __(s) { return s }

  // 1) 画导航图标：调 client.js 里那个 glyph 组件
  if (__slots[navKey]) {
    var glyph = __slots[navKey].component({ size: 18 });
    var host = document.getElementById('nav-purge-glyph');
    if (glyph && glyph.type === 'svg') {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      Object.keys(glyph.props).forEach(function (k) {
        if (k === 'children') return;
        svg.setAttribute(k, glyph.props[k]);
      });
      (glyph.children || []).forEach(function (c) {
        var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        Object.keys(c.props || {}).forEach(function (k) { p.setAttribute(k, c.props[k]) });
        svg.appendChild(p);
      });
      host.appendChild(svg);
      log.push('glyph rendered, paths=' + (glyph.children || []).length);
    } else { log.push('glyph MISSING/BAD') }
  }

  // 2) 挂主区：调 PurgePage，再把它的容器接到 #main
  if (__slots[mainKey]) {
    var node = __slots[mainKey].component({});
    var main = document.getElementById('main');
    main.appendChild(document.createTextNode(''));
    // PurgePage 返回 {type:'div', props:{ref}, children:[]}
    var box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%;width:100%;overflow:hidden';
    main.appendChild(box);
    node.props.ref.current = box;
    // 手动跑 useEffect（真实 React 会自动跑）
    if (typeof window.__pendingEffect === 'function') {
      try { window.__pendingEffect(); log.push('effect ran') }
      catch (e) { log.push('effect FAILED: ' + e.message) }
    }
  }

  // 3) 右键菜单项：直接调组件验证不炸
  if (__slots[menuKey]) {
    try {
      var item = __slots[menuKey].component({ sessionId: 'session-bbbbbbbb-2222-4a4a-8b8b-000000000002' });
      var ip = item.props || {};
      var label = ip.children !== undefined ? ip.children : (ip.child0 !== undefined ? ip.child0 : '?');
      log.push('menu item type=' + item.type + ' label=' + label +
        ' danger=' + ip.danger + ' icon=' + (ip.icon ? ip.icon.type : 'none'));
    } catch (e) { log.push('menu item FAILED: ' + e.message) }
  }

  // 截图用：?clean=1 不渲染右下角那块调试日志
  var CLEAN = /[?&]clean=1/.test(location.search);
  // 截图用：?theme=dark 切深色 token
  if (/[?&]theme=dark/.test(location.search)) document.documentElement.setAttribute('data-ds-dark-theme', '');
  var dump = document.createElement('pre');
  dump.id = 'fixture-log';
  dump.style.cssText = 'position:fixed;right:8px;bottom:8px;max-width:46vw;max-height:40vh;overflow:auto;' +
    'background:#0b0e14cc;border:1px solid #2a3444;border-radius:8px;padding:8px 10px;margin:0;' +
    'font:400 11px/1.5 ui-monospace,Consolas,monospace;color:#8ee6a8;white-space:pre-wrap;z-index:99';
  dump.textContent = log.join('\\n');
  if (CLEAN) { dump.style.display = 'none' } else { document.body.appendChild(dump) }
})();
</script>
</body></html>`

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const p = u.pathname
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body) }
  const json = (o) => send(200, 'application/json; charset=utf-8', JSON.stringify(o))

  if (p === '/' || p === '/index.html') return send(200, 'text/html; charset=utf-8', PAGE)
  if (p === '/dsh-deep-purge/ui.js') return send(200, 'application/javascript; charset=utf-8', UI)
  if (p === '/dsh-deep-purge/client.js') return send(200, 'application/javascript; charset=utf-8', CLIENT)
  if (p === '/dsh-deep-purge/version') return json({ ok: true, version: 'fixture', plugin: '1.0.0', ps1: 'fixture', dshHome: 'fixture' })
  if (p === '/dsh-deep-purge/list') return json(LIST)
  if (p === '/dsh-deep-purge/preview') return json(PREVIEW)
  if (p === '/dsh-deep-purge/execute') return json(EXECUTE)
  if (p === '/dsh-deep-purge/last-run') return json({ ok: true, found: false })
  send(404, 'text/plain', 'no route: ' + p)
})

const PORT = 5599
server.listen(PORT, '127.0.0.1', () => {
  console.log('fixture ready: http://127.0.0.1:' + PORT + '/')
})
