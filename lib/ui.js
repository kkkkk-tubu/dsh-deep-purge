/**
 * dsh-deep-purge —— 浏览器端半区（注入到页面，原生 JS，无构建步骤）
 *
 * 界面（0.2.0 起）：
 *   不再是左下角浮动按钮，而是左侧导航栏一个条目「会话清理」＋主区整页。
 *   · 左侧导航栏条目由 lib/client.js 通过 sidebar.panellist 槽位注册。
 *   · 本文件只负责「主区那一页」的内容：挂载到 client.js 给的 DOM 容器里。
 *   · 会话右键菜单「彻底删除会话」也由 client.js 注册，点击后调 openForSession(id)。
 *
 * 页面内容：
 *   · 会话列表：标题 / 工作区 / 磁盘占用 / 最近活动 / 标记（当前会话、已归档、未注册）
 *   · 勾选若干 → 「预演」看五处存储逐项明细 → 输入 DELETE → 「删除」
 *   · 删除走宿主的 ps1 -Execute -AutoRestart：DSH 会自己退出、删完自动重启，页面会断连。
 *   · 重启回来后页面顶部显示上一次 helper 日志的结论（成功/失败/残留）。
 *
 * 设计取舍：
 *   · 不用 React、不打包：宿主路由按 mtime 重读本文件，改完硬刷新即生效。
 *   · 不自己删任何东西：所有写盘都在 ps1 里，这里只发 HTTP。
 *   · 当前会话一律不可选（ps1 也会二次拒绝），避免「删掉正在看的对话」。
 */
;(function () {
  'use strict'
  if (window.__DSH_DEEP_PURGE__) return

  var API = '/dsh-deep-purge'
  var STYLE_ID = 'dsh-deep-purge-style'
  var CURRENT_KEY = 'dsh.sessions.current'
  /** 前端自己报的版本，跟 package.json 的 version 保持一致（宿主的 /version 里有真值）。 */
  var PLUGIN_VERSION = '1.0.0'

  // 颜色一律走宿主的 design token（--dsw-alias-*，定义在 @deepseek-ai/dsh-client-ui-theme）。
  // 0.2.x 早期这里硬编码的是深色主题色（#e6ecf7 这类浅字 + #161b25 表头），
  // 在浅色主题的白底上就是「浅灰压白」，整片看不清 —— 实测踩过。
  // 每个 var() 都带兜底值（浅色主题下可读的那一组），拿不到 token 也不会糊。
  var CSS = [
    '._sp-root{display:flex;flex-direction:column;height:100%;min-height:0;width:100%;',
    'font:400 13px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif;',
    'color:var(--dsw-alias-label-primary,#0f1115);',
    'background:var(--dsw-alias-bg-base,#fff);}',
    '._sp-root header{display:flex;align-items:baseline;gap:10px;padding:14px 18px;flex:none;',
    'border-bottom:1px solid var(--dsw-alias-border-l3,#0000001f);}',
    '._sp-root header h1{font-size:15px;font-weight:600;margin:0;flex:none;',
    'color:var(--dsw-alias-label-primary,#0f1115);}',
    '._sp-root header ._sp-hint{flex:1;}',
    '._sp-root ._sp-body{flex:1;min-height:0;overflow:auto;}',
    '._sp-root ._sp-bar{display:flex;align-items:center;gap:8px;padding:10px 18px;flex:none;',
    'border-bottom:1px solid var(--dsw-alias-border-l2,#0000001a);flex-wrap:wrap;font-size:12.5px;',
    'color:var(--dsw-alias-label-secondary,#61666b);}',
    '._sp-root ._sp-grow{flex:1;}',
    '._sp-root ._sp-hint{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;}',
    '._sp-root table{width:100%;border-collapse:collapse;font-size:12.5px;',
    'color:var(--dsw-alias-label-secondary,#61666b);}',
    // 表头：浅色主题下用 --dsw-alias-bg-module-platform(#f5f6f7) 才能和白底分开
    '._sp-root th{position:sticky;top:0;z-index:1;text-align:left;padding:9px 12px;',
    'font-weight:600;font-size:12px;letter-spacing:.02em;',
    'background:var(--dsw-alias-bg-module-platform,#f5f6f7);',
    'color:var(--dsw-alias-label-secondary,#61666b);',
    'border-bottom:1px solid var(--dsw-alias-border-l3,#0000001f);white-space:nowrap;}',
    '._sp-root td{padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#0000000a);',
    'vertical-align:top;}',
    '._sp-root tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover,#2631480f);}',
    '._sp-root tr[data-sel="1"] td{background:#4176e61f;}',
    '._sp-root tr[data-sel="1"]:hover td{background:#4176e62e;}',
    // 当前会话锁住不可选：不再整体降透明度（那样连标题都看不见），只弱化次要信息
    '._sp-root tr[data-locked="1"] ._sp-title{color:var(--dsw-alias-label-secondary,#61666b);}',
    '._sp-root tr[data-locked="1"] input{opacity:.5;}',
    '._sp-root ._sp-title{font-weight:600;font-size:13px;word-break:break-word;',
    'color:var(--dsw-alias-label-primary,#0f1115);}',
    '._sp-root ._sp-id{font:400 11.5px/1.45 ui-monospace,Consolas,monospace;',
    'color:var(--dsw-alias-label-tertiary,#81858c);margin-top:2px;}',
    '._sp-root input[type=checkbox]{accent-color:var(--dsw-alias-link,#4176e6);',
    'width:14px;height:14px;cursor:pointer;}',
    '._sp-root ._sp-tag{display:inline-block;padding:0 7px;margin:0 4px 2px 0;',
    'border-radius:999px;font-size:11px;line-height:17px;font-weight:500;',
    'border:1px solid transparent;white-space:nowrap;}',
    '._sp-root ._sp-tag[data-t="cur"]{color:#8a5a00;border-color:#f59e0b66;background:#f59e0b1f;}',
    '._sp-root ._sp-tag[data-t="arch"]{color:var(--dsw-alias-label-secondary,#61666b);',
    'border-color:var(--dsw-alias-border-l4,#00000029);background:#2631480f;}',
    '._sp-root ._sp-tag[data-t="orphan"]{color:var(--dsw-alias-state-error-primary,#ec1313);',
    'border-color:#ec131359;background:#ec131314;}',
    // 按钮：浅色主题下靠 border-l3 + label-primary 才立得住
    '._sp-root ._sp-btn{appearance:none;border-radius:7px;padding:5px 12px;font-size:12.5px;',
    'cursor:pointer;font-family:inherit;line-height:1.6;font-weight:500;',
    'border:1px solid var(--dsw-alias-border-l3,#0000001f);',
    'background:var(--dsw-alias-bg-layer-2,#fff);',
    'color:var(--dsw-alias-label-primary,#0f1115);}',
    '._sp-root ._sp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#2631480f);',
    'border-color:var(--dsw-alias-border-l4,#00000029);}',
    '._sp-root ._sp-btn:disabled{opacity:.45;cursor:not-allowed;}',
    '._sp-root ._sp-btn[data-kind="danger"]{color:var(--dsw-alias-state-error-primary,#ec1313);',
    'border-color:#ec131359;background:#ec13130f;}',
    '._sp-root ._sp-btn[data-kind="danger"]:hover:not(:disabled){background:#ec13131f;',
    'border-color:#ec13138c;}',
    '._sp-root ._sp-foot{display:flex;align-items:center;gap:10px;padding:12px 18px;flex:none;',
    'border-top:1px solid var(--dsw-alias-border-l3,#0000001f);font-size:12.5px;',
    'color:var(--dsw-alias-label-secondary,#61666b);',
    'background:var(--dsw-alias-bg-module-platform,#f5f6f7);}',
    '._sp-root input._sp-confirm{width:130px;padding:5px 9px;border-radius:7px;',
    'border:1px solid #ec131380;background:var(--dsw-alias-bg-base,#fff);',
    'color:var(--dsw-alias-label-primary,#0f1115);font-family:ui-monospace,Consolas,monospace;',
    'font-size:12.5px;letter-spacing:.06em;outline:none;}',
    '._sp-root input._sp-confirm:focus{border-color:var(--dsw-alias-state-error-primary,#ec1313);',
    'box-shadow:0 0 0 3px #ec13131f;}',
    '._sp-root ._sp-report{padding:16px 18px;font:400 12.5px/1.75 ui-monospace,Consolas,monospace;',
    'white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#0f1115);}',
    '._sp-root ._sp-report ._sp-fail{color:var(--dsw-alias-state-error-primary,#ec1313);}',
    '._sp-root ._sp-report ._sp-ok{color:#15803d;font-weight:500;}',
    '._sp-root ._sp-empty{padding:48px;text-align:center;',
    'color:var(--dsw-alias-label-tertiary,#81858c);font-size:13px;}',
    '._sp-root ._sp-last{margin:12px 18px 0;padding:10px 14px;border-radius:9px;font-size:12.5px;',
    'border:1px solid #16a34a4d;background:#22c55e14;color:#15803d;}',
    '._sp-root ._sp-last[data-ok="0"]{border-color:#ec131359;background:#ec131314;',
    'color:var(--dsw-alias-state-error-primary,#ec1313);}',
    '._sp-root ._sp-last b{font-weight:600;}',
    '._sp-root ._sp-last ._sp-link{margin-left:8px;text-decoration:underline;cursor:pointer;}',

    // ---- 常驻风险提示条：永远在顶部，不可关闭（这是这个插件唯一不可逆的地方）----
    // 字色用 label-primary 而不是固定琥珀色：琥珀字在浅色底好读、在深色底糊成一团，
    // 明暗两套主题都靠「琥珀左边框 + 琥珀底色」传达警示，正文沿用主题正文色。
    '._sp-root ._sp-warn{display:flex;align-items:flex-start;gap:9px;margin:12px 18px 0;',
    'padding:9px 13px;border-radius:9px;font-size:12.5px;line-height:1.65;flex:none;',
    'border:1px solid #f59e0b5c;border-left:3px solid #f59e0b;background:#f59e0b14;',
    'color:var(--dsw-alias-label-primary,#0f1115);}',
    '._sp-root ._sp-warn ._sp-warn-icon{flex:0 0 auto;font-size:14px;line-height:1.5;}',
    '._sp-root ._sp-warn ._sp-warn-body{flex:1;min-width:0;}',
    '._sp-root ._sp-warn b{font-weight:600;}',
    '._sp-root ._sp-warn code{padding:0 4px;border-radius:4px;font-size:11.5px;',
    'font-family:ui-monospace,Consolas,monospace;background:#f59e0b26;}',
    '._sp-root ._sp-warn ._sp-link{margin-left:2px;text-decoration:underline;cursor:pointer;',
    'color:inherit;font-weight:500;}',

    // ---- 首次使用引导弹窗：铺满视口，居中一张卡片 ----
    '._sp-modal{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;',
    'justify-content:center;padding:24px;background:#00000059;}',
    '._sp-modal-win{width:min(660px,100%);max-height:min(86vh,760px);display:flex;',
    'flex-direction:column;border-radius:14px;overflow:hidden;',
    'border:1px solid var(--dsw-alias-border-l3,#0000001f);',
    'background:var(--dsw-alias-bg-base,#fff);',
    'color:var(--dsw-alias-label-primary,#0f1115);',
    'box-shadow:0 18px 48px #00000038;',
    'font:400 13px/1.65 -apple-system,"Segoe UI",system-ui,sans-serif;}',
    '._sp-modal-win header{display:flex;align-items:center;gap:10px;padding:16px 20px;flex:none;',
    'border-bottom:1px solid var(--dsw-alias-border-l2,#0000001a);}',
    '._sp-modal-win header h2{margin:0;font-size:15px;font-weight:600;flex:1;}',
    '._sp-modal-win header ._sp-ver{font-size:11.5px;font-weight:400;',
    'color:var(--dsw-alias-label-tertiary,#81858c);}',
    '._sp-modal-body{padding:16px 20px;overflow:auto;flex:1;min-height:0;}',
    '._sp-modal-body h3{margin:16px 0 6px;font-size:13px;font-weight:600;}',
    '._sp-modal-body h3:first-child{margin-top:0;}',
    '._sp-modal-body p{margin:0 0 8px;}',
    '._sp-modal-body ul{margin:0 0 8px;padding-left:20px;}',
    '._sp-modal-body li{margin:0 0 5px;}',
    '._sp-modal-body code{padding:1px 5px;border-radius:4px;font-size:11.5px;',
    'font-family:ui-monospace,Consolas,monospace;',
    'background:var(--dsw-alias-bg-module-platform,#f5f6f7);',
    'border:1px solid var(--dsw-alias-border-l1,#0000000a);}',
    '._sp-modal-win footer{display:flex;align-items:center;gap:10px;padding:14px 20px;flex:none;',
    'border-top:1px solid var(--dsw-alias-border-l2,#0000001a);',
    'background:var(--dsw-alias-bg-module-platform,#f5f6f7);}',
    '._sp-modal-win footer ._sp-grow{flex:1;}',
    '._sp-modal ._sp-btn[data-kind="primary"]{color:#fff;',
    'border-color:transparent;background:var(--dsw-alias-link,#4176e6);}',
    '._sp-modal ._sp-btn[data-kind="primary"]:hover{filter:brightness(1.06);}',
    '._sp-modal-risk{border:1px solid #f59e0b5c;border-left:3px solid #f59e0b;',
    'background:#f59e0b14;color:var(--dsw-alias-label-primary,#0f1115);',
    'padding:10px 13px;border-radius:9px;margin:0 0 10px;}',
    '._sp-modal-risk b{font-weight:600;}',
    '._sp-modal-check{display:flex;align-items:center;gap:7px;font-size:12.5px;',
    'color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;}',
    '._sp-modal-check input{width:14px;height:14px;cursor:pointer;',
    'accent-color:var(--dsw-alias-link,#4176e6);}',

    // 会话右键菜单项（client.js 注册）没拿到 primitives 时的兜底样式
    '.dsp-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;',
    'border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;',
    'border-radius:6px;}',
    '.dsp-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);}',
    '.dsp-menu-item-danger{color:var(--dsw-alias-state-error-primary,#ec1313);}',
    '.dsp-menu-item-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger,#ec13130d);}',
    '.dsp-menu-item svg{flex:0 0 auto;}',
  ].join('')

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return
    var s = document.createElement('style')
    s.id = STYLE_ID
    s.textContent = CSS
    ;(document.head || document.documentElement).appendChild(s)
  }

  function fmtBytes(n) {
    n = Number(n) || 0
    if (n < 1024) return n + ' B'
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1
    do { n /= 1024; i++ } while (n >= 1024 && i < u.length - 1)
    return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i]
  }

  function fmtAgo(ms) {
    if (!ms) return '-'
    var d = Date.now() - ms
    if (d < 0) d = 0
    var m = Math.floor(d / 60000)
    if (m < 1) return '刚刚'
    if (m < 60) return m + ' 分钟前'
    var h = Math.floor(m / 60)
    if (h < 24) return h + ' 小时前'
    var day = Math.floor(h / 24)
    if (day < 30) return day + ' 天前'
    return new Date(ms).toLocaleDateString()
  }

  function currentSessionId() {
    try {
      var raw = localStorage.getItem(CURRENT_KEY)
      if (!raw) return ''
      var v = JSON.parse(raw)
      if (v && typeof v === 'object') return String(v.sessionId || '')
      if (typeof v === 'string') return v
    } catch (e) { /* 坏数据当没有 */ }
    return ''
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  // ---------------- 状态 ----------------

  var S = {
    list: null,
    selected: {},
    busy: false,
    view: 'list', // list | report
    mounted: null, // 当前挂载的 host
    last: null, // 上一次 helper 日志结论
  }

  var ui = {}

  function setBusy(on, msg) {
    S.busy = on
    if (ui.refreshBtn) ui.refreshBtn.disabled = on
    if (ui.previewBtn) ui.previewBtn.disabled = on || selCount() === 0
    if (ui.execBtn) ui.execBtn.disabled = on || selCount() === 0
    if (ui.status) ui.status.textContent = msg || ''
  }

  function selCount() {
    var n = 0
    for (var k in S.selected) if (S.selected[k]) n++
    return n
  }

  function selectedIds() {
    var out = []
    for (var k in S.selected) if (S.selected[k]) out.push(k)
    return out
  }

  // ---------------- 列表 ----------------

  function renderList() {
    var host = ui.body
    if (!host) return
    host.innerHTML = ''
    if (!S.list) { host.appendChild(el('div', '_sp-empty', '加载中…')); return }
    if (!S.list.ok) {
      host.appendChild(el('div', '_sp-empty', '读取失败：' + (S.list.error || '未知错误')))
      return
    }
    var rows = S.list.sessions || []
    if (!rows.length) { host.appendChild(el('div', '_sp-empty', '没有找到任何会话')); return }

    var cur = currentSessionId()
    var table = el('table')
    var thead = el('thead')
    var htr = el('tr')
    ;['', '标题', '工作区', '磁盘', '最近活动', '标记'].forEach(function (h) {
      htr.appendChild(el('th', null, h))
    })
    thead.appendChild(htr)
    table.appendChild(thead)

    var tbody = el('tbody')
    rows.forEach(function (r) {
      var locked = cur && r.id === cur
      var tr = el('tr')
      tr.setAttribute('data-locked', locked ? '1' : '0')
      if (S.selected[r.id]) tr.setAttribute('data-sel', '1')

      var tdChk = el('td')
      var chk = document.createElement('input')
      chk.type = 'checkbox'
      chk.checked = Boolean(S.selected[r.id]) && !locked
      chk.disabled = locked
      chk.addEventListener('change', function () {
        if (chk.checked) S.selected[r.id] = true
        else delete S.selected[r.id]
        tr.setAttribute('data-sel', chk.checked ? '1' : '0')
        updateFoot()
      })
      tdChk.appendChild(chk)
      tr.appendChild(tdChk)

      var tdTitle = el('td')
      tdTitle.appendChild(el('div', '_sp-title', r.title || '(无标题)'))
      tdTitle.appendChild(el('div', '_sp-id', r.id))
      tr.appendChild(tdTitle)

      tr.appendChild(el('td', null, r.workspace || '—'))
      tr.appendChild(el('td', null, fmtBytes(r.diskBytes)))
      tr.appendChild(el('td', null, fmtAgo(r.lastWrite)))

      var tdTag = el('td')
      if (cur && r.id === cur) {
        var a = el('span', '_sp-tag', '当前会话')
        a.setAttribute('data-t', 'cur')
        tdTag.appendChild(a)
      }
      if (r.archived) {
        var b = el('span', '_sp-tag', '已归档')
        b.setAttribute('data-t', 'arch')
        tdTag.appendChild(b)
      }
      if (r.pinned) {
        var p = el('span', '_sp-tag', '已置顶')
        p.setAttribute('data-t', 'arch')
        tdTag.appendChild(p)
      }
      if (!r.registered) {
        var c = el('span', '_sp-tag', '未注册')
        c.setAttribute('data-t', 'orphan')
        tdTag.appendChild(c)
      }
      if (!r.hasDir) tdTag.appendChild(el('span', '_sp-hint', '无日志'))
      tr.appendChild(tdTag)

      tbody.appendChild(tr)
    })
    table.appendChild(tbody)
    host.appendChild(table)
  }

  function updateFoot() {
    var n = selCount()
    if (ui.previewBtn) ui.previewBtn.disabled = S.busy || n === 0
    if (ui.execBtn) ui.execBtn.disabled = S.busy || n === 0
    if (ui.selInfo) ui.selInfo.textContent = n ? ('已选 ' + n + ' 个会话') : '未选择会话'
  }

  // ---------------- 数据请求 ----------------

  function loadList() {
    setBusy(true, '正在清点…')
    fetch(API + '/list', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        S.list = j
        S.selected = {}
        S.view = 'list'
        renderList()
        updateFoot()
        var n = (j.sessions || []).length
        setBusy(false, j.ok ? ('共 ' + n + ' 个会话，合计 ' + fmtBytes(j.totals && j.totals.diskBytes)) : '读取失败')
      })
      .catch(function (e) {
        S.list = { ok: false, error: String((e && e.message) || e) }
        renderList()
        setBusy(false, '读取失败')
      })
  }

  function showReport(text) {
    S.view = 'report'
    if (!ui.body) return
    ui.body.innerHTML = ''
    var box = el('div', '_sp-report')
    // 只做很轻的着色：带 [fail] 的行标红、[ok] 标绿
    String(text || '').split(/\r?\n/).forEach(function (line, i, arr) {
      var span = el('span', null, line)
      if (line.indexOf('[fail]') >= 0) span.className = '_sp-fail'
      else if (line.indexOf('[ok]') >= 0) span.className = '_sp-ok'
      box.appendChild(span)
      if (i < arr.length - 1) box.appendChild(document.createTextNode('\n'))
    })
    ui.body.appendChild(box)
  }

  function describePreview(j) {
    if (!j || !j.ok) {
      return '预演失败：' + ((j && (j.error || j.detail)) || '未知错误')
    }
    var lines = []
    var t = j.totals || {}
    lines.push('预演（没有改动任何文件）')
    lines.push('会话数 ' + t.count + '，DSH 日志合计 ' + fmtBytes(t.diskBytes) +
      '，bili 索引 ' + fmtBytes(t.biliBytes) + '，桥接日志 ' + fmtBytes(t.bridgeBytes))
    lines.push('')
    ;(j.sessions || []).forEach(function (s) {
      lines.push(s.id)
      if (s.workspace) lines.push('  工作区   : ' + s.workspace)
      lines.push('  DSH 日志 : ' + (s.dirs && s.dirs.length ? (s.dirs.length + ' 个目录, ' + fmtBytes(s.diskBytes)) : '无'))
      ;(s.dirs || []).forEach(function (d) { lines.push('             ' + d) })
      lines.push('  projcache: ' + (s.projCache ? '有' : '无'))
      lines.push('  bili     : ' + (s.biliRows ? (s.biliRows + ' 行, ' + fmtBytes(s.biliBytes)) : '无'))
      lines.push('  成本台账 : ' + (s.ledgerHits ? (s.ledgerHits + ' 处引用') : '无'))
      lines.push('  桥接日志 : ' + (s.bridgeFiles ? (s.bridgeFiles + ' 个文件, ' + fmtBytes(s.bridgeBytes)) : '无'))
      lines.push('')
    })
    lines.push('确认无误后，在下面输入 DELETE 再点「删除」。')
    lines.push('删除会关闭 DSH 并自动重启，本页面会断开，重启后这里会显示结果。')
    return lines.join('\n')
  }

  function doPreview() {
    var ids = selectedIds()
    if (!ids.length) return
    setBusy(true, '预演中…（要读 bili 索引，约 10 秒）')
    fetch(API + '/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids, currentSessionId: currentSessionId() }),
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        setBusy(false, j && j.ok ? '预演完成' : '预演失败')
        showReport(describePreview(j))
      })
      .catch(function (e) {
        setBusy(false, '预演失败')
        showReport('预演请求失败：' + String((e && e.message) || e))
      })
  }

  function doExecute() {
    var ids = selectedIds()
    if (!ids.length) return
    var confirm = (ui.confirmInput && ui.confirmInput.value || '').trim()
    if (confirm !== 'DELETE') {
      if (ui.status) ui.status.textContent = '请先在输入框里输入 DELETE'
      return
    }
    var msg = '即将删除 ' + ids.length + ' 个会话，并关闭 DSH、删完自动重启。\n\n继续？'
    if (!window.confirm(msg)) return

    setBusy(true, '正在派后台任务…')
    fetch(API + '/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids, currentSessionId: currentSessionId(), confirm: 'DELETE' }),
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        var text = []
        if (j && j.ok) {
          text.push('后台任务已派出。')
          text.push('DSH 大约 25 秒后自动关闭，删完会自己启动。这个页面会断开，属于正常现象。')
          text.push('')
          text.push('重启后本页会显示结果；也可以直接看日志：')
          text.push('  ' + (j.helperLog || '%USERPROFILE%\\.dsh\\session-delete-helper-*.log'))
        } else {
          text.push('派发失败，没有删除任何东西。')
          text.push('')
          text.push('原因：' + ((j && (j.error || j.detail)) || '未知'))
          if (j && j.stdout) { text.push(''); text.push(j.stdout) }
          if (j && j.stderr) { text.push(''); text.push(j.stderr) }
        }
        showReport(text.join('\n'))
        setBusy(false, j && j.ok ? '已派发，等待 DSH 关闭' : '派发失败')
      })
      .catch(function (e) {
        setBusy(false, '派发失败')
        showReport('执行请求失败：' + String((e && e.message) || e))
      })
  }

  // ---------------- 上一次结果 ----------------

  function renderLast() {
    if (!ui.lastBox) return
    var j = S.last
    if (!j || !j.found) { ui.lastBox.style.display = 'none'; return }
    ui.lastBox.style.display = ''
    ui.lastBox.setAttribute('data-ok', j.allOk ? '1' : '0')
    ui.lastBox.innerHTML = ''
    ui.lastBox.appendChild(el('b', null, j.allOk ? '上次删除完成' : '上次删除有残留'))
    ui.lastBox.appendChild(document.createTextNode(
      '（' + j.name + '，' + fmtAgo(j.mtimeMs) + '）'))
    var link = el('span', '_sp-link', '查看日志')
    link.addEventListener('click', function () {
      showReport(['上一次删除的 helper 日志（' + j.name + '）', ''].concat(j.lines || []).join('\n'))
    })
    ui.lastBox.appendChild(link)
  }

  function checkLastRun() {
    return fetch(API + '/last-run', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok || !j.found) return
        // 只关心最近 10 分钟内的（刚重启回来）
        if (Date.now() - j.mtimeMs > 10 * 60 * 1000) return
        S.last = j
        window.__DSH_DEEP_PURGE_LAST__ = j
        renderLast()
      })
      .catch(function () { })
  }

  // ---------------- 首次使用引导 ----------------

  /** 看过哪一版说明。改文案里的关键事实时把版本号 +1，老用户会再看一次。 */
  var GUIDE_VERSION = 1
  var GUIDE_KEY = 'dsh.deep-purge.guide'

  function guideSeen() {
    try {
      return Number(localStorage.getItem(GUIDE_KEY) || 0) >= GUIDE_VERSION
    } catch (e) {
      return false // localStorage 不可用时按「没看过」处理，宁可多弹一次
    }
  }

  function markGuideSeen() {
    try { localStorage.setItem(GUIDE_KEY, String(GUIDE_VERSION)) } catch (e) { /* 隐私模式忽略 */ }
  }

  function p(html) {
    var n = document.createElement('p')
    n.innerHTML = html
    return n
  }

  function h3(text) {
    var n = document.createElement('h3')
    n.textContent = text
    return n
  }

  function ul(items) {
    var n = document.createElement('ul')
    items.forEach(function (it) {
      var li = document.createElement('li')
      li.innerHTML = it
      n.appendChild(li)
    })
    return n
  }

  /**
   * 使用说明 / 注意事项 / 首次使用提醒，三合一。
   *
   * @param {{firstRun: boolean}} opts - firstRun 时底部多一个「我已了解」勾选，
   *        不勾不让关；同时按钮文案改成「开始使用」。
   * @returns 关闭函数
   */
  function showGuide(opts) {
    opts = opts || {}
    var firstRun = !!opts.firstRun
    if (document.getElementById('dsh-deep-purge-guide')) return function () { }

    ensureStyle()

    var mask = el('div', '_sp-modal')
    mask.id = 'dsh-deep-purge-guide'

    var win = el('div', '_sp-modal-win')
    mask.appendChild(win)

    var head = el('header')
    var title = el('h2', null, firstRun ? '首次使用：先读这 6 条' : '使用说明与注意事项')
    head.appendChild(title)
    head.appendChild(el('span', '_sp-ver', 'dsh-deep-purge v' + PLUGIN_VERSION))
    win.appendChild(head)

    var body = el('div', '_sp-modal-body')

    // —— 这个插件到底做什么 ——
    body.appendChild(h3('它做什么'))
    body.appendChild(p(
      'DSH 内建只有「归档会话」，没有删除：归档后侧栏看不见，' +
      '日志、索引、缓存仍然全部留在磁盘上。这个插件做的是<b>彻底删除</b>，' +
      '一次清掉同一个会话在下面六处存储里的全部痕迹：'))
    body.appendChild(ul([
      'DSH 会话日志 <code>~/.dsh/sessions/&lt;slug&gt;/&lt;session-id&gt;/</code>',
      '标题缓存 <code>~/.dsh/storages/session_projcache/sessions/</code>',
      'bili 索引 <code>~/.local/share/billion-context/sessions/index.db</code>（SQLite，含子会话行）',
      '侧栏注册表 <code>~/.dsh/storages/workspace.json</code> 的 sessionIds / archived / pinned',
      '成本台账 <code>~/.dsh/storages/cost-meter/ledger.json</code> 的会话明细与 hash 缓存',
      '桥接日志 <code>~/.dsh/storages/cost-meter/ledger.json.billion-context/</code>',
    ]))

    // —— 必须先知道的风险 ——
    body.appendChild(h3('注意事项（务必先看）'))
    var risk = el('div', '_sp-modal-risk')
    risk.innerHTML =
      '<b>删除不可逆。</b>没有回收站、没有撤销。删掉的会话日志就是删掉了，' +
      'bili 索引同时会 VACUUM，这一步做完之后第三方恢复工具也基本无望。'
    body.appendChild(risk)
    body.appendChild(ul([
      '<b>DSH 会被关掉再自己启动。</b>删除期间 DSH 必须退出（它持有 SQLite 连接、' +
        '内存里还有一份 workspace.json），所以流程是：写一段计划任务 → 关 DSH → 删 → 重启。' +
        '页面会断开几秒，这是正常现象。',
      '<b>正在看的会话删不了。</b>当前会话的勾选框是禁用的，服务端也会二次拒绝 —— ' +
        '删掉自己脚下的会话只会得到一个坏掉的界面。',
      '<b>先预演再删。</b>「预演选中」会把六处存储的命中量逐项列出来，' +
        '而且一个字节都不动。看到数字对不上就先去查，别直接删。',
      '<b>建议先备份。</b>脚本默认会在 <code>~/.dsh/session-delete-backup-&lt;时间戳&gt;/</code> ' +
        '留一份被删文件的原件，删错了可以用「回滚」命令还原。想彻底不留痕再加 <code>-NoBackup</code>。',
      '<b>只支持 Windows。</b>依赖 PowerShell 5.1+、计划任务、Win32 窗口消息来优雅地关掉 DSH；' +
        'macOS / Linux 上跑不起来。',
      '<b>不要同时开两个 DSH 窗口删同一批。</b>两个进程都会往 workspace.json 写，后写的覆盖先写的。',
    ]))

    // —— 怎么用 ——
    body.appendChild(h3('怎么用'))
    body.appendChild(ul([
      '左侧导航栏点「会话清理」，或者右键任意会话选「彻底删除会话」直接跳过来。',
      '勾选要删的会话 → 点「预演选中」核对六处存储的命中量。',
      '确认无误后，在底部输入框里手打 <code>DELETE</code>（这是防误点的口令，不是密码）。',
      '点「删除选中」→ 浏览器再确认一次 → DSH 大约 25 秒后自行退出，删完自动重启。',
      '重启回来后页面顶部会显示上一次的结果；有残留会变红，点「查看日志」看逐项明细。',
    ]))

    body.appendChild(h3('删错了怎么办'))
    body.appendChild(p('备份目录里的每一份文件都保留了原始相对路径，用脚本的回滚参数整体还原：'))
    body.appendChild(p(
      '<code>powershell -ExecutionPolicy Bypass -File &lt;本插件&gt;\\ps\\dsh-session-cleanup.ps1 ' +
      '-Restore "&lt;备份目录&gt;"</code>'))
    body.appendChild(p(
      '回滚前请先退出 DSH，否则写回去的 workspace.json 会被内存里的状态覆盖。' +
      '回滚是「把备份里的东西都写回去」，不会删掉删除之后新产生的会话。'))

    body.appendChild(h3('怎么卸载'))
    body.appendChild(p(
      '在插件管理里禁用或移除 <code>dsh-deep-purge</code>，然后重启 DSH。' +
      '插件本身不在任何地方留状态；它删的是你自己的会话数据，不会碰系统里的其它东西。'))

    win.appendChild(body)

    var foot = el('footer')
    var closeBtn
    var okCheck = null
    if (firstRun) {
      var label = el('label', '_sp-modal-check')
      okCheck = document.createElement('input')
      okCheck.type = 'checkbox'
      label.appendChild(okCheck)
      label.appendChild(document.createTextNode('我已了解删除不可逆'))
      foot.appendChild(label)
      foot.appendChild(el('span', '_sp-grow'))
      closeBtn = el('button', '_sp-btn', '开始使用')
      closeBtn.setAttribute('data-kind', 'primary')
      closeBtn.disabled = true
      okCheck.addEventListener('change', function () { closeBtn.disabled = !okCheck.checked })
    } else {
      foot.appendChild(el('span', '_sp-grow'))
      closeBtn = el('button', '_sp-btn', '知道了')
      closeBtn.setAttribute('data-kind', 'primary')
    }

    function close() {
      markGuideSeen()
      if (mask.parentNode) mask.parentNode.removeChild(mask)
      document.removeEventListener('keydown', onKey, true)
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        // 首次使用时 Esc 不给过：必须勾选 + 点按钮
        if (!firstRun || (okCheck && okCheck.checked)) { e.preventDefault(); close() }
      }
    }

    closeBtn.addEventListener('click', close)
    foot.appendChild(closeBtn)
    win.appendChild(foot)

    // 非首次使用允许点遮罩空白处关闭；首次使用不给
    mask.addEventListener('mousedown', function (e) {
      if (!firstRun && e.target === mask) close()
    })
    document.addEventListener('keydown', onKey, true)

    ;(document.body || document.documentElement).appendChild(mask)
    return close
  }

  // ---------------- 页面构建 ----------------

  /**
   * 常驻风险提示条。和「上次结果」那种可消失的横幅不同，这条永远在：
   * 删会话是这个插件唯一不可逆的动作，用户每次进来都该看见代价。
   * 不给关闭按钮 —— 能关掉的警示等于没有警示。
   */
  function buildWarnBar() {
    var box = el('div', '_sp-warn')
    box.appendChild(el('span', '_sp-warn-icon', '⚠'))
    var body = el('div', '_sp-warn-body')
    var b = el('b', null, '删除不可逆。')
    body.appendChild(b)
    body.appendChild(document.createTextNode(
      '会把选中会话在六处存储里的痕迹全部清掉，DSH 随之退出并在删完后自动重启，本页面会断开几秒。'))
    var link = el('span', '_sp-link', '完整说明与注意事项')
    link.addEventListener('click', function () { showGuide({ firstRun: false }) })
    body.appendChild(link)
    box.appendChild(body)
    return box
  }

  function buildPage(host) {
    host.innerHTML = ''
    ui = {}

    var root = el('div', '_sp-root')
    host.appendChild(root)

    var head = el('header')
    head.appendChild(el('h1', null, '会话清理'))
    head.appendChild(el('span', '_sp-hint',
      '彻底删除：DSH 日志 / projcache / bili 索引 / 成本台账 / 桥接日志'))
    head.appendChild(el('span', '_sp-grow'))
    ui.helpBtn = el('button', '_sp-btn', '使用说明')
    ui.helpBtn.addEventListener('click', function () { showGuide({ firstRun: false }) })
    head.appendChild(ui.helpBtn)
    root.appendChild(head)

    root.appendChild(buildWarnBar())

    ui.lastBox = el('div', '_sp-last')
    ui.lastBox.style.display = 'none'
    root.appendChild(ui.lastBox)

    var bar = el('div', '_sp-bar')
    ui.refreshBtn = el('button', '_sp-btn', '刷新列表')
    ui.refreshBtn.addEventListener('click', function () { loadList() })
    bar.appendChild(ui.refreshBtn)

    ui.selInfo = el('span', '_sp-hint', '未选择会话')
    bar.appendChild(ui.selInfo)
    bar.appendChild(el('span', '_sp-grow'))

    ui.status = el('span', '_sp-hint', '')
    bar.appendChild(ui.status)
    root.appendChild(bar)

    ui.body = el('div', '_sp-body')
    root.appendChild(ui.body)

    var foot = el('div', '_sp-foot')
    ui.previewBtn = el('button', '_sp-btn', '预演选中')
    ui.previewBtn.addEventListener('click', doPreview)
    ui.previewBtn.disabled = true
    foot.appendChild(ui.previewBtn)

    ui.execBtn = el('button', '_sp-btn', '删除选中')
    ui.execBtn.setAttribute('data-kind', 'danger')
    ui.execBtn.addEventListener('click', doExecute)
    ui.execBtn.disabled = true
    foot.appendChild(ui.execBtn)

    ui.confirmInput = document.createElement('input')
    ui.confirmInput.className = '_sp-confirm'
    ui.confirmInput.placeholder = '输入 DELETE'
    foot.appendChild(ui.confirmInput)

    foot.appendChild(el('span', '_sp-grow'))
    var backBtn = el('button', '_sp-btn', '返回列表')
    backBtn.addEventListener('click', function () {
      if (S.view === 'report') { S.view = 'list'; S.list ? renderList() : loadList() }
    })
    foot.appendChild(backBtn)
    root.appendChild(foot)

    ui.root = root
  }

  // ---------------- 对外接口（供 client.js 调用） ----------------

  /**
   * 把整页挂到 host 里。幂等：同一 host 重复调只重建一次。
   * @returns 卸载函数
   */
  function mount(host) {
    if (!host) return function () { }
    ensureStyle()
    if (S.mounted === host && ui.root && ui.root.isConnected) {
      refreshView()
      return function () { }
    }
    S.mounted = host
    buildPage(host)
    renderLast()
    if (S.view === 'report' && S.lastText) showReport(S.lastText)
    else if (S.list) { renderList(); updateFoot() }
    else loadList()
    checkLastRun()
    // 首次打开面板：先把「这玩意儿会删什么、删了回不来」讲清楚，再让人碰列表。
    // 放在 buildPage 之后，这样弹窗底下已经是真实界面，不是空白。
    if (!guideSeen()) showGuide({ firstRun: true })
    var pending = window.__DSH_DEEP_PURGE_PENDING__
    if (pending) {
      window.__DSH_DEEP_PURGE_PENDING__ = ''
      selectOne(pending)
    }
    return function () {
      if (S.mounted === host) { S.mounted = null; ui = {} }
    }
  }

  function refreshView() {
    if (S.list) { renderList(); updateFoot() }
    renderLast()
  }

  function selectOne(sid) {
    if (!sid) return
    S.selected = {}
    S.selected[sid] = true
    if (S.view !== 'list') { S.view = 'list' }
    if (S.list) { renderList(); updateFoot() }
    else {
      // 列表还没回来：等 loadList 完成后补选
      var tries = 0
      var t = setInterval(function () {
        tries += 1
        if (S.list || tries > 40) {
          clearInterval(t)
          if (S.list) { S.selected[sid] = true; renderList(); updateFoot() }
        }
      }, 250)
    }
  }

  /** 右键菜单「彻底删除会话」调这里：记下待选会话，页面挂载时自动勾上。 */
  function openForSession(sid) {
    window.__DSH_DEEP_PURGE_PENDING__ = String(sid || '')
    if (S.mounted) {
      window.__DSH_DEEP_PURGE_PENDING__ = ''
      selectOne(String(sid || ''))
    }
  }

  function unmount() {
    S.mounted = null
    ui = {}
  }

  window.__DSH_DEEP_PURGE__ = {
    version: PLUGIN_VERSION,
    mount: mount,
    unmount: unmount,
    openForSession: openForSession,
    reload: loadList,
    hasSession: function (sid) {
      var rows = (S.list && S.list.sessions) || []
      for (var i = 0; i < rows.length; i += 1) if (rows[i].id === sid) return true
      return false
    },
  }

  // 页面注入时就先把样式和「上次结果」准备好，这样切到面板立即可见
  ensureStyle()
  checkLastRun()
})()
