# 把工作区源码同步进 desktop profile 里真正被加载的那份。
#
# 为什么需要这一步：DSH 只从 <profile>/node_modules/<pkg> 解析 bundle，
# workspace 里的目录只是源码。改完 lib/index.js 要同步 + 重启 DSH；
# 只改 lib/ui.js 同步后硬刷新页面即可（路由按 mtime 重读，no-store）。
#
# 用法：powershell -ExecutionPolicy Bypass -File sync-to-profile.ps1
[CmdletBinding()]
param(
    [string] $ProfileName = 'desktop',
    [switch] $Reverse
)

$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
$dst = Join-Path $env:USERPROFILE ".dsh\profiles\$ProfileName\node_modules\dsh-deep-purge"

if ($Reverse) { $src, $dst = $dst, $src }

if (-not (Test-Path $dst)) {
    throw "profile 里没有这个包：$dst（先跑 register-profile.cjs 再手动建目录，或改用 dsh plugin add）"
}

$files = @(
    'package.json',
    'cordis.patch.yml',
    'lib\index.js',
    'lib\ui.js',
    'lib\client.js',
    'ps\dsh-session-cleanup.ps1'
)
foreach ($n in @('README.md','CHANGELOG.md','LICENSE','NOTICE.md','screenshots.json')) {
    if (Test-Path (Join-Path $src $n)) { $files += $n }
}
if (Test-Path (Join-Path $src 'screenshots')) {
    Get-ChildItem (Join-Path $src 'screenshots') -Filter '*.png' -File | ForEach-Object {
        $files += ('screenshots/' + $_.Name)
    }
}

$changed = @()
foreach ($rel in $files) {
    $a = Join-Path $src $rel
    $b = Join-Path $dst $rel
    if (-not (Test-Path $a)) { Write-Host "  跳过 $rel（源码里没有）" -ForegroundColor DarkGray; continue }
    New-Item -ItemType Directory -Force -Path (Split-Path $b) | Out-Null

    $same = (Test-Path $b) -and
            ((Get-FileHash $a -Algorithm SHA256).Hash -eq (Get-FileHash $b -Algorithm SHA256).Hash)
    if ($same) {
        Write-Host "  $rel 未变" -ForegroundColor DarkGray
        continue
    }
    Copy-Item $a $b -Force
    $changed += $rel
    Write-Host "  $rel 已复制（$((Get-Item $b).Length) bytes）" -ForegroundColor Green
}

Write-Host ""
Write-Host "目标：$dst"
if ($changed -contains 'lib\index.js' -or $changed -contains 'cordis.patch.yml' -or $changed -contains 'package.json' -or $changed -contains 'lib\client.js') {
    Write-Host "宿主半区或浏览器 bundle 变了 → 需要重启 DSH 才生效。" -ForegroundColor Yellow
} elseif ($changed -contains 'lib\ui.js') {
    Write-Host "只改了页面半区 → 页面硬刷新（Ctrl+R）即生效。" -ForegroundColor Cyan
} elseif ($changed.Count -gt 0) {
    Write-Host "只更新了文档/截图 → 无需重启。" -ForegroundColor Cyan
} else {
    Write-Host "没有变化。" -ForegroundColor DarkGray
}
