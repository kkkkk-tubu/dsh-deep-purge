/**
 * dsh-deep-purge —— 宿主半区
 *
 * 做什么：把已验证的 dsh-session-cleanup.ps1 包成侧栏面板。
 *   1) 往桌面端注入表推一行内联 script（Electron 桌面端唯一生效通道），
 *      页面自己 <script src="/dsh-deep-purge/ui.js">，onerror 静默。
 *   2) 注册路由：
 *        GET  /dsh-deep-purge/ui.js     浏览器端半区（按 mtime 重读，改完硬刷新即生效）
 *        GET  /dsh-deep-purge/version   版本探针，ui.js 变了页面自动 reload
 *        GET  /dsh-deep-purge/list      快速清点（纯 Node，~100ms，不碰 ps1）
 *        POST /dsh-deep-purge/preview   {ids}   → ps1 预演，五处存储逐项明细
 *        POST /dsh-deep-purge/execute   {ids,confirm,currentSessionId}
 *                                          → ps1 -Execute -AutoRestart（DSH 会退出并自动重启）
 *        GET  /dsh-deep-purge/last-run  最近一次 helper 日志尾部（重启后自检用）
 *
 * 为什么删除逻辑不复写在 Node 里：
 *   ps1 已经覆盖六处存储（DSH 日志 / projcache / bili index.db / ledger.json /
 *   details+usage 缓存 / billion-context 桥接日志），带备份、回滚、回读校验，
 *   还有 Job Object 与 WM_ENDSESSION 那些坑的实测解。重写等于把坑重踩一遍。
 *   插件只负责「让用户点得动」。
 *
 * !! 关键约束 !!：DSH 给工具进程套了 Job Object，插件 spawn 的 powershell 是
 *   DSH 的子进程，DSH 一退出就连坐被杀。真正干活的是 ps1 里注册的计划任务
 *   （父进程 svchost，完全在 DSH 进程树之外），所以只能走 -AutoRestart。
 *   任何「在本进程里直接把文件删掉再重启」的写法都活不过 DSH 退出那一刻。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.dirname(HERE)

/** ps1 优先用包内自带那份（随插件走，装到哪都能用）；退回 lib/ps/（打包工具把 ps 挪进去的情况） */
const PS1_CANDIDATES = [
  path.join(PKG_ROOT, 'ps', 'dsh-session-cleanup.ps1'),
  path.join(HERE, 'ps', 'dsh-session-cleanup.ps1'),
]
const UI_JS_CANDIDATES = [
  path.join(HERE, 'ui.js'),
  path.join(PKG_ROOT, 'lib', 'ui.js'),
  path.join(PKG_ROOT, 'assets', 'ui.js'),
]

const UI_VERSION = '1.0.0'
const BASE = '/dsh-deep-purge'
const SCRIPT_URL = BASE + '/ui.js'
const VERSION_URL = BASE + '/version'
const MAX_BODY = 8 * 1024

const DSH_HOME = process.env.DSH_HOME
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh')

const WS_JSON = path.join(DSH_HOME, 'storages', 'workspace.json')
const PROJ_CACHE = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')

const SID_RE = /^session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * 桌面端注入行：内联 script（不是 script-src —— 那条加载失败会 reject 掉整个 boot）。
 * 顺带每 5s 探一次版本，ui.js 变了就 location.reload()：
 * 打包版桌面端没有 Ctrl+R，不这样做改完 UI 进不了已经跑着的页面。
 */
const DESKTOP_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'if(window.__DSH_DEEP_PURGE_LOADER__)return;window.__DSH_DEEP_PURGE_LOADER__=1;' +
  'var S="' + SCRIPT_URL + '",V="' + VERSION_URL + '";' +
  'var s=document.createElement("script");s.src=S+"?v="+Date.now();' +
  's.onerror=function(){};d.appendChild(s);' +
  'var seen=null;' +
  'function probe(){fetch(V,{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(j){' +
  'if(!j||!j.version)return;if(seen===null){seen=j.version;return}' +
  'if(j.version!==seen){seen=j.version;try{location.reload()}catch(e){}}}).catch(function(){})}' +
  'probe();setInterval(probe,5000)}catch(e){}})()'

// ---------------------------------------------------------------- 小工具

function readFresh(candidates, cacheRef) {
  for (const p of candidates) {
    try {
      const st = fs.statSync(p)
      if (cacheRef.value && cacheRef.value.mtimeMs === st.mtimeMs) return cacheRef.value.text
      const text = fs.readFileSync(p, 'utf8')
      cacheRef.value = { text, mtimeMs: st.mtimeMs }
      return text
    } catch { /* 换下一个候选 */ }
  }
  return cacheRef.value ? cacheRef.value.text : ''
}

function findFile(candidates) {
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p } catch { /* miss */ }
  }
  return undefined
}

function isLoopbackHostname(hn) {
  const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  return m.slice(1).every((s) => Number(s) >= 0 && Number(s) <= 255)
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** 递归统计一个目录的字节数 / 文件数 / 最新 mtime（ms） */
function dirStats(root) {
  let bytes = 0, files = 0, newest = 0
  const stack = [root]
  while (stack.length) {
    const cur = stack.pop()
    let ents
    try { ents = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) { stack.push(full); continue }
      if (!e.isFile()) continue
      try {
        const st = fs.statSync(full)
        bytes += st.size
        files += 1
        if (st.mtimeMs > newest) newest = st.mtimeMs
      } catch { /* 被占用/消失的文件跳过 */ }
    }
  }
  return { bytes, files, newest }
}

/** 会话注册表：tables.workspaces 是 id -> {id,title,sessionIds,...} 的对象，不是数组 */
function readRegistry() {
  const ws = readJson(WS_JSON)
  if (!ws) return { ok: false, error: 'workspace.json 读取或解析失败: ' + WS_JSON }
  const g = ws.global || {}
  const archived = new Set(Array.isArray(g.archivedSessionIds) ? g.archivedSessionIds : [])
  const pinned = new Set(Array.isArray(g.pinnedSessionIds) ? g.pinnedSessionIds : [])
  const workspaces = []
  const owner = new Map() // sid -> {workspaceId, workspaceTitle}
  const tables = (ws.tables && ws.tables.workspaces) || {}
  for (const key of Object.keys(tables)) {
    const w = tables[key] || {}
    const title = typeof w.title === 'string' && w.title ? w.title : key
    workspaces.push({ id: w.id || key, title })
    for (const sid of Array.isArray(w.sessionIds) ? w.sessionIds : []) {
      if (!owner.has(sid)) owner.set(sid, { workspaceId: w.id || key, workspaceTitle: title })
    }
  }
  return { ok: true, archived, pinned, workspaces, owner }
}

/** projcache 里每个会话一份：record.rows.title.val 是标题 */
function readProjCache(sid) {
  const j = readJson(path.join(PROJ_CACHE, sid + '.json'))
  if (!j || !j.record) return null
  const rows = j.record.rows || {}
  const title = rows.title && rows.title.val
  const first = rows.titleInput && rows.titleInput.val && rows.titleInput.val.first
    && rows.titleInput.val.first.text
  const ident = j.record.identity || {}
  return {
    title: typeof title === 'string' && title ? title : (typeof first === 'string' ? first : ''),
    createdAt: Number(ident.createdAt) || 0,
    cwd: typeof ident.cwd === 'string' ? ident.cwd : '',
  }
}

/** 找出会话目录：<sessions>/<slug>/<sid>，跨所有 slug */
function findSessionDirs(sid) {
  const out = []
  let slugs
  try { slugs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }) } catch { return out }
  for (const s of slugs) {
    if (!s.isDirectory()) continue
    const cand = path.join(SESSIONS_ROOT, s.name, sid)
    try { if (fs.statSync(cand).isDirectory()) out.push(cand) } catch { /* miss */ }
  }
  return out
}

/** 每条会话记录：磁盘占用 + 最近活动，用于排序 */
function listAllSessions() {
  const reg = readRegistry()
  if (!reg.ok) return reg

  const ids = new Set(reg.owner.keys())

  // projcache 里存在但没注册的（孤儿）；以及有会话目录但没注册的
  let pcFiles = []
  try { pcFiles = fs.readdirSync(PROJ_CACHE) } catch { /* 没有 projcache 目录 */ }
  for (const f of pcFiles) {
    if (!f.endsWith('.json')) continue
    const sid = f.slice(0, -5)
    if (SID_RE.test(sid)) ids.add(sid)
  }
  try {
    for (const slug of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
      if (!slug.isDirectory()) continue
      for (const d of fs.readdirSync(path.join(SESSIONS_ROOT, slug.name), { withFileTypes: true })) {
        if (d.isDirectory() && SID_RE.test(d.name)) ids.add(d.name)
      }
    }
  } catch { /* 没有 sessions 目录 */ }

  const rows = []
  for (const sid of ids) {
    const owner = reg.owner.get(sid)
    const pc = readProjCache(sid)
    const dirs = findSessionDirs(sid)
    let bytes = 0, files = 0, newest = 0
    for (const d of dirs) {
      const st = dirStats(d)
      bytes += st.bytes
      files += st.files
      if (st.newest > newest) newest = st.newest
    }
    if (pc && pc.createdAt > newest) newest = pc.createdAt
    rows.push({
      id: sid,
      title: (pc && pc.title) || '',
      cwd: (pc && pc.cwd) || '',
      workspace: owner ? owner.workspaceTitle : null,
      workspaceId: owner ? owner.workspaceId : null,
      registered: Boolean(owner),
      archived: reg.archived.has(sid),
      pinned: reg.pinned.has(sid),
      hasDir: dirs.length > 0,
      hasProjCache: Boolean(pc),
      dirs: dirs.length,
      files,
      diskBytes: bytes,
      lastWrite: newest,
    })
  }
  rows.sort((a, b) => (b.lastWrite - a.lastWrite) || a.id.localeCompare(b.id))

  return {
    ok: true,
    dshHome: DSH_HOME,
    workspaces: reg.workspaces,
    sessions: rows,
    totals: {
      count: rows.length,
      registered: rows.filter((r) => r.registered).length,
      orphan: rows.filter((r) => !r.registered).length,
      diskBytes: rows.reduce((n, r) => n + r.diskBytes, 0),
    },
  }
}

// ---------------------------------------------------------------- 调 ps1

/**
 * 用 -EncodedCommand 调 ps1：绕开 PS5.1 一切引号/分词坑，
 * 并且能先设 [Console]::OutputEncoding=UTF8（否则 pipe 出 GBK，中文全乱）。
 */
function psEncodedArgs(body) {
  const prelude = '$ProgressPreference="SilentlyContinue";[Console]::OutputEncoding=[Text.Encoding]::UTF8;'
  const text = prelude + body
  const b64 = Buffer.from(text, 'utf16le').toString('base64')
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64]
}

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

/**
 * ps1 的 -Json 走的是 ConvertTo-Json 默认格式化（缩进 4 空格、多行），
 * 所以不能只取最后一行。从左往右逐个 '{' 试括号平衡，返回**最外层**能解析的对象
 * （从右往左会先命中嵌套的内层对象，比如 sessions[0]）。
 * 跳过字符串字面量与转义，避免内容里的花括号把计数带偏。
 */
function extractLastJson(text) {
  const s = text || ''
  let from = 0
  for (;;) {
    const start = s.indexOf('{', from)
    if (start < 0) return undefined
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < s.length; i += 1) {
      const c = s[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') { inStr = true; continue }
      if (c === '{') depth += 1
      else if (c === '}') {
        depth -= 1
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)) } catch { break }
        }
      }
      if (depth < 0) break
    }
    from = start + 1
  }
}

/** 前台跑一段 ps1，等到进程退出；返回最后一行 JSON */
function runPs1(argv, timeoutMs) {
  return new Promise((resolve) => {
    const ps1 = findFile(PS1_CANDIDATES)
    if (!ps1) {
      resolve({ ok: false, error: 'ps1-not-found', searched: PS1_CANDIDATES })
      return
    }
    const call = '& ' + psQuote(ps1) + ' ' + argv.join(' ')
    const full = psEncodedArgs(call)

    let child
    try {
      child = spawn('powershell.exe', full, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, error: 'spawn-failed', detail: String(e && e.message) })
      return
    }

    let out = ''
    let err = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try { child.kill() } catch { /* 已经没了 */ }
      resolve({ ok: false, error: 'timeout', timeoutMs, stdout: out.slice(-2000), stderr: err.slice(-2000) })
    }, timeoutMs)

    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, error: 'spawn-error', detail: String(e && e.message) })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const parsed = extractLastJson(out)
      if (parsed) {
        parsed.exitCode = code
        if (!parsed.ok && err.trim()) parsed.stderr = err.trim().slice(0, 1500)
        resolve(parsed)
      } else {
        resolve({
          ok: false,
          error: 'bad-json',
          exitCode: code,
          stdout: out.slice(-2000),
          stderr: err.slice(-2000),
        })
      }
    })
  })
}

/** 最近一次 helper 日志的尾部（DSH 重启后回来看结果） */
function lastHelperRun() {
  let best = null
  try {
    for (const f of fs.readdirSync(DSH_HOME)) {
      if (!/^session-delete-helper-.*\.log$/.test(f)) continue
      const full = path.join(DSH_HOME, f)
      const st = fs.statSync(full)
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, name: f, mtimeMs: st.mtimeMs }
    }
  } catch { return { ok: false, error: 'read-dsh-home-failed' } }
  if (!best) return { ok: true, found: false }
  let text = ''
  try { text = fs.readFileSync(best.file, 'utf8') } catch { /* ignore */ }
  const lines = text.split(/\r?\n/).filter(Boolean)
  return {
    ok: true,
    found: true,
    name: best.name,
    mtimeMs: best.mtimeMs,
    lines: lines.slice(-60),
    allOk: /allOk=True/.test(text),
    restarted: /已重启 DSH/.test(text),
  }
}

// ---------------------------------------------------------------- 路由主体

export default {
  name: 'dsh-deep-purge',

  apply(root) {
    const rowDisposers = []
    root.effect(() => () => {
      for (const d of rowDisposers) { try { d() } catch { /* ignore */ } }
    })

    // ① 注入行要尽早进表：桌面端的注入表是宿主启动时一次性收集的
    rowDisposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === SCRIPT_URL) return
          if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(SCRIPT_URL)) return
        }
        table.push({ kind: 'script', placement: 'body', text: DESKTOP_ROW_TEXT })
      } catch { /* 注入失败不能拖垮宿主 */ }
    }))

    root.inject(['webServer'], (ctx) => {
      const disposers = []
      const uiCache = { value: null }

      /** 只认回环 + 同源：挡 DNS 重绑定与跨站 POST */
      function rejected(req, res) {
        const host = String(req.headers.host || '')
        const hostname = host.replace(/:\d+$/, '')
        if (!isLoopbackHostname(hostname)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('forbidden: non-loopback host')
          return true
        }
        if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('forbidden: cross-site')
          return true
        }
        const origin = req.headers.origin
        if (origin) {
          try {
            const o = new URL(String(origin))
            if (o.host !== host) {
              res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('forbidden: cross-origin')
              return true
            }
          } catch {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('forbidden: bad origin')
            return true
          }
        }
        return false
      }

      function json(res, code, obj) {
        const body = JSON.stringify(obj)
        res.writeHead(code, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(body),
        })
        res.end(body)
      }

      function route(entry) {
        const inner = entry.handler
        return ctx.webServer.register(Object.assign({}, entry, {
          handler: async (req, res) => {
            if (rejected(req, res)) return
            try { return await inner(req, res) } catch (e) {
              try { json(res, 500, { ok: false, error: 'handler-threw', detail: String(e && e.message) }) } catch { /* 头已发 */ }
            }
          },
        }))
      }

      function readBody(req) {
        return new Promise((resolve) => {
          let body = ''
          let tooBig = false
          req.on('data', (c) => {
            body += c
            if (body.length > MAX_BODY) { tooBig = true; req.destroy() }
          })
          req.on('end', () => {
            if (tooBig) return resolve({ tooBig: true, value: {} })
            try { resolve({ value: body ? JSON.parse(body) : {} }) } catch { resolve({ value: {} }) }
          })
          req.on('error', () => resolve({ value: {} }))
        })
      }

      /** ids 校验：形状对 + 不能含当前会话 */
      function cleanIds(payload) {
        const raw = Array.isArray(payload.ids) ? payload.ids : []
        const ids = []
        const bad = []
        for (const v of raw) {
          const s = String(v || '').trim()
          if (!SID_RE.test(s)) { if (s) bad.push(s); continue }
          if (!ids.includes(s)) ids.push(s)
        }
        const cur = String(payload.currentSessionId || '').trim()
        const hitsCurrent = cur && ids.includes(cur)
        return { ids, bad, cur, hitsCurrent }
      }

      // —— 浏览器端半区 ——
      disposers.push(route({
        kind: 'exact',
        path: SCRIPT_URL,
        handler: (req, res) => {
          const text = readFresh(UI_JS_CANDIDATES, uiCache)
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          res.end(text)
        },
      }))

      disposers.push(route({
        kind: 'exact',
        path: VERSION_URL,
        handler: (req, res) => {
          const file = findFile(UI_JS_CANDIDATES)
          let mtimeMs = 0
          try { mtimeMs = file ? fs.statSync(file).mtimeMs : 0 } catch { /* ignore */ }
          json(res, 200, {
            ok: true,
            version: UI_VERSION + '.' + Math.round(mtimeMs),
            plugin: UI_VERSION,
            ps1: findFile(PS1_CANDIDATES) || null,
            dshHome: DSH_HOME,
          })
        },
      }))

      // —— 快速清点（纯 Node，不调 ps1） ——
      disposers.push(route({
        kind: 'exact',
        path: BASE + '/list',
        handler: (req, res) => {
          const t0 = Date.now()
          const out = listAllSessions()
          out.ms = Date.now() - t0
          json(res, out.ok ? 200 : 500, out)
        },
      }))

      // —— 预演：五处存储逐项明细（调 ps1，7~15s） ——
      disposers.push(route({
        kind: 'exact',
        path: BASE + '/preview',
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
          const { value } = await readBody(req)
          const { ids, bad, hitsCurrent } = cleanIds(value)
          if (bad.length) { json(res, 400, { ok: false, error: 'bad-session-id', bad }); return }
          if (!ids.length) { json(res, 400, { ok: false, error: 'no-ids' }); return }
          if (hitsCurrent) { json(res, 400, { ok: false, error: 'targets-current-session' }); return }

          const argv = ['-SessionId', psQuote(ids.join(',')), '-Json']
          const out = await runPs1(argv, 90000)
          json(res, 200, out)
        },
      }))

      // —— 执行：-Execute -AutoRestart（会退出并重启 DSH） ——
      disposers.push(route({
        kind: 'exact',
        path: BASE + '/execute',
        handler: async (req, res) => {
          if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
          const { value } = await readBody(req)
          const { ids, bad, hitsCurrent } = cleanIds(value)
          if (bad.length) { json(res, 400, { ok: false, error: 'bad-session-id', bad }); return }
          if (!ids.length) { json(res, 400, { ok: false, error: 'no-ids' }); return }
          if (hitsCurrent) {
            json(res, 400, { ok: false, error: 'targets-current-session', detail: '当前正在看的会话不能删' })
            return
          }
          if (String(value.confirm || '') !== 'DELETE') {
            json(res, 400, { ok: false, error: 'confirm-required', detail: '需要在面板里输入 DELETE' })
            return
          }

          // QuitDelaySec 给足 25 秒：留时间把这条 HTTP 响应送回页面并让用户看到"即将关闭"
          const argv = [
            '-SessionId', psQuote(ids.join(',')),
            '-Execute', '-AutoRestart',
            '-QuitDelaySec', '25',
            '-Json',
          ]
          const out = await runPs1(argv, 120000)
          json(res, 200, out)
        },
      }))

      // —— 重启后自检：最近一次 helper 日志 ——
      disposers.push(route({
        kind: 'exact',
        path: BASE + '/last-run',
        handler: (req, res) => {
          json(res, 200, lastHelperRun())
        },
      }))

      // web 形态补偿通道（桌面端走不到，由 ① 负责）
      if (typeof ctx.webServer.tapIndex === 'function') {
        disposers.push(ctx.webServer.tapIndex((html) => {
          if (html.includes(SCRIPT_URL)) return html
          const tag = '<script defer src="' + SCRIPT_URL + '"></script>'
          if (html.includes('</body>')) return html.replace('</body>', tag + '</body>')
          return html + tag
        }))
      }

      ctx.effect(() => () => {
        for (const d of disposers) { try { d() } catch { /* ignore */ } }
      })
    })
  },
}
