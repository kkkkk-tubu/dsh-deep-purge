// 把 dsh-deep-purge 注册进 desktop profile：dependencies + bundles
const fs = require('fs')
const path = require('path')

const profileDir = 'C:/Users/19906/.dsh/profiles/desktop'
const pkgFile = path.join(profileDir, 'package.json')
const NAME = 'dsh-deep-purge'
const SRC = 'file:C:/Users/19906/Documents/deepseek-harness/default-workspace/dsh-deep-purge'

const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
pkg.dependencies = pkg.dependencies || {}

// 老包名（dsh-session-purge）是同一份代码改名前注册进去的，留着会一起加载两份，
// 两个 bundle 抢同一个 sidebar.panellist 槽位。改成新名时顺手清掉。
const LEGACY = 'dsh-session-purge'
if (pkg.dependencies[LEGACY] !== undefined) {
  delete pkg.dependencies[LEGACY]
  console.log('removed legacy dependency:', LEGACY)
}

pkg.dependencies[NAME] = SRC

const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles
if (!Array.isArray(bundles)) throw new Error('no dsh.profile.bundles')
if (bundles.includes(LEGACY)) {
  const i = bundles.indexOf(LEGACY)
  bundles.splice(i, 1, NAME)
  console.log('replaced legacy bundle entry at index', i)
}
if (!bundles.includes(NAME)) bundles.push(NAME)

fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log('dependencies:', Object.keys(pkg.dependencies).length)
console.log('bundles:', bundles.length, '| has ours:', bundles.includes(NAME))
console.log('tail:', bundles.slice(-3).join(', '))
