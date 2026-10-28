# 发布：照着敲

包已经准备好了（git 仓库已 init、首个 commit 已打、URL 全填 `kkkkk-tubu`、awesome 的 yml 已生成）。
剩下三件事都需要你的 GitHub / npm 凭据，我这边没有。

---

## 1. 建仓库（网页 30 秒）

https://github.com/new

- Repository name: **dsh-deep-purge**
- Public
- **不要**勾 Add README / .gitignore / license（本地已有，勾了会冲突）
- 创建后到 Settings → Topics 加 **`dsh-plugin`**（市场 CI 会查这个）

---

## 2. 推送（本机执行）

```powershell
cd C:\Users\19906\Documents\deepseek-harness\default-workspace\dsh-deep-purge
git remote add origin https://github.com/kkkkk-tubu/dsh-deep-purge.git
git push -u origin main
```

首次 push 会弹 GitHub 登录窗口（浏览器授权或粘贴 PAT，勾 `repo` 权限）。

---

## 3. 发 npm（本机执行）

```powershell
cd C:\Users\19906\Documents\deepseek-harness\default-workspace\dsh-deep-purge

# 先登一次（交互式，浏览器/OTP）
ELECTRON_RUN_AS_NODE=1 "E:\DSH\DeepSeek Harness.exe" `
  "E:/DSH/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" login --registry https://registry.npmjs.org

# 发布（--no-git-checks 略过 git 洁净检查；包内 15 个文件已核对）
ELECTRON_RUN_AS_NODE=1 "E:\DSH\DeepSeek Harness.exe" `
  "E:/DSH/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" publish --no-git-checks --access public
```

`dsh-deep-purge` 在 npm 上是 **404（可用）**，实测确认。

---

## 4. 建 Release（可选，但 awesome 的 tarball 字段要用）

```powershell
# 先把 pack 产物拿出来
cd C:\Users\19906\Documents\deepseek-harness\default-workspace\dsh-deep-purge
mkdir -p dist
ELECTRON_RUN_AS_NODE=1 "E:\DSH\DeepSeek Harness.exe" `
  "E:/DSH/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" pack --pack-destination dist
```

然后 https://github.com/kkkkk-tubu/dsh-deep-purge/releases/new
- Tag: `v1.0.0`
- 标题: `dsh-deep-purge 1.0.0`
- 附件: 上传 `dist/dsh-deep-purge-1.0.0.tgz`
- 说明: 直接把 `CHANGELOG.md` 的 1.0.0 段贴过去

---

## 5. 投市场（仓库建满 24h 后）

1. Fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
2. 把 `dev/awesome/kkkkk-tubu__dsh-deep-purge.yml` 复制到 fork 的 `data/plugins/` 下
3. 提 PR，标题 `Add kkkkk-tubu/dsh-deep-purge`

CI 会自己校验：`url` 与仓库一致 ✅、`package.json` 有 `dsh.bundle` ✅、topic `dsh-plugin`（第 1 步记得加）、
`tarball` 指向本仓库 ✅、yml 里没有 `npm:` 键 ✅。全部满足。

---

## 已替你核对过的项

| 检查 | 结果 |
|---|---|
| npm 包名 `dsh-deep-purge` | 404，可用 |
| GitHub 账号 `kkkkk-tubu` | 存在，5 个公开仓库，建于 2026-10-09 |
| `package.json` 三处 URL | 已全部指向 `kkkkk-tubu/dsh-deep-purge` |
| `LICENSE` | 版权人已改 `kkkkk-tubu` |
| `pnpm pack` | 15 个文件 / 405,355 B，dev/ 与 _shots/ 已排除 |
| 解包后 `verify-client-half.mjs` | 全 PASS |
| `git commit` | ad8b87a，26 文件，工作区干净 |
| ps1 BOM + CRLF | 1321 行全 CRLF，BOM 存在，`.gitattributes` 禁止 eol 归一化 |
