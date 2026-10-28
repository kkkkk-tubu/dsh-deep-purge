#!/usr/bin/env node
/**
 * 用 GitHub REST API 推送本仓库（不经 git:// 或 https://github.com，那条路在本机被墙）。
 *
 *   api.github.com:443        200 OK      ← 用它
 *   github.com:443            CLOSED      ← git push 走这里，死了
 *   ssh.github.com:443        22/443 OPEN ← 需要先注册 SSH key，作为备选
 *
 * 用法：
 *   $env:GITHUB_TOKEN = 'github_pat_...'      # 或 ghp_...
 *   ELECTRON_RUN_AS_NODE=1 "E:\DSH\DeepSeek Harness.exe" dev/push-via-api.mjs
 *
 * 加 --dry 只看计划，不写远端。
 *
 * 关键设计：
 * - 每个文件按**原始字节**做 base64 blob，不做任何换行/编码转换。
 *   ps/dsh-session-cleanup.ps1 的 UTF-8 BOM + CRLF 必须原样到达远端，
 *   否则 Windows PowerShell 5.1 会拿 GBK 解中文，直接语法崩溃。
 * - 走 git data API（blob → tree → commit → ref），不碰 contents API，
 *   因此一次提交就是一个真实 commit，历史干净。
 * - 幂等：仓库已存在则复用；ref 已存在且父提交一致则跳过；否则 fast-forward。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const API = 'https://api.github.com'
const OWNER = 'kkkkk-tubu'
const REPO = 'dsh-deep-purge'
const BRANCH = 'main'
const DRY = process.argv.includes('--dry')

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
if (!TOKEN && !DRY) {
  console.error('缺少 GITHUB_TOKEN 环境变量。先设：$env:GITHUB_TOKEN = "github_pat_..."')
  process.exit(2)
}

async function call(method, url, body, accept = 'application/vnd.github+json') {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-deep-purge-publisher',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const msg = json?.message ? `${json.message}${json.errors ? ' :: ' + JSON.stringify(json.errors) : ''}` : text.slice(0, 300)
    const err = new Error(`${method} ${url} -> ${res.status} ${msg}`)
    err.status = res.status
    throw err
  }
  return json
}

/** 取本仓库跟踪的全部文件（相对路径，posix 分隔） */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: HERE, encoding: 'buffer' })
  return out.toString('utf8').split('\0').filter(Boolean)
}

function headInfo() {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: HERE, encoding: 'utf8' }).trim()
  const msg = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: HERE, encoding: 'utf8' }).trim()
  const parent = (() => {
    try { return execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: HERE, encoding: 'utf8' }).trim() } catch { return null }
  })()
  return { sha, msg, parent }
}

async function ensureRepo() {
  try {
    const r = await call('GET', `/repos/${OWNER}/${REPO}`)
    console.log(`仓库已存在: ${r.html_url}  (default_branch=${r.default_branch})`)
    return { existed: true, info: r }
  } catch (e) {
    if (e.status !== 404) throw e
  }
  if (DRY) { console.log(`[dry] 将创建仓库 ${OWNER}/${REPO}`); return { existed: false, info: null } }
  const r = await call('POST', '/user/repos', {
    name: REPO,
    description: 'Delete DSH sessions completely — clears all six on-disk locations, with dry run, backup, rollback and automatic DSH restart.',
    homepage: `https://github.com/${OWNER}/${REPO}#readme`,
    private: false,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    auto_init: false,          // 远端不要初始 commit，否则推不上去
  })
  console.log(`已创建仓库: ${r.html_url}`)
  return { existed: false, info: r }
}

async function ensureTopics() {
  if (DRY) { console.log('[dry] 将设置 topics'); return }
  await call('PUT', `/repos/${OWNER}/${REPO}/topics`, {
    names: ['dsh-plugin', 'deepseek-harness', 'dsh', 'session', 'purge', 'cleanup', 'deepseek', 'windows'],
  })
  console.log('已设置 topics（含 dsh-plugin，市场 CI 必查项）')
}

async function pushTree() {
  const files = trackedFiles()
  const head = headInfo()
  console.log(`本地 HEAD ${head.sha.slice(0, 8)} "${head.msg}"，${files.length} 个文件`)

  // 远端当前 ref
  let remoteSha = null
  let remoteTreeSha = null
  try {
    const ref = await call('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
    remoteSha = ref.object.sha
    const rc = await call('GET', `/repos/${OWNER}/${REPO}/git/commits/${remoteSha}`)
    remoteTreeSha = rc.tree.sha
    console.log(`远端 ${BRANCH} 已在 ${remoteSha.slice(0, 8)}`)
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e
    console.log(`远端还没有 ${BRANCH} 分支`)
  }

  // 空仓库（没有任何 commit）时 git data API 全部返回 409 Git Repository is empty。
  // 必须先用 contents API 落地一个真实 commit 把对象库建立起来，之后才可建 blob。
  if (!remoteSha && !DRY) {
    console.log('远端是空仓库，先 bootstrap 一个初始 commit（contents API）…')
    const seed = await call('PUT', `/repos/${OWNER}/${REPO}/contents/.gitkeep`, {
      message: 'chore: bootstrap empty repository',
      content: Buffer.from('').toString('base64'),
      branch: BRANCH,
    })
    remoteSha = seed.commit.sha
    console.log(`bootstrap commit ${remoteSha.slice(0, 8)} 已建立，${BRANCH} 分支就绪`)
  }

  // 本地树 hash（用 git 自己的：git rev-parse HEAD^{tree}）
  const localTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: HERE, encoding: 'utf8' }).trim()
  if (remoteTreeSha && remoteTreeSha === localTree) {
    console.log('远端树与本地一致，无需推送。')
    return { pushed: false, sha: remoteSha }
  }

  if (DRY) {
    console.log(`[dry] 将上传 ${files.length} 个 blob 并建 tree/commit/ref`)
    return { pushed: false, sha: null }
  }

  // 逐文件上传 blob（保留原始字节）
  const entries = []
  let total = 0
  for (const rel of files) {
    const abs = path.join(HERE, rel)
    if (!existsSync(abs)) throw new Error('文件不存在: ' + rel)
    const buf = readFileSync(abs)
    total += buf.length
    const blob = await call('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    })
    // 100644 = 普通文件；脚本没有可执行位（Windows）
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha })
  }
  console.log(`已上传 ${entries.length} 个 blob，共 ${total} 字节（按原始字节，ps1 的 BOM+CRLF 未动）`)

  const tree = await call('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree: entries })
  console.log(`已建 tree ${tree.sha.slice(0, 8)}`)

  const commitBody = {
    message: `${head.msg}\n\n${head.parent ? '' : '(initial commit, pushed via GitHub REST API)\n'}`.trim() + `\n\n源提交: ${head.sha}`,
    tree: tree.sha,
    parents: remoteSha ? [remoteSha] : [],
  }
  const commit = await call('POST', `/repos/${OWNER}/${REPO}/git/commits`, commitBody)
  console.log(`已建 commit ${commit.sha.slice(0, 8)}`)

  if (remoteSha) {
    await call('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false })
  } else {
    await call('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha })
  }
  console.log(`已更新 ${BRANCH} -> ${commit.sha.slice(0, 8)}`)
  return { pushed: true, sha: commit.sha }
}

async function verify() {
  const files = trackedFiles()
  const probe = 'ps/dsh-session-cleanup.ps1'
  const r = await call('GET', `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(probe)}?ref=${BRANCH}`)
  const remote = Buffer.from(r.content.replace(/\n/g, ''), 'base64')
  const local = readFileSync(path.join(HERE, probe))
  const same = remote.equals(local)
  console.log(`\n远端校验 ${probe}: ${remote.length} 字节 vs 本地 ${local.length} 字节 -> ${same ? '逐字节一致 ✓' : '不一致 ✗'}`)
  if (!same) {
    console.log(`  远端 BOM=${remote[0] === 0xef && remote[1] === 0xbb && remote[2] === 0xbf}, CRLF=${(remote.toString('latin1').match(/\r\n/g) || []).length}`)
    console.log(`  本地 BOM=${local[0] === 0xef && local[1] === 0xbb && local[2] === 0xbf}, CRLF=${(local.toString('latin1').match(/\r\n/g) || []).length}`)
  }
  // 顺便确认文件数
  const tree = await call('GET', `/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`)
  const n = tree.tree.filter((t) => t.type === 'blob').length
  console.log(`远端文件总数: ${n}（本地跟踪 ${files.length}）`)
  return same && n === files.length
}

const repo = await ensureRepo()
await ensureTopics()
const res = await pushTree()
if (!DRY) {
  const ok = await verify()
  console.log(`\n${ok ? '全部通过' : '有差异，检查上面的输出'}`)
  console.log(`仓库地址: https://github.com/${OWNER}/${REPO}`)
  process.exit(ok ? 0 : 1)
}
