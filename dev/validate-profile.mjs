// 用宿主自己的 loader 校验 desktop profile 的 bundle 解析结果
// 运行：ELECTRON_RUN_AS_NODE=1 & 'E:\DSH\DeepSeek Harness.exe' validate-profile.mjs
import { loadProfileDirectory } from 'file:///E:/DSH/resources/app/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'

const dir = 'C:/Users/19906/.dsh/profiles/desktop'
const installAnchor = 'E:/DSH/resources/app/dsh/package.json'

const profile = loadProfileDirectory('dsh', dir, installAnchor, { userLayer: false })

console.log('layers:', profile.layers.length)
console.log('skipped:', JSON.stringify(profile.skippedBundles, null, 2))
const ours = profile.layers.find((l) => l.packageName === 'dsh-deep-purge')
console.log('ours layer:', ours
  ? JSON.stringify({ dir: ours.packageDir, patchPaths: ours.patchPaths, rows: ours.patches }, null, 2)
  : 'NOT FOUND')
