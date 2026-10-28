// 用最小 mock 宿主跑插件：不需要真实 DSH，直接起一个 http.Server 挂上插件注册的路由。
// 运行：ELECTRON_RUN_AS_NODE=1 & 'E:\DSH\DeepSeek Harness.exe' test-host.mjs
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import('file:///' + path.join(HERE, 'lib', 'index.js').replace(/\\/g, '/'))
const plugin = mod.default

const routes = []
const injections = []
let webServerCtx = null

// —— mock 宿主 ——
const root = {
  effect(fn) { const d = fn(); return () => { try { d && d() } catch {} } },
  on(name, fn) { if (name === 'webserver/index-inject') injections.push(fn); return () => {} },
  inject(deps, fn) {
    if (!deps.includes('webServer')) throw new Error('unexpected deps ' + deps)
    webServerCtx = {
      register(entry) { routes.push(entry); return () => { const i = routes.indexOf(entry); if (i >= 0) routes.splice(i, 1) } },
      // 不提供 tapIndex，模拟桌面端
    }
    const ctx = {
      webServer: webServerCtx,
      effect(fn) { const d = fn(); return () => { try { d && d() } catch {} } },
      get() { return undefined },
    }
    fn(ctx)
  },
}

plugin.apply(root)

console.log('injections:', injections.length, 'routes:', routes.map((r) => r.path).join(', '))

// 触发一次注入表
const table = []
injections.forEach((fn) => fn(table))
console.log('inject rows:', table.length, table.map((r) => r.kind).join(','))
console.log('row has SCRIPT_URL:', table[0] && table[0].text.includes('/dsh-deep-purge/ui.js'))

// —— 起服务，用真实的 handler 跑请求 ——
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const hit = routes.find((r) => (r.kind === 'exact' ? r.path === url.pathname : url.pathname.startsWith(r.path)))
  if (!hit) { res.writeHead(404).end('no route'); return }
  Promise.resolve(hit.handler(req, res)).catch((e) => { try { res.writeHead(500).end(String(e)) } catch {} })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}/dsh-deep-purge`
console.log('listening', base)

async function call(label, urlPath, opts) {
  const t0 = Date.now()
  const r = await fetch(base + urlPath, opts)
  const text = await r.text()
  console.log(`\n### ${label}  ${r.status}  ${Date.now() - t0}ms  ${text.length}B`)
  return { status: r.status, text }
}

// 1) version
const v = await call('version', '/version')
console.log(v.text.slice(0, 400))

// 2) ui.js
const ui = await call('ui.js', '/ui.js')
console.log('starts:', JSON.stringify(ui.text.slice(0, 80)), '... ends:', JSON.stringify(ui.text.slice(-40)))

// 3) list
const list = await call('list', '/list')
try {
  const j = JSON.parse(list.text)
  console.log('ok:', j.ok, 'count:', j.sessions && j.sessions.length, 'ms:', j.ms, 'totalBytes:', j.totals && j.totals.diskBytes)
  console.log('first:', JSON.stringify(j.sessions && j.sessions[0]))
} catch (e) { console.log('LIST NOT JSON:', list.text.slice(0, 300)) }

// 4) preview 参数校验
await call('preview bad id', '/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['nope'] }) })
await call('preview empty', '/preview', { method: 'POST', body: JSON.stringify({ ids: [] }) })
await call('preview GET', '/preview')

// 5) execute 校验（不真跑）
await call('execute no confirm', '/execute', { method: 'POST', body: JSON.stringify({ ids: ['session-7c1c6ff5-0ee5-4249-b68f-2c804cce919a'] }) })
await call('execute current', '/execute', { method: 'POST', body: JSON.stringify({ ids: ['session-f60b5464-e8bc-4a4a-ad7b-f6cf70380aae'], confirm: 'DELETE', currentSessionId: 'session-f60b5464-e8bc-4a4a-ad7b-f6cf70380aae' }) })

// 6) 安全：跨站 / 非回环
const cross = await fetch(base + '/list', { headers: { 'sec-fetch-site': 'cross-site' } })
console.log('\ncross-site list:', cross.status, (await cross.text()).slice(0, 80))
const badOrigin = await fetch(base + '/list', { headers: { origin: 'http://evil.example' } })
console.log('bad-origin list:', badOrigin.status, (await badOrigin.text()).slice(0, 80))

// 7) 404
const nf = await fetch(base + '/nope')
console.log('unknown route:', nf.status)

server.close()
console.log('\nDONE')
