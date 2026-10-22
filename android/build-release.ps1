param(
    [string]$Gradle = 'gradle',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'out'),
    [string[]]$GradleOptions = @()
)
$ErrorActionPreference = 'Stop'
foreach ($name in @('ANDROID_KEYSTORE_FILE', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD')) {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "缺少签名环境变量 $name" }
}
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
$tools = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $tools) { throw '未找到 Android build-tools' }
Push-Location $PSScriptRoot
try {
    & $Gradle --no-daemon @GradleOptions testDebugUnitTest assembleRelease
    if ($LASTEXITCODE -ne 0) { throw 'Android 测试或构建失败' }
    $apk = Join-Path $PSScriptRoot 'app/build/outputs/apk/release/app-release.apk'
    & (Join-Path $tools.FullName 'apksigner.bat') verify --verbose --print-certs $apk
    if ($LASTEXITCODE -ne 0) { throw 'APK 签名验证失败' }
    $badging = & (Join-Path $tools.FullName 'aapt2.exe') dump badging $apk
    if ($LASTEXITCODE -ne 0) { throw '无法读取 APK 包名' }
    $config = Get-Content (Join-Path $PSScriptRoot 'app/build.gradle.kts') -Raw
    $version = [regex]::Match($config, 'versionName = "([^"]+)"').Groups[1].Value
    $code = [int][regex]::Match($config, 'versionCode = (\d+)').Groups[1].Value
    $package = $badging | Where-Object { $_ -match '^package:' } | Select-Object -First 1
    if ($package -notmatch "name='cn.ayase.chisabot'" -or $package -notmatch "versionCode='$code'" -or $package -notmatch "versionName='$([regex]::Escape($version))'") {
        throw "APK 包名或版本不正确：$package"
    }
    New-Item $OutputDirectory -ItemType Directory -Force | Out-Null
    $name = "ChisaBot-Android-$version-cn.ayase.chisabot.apk"
    $dest = Join-Path $OutputDirectory $name
    Copy-Item -LiteralPath $apk -Destination $dest
    $sha = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant()
    "$sha  $name" | Set-Content (Join-Path $OutputDirectory "$name.sha256") -Encoding utf8
    [ordered]@{ version = $version; versionCode = $code; packageName = 'cn.ayase.chisabot'; url = $name; sha256 = $sha; notes = '安卓原生模型选择、搜索与刷新；签名安装包。' } |
        ConvertTo-Json | Set-Content (Join-Path $OutputDirectory 'latest.json') -Encoding utf8NoBOM
    Write-Output "已验证签名、包名和版本：$dest"
} finally { Pop-Location }
