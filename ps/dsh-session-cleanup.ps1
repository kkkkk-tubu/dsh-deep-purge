#requires -Version 5.1
<#
.SYNOPSIS
    DSH 会话彻底删除工具 v2 —— 一次删干净六处存储，失败可回滚。

.DESCRIPTION
    DSH 内建没有删除会话的功能（只有归档），会话数据散落在六处：
      1. %USERPROFILE%\.dsh\sessions\<slug>\<session-id>\session.v4.jsonl.zstd   DSH 日志
      2. %USERPROFILE%\.dsh\storages\session_projcache\sessions\<session-id>.json  标题缓存
      3. %USERPROFILE%\.dsh\storages\workspace.json        侧栏注册表（sessionIds / archived / pinned）
      4. ~/.local/share/billion-context/sessions/index.db  billion-context 索引（+ |sub: 子会话）
      5. %USERPROFILE%\.dsh\storages\cost-meter\ledger.json 成本台账里的会话明细
      6. cost-meter 的两个 hash 缓存目录（含该 sid 的条目）

    本脚本按「bili -> 磁盘 -> 缓存 -> 台账 -> 注册表」顺序删除，
    每步记录成败；workspace.json 最后改，改完回读校验。

.PARAMETER List
    只列出全部会话及其在六处存储里的存在情况，不动任何文件。

.PARAMETER SessionId
    要删的会话 id，可逗号分隔，如 session-aaa,session-bbb

.PARAMETER Execute
    真正执行。不加即预演（只打印计划）。

.PARAMETER Restore
    从备份目录还原。

.EXAMPLE
    .\dsh-session-cleanup.ps1 -List

.EXAMPLE
    .\dsh-session-cleanup.ps1 -SessionId session-7c1c6ff5-0ee5-4249-b68f-2c804cce919a

.EXAMPLE
    .\dsh-session-cleanup.ps1 -SessionId session-7c1c6ff5-0ee5-4249-b68f-2c804cce919a -Execute

.EXAMPLE
    .\dsh-session-cleanup.ps1 -Restore "$env:USERPROFILE\.dsh\session-delete-backup-20261026-180000"
#>
[CmdletBinding(DefaultParameterSetName = 'Clean')]
param(
    [Parameter(ParameterSetName = 'List')]
    [switch] $List,

    [Parameter(ParameterSetName = 'Clean', Position = 0)]
    [string[]] $SessionId,

    [Parameter(ParameterSetName = 'Clean')]
    [switch] $Execute,

    [Parameter(ParameterSetName = 'Restore')]
    [string] $Restore,

    [Parameter(ParameterSetName = 'Clean')]
    [switch] $AutoRestart,

    [switch] $NoBackup,
    [switch] $SkipBiliGc,
    [switch] $KeepLedger,
    [switch] $AllowRunningDsh,
    [switch] $Json,

    [string] $DshHome,
    [string] $BiliSessions,
    [string] $HarnessExe,
    [int] $WaitTimeoutSec = 180,
    [string] $RestartExe,
    # 进程名：真实环境固定 'DeepSeek Harness'；沙箱验证时换成假的 sleeper 进程名
    [string] $DshProcessName = 'DeepSeek Harness',

    # 内部用：由 -AutoRestart 派生出的后台 helper 自己调用时置位，跳过"派 helper"那一段
    [switch] $HelperStage,
    [string] $HelperLog,
    # 内部用：helper 自己跑完时用来注销临时计划任务
    [string] $HelperTaskName,
    # helper 延后多少秒由自己动手关 DSH（给前台命令留出返回时间）
    [int] $QuitDelaySec = 8
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------- 环境

if (-not $DshHome) {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
}
if (-not $BiliSessions) {
    $dataHome = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { Join-Path $env:USERPROFILE '.local\share' }
    $BiliSessions = Join-Path $dataHome 'billion-context\sessions'
}
if ($env:BILI_SESSIONS_DIR) { $BiliSessions = $env:BILI_SESSIONS_DIR }

# DSH 可执行文件发现顺序（重要：这决定了插件能不能换机器装）
#   1. -HarnessExe 显式指定
#   2. 环境变量 DSH_HARNESS_EXE
#   3. 正在运行的 DSH 进程自己的 Path（最准，安装位置随便在哪都能找到）
#   4. 常见安装位置（桌面端默认在 %LOCALAPPDATA%\Programs\@deepseek-ai\dsh-desktop\）
#   5. 全盘兜底：%LOCALAPPDATA% / Program Files 下浅层搜一遍
# 找不到不算致命：bili 相关步骤会跳过，其余五处照删（见文件后面的 $biliAvailable）。
function Find-DshExe {
    param([string] $Hint)
    if ($Hint -and (Test-Path $Hint)) { return (Resolve-Path $Hint).Path }
    if ($env:DSH_HARNESS_EXE -and (Test-Path $env:DSH_HARNESS_EXE)) { return $env:DSH_HARNESS_EXE }

    $live = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
              Where-Object { $_.Path } | Select-Object -First 1)
    if ($live.Count -gt 0 -and (Test-Path $live[0].Path)) { return $live[0].Path }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\@deepseek-ai\dsh-desktop\DeepSeek Harness.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\dsh-desktop\DeepSeek Harness.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
        (Join-Path ${env:ProgramFiles} 'DeepSeek Harness\DeepSeek Harness.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness\DeepSeek Harness.exe')
    ) | Where-Object { $_ -and (Test-Path $_) }
    if ($candidates.Count -gt 0) { return (Resolve-Path $candidates[0]).Path }

    # 兜底：在 %LOCALAPPDATA%\Programs 下找三层以内（不同版本的安装布局不一样）
    $root = Join-Path $env:LOCALAPPDATA 'Programs'
    if (Test-Path $root) {
        $hit = @(Get-ChildItem -Path $root -Filter 'DeepSeek Harness.exe' -Recurse -Depth 3 -File -ErrorAction SilentlyContinue |
                 Select-Object -First 1)
        if ($hit.Count -gt 0) { return $hit[0].FullName }
    }
    return $null
}

if (-not $HarnessExe) { $HarnessExe = Find-DshExe }
if (-not $HarnessExe) { $HarnessExe = '' }

$WsJson    = Join-Path $DshHome 'storages\workspace.json'
$ProjCache = Join-Path $DshHome 'storages\session_projcache\sessions'
$LedgerPath = Join-Path $DshHome 'storages\cost-meter\ledger.json'
$LedgerDc  = Join-Path $DshHome 'storages\cost-meter\ledger.json.details-cache'
$LedgerUc  = Join-Path $DshHome 'storages\cost-meter\ledger.json.usage-cache'
$LedgerBc  = Join-Path $DshHome 'storages\cost-meter\ledger.json.billion-context'
$SessionsRoot = Join-Path $DshHome 'sessions'
$BiliDb    = Join-Path $BiliSessions 'index.db'

# bili CLI（billion-context 的 dist/index.js）不固定在 desktop profile 下：
# 用户可能装在别的 profile、或者根本没有装 billion-context。逐个位置探，探到为止。
function Find-BiliEntry {
    $cands = @()
    if ($env:DSH_PROFILE_DIR) { $cands += (Join-Path $env:DSH_PROFILE_DIR 'node_modules\billion-context\dist\index.js') }
    $cands += (Join-Path $DshHome 'profiles\desktop\node_modules\billion-context\dist\index.js')
    $profilesRoot = Join-Path $DshHome 'profiles'
    if (Test-Path $profilesRoot) {
        $cands += @(Get-ChildItem -Path $profilesRoot -Directory -ErrorAction SilentlyContinue |
                    ForEach-Object { Join-Path $_.FullName 'node_modules\billion-context\dist\index.js' })
    }
    $cands += (Join-Path $env:APPDATA 'npm\node_modules\billion-context\dist\index.js')
    foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
    return ''
}
$BiliEntry = Find-BiliEntry

# ---------------------------------------------------------------- 进程探测
# DSH 桌面端是多进程（1 主 + N 渲染/GPU/utility），全部同名 'DeepSeek Harness'。
# 判定"DSH 在跑"用主进程：MainWindowTitle 非空的那个；拿不到再退回进程数 > 0。

function Get-DshProcesses {
    @(Get-Process -Name $DshProcessName -ErrorAction SilentlyContinue)
}
function Test-DshRunning {
    $ps = Get-DshProcesses
    return ($ps.Count -gt 0)
}
function Get-DshMainProcess {
    $ps = Get-DshProcesses
    $withWin = @($ps | Where-Object { $_.MainWindowHandle -ne 0 })
    if ($withWin.Count -gt 0) { return $withWin[0] }
    return $null
}
function Get-DshExePath {
    param([string] $Fallback)
    $m = Get-DshMainProcess
    if ($m -and $m.Path) { return $m.Path }
    $any = @(Get-DshProcesses | Where-Object { $_.Path } | Select-Object -First 1)
    if ($any.Count -gt 0) { return $any[0].Path }
    return $Fallback
}

# 优雅退出：WM_CLOSE 在 DSH 上只会把主窗口隐藏进托盘（main.js:12943 close→preventDefault→hideMainWindow），
# 进程永不退出 —— 实测踩过。改发 WM_ENDSESSION(wParam=1)：Electron 触发 session-end 事件
# （main.js:12958 window.on("session-end")→sessionEnding=true），before-quit 直接 finishQuit 跳过确认框，
# 等价于系统注销/关机的优雅退出路径。仍走 before-quit 清理链（ledger/workspaces 正常落盘）。
function Send-DshCloseWindow {
    if (-not ('DshWin32' -as [type])) {
        Add-Type -Namespace '' -Name 'DshWin32' -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)]
public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")]
public static extern bool IsWindow(IntPtr hWnd);
'@ -ErrorAction Stop
    }
    $m = Get-DshMainProcess
    if (-not $m) { return $false }
    $WM_ENDSESSION = 0x0016
    return [DshWin32]::PostMessage($m.MainWindowHandle, $WM_ENDSESSION, [IntPtr]1, [IntPtr]::Zero)
}
# 注：$BiliEntry 的探测已经提前到上面 Find-BiliEntry，这里不再重复。

$script:Out = New-Object System.Collections.ArrayList

function Log {
    param([string] $Msg = '', [string] $Color = 'Gray')
    [void]$script:Out.Add($Msg)
    if (-not $Json) { Write-Host $Msg -ForegroundColor $Color }
}
function LogStep { param([string] $Title) Log '' ; Log "==== $Title ====" 'Cyan' }
function LogOk   { param([string] $Msg) Log "  [ok]   $Msg" 'Green' }
function LogSkip { param([string] $Msg) Log "  [skip] $Msg" 'DarkGray' }
function LogWarn { param([string] $Msg) Log "  [warn] $Msg" 'Yellow' }
function LogErr  { param([string] $Msg) Log "  [fail] $Msg" 'Red' }
function Die {
    param([string] $Msg)
    Log '' ; Log "中止：$Msg" 'Red'
    if ($Json) { [pscustomobject]@{ ok = $false; error = $Msg } | ConvertTo-Json -Depth 8 | Write-Output }
    exit 1
}

# ---------------------------------------------------------------- bili 调用
# 关键：不能用 & $exe ... 2>&1
#   - PS5.1 下 $ErrorActionPreference='Stop' + 子进程写 stderr => NativeCommandError 直接抛，脚本崩
#   - & 调用拿不到可靠 $LASTEXITCODE
# 因此统一 Start-Process + 重定向到临时文件，读文件取输出，PassThru 取退出码。

function Invoke-Bili {
    param([string[]] $BiliArgs)
    if (-not $HarnessExe -or -not (Test-Path $HarnessExe)) { return [pscustomobject]@{ Code = -1; Out = ''; Err = "找不到 DSH 可执行文件（用 -HarnessExe 指定）" } }
    if (-not $BiliEntry -or -not (Test-Path $BiliEntry))  { return [pscustomobject]@{ Code = -1; Out = ''; Err = '找不到 billion-context 入口（未安装？）' } }

    $tmpOut = [System.IO.Path]::GetTempFileName()
    $tmpErr = [System.IO.Path]::GetTempFileName()
    $savedNode = $env:ELECTRON_RUN_AS_NODE
    $env:ELECTRON_RUN_AS_NODE = '1'
    try {
        $quoted = @("`"$BiliEntry`"") + $BiliArgs
        $p = Start-Process -FilePath $HarnessExe -ArgumentList $quoted -NoNewWindow -Wait -PassThru `
                           -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
        $o = ''
        $e = ''
        try { $o = [System.IO.File]::ReadAllText($tmpOut, [System.Text.Encoding]::UTF8) } catch { }
        try { $e = [System.IO.File]::ReadAllText($tmpErr, [System.Text.Encoding]::UTF8) } catch { }
        return [pscustomobject]@{ Code = $p.ExitCode; Out = $o; Err = $e }
    }
    finally {
        $env:ELECTRON_RUN_AS_NODE = $savedNode
        Remove-Item $tmpOut, $tmpErr -Force -ErrorAction SilentlyContinue
    }
}

function Get-BiliSessions {
    $r = Invoke-Bili @('sessions', 'ls', '--json')
    if ($r.Code -ne 0) { return $null }
    try {
        $j = $r.Out | ConvertFrom-Json
        return @($j)
    } catch { return $null }
}

# ---------------------------------------------------------------- JSON 处理

# PS5.1 的 ConvertTo-Json 会把 2 空格缩进写成 4 空格 + 冒号后双空格 + 畸形对齐，
# 2067 字节的 workspace.json 会膨胀到 5564 字节，diff 全红。这里按原格式重写。
function ConvertTo-JsonExact {
    param($Value, [int] $Indent = 0)
    $pad  = ' ' * $Indent
    $pad2 = ' ' * ($Indent + 2)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { return $(if ($Value) { 'true' } else { 'false' }) }
    if ($Value -is [string]) {
        $s = $Value.Replace('\', '\\').Replace('"', '\"')
        $s = $s.Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
        $s = $s -replace '[\x00-\x1f]', { param($m) '\u{0:x4}' -f [int][char]$m.Value }
        return '"' + $s + '"'
    }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [int64]) { return $Value.ToString([System.Globalization.CultureInfo]::InvariantCulture) }
    if ($Value -is [double] -or $Value -is [single] -or $Value -is [decimal]) {
        return $Value.ToString('R', [System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [System.Management.Automation.PSCustomObject] -or $Value -is [System.Collections.IDictionary]) {
        $names = if ($Value -is [System.Collections.IDictionary]) { @($Value.Keys) } else { @($Value.PSObject.Properties | ForEach-Object { $_.Name }) }
        if ($names.Count -eq 0) { return '{}' }
        $parts = foreach ($n in $names) {
            # 不能用 $v = if (...) { $arr } else { $arr }：
            # PowerShell 会把 if 语句的输出当管道枚举，单元数组退化成标量、空数组退化成 $null，
            # 写出来就变成 "sessionIds": "xxx" / "archivedSessionIds": null。
            $v = $null
            if ($Value -is [System.Collections.IDictionary]) { $v = $Value[$n] } else { $v = $Value.$n }
            $pad2 + (ConvertTo-JsonExact $n 0) + ': ' + (ConvertTo-JsonExact $v ($Indent + 2))
        }
        return "{`n" + ($parts -join ",`n") + "`n" + $pad + '}'
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @($Value)
        if ($items.Count -eq 0) { return '[]' }
        $parts = foreach ($it in $items) { $pad2 + (ConvertTo-JsonExact $it ($Indent + 2)) }
        return "[`n" + ($parts -join ",`n") + "`n" + $pad + ']'
    }
    return ConvertTo-JsonExact ([string]$Value) 0
}

function Write-JsonFile {
    param([string] $Path, $Object)
    $text = ConvertTo-JsonExact $Object 0
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($Path, $text, $utf8)
    return $text
}

function Test-JsonTreeEqual {
    # 语义比较（忽略对象属性顺序），用于写完回读校验
    param($A, $B)
    if ($null -eq $A -and $null -eq $B) { return $true }
    if ($null -eq $A -or $null -eq $B) { return $false }
    $aArr = $A -is [System.Collections.IEnumerable] -and -not ($A -is [string])
    $bArr = $B -is [System.Collections.IEnumerable] -and -not ($B -is [string])
    if ($aArr -ne $bArr) { return $false }
    if ($aArr) {
        $la = @($A); $lb = @($B)
        if ($la.Count -ne $lb.Count) { return $false }
        for ($i = 0; $i -lt $la.Count; $i++) {
            if (-not (Test-JsonTreeEqual $la[$i] $lb[$i])) { return $false }
        }
        return $true
    }
    if ($A -is [System.Management.Automation.PSCustomObject] -and $B -is [System.Management.Automation.PSCustomObject]) {
        $na = @($A.PSObject.Properties | ForEach-Object { $_.Name }) | Sort-Object
        $nb = @($B.PSObject.Properties | ForEach-Object { $_.Name }) | Sort-Object
        if (($na -join '|') -ne ($nb -join '|')) { return $false }
        foreach ($n in $na) {
            if (-not (Test-JsonTreeEqual $A.$n $B.$n)) { return $false }
        }
        return $true
    }
    return ("$A" -eq "$B")
}

# ---------------------------------------------------------------- 枚举

function Expand-SessionIds {
    param([string[]] $Raw)
    $acc = New-Object System.Collections.ArrayList
    foreach ($r in $Raw) {
        foreach ($piece in ($r -split ',')) {
            $t = $piece.Trim()
            if ($t) { [void]$acc.Add($t) }
        }
    }
    return @($acc)
}

function Get-CurrentSessionId {
    if ($env:DSH_SESSION_ID) { return $env:DSH_SESSION_ID }
    return $null
}

function Read-Workspace {
    if (-not (Test-Path $WsJson)) { return $null }
    $raw = [System.IO.File]::ReadAllText($WsJson, [System.Text.Encoding]::UTF8)
    try {
        return ($raw | ConvertFrom-Json)
    } catch {
        Die "workspace.json 不是合法 JSON，拒绝继续（避免在坏文件上写回）：$WsJson`n原因：$($_.Exception.Message)`n建议：先备份该文件，再让 DSH 重新生成（启动一次后它会重建），或用 session-delete-backup-* 里的副本替换。"
    }
}

# ---------------------------------------------------------------- 桥接日志索引
# cost-meter 把每次模型调用落到 <ledger>.billion-context/<uuid>.jsonl，每行带
#   "sessionId":"session-..."（字段：callId/seq/model/usage/... 无消息正文）
# 实测 8027 个文件全部只含单一 sessionId，无多会话混写，因此整文件命中即可整删，
# 不做行级手术（重写 JSONL 有截断/并发追加风险）。
# 全量扫描 8027 文件约 0.8 秒，只做一次，结果按 sid 归组成索引。

$script:BridgeIndex = $null
function Get-BridgeIndex {
    if ($null -ne $script:BridgeIndex) { return $script:BridgeIndex }
    $idx = @{}
    if (Test-Path -LiteralPath $LedgerBc) {
        foreach ($f in [System.IO.Directory]::EnumerateFiles($LedgerBc, '*', 'AllDirectories')) {
            try { $c = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8) } catch { continue }
            foreach ($m in [regex]::Matches($c, '"sessionId":"(session-[0-9a-fA-F-]{36})"')) {
                $s = $m.Groups[1].Value
                if (-not $idx.ContainsKey($s)) { $idx[$s] = New-Object System.Collections.Generic.List[string] }
                if (-not $idx[$s].Contains($f)) { $idx[$s].Add($f) }
            }
        }
    }
    $script:BridgeIndex = $idx
    return $idx
}

function Get-BridgeFiles {
    param([string] $Sid)
    $idx = Get-BridgeIndex
    if ($idx.ContainsKey($Sid)) { return @($idx[$Sid]) }
    return @()
}

function Get-SessionRecord {
    param([string] $Sid, $Ws, $BiliList)

    $dirs = @()
    if (Test-Path $SessionsRoot) {
        foreach ($slug in (Get-ChildItem -LiteralPath $SessionsRoot -Directory)) {
            $cand = Join-Path $slug.FullName $Sid
            if (Test-Path -LiteralPath $cand) { $dirs += $cand }
        }
    }

    $diskBytes = 0
    $lastWrite = $null
    foreach ($d in $dirs) {
        $f = Join-Path $d 'session.v4.jsonl.zstd'
        if (Test-Path -LiteralPath $f) {
            $fi = Get-Item -LiteralPath $f
            if (-not $lastWrite -or $fi.LastWriteTime -gt $lastWrite) { $lastWrite = $fi.LastWriteTime }
        }
        # 整个目录计体积：日志之外还有 blobs/、attachments/ 等，只算主文件会低报
        $sum = (Get-ChildItem -LiteralPath $d -Recurse -File -Force -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum).Sum
        if ($sum) { $diskBytes += [int64]$sum }
    }

    $pc = Join-Path $ProjCache "$Sid.json"

    $biliRows = @()
    $biliBytes = 0
    if ($BiliList) {
        $biliRows = @($BiliList | Where-Object { $_.id -eq $Sid -or $_.id -like "$Sid|sub:*" })
        foreach ($r in $biliRows) { $biliBytes += [int64]$r.sizeBytes }
    }

    $wsTitle = $null
    $inRegistry = $false
    $inArchived = $false
    $inPinned = $false
    if ($Ws) {
        foreach ($p in $Ws.tables.workspaces.PSObject.Properties) {
            if (@($p.Value.sessionIds) -contains $Sid) { $wsTitle = $p.Value.title; $inRegistry = $true }
        }
        if (@($Ws.global.archivedSessionIds) -contains $Sid) { $inArchived = $true }
        if (@($Ws.global.pinnedSessionIds) -contains $Sid) { $inPinned = $true }
    }

    $ledgerHits = 0
    if (Test-Path $LedgerPath) {
        $lraw = [System.IO.File]::ReadAllText($LedgerPath, [System.Text.Encoding]::UTF8)
        $ledgerHits = ([regex]::Matches($lraw, [regex]::Escape($Sid))).Count
    }

    $bridgeFiles = @(Get-BridgeFiles $Sid)
    $bridgeBytes = 0
    foreach ($bf in $bridgeFiles) {
        try { $bridgeBytes += (Get-Item -LiteralPath $bf).Length } catch { }
    }

    [pscustomobject]@{
        Id           = $Sid
        Dirs         = $dirs
        DiskBytes    = $diskBytes
        LastWrite    = $lastWrite
        ProjCache    = $(if (Test-Path -LiteralPath $pc) { $pc } else { $null })
        WorkTitle    = $wsTitle
        InRegistry   = $inRegistry
        InArchived   = $inArchived
        InPinned     = $inPinned
        BiliRows     = $biliRows
        BiliBytes    = $biliBytes
        LedgerHits   = $ledgerHits
        BridgeFiles  = $bridgeFiles
        BridgeBytes  = [int64]$bridgeBytes
    }
}

function Format-Size {
    param([double] $Bytes)
    if ($Bytes -ge 1MB) { return ('{0:N2} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N1} KB' -f ($Bytes / 1KB)) }
    return ('{0} B' -f [int]$Bytes)
}

# ---------------------------------------------------------------- 还原

function Invoke-Restore {
    param([string] $BackupDir)
    if (-not (Test-Path -LiteralPath $BackupDir)) { Die "备份目录不存在：$BackupDir" }
    $man = Join-Path $BackupDir 'manifest.json'
    if (-not (Test-Path -LiteralPath $man)) { Die "备份缺 manifest.json：$BackupDir" }
    $m = [System.IO.File]::ReadAllText($man, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

    LogStep '还原'
    $ok = $true
    $restoredBridge = 0

    foreach ($d in @($m.sessionDirs)) {
        if (-not $d) { continue }
        $src = Join-Path $BackupDir $d.backupName
        $dst = $d.originalPath
        if (-not (Test-Path -LiteralPath $src)) { LogErr "备份里缺 $($d.backupName)"; $ok = $false; continue }
        $parent = Split-Path -Parent $dst
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
        Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
        LogOk "恢复目录 $dst"
    }

    foreach ($f in @($m.projCacheFiles)) {
        if (-not $f) { continue }
        $src = Join-Path $BackupDir $f.backupName
        $dst = $f.originalPath
        if (-not (Test-Path -LiteralPath $src)) { LogErr "备份里缺 $($f.backupName)"; $ok = $false; continue }
        Copy-Item -LiteralPath $src -Destination $dst -Force
        LogOk "恢复 $dst"
    }

    foreach ($f in @($m.cacheFiles)) {
        if (-not $f) { continue }
        $src = Join-Path $BackupDir $f.backupName
        $parent = Split-Path -Parent $f.originalPath
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        if (-not (Test-Path -LiteralPath $src)) { LogErr "备份里缺 $($f.backupName)"; $ok = $false; continue }
        Copy-Item -LiteralPath $src -Destination $f.originalPath -Force
        LogOk "恢复缓存 $($f.originalPath)"
    }

    foreach ($f in @($m.bridgeFiles)) {
        if (-not $f) { continue }
        $src = Join-Path $BackupDir $f.backupName
        $dst = $f.originalPath
        if (-not (Test-Path -LiteralPath $src)) { LogErr "备份里缺 $($f.backupName)"; $ok = $false; continue }
        $parent = Split-Path -Parent $dst
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Copy-Item -LiteralPath $src -Destination $dst -Force
        $restoredBridge++
    }
    if ($restoredBridge -gt 0) { LogOk "恢复桥接日志 $restoredBridge 个文件" }

    foreach ($f in @($m.singleFiles)) {
        if (-not $f) { continue }
        $src = Join-Path $BackupDir $f.backupName
        if (-not (Test-Path -LiteralPath $src)) { LogErr "备份里缺 $($f.backupName)"; $ok = $false; continue }
        $utf8 = New-Object System.Text.UTF8Encoding $false
        $bytes = [System.IO.File]::ReadAllBytes($src)
        [System.IO.File]::WriteAllBytes($f.originalPath, $bytes)
        LogOk "恢复 $($f.originalPath)"
    }

    Log ''
    if ($ok) { Log '还原完成。workspace.json / ledger.json 已按备份原样写回。' 'Green' }
    else { Log '还原过程中有失败项，见上面的 [fail]。' 'Red' }
    Log 'billion-context 的 index.db 不在备份范围（体积大且可用 bili sessions archive 复原），如需找回会话内容请用 DSH 的日志备份目录。' 'DarkGray'
    if (-not $ok) { exit 1 }
    exit 0
}

# ---------------------------------------------------------------- 入口

if ($Restore) { Invoke-Restore $Restore }

# 自检
if (-not (Test-Path $WsJson)) { Die "找不到 workspace.json：$WsJson" }
if (-not (Test-Path $SessionsRoot)) { Die "找不到 sessions 目录：$SessionsRoot" }

# $HarnessExe / $BiliEntry 探不到时是空串：Test-Path '' 会抛，所以先判空再判路径。
$hasHarness = ($HarnessExe -ne '') -and (Test-Path $HarnessExe)
$hasBiliEntry = ($BiliEntry -ne '') -and (Test-Path $BiliEntry)
if (-not $hasHarness) { LogWarn "找不到 DSH 可执行文件$(if($HarnessExe){"：$HarnessExe"}else{'（自动发现失败）'})，billion-context 相关步骤会跳过；可用 -HarnessExe 指定" }
if (-not $hasBiliEntry) { LogWarn "找不到 billion-context 入口$(if($BiliEntry){"：$BiliEntry"}else{'（未安装）'})，同上" }

$biliAvailable = $hasHarness -and $hasBiliEntry -and (Test-Path $BiliDb)
$biliList = $null
if ($biliAvailable) {
    $biliList = Get-BiliSessions
    if ($null -eq $biliList) { LogWarn 'bili sessions ls 失败，billion-context 相关步骤会跳过'; $biliAvailable = $false }
}

$ws = Read-Workspace
if ($null -eq $ws) { Die "workspace.json 解析失败：$WsJson" }

# ---------------------------------------------------------------- -List

if ($List) {
    Log '会话清单（六处存储覆盖情况）' 'Cyan'
    Log ''
    $allIds = New-Object System.Collections.Generic.List[string]
    foreach ($p in $ws.tables.workspaces.PSObject.Properties) {
        foreach ($s in @($p.Value.sessionIds)) { if (-not $allIds.Contains($s)) { $allIds.Add($s) } }
    }
    if ($biliList) {
        foreach ($r in $biliList) {
            $base = ($r.id -split '\|')[0]
            if (-not $allIds.Contains($base)) { $allIds.Add($base) }
        }
    }
    if (Test-Path $SessionsRoot) {
        foreach ($slug in (Get-ChildItem -LiteralPath $SessionsRoot -Directory)) {
            foreach ($d in (Get-ChildItem -LiteralPath $slug.FullName -Directory)) {
                if ($d.Name -like 'session-*' -and -not $allIds.Contains($d.Name)) { $allIds.Add($d.Name) }
            }
        }
    }

    $recs = @()
    foreach ($sid in $allIds) { $recs += Get-SessionRecord -Sid $sid -Ws $ws -BiliList $biliList }
    $curSid = Get-CurrentSessionId

    $rows = @()
    foreach ($r in $recs) {
        $rows += [pscustomobject]@{
            id       = $r.Id
            work     = $(if ($r.InRegistry) { $r.WorkTitle } else { '未注册' })
            disk     = Format-Size $r.DiskBytes
            projcache = $(if ($r.ProjCache) { '有' } else { '-' })
            bili     = $(if ($r.BiliRows.Count -gt 0) { Format-Size $r.BiliBytes } else { '-' })
            bridge   = $(if ($r.BridgeFiles.Count -gt 0) { Format-Size $r.BridgeBytes } else { '-' })
            flags    = (@(
                $(if ($r.InArchived) { '已归档' })
                $(if ($r.InPinned) { '已置顶' })
                $(if ($r.LedgerHits -gt 0) { "台账$($r.LedgerHits)" })
                $(if ($r.Id -eq $curSid) { '当前会话' })
            ) | Where-Object { $_ }) -join ' '
            last     = $(if ($r.LastWrite) { $r.LastWrite.ToString('MM-dd HH:mm') } else { '-' })
        }
    }

    if ($Json) {
        [pscustomobject]@{ ok = $true; sessions = $rows; totals = [pscustomobject]@{
            count = $rows.Count
            diskBytes   = ($recs | Measure-Object -Property DiskBytes -Sum).Sum
            biliBytes   = ($recs | Measure-Object -Property BiliBytes -Sum).Sum
            bridgeBytes = ($recs | Measure-Object -Property BridgeBytes -Sum).Sum
        } } | ConvertTo-Json -Depth 8
        exit 0
    }

    $fmt = '{0,-46} {1,-12} {2,10} {3,-9} {4,10} {5,10} {6,-18} {7}'
    Log ($fmt -f 'ID', '工作区', '磁盘', 'projcache', 'bili', '桥接', '标记', '最近活动')
    Log ('-' * 146) 'DarkGray'
    foreach ($r in $rows) {
        Log ($fmt -f $r.id, $r.work, $r.disk, $r.projcache, $r.bili, $r.bridge, $r.flags, $r.last)
    }
    Log ''
    $sum = ($recs | Measure-Object -Property DiskBytes -Sum).Sum
    $sumB = ($recs | Measure-Object -Property BridgeBytes -Sum).Sum
    Log ("会话数 {0}，DSH 日志合计 {1}，cost-meter 桥接日志合计 {2}" -f $rows.Count, (Format-Size $sum), (Format-Size $sumB)) 'Cyan'
    Log ''
    Log '删除某个会话：.\dsh-session-cleanup.ps1 -SessionId <ID>          （预演）' 'DarkGray'
    Log '             ：.\dsh-session-cleanup.ps1 -SessionId <ID> -Execute （真删，需先退 DSH）' 'DarkGray'
    Log '             ：.\dsh-session-cleanup.ps1 -SessionId <ID> -Execute -AutoRestart （全自动：自己退、删完自己起）' 'DarkGray'
    exit 0
}

# ---------------------------------------------------------------- 参数校验
# 先算 id 再做任何"派 helper / 等退出"的动作，避免白等一轮才发现 id 不合法。

$ids = Expand-SessionIds $SessionId
if ($ids.Count -eq 0) { Die '没有给出会话 id。用 -List 查看，或 -SessionId <ID>' }

foreach ($sid in $ids) {
    if ($sid -notmatch '^session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
        Die "不是合法的会话 id：$sid"
    }
}

# 当前会话不可删
$cur = Get-CurrentSessionId
if ($cur -and ($ids -contains $cur)) {
    Die "目标是当前正在运行的会话（$cur），换一个。"
}

# ---------------------------------------------------------------- AutoRestart 全流程
# 目标：一条命令搞定 "让 DSH 自己退 → 删 → 自己起来"。
#
# 为什么不能就地做（实测依据）：
#   - DSH 把 workspace.json 的状态放在内存里，退出时/变更时才落盘；
#     DSH 活着时改文件，下一次 setState 会把它覆盖回去。
#     实测（挂 45 秒）空闲期不重写，但任何一次归档/重命名/置顶就整份重写。
#   - index.db 是 SQLite WAL 模式，DSH 持有连接；bili storage gc 需要独占 VACUUM。
#
# 所以必须两段式：
#   阶段 A（现在，DSH 还活着）：校验目标、派一个 detached helper、返回
#   阶段 B（helper，DSH 已退出）：执行删除 → 验证 → 重启 DSH
#
# helper 用 Start-Process 派生，父进程退出后仍存活（已实测）。

if ($AutoRestart -and -not $HelperStage) {
    if (-not $Execute) { Die '-AutoRestart 必须和 -Execute 一起用（它真的会删）' }
    if (-not (Test-DshRunning)) { Die '没检测到运行中的 DSH。没有要自动重启的对象，去掉 -AutoRestart 直接跑即可。' }

    $main = Get-DshMainProcess
    $dshExe = Get-DshExePath $HarnessExe
    if (-not $dshExe) { Die '找不到 DSH 可执行文件路径，无法自动重启。用 -HarnessExe 指定。' }

    LogStep '自动重启模式'
    Log '  分两段：本进程先把 helper 派出去，然后 DSH 退出，helper 接手删除并重启。' 'Cyan'
    Log ''
    Log "  DSH 主进程 : $(if ($main) { "PID $($main.Id)  $($main.MainWindowTitle)" } else { '已定位不到主窗口' })" 
    Log "  重启命令   : $dshExe" 'DarkGray'
    Log "  等待上限   : $WaitTimeoutSec 秒" 'DarkGray'
    Log ''

    # helper 日志：和备份放一起，便于事后查
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    if (-not $HelperLog) { $HelperLog = Join-Path $DshHome "session-delete-helper-$stamp.log" }

    $argList = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
        '-SessionId', ($ids -join ','),
        '-Execute', '-HelperStage',
        '-DshHome', $DshHome,
        '-HelperLog', $HelperLog,
        '-WaitTimeoutSec', $WaitTimeoutSec,
        '-RestartExe', $dshExe,
        '-DshProcessName', $DshProcessName,
        '-QuitDelaySec', [string] $QuitDelaySec
    )
    if ($NoBackup)     { $argList += '-NoBackup' }
    if ($SkipBiliGc)   { $argList += '-SkipBiliGc' }
    if ($KeepLedger)   { $argList += '-KeepLedger' }
    if ($AllowRunningDsh) { $argList += '-AllowRunningDsh' }
    if ($BiliSessions -and $env:BILI_SESSIONS_DIR -ne $BiliSessions) { $argList += @('-BiliSessions', $BiliSessions) }
    if ($HarnessExe)   { $argList += @('-HarnessExe', $HarnessExe) }

    # 关键坑（实测三次才定位）：DSH 给工具进程套了 Job Object，DSH 一退出，派生出来的
    # helper 会被连坐杀掉 —— 连第一行日志都来不及写（powershell 冷启动 > 800ms）。
    # Start-Process / ProcessStartInfo / Win32_Process.Create 全部无效（WMI 那条还直接「拒绝访问」）。
    # 唯一稳的路：交给任务计划程序，父进程是 svchost，完全在 DSH 进程树和 Job 之外。
    $taskName = "DshSessionCleanupHelper-$stamp"
    $taskArgs = ($argList | ForEach-Object {
                    $s = [string] $_
                    if ($s -match '\s') { '"' + $s.Replace('"', '\"') + '"' } else { $s }
                }) -join ' '
    $taskArgs += " -HelperTaskName `"$taskName`""

    try {
        $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs
        $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddYears(1)
        $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                   -ExecutionTimeLimit (New-TimeSpan -Hours 2) -StartWhenAvailable
        Register-ScheduledTask -TaskName $taskName -Action $act -Trigger $trg -Settings $set -Force -ErrorAction Stop | Out-Null
        Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    } catch {
        LogErr "无法通过任务计划程序派发 helper：$($_.Exception.Message)"
        Log '     可改用：手动完全退出 DSH 后，再在普通终端里跑同一个 -Execute 命令。' 'Yellow'
        exit 1
    }
    LogOk "helper 已派出（计划任务 $taskName），它现在在等 DSH 退出"
    Log "     日志：$HelperLog" 'DarkGray'
    Log ''

    # 等 helper 落地写第一行日志，确认它真的活着（而不是被 Job 连坐）
    $swH = [System.Diagnostics.Stopwatch]::StartNew()
    while ($swH.Elapsed.TotalSeconds -lt 15) {
        if ((Test-Path -LiteralPath $HelperLog) -and ((Get-Item -LiteralPath $HelperLog).Length -gt 0)) { break }
        Start-Sleep -Milliseconds 300
    }
    if (-not (Test-Path -LiteralPath $HelperLog) -or (Get-Item -LiteralPath $HelperLog).Length -eq 0) {
        LogErr "helper 15 秒内没有写出日志，放弃（不碰任何文件）。计划任务名：$taskName"
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        exit 1
    }
    Log "     helper 已确认存活：$((Get-Content -LiteralPath $HelperLog -TotalCount 1))" 'DarkGray'

    # 关闭 DSH 这件事交给 helper 自己做（延后 QuitDelaySec 秒），前台派完就撤。
    # 原因：如果前台自己发退出消息，DSH 立刻死 → 前台脚本被杀 → 这条命令永远跑不完、
    # 也看不到任何输出。让 helper 延后动手，前台可以正常返回，你也能看到这整段说明。
    Log ''
    Log "  helper 会在 $QuitDelaySec 秒后自动关闭 DSH（你不用动手）" 'Yellow'
    Log '    DSH 关闭后 helper 删完会自动把 DSH 重新拉起来。' 'Yellow'
    Log ''
    Log "helper 在等：DSH 进程全部退出 → 删除 → 重启 → 写日志到 $HelperLog" 'DarkGray'

    # -Json 调用方（插件）需要在派发成功那一刻拿到结论与日志路径。
    # 这一段必须放在 exit 之前，而且只输出一行 JSON（Log 在 $Json 下不写 host）。
    if ($Json) {
        [pscustomobject]@{
            ok         = $true
            dispatched = $true
            helperTask = $taskName
            helperLog  = $HelperLog
            restartExe = $dshExe
            quitIn     = $QuitDelaySec
            sessions   = @($ids)
        } | ConvertTo-Json -Depth 8
    }
    exit 0
}

# ---- 以下是 helper 阶段（-HelperStage）----

function Write-HelperLog {
    param([string] $Msg)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Msg"
    if ($HelperLog) {
        try { Add-Content -LiteralPath $HelperLog -Value $line -Encoding UTF8 } catch { }
    }
}

# helper 起手第一件事：写一行"我活着"，让前台能确认派发成功
if ($HelperStage) {
    Write-HelperLog "helper 启动 pid=$PID"
    Log ''
    Log "==== 后台 helper（PID $PID）====" 'Cyan'

    # 由 helper 自己动手关 DSH：延后 QuitDelaySec 秒，给前台脚本留出正常返回的时间。
    # 前台若自己发退出消息，DSH 会立刻杀掉整棵进程树（含发起命令的工具进程），
    # 那条命令就永远拿不到结果 —— 实测踩过两次。
    if ($QuitDelaySec -gt 0) {
        Write-HelperLog "将在 $QuitDelaySec 秒后自动关闭 DSH"
        Start-Sleep -Seconds $QuitDelaySec
        $sent = Send-DshCloseWindow
        if ($sent) { Write-HelperLog '已发送退出请求（WM_ENDSESSION）' }
        else       { Write-HelperLog '拿不到主窗口句柄，未能代关，等待用户手动退出' }
    }

    Log "等待 DSH 完全退出（上限 $WaitTimeoutSec 秒）…" 'Cyan'

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastCount = -1
    while ($sw.Elapsed.TotalSeconds -lt $WaitTimeoutSec) {
        $ps = Get-DshProcesses
        $n = $ps.Count
        if ($n -ne $lastCount) {
            $msg = "DSH 进程数: $n"
            Write-HelperLog $msg
            Log "  $msg" 'DarkGray'
            $lastCount = $n
        }
        if ($n -eq 0) { break }
        Start-Sleep -Milliseconds 500
    }
    $sw.Stop()

    $still = Get-DshProcesses
    if ($still.Count -gt 0) {
        $msg = "等待 $([int]$sw.Elapsed.TotalSeconds) 秒后仍有 $($still.Count) 个 DSH 进程，放弃（不删，避免写回被覆盖）"
        Write-HelperLog $msg
        LogErr $msg
        Log '     DSH 可能卡在"确认退出"弹窗，或托盘没退。手动退干净后重跑即可。' 'Yellow'
        if ($HelperTaskName) {
            try { Unregister-ScheduledTask -TaskName $HelperTaskName -Confirm:$false -ErrorAction Stop } catch { }
        }
        exit 3
    }

    $msg = "DSH 已完全退出（等待 $([math]::Round($sw.Elapsed.TotalSeconds,1)) 秒），开始删除"
    Write-HelperLog $msg
    LogOk $msg
    Log ''
}

# DSH 运行中不许写盘：内存 state 会覆盖 workspace.json，SQLite 会锁库
$running = Get-DshProcesses
if ($Execute -and $running.Count -gt 0 -and -not $AllowRunningDsh) {
    $mainNow = Get-DshMainProcess
    Log ''
    Log "检测到 $($running.Count) 个 DeepSeek Harness 进程仍在运行$(if ($mainNow) { "（主进程 PID $($mainNow.Id)）" })。" 'Yellow'
    Log 'DSH 在跑时：workspace.json 会被内存状态覆盖，index.db 可能锁库，写回白做。' 'Yellow'
    Log ''
    Log '两种做法，任选：' 'Cyan'
    Log ''
    Log '  A) 让脚本全自动（推荐）：加 -AutoRestart，脚本会派后台 helper、' 'White'
    Log '     代你关窗，等 DSH 退干净后删完自动把 DSH 拉起来。' 'White'
    Log ''
    Log ("     powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -SessionId " + ($ids -join ',') + ' -Execute -AutoRestart') 'White'
    Log ''
    Log '  B) 手动：复制下面这条，完全退出 DSH（托盘也要退），再粘到 PowerShell 回车' 'White'
    Log ''
    Log ("     powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -SessionId " + ($ids -join ',') + ' -Execute') 'White'
    Log ''
    Log '（预演不需要退出 DSH，去掉 -Execute 即可）' 'DarkGray'
    exit 2
}

$plan = @()
foreach ($sid in $ids) {
    $plan += Get-SessionRecord -Sid $sid -Ws $ws -BiliList $biliList
}

# ---------------------------------------------------------------- 打印计划

LogStep '删除计划'
foreach ($p in $plan) {
    Log ("  $($p.Id)") 'White'
    Log ("     工作区   : " + $(if ($p.InRegistry) { $p.WorkTitle } else { '未注册（侧栏不可见）' }))
    if ($p.InArchived) { Log '     归档     : 是' 'DarkGray' }
    if ($p.InPinned)   { Log '     置顶     : 是' 'DarkGray' }
    Log ("     DSH 日志 : " + $(if ($p.Dirs.Count) { "$($p.Dirs.Count) 个目录, $(Format-Size $p.DiskBytes)" } else { '无' }))
    foreach ($d in $p.Dirs) { Log "                $d" 'DarkGray' }
    Log ("     projcache: " + $(if ($p.ProjCache) { '有' } else { '无' }))
    Log ("     bili     : " + $(if ($p.BiliRows.Count) { "$($p.BiliRows.Count) 行, $(Format-Size $p.BiliBytes)" + $(if ($p.BiliRows.Count -gt 1) { '（含子会话）' } else { '' }) } else { '无' }))
    Log ("     成本台账 : " + $(if ($p.LedgerHits) { "$($p.LedgerHits) 处引用" } else { '无' }))
    Log ("     桥接日志 : " + $(if ($p.BridgeFiles.Count) { "$($p.BridgeFiles.Count) 个文件, $(Format-Size $p.BridgeBytes)" } else { '无' }))
}

$totalDisk = ($plan | Measure-Object -Property DiskBytes -Sum).Sum
$totalBili = ($plan | Measure-Object -Property BiliBytes -Sum).Sum
$totalBridge = ($plan | Measure-Object -Property BridgeBytes -Sum).Sum
Log ''
Log ("合计：DSH 日志 $(Format-Size $totalDisk)，bili 索引 $(Format-Size $totalBili)，桥接日志 $(Format-Size $totalBridge)") 'Cyan'

if (-not $Execute) {
    if ($Json) {
        [pscustomobject]@{
            ok      = $true
            dryRun  = $true
            totals  = [pscustomobject]@{
                count       = $plan.Count
                diskBytes   = $totalDisk
                biliBytes   = $totalBili
                bridgeBytes = $totalBridge
            }
            sessions = @($plan | ForEach-Object {
                [pscustomobject]@{
                    id          = $_.Id
                    workspace   = $(if ($_.InRegistry) { $_.WorkTitle } else { $null })
                    archived    = [bool]$_.InArchived
                    pinned      = [bool]$_.InPinned
                    dirs        = @($_.Dirs)
                    diskBytes   = [long]$_.DiskBytes
                    projCache   = [bool]$_.ProjCache
                    biliRows    = $_.BiliRows.Count
                    biliBytes   = [long]$_.BiliBytes
                    ledgerHits  = $_.LedgerHits
                    bridgeFiles = $_.BridgeFiles.Count
                    bridgeBytes = [long]$_.BridgeBytes
                }
            })
        } | ConvertTo-Json -Depth 8
        exit 0
    }
    Log ''
    Log '这是预演，没有改动任何文件。确认后加 -Execute 真正执行。' 'Yellow'
    exit 0
}

# ---------------------------------------------------------------- 备份

$backupDir = $null
if (-not $NoBackup) {
    LogStep '备份'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupDir = Join-Path $DshHome "session-delete-backup-$stamp"
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

    $manifest = [ordered]@{
        createdAt   = (Get-Date).ToString('o')
        dshHome     = $DshHome
        sessionIds  = @($ids)
        sessionDirs = @()
        projCacheFiles = @()
        cacheFiles  = @()
        bridgeFiles = @()
        singleFiles = @()
    }

    $i = 0
    foreach ($p in $plan) {
        foreach ($d in $p.Dirs) {
            $i++
            $name = "dir-$i-$($p.Id)"
            Copy-Item -LiteralPath $d -Destination (Join-Path $backupDir $name) -Recurse -Force
            $manifest.sessionDirs += [ordered]@{ sessionId = $p.Id; originalPath = $d; backupName = $name }
        }
        if ($p.ProjCache) {
            $name = "$($p.Id).projcache.json"
            Copy-Item -LiteralPath $p.ProjCache -Destination (Join-Path $backupDir $name) -Force
            $manifest.projCacheFiles += [ordered]@{ sessionId = $p.Id; originalPath = $p.ProjCache; backupName = $name }
        }
    }

    # ledger 的 hash 缓存条目：内容含这些 sid 的会整条删掉，所以也要先备份
    $i = 0
    foreach ($dir in @($LedgerDc, $LedgerUc)) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        foreach ($f in (Get-ChildItem -LiteralPath $dir -File -Filter *.json -ErrorAction SilentlyContinue)) {
            try { $c = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8) } catch { continue }
            $hit = $false
            foreach ($sid in $ids) { if ($c.Contains($sid)) { $hit = $true; break } }
            if (-not $hit) { continue }
            $i++
            $name = "cache-$i-$(Split-Path -Leaf $dir)-$($f.Name)"
            Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $backupDir $name) -Force
            $manifest.cacheFiles += [ordered]@{ originalPath = $f.FullName; backupName = $name }
        }
    }

    # 桥接日志（cost-meter 的 per-call JSONL）会按会话整文件删除，同样要备份
    $i = 0
    $seenBridge = New-Object System.Collections.Generic.HashSet[string]
    foreach ($p in $plan) {
        foreach ($bf in $p.BridgeFiles) {
            if (-not $seenBridge.Add($bf)) { continue }
            $i++
            $name = "bridge-$i-$($p.Id.Substring(8,8))-$(Split-Path -Leaf $bf)"
            Copy-Item -LiteralPath $bf -Destination (Join-Path $backupDir $name) -Force
            $manifest.bridgeFiles += [ordered]@{ sessionId = $p.Id; originalPath = $bf; backupName = $name }
        }
    }

    foreach ($f in @($WsJson, $LedgerPath)) {
        if (Test-Path -LiteralPath $f) {
            $name = 'file-' + (Split-Path -Leaf $f)
            Copy-Item -LiteralPath $f -Destination (Join-Path $backupDir $name) -Force
            $manifest.singleFiles += [ordered]@{ originalPath = $f; backupName = $name }
        }
    }

    $mtxt = ConvertTo-JsonExact ([pscustomobject]$manifest)
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText((Join-Path $backupDir 'manifest.json'), $mtxt, $utf8)

    $bytes = (Get-ChildItem -LiteralPath $backupDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
    LogOk "备份 $(Format-Size $bytes) -> $backupDir"
    Log "     回滚：.\dsh-session-cleanup.ps1 -Restore `"$backupDir`"" 'DarkGray'
}

# ---------------------------------------------------------------- 执行

$result = [ordered]@{ biliOk = $true; diskOk = $true; cacheOk = $true; ledgerOk = $true; wsOk = $true; notes = @() }

# --- 4a. billion-context
LogStep 'billion-context'
if (-not $biliAvailable) {
    LogSkip 'billion-context 不可用，跳过（侧栏搜索仍可能命中已删会话）'
    $result.biliOk = $false
    $result.notes += 'bili-skipped'
} else {
    foreach ($p in $plan) {
        if ($p.BiliRows.Count -eq 0) { LogSkip "$($p.Id) 不在 billion-context 里"; continue }
        foreach ($row in $p.BiliRows) {
            $r = Invoke-Bili @('sessions', 'rm', $row.id)
            if ($r.Code -eq 0) { LogOk "rm $($row.id)" }
            elseif ($r.Code -eq 1 -and $r.Out -match 'no session found') { LogSkip "$($row.id) 已不存在" }
            else { LogErr "rm $($row.id) 退出码 $($r.Code)：$($r.Out.Trim()) $($r.Err.Trim())"; $result.biliOk = $false }
        }
    }
    if ($result.biliOk -and -not $SkipBiliGc) {
        Log '  VACUUM（清零引用内容并压缩 index.db，可能要一两分钟）…' 'DarkGray'
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $r = Invoke-Bili @('storage', 'gc', '--vacuum', 'full', '--days', '36500')
        $sw.Stop()
        if ($r.Code -eq 0) {
            foreach ($line in ($r.Out -split "`r?`n")) {
                if ($line.Trim()) { Log "    $($line.Trim())" 'DarkGray' }
            }
            LogOk "gc 完成，用时 $([int]$sw.Elapsed.TotalSeconds) 秒"
        } else {
            LogErr "storage gc 退出码 $($r.Code)：$($r.Err.Trim())"
            $result.biliOk = $false
        }
    }
}

# --- 4b. DSH 日志目录
LogStep 'DSH 日志目录'
foreach ($p in $plan) {
    if ($p.Dirs.Count -eq 0) { LogSkip "$($p.Id) 没有磁盘目录"; continue }
    foreach ($d in $p.Dirs) {
        try {
            $parent = Split-Path -Parent $d
            if ((Split-Path -Leaf $d) -ne $p.Id) { throw "路径末段不是会话 id：$d" }
            if ((Split-Path -Parent $parent) -ne $SessionsRoot) { throw "不在 sessions 根下：$d" }
            Remove-Item -LiteralPath $d -Recurse -Force
            LogOk "删除 $d"
        } catch {
            LogErr "删除失败 $d ：$($_.Exception.Message)"
            $result.diskOk = $false
        }
    }
}

# --- 4c. projcache
LogStep 'projcache'
foreach ($p in $plan) {
    if (-not $p.ProjCache) { LogSkip "$($p.Id) 无缓存文件"; continue }
    try {
        Remove-Item -LiteralPath $p.ProjCache -Force
        LogOk "删除 $($p.ProjCache)"
    } catch {
        LogErr "删除失败 $($p.ProjCache) ：$($_.Exception.Message)"
        $result.cacheOk = $false
    }
}

# --- 4d. 成本台账
LogStep '成本台账'
if ($KeepLedger) {
    LogSkip '按 -KeepLedger 要求保持原样'
} else {
    $ledger = $null
    if (Test-Path -LiteralPath $LedgerPath) {
        try { $ledger = [System.IO.File]::ReadAllText($LedgerPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
        catch { LogErr "ledger.json 解析失败：$($_.Exception.Message)"; $result.ledgerOk = $false }
    }
    if ($ledger) {
        $removed = 0
        if ($ledger.days) {
            foreach ($dp in $ledger.days.PSObject.Properties) {
                $day = $dp.Value
                if (-not ($day.PSObject.Properties.Name -contains 'sessions')) { continue }
                $before = @($day.sessions).Count
                $keep = @($day.sessions | Where-Object { $_ -and ($ids -notcontains $_.id) })
                if ($keep.Count -ne $before) {
                    $day.sessions = $keep
                    $removed += ($before - $keep.Count)
                }
            }
        }
        if ($removed -gt 0) {
            try {
                $txt = $ledger | ConvertTo-Json -Depth 40 -Compress
                $utf8 = New-Object System.Text.UTF8Encoding $false
                [System.IO.File]::WriteAllText($LedgerPath, $txt, $utf8)
                $chk = [System.IO.File]::ReadAllText($LedgerPath, [System.Text.Encoding]::UTF8)
                if ($ids | Where-Object { $chk.Contains($_) }) {
                    LogWarn "已移除 $removed 条会话明细，但文件里仍有 id 字符串（可能在历史缓存字段里）"
                } else {
                    LogOk "移除 $removed 条会话明细"
                }
                Log '       日聚合金额保留（钱确实花过），只清掉会话入口。' 'DarkGray'
            } catch {
                LogErr "写回 ledger.json 失败：$($_.Exception.Message)"; $result.ledgerOk = $false
            }
        } else {
            LogSkip '台账里没有这些会话的明细'
        }
    } elseif (-not (Test-Path -LiteralPath $LedgerPath)) {
        LogSkip '没有 ledger.json（未装 cost-meter）'
    }

    # hash 缓存：内容含该 sid 的条目直接删（只是缓存，删了会重建）
    foreach ($dir in @($LedgerDc, $LedgerUc)) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        $hit = 0
        foreach ($f in (Get-ChildItem -LiteralPath $dir -File -Filter *.json -ErrorAction SilentlyContinue)) {
            try {
                $c = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
                $match = $false
                foreach ($sid in $ids) { if ($c.Contains($sid)) { $match = $true; break } }
                if ($match) { Remove-Item -LiteralPath $f.FullName -Force; $hit++ }
            } catch { }
        }
        if ($hit -gt 0) { LogOk "清缓存 $(Split-Path -Leaf $dir) 下 $hit 个条目" }
    }

    # billion-context 桥接日志：cost-meter 把每次模型调用落到
    #   <ledger>.billion-context/<uuid>.jsonl，每行都带 "sessionId":"session-..."
    # 实测 8027 个文件全部只含单一 sessionId，无多会话混写，
    # 因此整文件命中即可安全删除；不做行级手术（重写 JSONL 有截断风险）。
    if (Test-Path -LiteralPath $LedgerBc) {
        $hitFiles = 0
        $hitBytes = 0
        $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
        foreach ($p in $plan) {
            foreach ($bf in $p.BridgeFiles) {
                try {
                    if (-not (Test-Path -LiteralPath $bf)) { continue }
                    $hitBytes += (Get-Item -LiteralPath $bf).Length
                    Remove-Item -LiteralPath $bf -Force
                    $hitFiles++
                } catch {
                    LogWarn "桥接日志删除失败 $bf ：$($_.Exception.Message)"
                    $result.ledgerOk = $false
                }
            }
        }
        $sw2.Stop()
        if ($hitFiles -gt 0) {
            LogOk "删除 billion-context 桥接日志 $hitFiles 个文件，释放 $(Format-Size $hitBytes)（用时 $([math]::Round($sw2.Elapsed.TotalSeconds,1)) 秒）"
        } else {
            LogSkip '桥接日志里没有这些会话'
        }
    }
}

# --- 4e. workspace.json（最后）
LogStep 'workspace.json'
try {
    $wsNow = Read-Workspace
    $touched = $false
    foreach ($p in $wsNow.tables.workspaces.PSObject.Properties) {
        $before = @($p.Value.sessionIds).Count
        $kept = @($p.Value.sessionIds | Where-Object { $ids -notcontains $_ })
        if ($kept.Count -ne $before) {
            $p.Value.sessionIds = $kept
            LogOk "$($p.Value.title)：$before -> $($kept.Count)"
            $touched = $true
        }
    }
    $g = $wsNow.global
    foreach ($field in @('archivedSessionIds', 'pinnedSessionIds')) {
        if ($g.PSObject.Properties.Name -notcontains $field) { continue }
        $before = @($g.$field).Count
        $kept = @($g.$field | Where-Object { $ids -notcontains $_ })
        if ($kept.Count -ne $before) {
            $g.$field = $kept
            LogOk "global.$field：$before -> $($kept.Count)"
            $touched = $true
        }
    }

    if (-not $touched) {
        LogSkip '这些会话本来就不在注册表里'
    } else {
        Write-JsonFile -Path $WsJson -Object $wsNow | Out-Null
        $chk = Read-Workspace
        if (Test-JsonTreeEqual $chk $wsNow) {
            LogOk "已写回 workspace.json（2 空格缩进、UTF-8 无 BOM、回读校验通过）"
        } else {
            LogErr '回读校验不一致，workspace.json 可能已损坏'
            $result.wsOk = $false
            if ($backupDir) { Log "     从备份还原：.\dsh-session-cleanup.ps1 -Restore `"$backupDir`"" 'Yellow' }
        }
    }
} catch {
    LogErr "改 workspace.json 失败：$($_.Exception.Message)"
    $result.wsOk = $false
}

# ---------------------------------------------------------------- 验证

LogStep '验证'
$biliAfter = if ($biliAvailable) { Get-BiliSessions } else { $null }
$allOk = $true
foreach ($p in $plan) {
    $problems = @()

    if ($p.Dirs.Count -gt 0) {
        foreach ($d in $p.Dirs) { if (Test-Path -LiteralPath $d) { $problems += "目录还在 $d" } }
    }
    if ($p.ProjCache -and (Test-Path -LiteralPath $p.ProjCache)) { $problems += 'projcache 还在' }

    if ($biliAfter) {
        $left = @($biliAfter | Where-Object { $_.id -eq $p.Id -or $_.id -like "$($p.Id)|sub:*" })
        if ($left.Count -gt 0) { $problems += "bili 还有 $($left.Count) 行" }
    }

    if (Test-Path -LiteralPath $WsJson) {
        $t = [System.IO.File]::ReadAllText($WsJson, [System.Text.Encoding]::UTF8)
        if ($t.Contains($p.Id)) { $problems += 'workspace.json 里仍有该 id' }
    }

    if (-not $KeepLedger) {
        if (Test-Path -LiteralPath $LedgerPath) {
            $lt = [System.IO.File]::ReadAllText($LedgerPath, [System.Text.Encoding]::UTF8)
            if ($lt.Contains($p.Id)) { $problems += 'ledger.json 里仍有该 id' }
        }
        foreach ($dir in @($LedgerDc, $LedgerUc)) {
            if (-not (Test-Path -LiteralPath $dir)) { continue }
            foreach ($f in (Get-ChildItem -LiteralPath $dir -File -Filter *.json -ErrorAction SilentlyContinue)) {
                try { $c = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8) } catch { continue }
                if ($c.Contains($p.Id)) { $problems += "缓存 $(Split-Path -Leaf $dir) 里仍有该 id"; break }
            }
        }
        # 桥接日志按实测重扫（不信任前面缓存的索引，删除后可能有新增）
        if (Test-Path -LiteralPath $LedgerBc) {
            $leftBridge = 0
            foreach ($f in [System.IO.Directory]::EnumerateFiles($LedgerBc, '*', 'AllDirectories')) {
                try { $c = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8) } catch { continue }
                if ($c.Contains($p.Id)) { $leftBridge++ }
            }
            if ($leftBridge -gt 0) { $problems += "桥接日志还有 $leftBridge 个文件" }
        }
    }

    if ($problems.Count -eq 0) { LogOk "$($p.Id) 全部存储均无残留" }
    else { LogErr ("$($p.Id)：" + ($problems -join '；')); $allOk = $false }
}

Log ''
if ($allOk) {
    Log '完成。启动 DSH 检查侧栏与搜索。' 'Green'
} else {
    Log '有残留项，见上面 [fail]。' 'Red'
    Log '若 DSH 当时未完全退出，退出后重跑同一条 -Execute 命令即可（脚本幂等，已删的会跳过）。' 'Yellow'
}

if ($Json) {
    $result.ok = $allOk
    $result.backupDir = $backupDir
    # @() 必须包住：单会话时 PowerShell 会把单元素管道降成标量，JSON 消费者拿到字符串而非数组
    $result.sessions = @($plan | ForEach-Object { $_.Id })
    [pscustomobject]$result | ConvertTo-Json -Depth 8
}

# ---------------------------------------------------------------- 自动重启收尾
# helper 阶段跑完删除后，把 DSH 拉起来。失败也要尽量拉起（用户的桌面入口不能停在半死状态）。
if ($HelperStage) {
    Write-HelperLog "删除阶段结束 allOk=$allOk"
    if ($RestartExe) {
        Start-Sleep -Milliseconds 500
        try {
            Start-Process -FilePath $RestartExe -WorkingDirectory (Split-Path -Parent $RestartExe) | Out-Null
            Write-HelperLog "已重启 DSH：$RestartExe"
            Log '' ; Log "已自动重启 DSH：$RestartExe" 'Green'
        } catch {
            Write-HelperLog "重启失败：$($_.Exception.Message)"
            LogErr "重启 DSH 失败：$($_.Exception.Message)"
            Log "     手动启动：$RestartExe" 'Yellow'
        }
    } else {
        Write-HelperLog '没有 RestartExe，未自动重启'
    }
    $logHint = if ($HelperLog) { "完整日志：$HelperLog" } else { '' }
    if ($logHint) { Log "     $logHint" 'DarkGray' }

    # 注销临时计划任务（一次性，跑完即弃；失败也不影响结果）
    if ($HelperTaskName) {
        try { Unregister-ScheduledTask -TaskName $HelperTaskName -Confirm:$false -ErrorAction Stop }
        catch { Write-HelperLog "注销计划任务失败（可手动删）：$HelperTaskName" }
    }
}

if (-not $allOk) { exit 1 }
exit 0
