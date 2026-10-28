# 发布进度

## 已完成（我做的，你不需要再碰）

| 步骤 | 状态 | 证据 |
|---|---|---|
| 建 GitHub 仓库 | ✅ 已建 | https://github.com/kkkkk-tubu/dsh-deep-purge |
| 推送全部代码 | ✅ 31 个文件 | `main` @ `6edae32`，`ps1` 逐字节一致（BOM+CRLF 未损） |
| 加 topic `dsh-plugin` | ✅ 8 个 topic | 市场 CI 必查项 |
| 建 Release `v1.0.0` | ✅ 已建 | https://github.com/kkkkk-tubu/dsh-deep-purge/releases/tag/v1.0.0 |
| 上传 tarball | ✅ 405,385 B | 下载回来逐字节一致 |
| README 截图改绝对 URL | ✅ 4 处 | 否则 npm 页与市场页全是死链 |
| 公开可访问 | ✅ 无需登录 | `GET /repos/...` 匿名 200，`private: false` |

**为什么不用 `git push`**：本机 `github.com:443` 被重置，`git ls-remote` 直接挂死；`api.github.com:443` 与 `uploads.github.com:443` 正常。所以走了 GitHub REST API（blob → tree → commit → ref），脚本留在 `dev/push-via-api.mjs`，以后改版直接复用：

```powershell
# 从凭据管理器取回已有 token（脚本不落盘，用完删）
# 再执行：
$env:GITHUB_TOKEN = '<token>'
$env:ELECTRON_RUN_AS_NODE = '1'
"E:\DSH\DeepSeek Harness.exe" dev/push-via-api.mjs
```

---

## 还差两步，需要你的凭据

### 1. 发 npm（需要 npm 账号，本机无 `~/.npmrc`）

```powershell
cd C:\Users\19906\Documents\deepseek-harness\default-workspace\dsh-deep-purge

# 首次登录（浏览器授权，会写 ~/.npmrc）
$env:ELECTRON_RUN_AS_NODE='1'
"E:\DSH\DeepSeek Harness.exe" "E:/DSH/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" login --registry https://registry.npmjs.org

# 发布
"E:\DSH\DeepSeek Harness.exe" "E:/DSH/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" publish --no-git-checks --access public
```

`dsh-deep-purge` 在 npm 上是 **404（名字可用）**，实测确认。发完告诉我，我把 README 的安装命令从「手动安装」改成 `dsh plugin add dsh-deep-purge` 的默认路径并补 badge。

### 2. 投插件市场（仓库建满 24 小时后才能提 PR）

仓库建于 `2026-10-28 22:03`，即 **2026-10-29 22:03 之后**才能提。

投稿文件已经写好：`dev/awesome/kkkkk-tubu__dsh-deep-purge.yml`

到那时有两种做法：
- 你自己 fork + 提 PR（模板：`Add kkkkk-tubu/dsh-deep-purge`，目标路径 `data/plugins/kkkkk-tubu__dsh-deep-purge.yml`）
- 或者过了 24h 告诉我，我直接用同一个 token 走 fork + PR（token 的 scope 是 `gist, repo, workflow`，够用）

CI 会校验的项我都已对齐：`url` 与仓库一致 ✅、`package.json` 有 `dsh.bundle` ✅、topic `dsh-plugin` ✅、`tarball` 指本仓库 release ✅、yml 里没有 `npm:` 键 ✅、`category: session` ✅。

---

## 已核对过的项

| 检查 | 结果 |
|---|---|
| npm 包名 `dsh-deep-purge` | 404，可用 |
| GitHub token 权限 | `gist, repo, workflow`，能建库/推 ref/发 release |
| `pnpm pack` | 15 个文件 / 405,385 B，`dev/` 与 `_shots/` 已排除 |
| 远端 `ps/dsh-session-cleanup.ps1` | 60,959 B，BOM + CRLF 逐字节一致 |
| Release 资产下载 | 200，逐字节一致，gzip magic `1f8b` |
| `.gitattributes` | `*.ps1 -text`，禁止任何 eol 归一化 |
| 工作区 | 干净，无未提交改动 |
