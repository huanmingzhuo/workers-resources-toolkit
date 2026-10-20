<#
.SYNOPSIS
    把本目录打包成可安装的 .vsix（不依赖 Node.js / npm）。

.DESCRIPTION
    .vsix 就是一个 zip，三部分：
        extension.vsixmanifest     插件身份与资源清单
        [Content_Types].xml        OPC 内容类型表（VS Code 不读，严格 OPC 解析器才用）
        extension/…                插件的全部文件


.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\pack-vsix.ps1
    powershell -ExecutionPolicy Bypass -File tools\pack-vsix.ps1 -Output D:\pyrois.vsix
#>
[CmdletBinding()]
param(
    [string]$Output
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$root = Split-Path -Parent $scriptDir

# ---------------------------------------------------------------- 语法自检（src/ 下所有 .js）
function Find-CodeExe {
    $c = Get-Command code -ErrorAction SilentlyContinue
    if ($c) {
        # code.cmd 通常位于 <安装目录>\bin，Code.exe 在上一级；个别安装把两者放在同一层
        $binDir = Split-Path -Parent $c.Source
        foreach ($cand in @((Join-Path $binDir 'Code.exe'), (Join-Path (Split-Path -Parent $binDir) 'Code.exe'))) {
            if (Test-Path -LiteralPath $cand) { return $cand }
        }
    }
    foreach ($p in @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe", "$env:ProgramFiles\Microsoft VS Code\Code.exe")) {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    foreach ($rp in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        foreach ($item in Get-ItemProperty $rp -ErrorAction SilentlyContinue) {
            $dn = $item.PSObject.Properties['DisplayName']
            $loc = $item.PSObject.Properties['InstallLocation']
            if ($dn -and $loc -and ($dn.Value -like '*Visual Studio Code*')) {
                $exe = Join-Path $loc.Value 'Code.exe'
                if (Test-Path -LiteralPath $exe) { return $exe }
            }
        }
    }
    return $null
}

$codeExe = Find-CodeExe
if ($codeExe) {
    # 目录写进脚本内容而不是当命令行参数：中文路径经参数传递容易编码错乱
    $srcDir = (Join-Path $root 'src').Replace('\', '/')
    $checkJs = @"
const fs = require('fs'), vm = require('vm'), path = require('path');
let bad = 0;
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!p.endsWith('.js')) { continue; }
    try { new vm.Script(fs.readFileSync(p, 'utf8'), { filename: p }); }
    catch (err) { bad++; console.error('FAIL ' + p + ' :: ' + err.message); }
  }
}
walk("$srcDir");

/* ---- 键同步校验：各语言的键必须与默认语言一致 ---- */
const SRC = "$srcDir";
const DEFAULT_LOCALE = 'zh-CN';

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function flatKeys(obj, isStruct) {
  if (!obj || typeof obj !== 'object') { return []; }
  const out = [];
  for (const k of Object.keys(obj)) {
    if (k === '_note') { continue; }
    const v = obj[k];
    if (isStruct && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const m of Object.keys(v)) { if (m !== '_note') { out.push(k + '.' + m); } }
    } else {
      out.push(k);
    }
  }
  return out;
}

const baseDirs = [];
for (const mod of fs.readdirSync(path.join(SRC, 'features'))) {
  const d = path.join(SRC, 'features', mod, 'data', 'docs');
  if (fs.existsSync(d)) { baseDirs.push(d); }
}
const coreUi = path.join(SRC, 'core', 'ui');
if (fs.existsSync(coreUi)) { baseDirs.push(coreUi); }

for (const base of baseDirs) {
  const defDir = path.join(base, DEFAULT_LOCALE);
  if (!fs.existsSync(defDir)) { continue; }
  const names = fs.readdirSync(defDir).filter(f => f.endsWith('.json'));
  const locales = fs.readdirSync(base, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name);
  for (const loc of locales) {
    if (loc === DEFAULT_LOCALE) { continue; }
    for (const name of names) {
      const p = path.join(base, loc, name);
      if (!fs.existsSync(p)) {
        bad++;
        console.error('KEY  缺少文件 ' + p);
        continue;
      }
      const isStruct = name === 'structs.json';
      const want = flatKeys(readJsonSafe(path.join(defDir, name)), isStruct);
      const have = flatKeys(readJsonSafe(p), isStruct);
      const miss = want.filter(k => have.indexOf(k) < 0);
      if (miss.length) {
        bad++;
        console.error('KEY  ' + p + ' 缺 ' + miss.length + ' 个键：' + miss.slice(0, 5).join(', ') + (miss.length > 5 ? ' …' : ''));
      }
    }
  }
}

process.exit(bad ? 1 : 0);
"@
    $tmpJs = Join-Path $scriptDir 'wrsr-check-syntax.js'
    Set-Content -LiteralPath $tmpJs -Value $checkJs -Encoding UTF8
    $env:ELECTRON_RUN_AS_NODE = '1'
    try {
        # Code.exe 是 GUI 程序，直接用 & 调用不会等待退出、也不设 $LASTEXITCODE，
        # 会出现临时文件被删掉而 node 才开始加载的情况，所以走 Start-Process -Wait。
        $proc = Start-Process -FilePath $codeExe -ArgumentList @("`"$tmpJs`"") -NoNewWindow -Wait -PassThru
        if ($proc.ExitCode -ne 0) { throw '打包前自检没通过：看上方以 FAIL（语法错误）或 KEY（各语言键不同步）开头的行' }
    } finally {
        Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tmpJs -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host '未找到 VS Code（Code.exe），跳过语法自检' -ForegroundColor Yellow
}

# ---------------------------------------------------------------- 读 package.json
$pkgPath = Join-Path $root 'package.json'
if (-not (Test-Path -LiteralPath $pkgPath)) { throw "找不到 package.json：$pkgPath" }
$pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json

$name = $pkg.name
$version = $pkg.version
$publisher = $pkg.publisher

# manifest 里不能留 %key%，用 package.nls.json 换成实际文字。
$nlsTable = @{}
$nlsPath = Join-Path $root 'package.nls.json'
if (Test-Path -LiteralPath $nlsPath) {
    $nlsObj = Get-Content -LiteralPath $nlsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $nlsObj.PSObject.Properties) { $nlsTable[$p.Name] = [string]$p.Value }
}
function Resolve-Nls([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return $text }
    return [regex]::Replace($text, '%([A-Za-z0-9_.]+)%', {
            param($m)
            $k = $m.Groups[1].Value
            if ($script:nlsTable.ContainsKey($k)) { $script:nlsTable[$k] } else { $m.Value }
        })
}
function Escape-Xml([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return $text }
    return $text.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}

$displayName = Escape-Xml (Resolve-Nls $pkg.displayName)
$description = Escape-Xml (Resolve-Nls $pkg.description)

if (-not (Test-Path -LiteralPath (Join-Path $root 'images\icon.png'))) {
    Write-Warning 'images\icon.png 不存在，商店与本地安装都不会显示图标。'
}

if (-not $Output) { $Output = Join-Path $root ('{0}-{1}.vsix' -f $name, $version) }

# ---------------------------------------------------------------- 收集文件
# 排除列表要和 .vscodeignore 保持同步。
# 顶层和任意层要分开判断：裸的 'docs' 会误伤模块自带的人工说明数据。
$topOnlyDirs  = @('docs', 'notes', 'tools', 'examples', 'reference', '.vscode', '.vscode-test', '.github')
$anyDepthDirs = @('.git', '.tmp', 'node_modules', '.history')
$excludeNames = @('.gitignore', '.gitattributes', '.vscodeignore', 'CONTRIBUTING.md', '_模板.js',
    'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'jsconfig.json', 'tsconfig.json',
    '.DS_Store', 'Thumbs.db')
$excludeExt   = @('.vsix', '.map', '.log', '.code-workspace', '.ts')

$outFull = [System.IO.Path]::GetFullPath($Output)

$files = @()
foreach ($f in (Get-ChildItem -LiteralPath $root -Recurse -File -Force)) {
    if ($f.FullName -eq $outFull) { continue }
    $rel = $f.FullName.Substring($root.Length).TrimStart('\')
    $parts = @($rel -split '\\')
    $dirs = @()
    if ($parts.Count -gt 1) { $dirs = @($parts[0..($parts.Count - 2)]) }

    if ($dirs.Count -gt 0 -and $topOnlyDirs -contains $dirs[0]) { continue }
    $hit = $false
    foreach ($d in $dirs) { if ($anyDepthDirs -contains $d) { $hit = $true; break } }
    if ($hit) { continue }

    if ($excludeNames -contains $f.Name) { continue }
    if ($excludeExt -contains $f.Extension) { continue }
    $files += [pscustomobject]@{ Rel = $rel.Replace('\', '/'); Path = $f.FullName }
}
if ($files.Count -eq 0) { throw '没有收集到任何文件，检查一下目录结构。' }

# ---------------------------------------------------------------- 清单
# package.json 里的 repository / homepage / bugs 不会自动进 manifest，
# 市场页面右侧那几个链接读的就是 Links.Source / Learn / Support，缺了就不显示。
$linkProps = ''
$esc = { param($s) if ($s) { [System.Security.SecurityElement]::Escape([string]$s) } else { '' } }
if ($pkg.repository -and $pkg.repository.url) {
    $linkProps += "      <Property Id=`"Microsoft.VisualStudio.Services.Links.Source`" Value=`"$(& $esc $pkg.repository.url)`" />`n"
}
if ($pkg.homepage) {
    $linkProps += "      <Property Id=`"Microsoft.VisualStudio.Services.Links.Learn`" Value=`"$(& $esc $pkg.homepage)`" />`n"
}
if ($pkg.bugs -and $pkg.bugs.url) {
    $linkProps += "      <Property Id=`"Microsoft.VisualStudio.Services.Links.Support`" Value=`"$(& $esc $pkg.bugs.url)`" />`n"
}

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$name" Version="$version" Publisher="$publisher" />
    <DisplayName>$displayName</DisplayName>
    <Description xml:space="preserve">$description</Description>
    <Tags>pyrois,workers and resources,soviet republic,script,modding,scenario</Tags>
    <Categories>Programming Languages,Snippets</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($pkg.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace,web" />
${linkProps}    </Properties>
    <License>extension/LICENSE</License>
    <Icon>extension/images/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"@

# 包里出现的每种扩展名都要在这里有一行。
$contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="xml" ContentType="text/xml" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="png" ContentType="image/png" />
  <!-- LICENSE 没有扩展名，Default 按「.后缀」匹配不到它，必须用 Override 指名 -->
  <Override PartName="/extension/LICENSE" ContentType="text/plain" />
</Types>
'@

# ---------------------------------------------------------------- 写 zip
Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

if (Test-Path -LiteralPath $Output) { Remove-Item -LiteralPath $Output -Force }

$utf8 = New-Object System.Text.UTF8Encoding($false)

function Add-TextEntry($zip, [string]$entryName, [string]$text) {
    $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $stream = $entry.Open()
    $writer = New-Object System.IO.StreamWriter($stream, $utf8)
    $writer.Write($text)
    $writer.Flush()
    $writer.Dispose()
    $stream.Dispose()
}

function Add-FileEntry($zip, [string]$entryName, [string]$filePath) {
    $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $out = $entry.Open()
    $in = [System.IO.File]::OpenRead($filePath)
    try { $in.CopyTo($out) } finally { $in.Dispose(); $out.Dispose() }
}

$zip = [System.IO.Compression.ZipFile]::Open($Output, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Add-TextEntry $zip 'extension.vsixmanifest' $manifest
    Add-TextEntry $zip '[Content_Types].xml' $contentTypes
    foreach ($f in $files) {
        Add-FileEntry $zip ('extension/' + $f.Rel) $f.Path
    }
} finally {
    $zip.Dispose()
}

# ---------------------------------------------------------------- 自检与汇报
$verify = [System.IO.Compression.ZipFile]::OpenRead($Output)
try {
    $names = $verify.Entries | ForEach-Object { $_.FullName }
    foreach ($m in @('extension.vsixmanifest', '[Content_Types].xml', 'extension/package.json')) {
        if ($names -notcontains $m) { throw "打包结果缺少必需条目：$m" }
    }
    $entryCount = $names.Count
} finally {
    $verify.Dispose()
}

$size = (Get-Item -LiteralPath $Output).Length
Write-Host ''
Write-Host ("已生成：{0}" -f $Output) -ForegroundColor Green
Write-Host ("  标识      {0}.{1}  v{2}" -f $publisher, $name, $version)
Write-Host ("  条目      {0} 个" -f $entryCount)
Write-Host ("  大小      {0:N1} KB" -f ($size / 1KB))

