#!/usr/bin/env node
/**
 * 建 GitHub Release v1.0.0 并上传 tarball 资产。
 * 需要 GITHUB_TOKEN（repo 权限）。upload 走 uploads.github.com，实测可达。
 *
 *   ELECTRON_RUN_AS_NODE=1 "E:\DSH\DeepSeek Harness.exe" dev/create-release.mjs [--dry]
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const API = 'https://api.github.com'
const OWNER = 'kkkkk-tubu'
const REPO = 'dsh-deep-purge'
const TAG = 'v1.0.0'
const TARBALL = process.argv.slice(2).find((a) => a.endsWith('.tgz')) || null
const DRY = process.argv.includes('--dry')
const TOKEN = process.env.GITHUB_TOKEN || ''

if (!TOKEN && !DRY) { console.error('缺少 GITHUB_TOKEN'); process.exit(2) }

const H = () => ({
  Authorization: 'Bearer ' + TOKEN,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'dsh-deep-purge-release',
})

async function api(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: { ...H(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const t = await res.text()
  let j = null
  try { j = t ? JSON.parse(t) : null } catch {}
  if (!res.ok) {
    const e = new Error(`${method} ${url} -> ${res.status} ${j?.message || t.slice(0, 200)}`)
    e.status = res.status
    throw e
  }
  return j
}

/** 从 CHANGELOG.md 取 1.0.0 段正文 */
function releaseNotes() {
  const md = readFileSync(path.join(HERE, 'CHANGELOG.md'), 'utf8')
  const m = md.match(/##\s*\[?1\.0\.0\]?[^\n]*\n([\s\S]*?)(?=\n##\s|\n*$)/)
  const body = (m ? m[1] : '').trim()
  return body || '1.0.0'
}

let rel = null
try {
  rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`)
  console.log(`Release ${TAG} 已存在: ${rel.html_url}`)
} catch (e) {
  if (e.status !== 404) throw e
}

if (!rel) {
  const notes = releaseNotes()
  if (DRY) {
    console.log(`[dry] 将创建 Release ${TAG}，说明 ${notes.length} 字符`)
  } else {
    rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: TAG,
      target_commitish: 'main',
      name: 'dsh-deep-purge 1.0.0',
      body: notes,
      draft: false,
      prerelease: false,
    })
    console.log(`已创建 Release: ${rel.html_url}`)
  }
}

// 上传资产
const file = TARBALL || path.join(process.env.TEMP || '/tmp', 'pk', 'dsh-deep-purge-1.0.0.tgz')
if (!existsSync(file)) { console.error('tarball 不存在: ' + file); process.exit(3) }
const buf = readFileSync(file)
const assetName = path.basename(file)
console.log(`资产 ${assetName}，${buf.length} 字节`)

if (DRY) { console.log('[dry] 将上传资产'); process.exit(0) }

// 已存在同名资产则先删
const existing = (rel.assets || []).find((a) => a.name === assetName)
if (existing) {
  await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`)
  console.log(`已删除旧资产 ${assetName}`)
}

const uploadUrl = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(assetName)}`
const up = await fetch(uploadUrl, {
  method: 'POST',
  headers: { ...H(), 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
  body: buf,
})
const upText = await up.text()
if (!up.ok) { console.error(`上传失败 ${up.status}: ${upText.slice(0, 400)}`); process.exit(1) }
const asset = JSON.parse(upText)
console.log(`资产已上传: ${asset.browser_download_url} (${asset.size} 字节)`)

// 校验可下载
const dl = await fetch(asset.browser_download_url, { redirect: 'follow', headers: { 'User-Agent': 'x' } })
const got = Buffer.from(await dl.arrayBuffer())
console.log(`下载校验: ${dl.status}，${got.length} 字节 vs 本地 ${buf.length} -> ${got.equals(buf) ? '逐字节一致 ✓' : '不一致 ✗'}`)
console.log(`Release 页面: ${rel.html_url}`)
