// 按 @deepseek-ai/dsh-client-modules 的硬校验，逐条核对本插件的客户端半区。
// 只复刻会抛错的分支（parseDshClient / clientExportOf / 文件存在性），不重跑 compose。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const SELFTEST = process.argv.includes('--selftest')
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
// 可选：`node verify-client-half.mjs <包目录>` 直接核对任意副本（比如 npm pack 解包出来的）
const EXPLICIT = process.argv.slice(2).find((a) => !a.startsWith('--'))
const PKG_DIR = EXPLICIT
  ? path.resolve(EXPLICIT)
  : SELFTEST
    ? path.join(HERE, '.verify-fixture')
    : path.join(HERE, '..')

let failures = 0
const ok = (m) => console.log('  PASS  ' + m)
const bad = (m) => { failures += 1; console.log('  FAIL  ' + m) }

// ---- 复刻 index.js 的可选字符串数组校验 ----
function optionalStringArray(subject, field, value) {
  if (value === void 0) return void 0
  if (!Array.isArray(value) || value.some((i) => typeof i !== 'string')) {
    throw new Error(`client-modules: ${subject} ${field} must be a string array`)
  }
  return value
}

// ---- 复刻 parseDshClient（:65-84） ----
function parseDshClient(pkgName, value) {
  if (value === void 0) return void 0
  if (typeof value !== 'object' || value === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`)
  }
  if (typeof value.platform !== 'string') {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`)
  }
  return {
    platform: value.platform,
    inject: optionalStringArray(pkgName, 'dsh.client.inject', value.inject),
    external: optionalStringArray(pkgName, 'dsh.client.external', value.external),
  }
}

// ---- 复刻 clientExportOf（:172-182） ----
function clientExportOf(pkgName, exportsField) {
  if (typeof exportsField !== 'object' || exportsField === null) return void 0
  const client = exportsField['./client']
  if (client === void 0) return void 0
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null && typeof client.default === 'string') return client.default
  throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`)
}

console.log('package: ' + (SELFTEST ? '<selftest fixture>' : PKG_DIR))
console.log('')

const pkgPath = path.join(PKG_DIR, 'package.json')
if (!fs.existsSync(pkgPath)) { bad('package.json 不存在: ' + pkgPath); process.exit(1) }

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const name = pkg.name

// 1) package.json 能被 node 解析（上面已 parse）
ok('package.json 合法，name=' + name)

// 2) dsh.client 声明
let decl
try {
  decl = parseDshClient(name, pkg.dsh && pkg.dsh.client)
  if (decl === void 0) throw new Error('dsh.client 缺失')
  ok('dsh.client 声明合法: platform=' + decl.platform + ' inject=' + (decl.inject || []).length + ' 项')
} catch (error) {
  bad('dsh.client 校验失败: ' + error.message)
}

// 3) platform 必须是 web（index.js:733 用它决定是否进 client 表）
if (decl && decl.platform === 'web') ok('platform === "web"（客户端表接纳条件）')
else bad('platform 必须是 "web"，实际 ' + (decl && decl.platform))

// 4) exports["./client"] 必须存在且指向真实文件（index.js:737）
let clientRel
try {
  clientRel = clientExportOf(name, pkg.exports)
  if (clientRel === void 0) throw new Error('exports 里没有 "./client"')
  ok('exports["./client"] -> ' + clientRel)
} catch (error) {
  bad('exports["./client"] 校验失败: ' + error.message)
}

if (clientRel !== void 0) {
  const clientAbs = path.join(PKG_DIR, clientRel)
  if (fs.existsSync(clientAbs)) {
    const stat = fs.statSync(clientAbs)
    const sha = crypto.createHash('sha256').update(fs.readFileSync(clientAbs)).digest('hex').slice(0, 12)
    ok(`客户端 bundle 存在：${clientRel}  ${stat.size} B  sha256=${sha}`)
  } else {
    bad('客户端 bundle 不存在: ' + clientAbs)
  }

  // 5) 语法 + 必须是 __ModuleLoader__.load({ id, factory }) 形态
  const src = fs.readFileSync(clientAbs, 'utf8')
  try {
    new (await import('node:vm')).Script(src, { filename: clientRel })
    ok('客户端 bundle 语法通过（vm.Script 编译成功）')
  } catch (error) {
    bad('客户端 bundle 语法错误: ' + error.message)
  }

  if (src.includes('__ModuleLoader__.load(')) ok('使用 window.__ModuleLoader__.load({ id, factory }) 形态')
  else bad('缺少 __ModuleLoader__.load(...) 入口')

  const idMatch = src.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*['"]([^'"]+)['"]/)
  if (idMatch && idMatch[1] === name) ok(`注册 id 与包名一致: "${idMatch[1]}"`)
  else bad(`注册 id "${idMatch && idMatch[1]}" 与包名 "${name}" 不一致`)

  // 6) require 只能落在平台种子表里（client.js:834-843 的 seed 表）
  const SEED = new Set([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
  ])
  // 注释里写了 `require("…")` 这种示例，会污染扫描，先剥掉块注释与行注释
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
  const requires = [...new Set([...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]))]
  const outside = requires.filter((s) => !SEED.has(s) && s !== name && !s.startsWith('./') && !s.startsWith('../'))
  if (requires.length === 0) bad('一个 require 都没有，factory 形参没用上？')
  else ok('require 列表: ' + requires.join(', '))
  if (outside.length === 0) ok('全部 require 命中平台种子表')
  else bad('这些 require 不在种子表，会抛 missed the module table: ' + outside.join(', '))

  // 6b) 种子表里的 UI 基础件，确认这两处命名真的存在于前端 bundle 的命名空间
  const shellPath = 'E:/DSH/resources/app/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js'
  if (fs.existsSync(shellPath)) {
    const shell = fs.readFileSync(shellPath, 'utf8')
    const nsStart = shell.indexOf('TU=Object.freeze')
    const ns = nsStart === -1 ? '' : shell.slice(nsStart, shell.indexOf('}))', nsStart) + 3)
    if (!ns) {
      bad('找不到 primitives 命名空间 TU')
    } else {
      const wanted = ['MenuItemButton', 'IconTrashOutlineRegular']
      const missing = wanted.filter((k) => !ns.includes(k + ':'))
      if (missing.length === 0) ok('primitives 命名空间含 ' + wanted.join(' / '))
      else bad('primitives 命名空间缺 ' + missing.join(', '))
    }
  } else {
    console.log('  SKIP  前端 bundle 不在预期路径，跳过命名空间核对')
  }
}

// 7) 服务级 bundle（main 字段）也要能解析
const mainRel = typeof pkg.main === 'string' ? pkg.main : (pkg.exports && pkg.exports['.'] && pkg.exports['.'].default)
if (typeof mainRel === 'string' && fs.existsSync(path.join(PKG_DIR, mainRel))) {
  ok('宿主半区入口存在: ' + mainRel)
} else {
  bad('宿主半区入口解析失败: main=' + pkg.main)
}

// 8) bundle patch 存在（否则 profile 不会 insert 这一行）
const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
if (typeof patchRel === 'string' && fs.existsSync(path.join(PKG_DIR, patchRel))) {
  ok('bundle patch 存在: ' + patchRel)
} else {
  bad('bundle patch 缺失: ' + patchRel)
}

// 9) cordis.patch.yml 里确实 insert 了自己
if (typeof patchRel === 'string' && fs.existsSync(path.join(PKG_DIR, patchRel))) {
  const patch = fs.readFileSync(path.join(PKG_DIR, patchRel), 'utf8')
  if (patch.includes(name)) ok('patch 里 insert 了 ' + name)
  else bad('patch 里没有 ' + name)
}

console.log('')
if (failures === 0) console.log('RESULT: 全部通过，客户端半区可被 dsh-client-modules 接纳')
else console.log(`RESULT: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
