# 发布清单（PUBLISH）

这份文件只给仓库维护者看，不进 npm 包（`files` 白名单里没有它）。所有门槛都来自
`awesome-dsh-plugin` 的 `contributing.md` 和本机 DSH 源码，照着做就不会被打回。

---

## 0. 发布前必须改的一处

`package.json` 里三处仓库 URL（已填 `kkkkk-tubu`，若换账号需三处同改）：

```json
"repository": { "type": "git", "url": "git+https://github.com/kkkkk-tubu/dsh-deep-purge.git" },
"bugs": { "url": "https://github.com/kkkkk-tubu/dsh-deep-purge/issues" },
"homepage": "https://github.com/kkkkk-tubu/dsh-deep-purge#readme",
```

换成真实的 GitHub 账号。三条要求：

1. 三个 URL 必须指向**同一个**仓库。
2. 这个仓库必须就是提交给 awesome-dsh-plugin 的那个仓库 —— npm 包靠 `repository`
   字段与收录条目关联，指错了市场页面就显示不出下载量。
3. 仓库名建议就叫 `dsh-deep-purge`，与包名一致。

---

## 1. 建仓库

```bash
cd <这个目录>
git init
git add .
git commit -m "dsh-deep-purge 1.0.0"
git branch -M main
git remote add origin https://github.com/kkkkk-tubu/dsh-deep-purge.git
git push -u origin main
```

然后必须在 GitHub 仓库页面做两件事：

- **加 topic `dsh-plugin`**（Settings → Topics，或用 `gh repo edit --add-topic dsh-plugin`）。
  没有这个 topic，CI 直接判不合格。
- 仓库要**创建满 24 小时**才能提交收录。新仓库当天提交会被拒。

`.gitignore` 已排除 `_shots/`、`node_modules/`、`session-delete-backup-*/` 和临时截图。

---

## 2. 发布到 npm

`dsh-deep-purge` 这个包名在 npm 上当前是 **404（可用）**。发布前再确认一次：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/dsh-deep-purge   # 要 404
```

发布（本机没有全局 pnpm，用 DSH 自带的那个）：

```bash
cd <这个目录>
ELECTRON_RUN_AS_NODE=1 "/e/DSH/DeepSeek Harness.exe" \
  "E:/DSH/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" publish --access public
```

或者先本地试打包再发：

```bash
ELECTRON_RUN_AS_NODE=1 "/e/DSH/DeepSeek Harness.exe" \
  "E:/DSH/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" pack --pack-destination /tmp/pk
tar -tzf /tmp/pk/dsh-deep-purge-1.0.0.tgz    # 核对白名单，不该出现 dev/ 和 _shots/
```

当前 `pnpm pack` 实测产物（432 KB，16 个文件）：

```
package/CHANGELOG.md  LICENSE  NOTICE.md  README.md  package.json
package/cordis.patch.yml
package/lib/client.js  lib/index.js  lib/ui.js
package/ps/dsh-session-cleanup.ps1
package/screenshots.json
package/screenshots/01-first-run-guide.png ... 04-dark-theme.png
```

发布后验证：

```bash
curl -s https://registry.npmjs.org/dsh-deep-purge | head -c 300
```

---

## 3. 提交到 awesome-dsh-plugin

一个 PR 最多 3 条，一条一个文件。新增 `data/plugins/kkkkk-tubu__dsh-deep-purge.yml`：

```yaml
url: https://github.com/kkkkk-tubu/dsh-deep-purge
name: kkkkk-tubu/dsh-deep-purge
category: session
description:
  en: >-
    Actually delete DSH sessions instead of archiving them. Clears all six
    on-disk locations (transcript, title cache, bili SQLite index with VACUUM,
    workspace registry, cost-meter ledger, bridge logs) with a dry run, a
    backup, byte-for-byte rollback, and an automatic quit-delete-relaunch flow.
  zh: >-
    真正删除 DSH 会话，而不是只归档。一次清掉六处本地存储：会话日志、标题缓存、
    bili SQLite 索引（含 VACUUM）、侧栏注册表、成本台账、桥接日志。带预演、
    自动备份、逐字节回滚，以及「退出→删除→重启」全自动流程。
icon: https://raw.githubusercontent.com/kkkkk-tubu/dsh-deep-purge/main/screenshots/02-panel.png
tarball: https://github.com/kkkkk-tubu/dsh-deep-purge/releases/download/v1.0.0/dsh-deep-purge-1.0.0.tgz
```

注意事项：

- **不要写 `npm:` 键**。下载量靠 `repository` 字段自动关联，手写会被 CI 拒。
- `url` 必须与仓库地址**完全一致**（含大小写）。
- `tarball` 可选；要用就选 GitHub Release 上的 `.tgz`，且必须与该仓库匹配。
- `description` 不许夸大。我们把六处存储逐条列了，这正好是最有力的部分。
- `icon` 可选，建议用 `02-panel.png`（96px 左右会被缩，看 repo 里的原图即可）。
- README 由他们的脚本生成，**不要手改**仓库里的 README 去适配市场。

截图走 `package.json` 旁边的 `screenshots.json`（已建好，4 张，相对路径，无 `..`
无前导 `/`）。市场会自动读它，不需要在 yml 里再列。

---

## 4. 提交前自检（本机可跑）

```bash
cd dev
# 客户端半区硬校验（复刻 client-modules 会抛错的每个分支）
ELECTRON_RUN_AS_NODE=1 "/e/DSH/DeepSeek Harness.exe" verify-client-half.mjs
# 宿主半区路由 + 安全校验（mock 宿主，不碰真实数据）
ELECTRON_RUN_AS_NODE=1 "/e/DSH/DeepSeek Harness.exe" test-host.mjs
# 真机安装后的副本核对
ELECTRON_RUN_AS_NODE=1 "/e/DSH/DeepSeek Harness.exe" verify-client-half.mjs "C:/Users/<you>/.dsh/profiles/desktop/node_modules/dsh-deep-purge"
```

`verify-client-half.mjs` 支持传包目录，所以也能核对 `pnpm pack` 解包出来的那份。

---

## 5. 兼容性声明怎么来的

`engines.dsh` 写的是：

```
>=0.2.1-rc.2 <0.3.0-0 || >=0.3.0-rc.1
```

这不是随手写的范围。用 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`
在 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-rc.2 / 0.2.1-rc.3 / 0.3.0-rc.1 / 0.3.0 / 1.0.0
上逐个实测：

| runtime | 结果 |
|---|---|
| 0.1.7-rc.2 | 不兼容（缺 `slots.subscribe` 之前的旧槽位 API） |
| 0.2.0-rc.2 | 不兼容 |
| 0.2.1-rc.2 | 兼容 |
| 0.2.1-rc.3 | 兼容 |
| 0.3.0-rc.1 / 0.3.0 / 1.0.0 | 兼容 |

为什么必须两段：`<0.3.0` 这种上界会**静默排除所有 0.3.0 预发布版**（semver 的
预发布陷阱），所以要显式补 `>=0.3.0-rc.1`，再用 `<0.3.0-0` 把 0.3.0 之前的
预发布排除干净。

`dsh.compatibility.dshReleases` 里的三条只是给人看的说明，真正判定走 `engines.dsh`
—— `unmetRequirements` 里 `engines.dsh` 一旦存在就**单独决定**，peerDependencies 被忽略。

---

## 6. 数据安全红线（别再动）

发布版本里这三件事不能改：

- 默认写备份到 `~/.dsh/session-delete-backup-<timestamp>/`，保留原相对路径，
  `-Restore <dir>` 能逐字节还原。要关掉必须显式 `-NoBackup`。
- 当前会话不可删：UI checkbox 禁用 + HTTP handler 二次拒（`targets-current-session`）。
- `DELETE` 口令：UI 比对 + 服务端再比对（`confirm-required`）。这是防手滑，不是加密，
  写文档时不要吹成安全机制。
