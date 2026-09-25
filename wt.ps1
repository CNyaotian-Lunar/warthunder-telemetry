#Requires -Version 5.1
<#
  wt.ps1 —— War Thunder 遥测一键：采集 + 报告
  用法:
    .\wt.ps1                          # 采集一局（默认名），结束后自动出报告
    .\wt.ps1 -Me "你的游戏昵称"       # 带玩家昵称
    .\wt.ps1 -MaxMin 30               # 硬上限 30 分钟
    .\wt.ps1 -ReportOnly              # 只对最新的 run 目录出报告
    .\wt.ps1 -ReportOnly -Dir .\runs\run-20260921-141235
#>
param(
  [string]$Me = "",
  [int]$MaxMin = 180,
  [switch]$ReportOnly,
  [string]$Dir = ""
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-LatestRun {
  $runs = Get-ChildItem -Path (Join-Path $here "runs") -Directory -ErrorAction SilentlyContinue | Sort-Object Name
  if (-not $runs) { throw "runs\ 下没有采集目录" }
  return $runs[-1].FullName
}

if ($ReportOnly) {
  if (-not $Dir) { $Dir = Get-LatestRun }
  $nodeArgs = @((Join-Path $here "wt-report.mjs"), $Dir)
  if ($Me) { $nodeArgs += @("--me", $Me) }
  & node @nodeArgs
  return
}

$out = Join-Path $here ("runs\run-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$nodeArgs = @((Join-Path $here "wt-collect.mjs"), "--out", $out, "--max-min", $MaxMin)
if ($Me) { $nodeArgs += @("--me", $Me) }
Write-Host "开始采集 → $out" -ForegroundColor Cyan
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { Write-Host "采集器退出码 $LASTEXITCODE，跳过报告" -ForegroundColor Yellow; return }

$rargs = @((Join-Path $here "wt-report.mjs"), $out)
if ($Me) { $rargs += @("--me", $Me) }
& node @rargs

# 顺手出缠斗热区图 + 航迹还原
& node (Join-Path $here "wt-heatmap.mjs") $out
& node (Join-Path $here "wt-track.mjs") $out

