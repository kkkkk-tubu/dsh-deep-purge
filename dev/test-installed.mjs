// 从 profile 里装好的那份跑一遍（验证 ps1 走包内路径，不依赖工作区）
import http from 'node:http'
import path from 'node:path'

const PKG = 'C:/Users/19906/.dsh/profiles/desktop/node_modules/dsh-deep-purge'
const mod = await import('file:///' + PKG + '/lib/index.js')
const plugin = mod.default

const routes = []
const injections = []
const root = {
  effect(fn) { const d = fn(); return () => { try { d && d() } catch {} } },
  on(n, fn) { injections.push(fn); return () => {} },
  inject(deps, fn) {
    fn({
      webServer: { register(e) { routes.push(e); return () => {} } },
      effect(fn2) { const d = fn2(); return () => { try { d && d() } catch {} } },
      get() {},
    })
  },
}
plugin.apply(root)

const table = []
injections.forEach((f) => f(table))
console.log('inject rows:', table.length, '| kind:', table[0]?.kind, '| has url:', table[0]?.text?.includes('/dsh-deep-purge/ui.js'))
console.log('routes:', routes.map((r) => r.path).join(' '))

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const hit = routes.find((r) => r.kind === 'exact' && r.path === u.pathname)
  if (!hit) { res.writeHead(404).end('no route'); return }
  Promise.resolve(hit.handler(req, res)).catch((e) => { try { res.writeHead(500).end(String(e)) } catch {} })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/dsh-deep-purge`

const v = await (await fetch(base + '/version')).json()
console.log('\nversion:', JSON.stringify(v, null, 2))

const l = await (await fetch(base + '/list')).json()
console.log('\nlist ok:', l.ok, 'count:', l.sessions?.length, 'ms:', l.ms)
console.log('totals:', JSON.stringify(l.totals))

const uiRes = await fetch(base + '/ui.js')
const uiText = await uiRes.text()
console.log('\nui.js', uiRes.status, uiText.length, 'B | header:', uiRes.headers.get('content-type'))

server.close()
console.log('\nOK')
