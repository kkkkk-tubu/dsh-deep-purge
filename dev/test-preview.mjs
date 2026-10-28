// 只跑 /preview，验证插件→ps1 调用链与 JSON 解析
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import('file:///' + path.join(HERE, 'lib', 'index.js').replace(/\\/g, '/'))
const plugin = mod.default

const routes = []
const root = {
  effect(fn) { const d = fn(); return () => { try { d && d() } catch {} } },
  on() { return () => {} },
  inject(deps, fn) {
    fn({ webServer: { register(e) { routes.push(e); return () => {} } }, effect(fn2) { const d = fn2(); return () => { try { d && d() } catch {} } }, get() {} })
  },
}
plugin.apply(root)

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const hit = routes.find((r) => r.kind === 'exact' && r.path === url.pathname)
  if (!hit) { res.writeHead(404).end('no route'); return }
  Promise.resolve(hit.handler(req, res)).catch((e) => { try { res.writeHead(500).end(String(e)) } catch {} })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const target = process.argv[2]
console.log('preview target:', target)

const t0 = Date.now()
const r = await fetch(`http://127.0.0.1:${port}/dsh-deep-purge/preview`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
  body: JSON.stringify({ ids: [target] }),
})
const text = await r.text()
console.log('status', r.status, 'elapsed', Date.now() - t0, 'ms', text.length, 'B')
console.log(text.slice(0, 3000))
server.close()
