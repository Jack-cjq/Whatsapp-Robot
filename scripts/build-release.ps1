# 隔离构建 Windows 安装包 / 便携包，不破坏开发区 Junction
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "== 环境 =="
node -v
npm -v
npx --yes electron --version
npx --yes electron-builder --version

Write-Host "== 语法检查 =="
node --check main.js
node --check bot.js
node --check lib/runtime-paths.js
node --check lib/migrate-legacy.js
node --check lib/json-capital-store.js
node --check lib/command-engine.js
node --check lib/runtime-core.js
node --check lib/message-ingress.js
node --check lib/whatsapp-bridge-health.js
node scripts/generate-icon.js

Write-Host "== 快速测试（开发区，跳过长基准以加速发布；完整测试请 npm test） =="
node test/migration.test.js
if ($LASTEXITCODE -ne 0) { throw "migration test failed: $LASTEXITCODE" }
node test/packaging-config.test.js
if ($LASTEXITCODE -ne 0) { throw "packaging-config test failed: $LASTEXITCODE" }
node test/packaging-styles.test.js
if ($LASTEXITCODE -ne 0) { throw "packaging-styles test failed: $LASTEXITCODE" }

Write-Host "== 准备发布依赖 =="
# 已有隔离依赖时复用 node_modules，仅刷新源码（含 styles.css）
$env:RELEASE_REUSE_DEPS = "1"
node scripts/prepare-release-deps.js
if ($LASTEXITCODE -ne 0) { throw "prepare-release-deps failed" }

$Stage = Join-Path $Root ".release-stage"
Set-Location $Stage

Write-Host "== 发布目录快速测试 =="
node test/migration.test.js
if ($LASTEXITCODE -ne 0) { throw "stage migration test failed: $LASTEXITCODE" }
node test/packaging-config.test.js
if ($LASTEXITCODE -ne 0) { throw "stage packaging-config test failed: $LASTEXITCODE" }
node test/packaging-styles.test.js
if ($LASTEXITCODE -ne 0) { throw "stage packaging-styles test failed: $LASTEXITCODE" }

Write-Host "== electron-builder =="
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npx electron-builder --win nsis portable --x64 --publish=never
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed: $LASTEXITCODE" }

$Out = Join-Path $Root "dist-release"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
# 同步 win-unpacked 便于 asar 验收
if (Test-Path (Join-Path $Stage "dist\win-unpacked")) {
    $wu = Join-Path $Out "win-unpacked"
    if (Test-Path $wu) { Remove-Item -Recurse -Force $wu }
    Copy-Item -Recurse -Force (Join-Path $Stage "dist\win-unpacked") $wu
}
Copy-Item -Force (Join-Path $Stage "dist\*") $Out -ErrorAction SilentlyContinue
Write-Host "== 产物已复制到 dist-release =="
Get-ChildItem $Out -File | Format-Table Name, Length, LastWriteTime

Set-Location $Root
Write-Host "== 打包后 asar 样式验收 =="
$env:CHECK_PACKAGED_ASAR = "1"
node test/packaging-styles.test.js
if ($LASTEXITCODE -ne 0) { throw "post-build packaging-styles failed: $LASTEXITCODE" }

Write-Host "DONE"
