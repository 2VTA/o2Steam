# Builds the update zip that o2steam's Updates page downloads: millennium-<version>-windows-x86_64.zip
#
# o2steam (src/engine/millennium_updater.cc) looks at the newest release of 2VTA/o2Steam, compares its tag
# with its own version (scripts/version) and, if newer, downloads the asset with exactly this name and
# unpacks it into the Steam folder. So the zip is laid out like the Steam folder:
#   wsock32.dll, millennium/lib/*.dll, millennium/bin/*.exe        (o2steam itself)
#   millennium/themes/<theme>/...                                  (o2 Retro Terminal)
#   millennium/plugins/<plugin>/plugin.json + .millennium/Dist/*   (o2steam plugins)
# Theme/plugin settings live in millennium/config, which is not touched.
#
# Release steps: bump scripts/version, build o2steam (build-o2steam.bat), run this, then create a GitHub
# release whose tag is the same version (e.g. v3.7.0) and attach the zip (and the installer).
param([string] $Out = "")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$Here = $PSScriptRoot
$Root = Split-Path -Parent $Here
$Build = Join-Path $Root "build"
$Extras = Join-Path $Root "o2-extras"
if (-not $Out) { $Out = Join-Path $Here "out" }

$version = (Get-Content (Join-Path $Root "scripts\version"))[1].Trim()
if ($version -notmatch '^v\d+\.\d+\.\d+') { throw "scripts/version line 2 should look like v3.7.0, got '$version'" }

# zip path (always with /) -> file on disk
$entries = [ordered]@{
    "wsock32.dll"                                = Join-Path $Build "millennium.bootstrap64.dll"
    "millennium/lib/millennium.dll"              = Join-Path $Build "millennium.dll"
    "millennium/lib/millennium.hhx64.dll"        = Join-Path $Build "millennium.hhx64.dll"
    "millennium/lib/millennium.bootstrap64.dll"  = Join-Path $Build "millennium.bootstrap64.dll"
    "millennium/bin/millennium.crashhandler64.exe" = Join-Path $Build "millennium.crashhandler64.exe"
    "millennium/bin/millennium.luavm64.exe"      = Join-Path $Build "millennium.luavm64.exe"
}
foreach ($file in $entries.Values) { if (-not (Test-Path $file)) { throw "Missing $file - build o2steam first (build-o2steam.bat)." } }

foreach ($theme in Get-ChildItem (Join-Path $Extras "themes") -Directory) {
    foreach ($file in Get-ChildItem $theme.FullName -Recurse -File -Force) {
        $rel = $file.FullName.Substring($theme.FullName.Length + 1).Replace('\', '/')
        $entries["millennium/themes/$($theme.Name)/$rel"] = $file.FullName
    }
}
foreach ($plugin in Get-ChildItem (Join-Path $Extras "plugins") -Directory) {
    $dist = Join-Path $plugin.FullName ".millennium\Dist"
    if (-not (Test-Path (Join-Path $dist "index.js"))) { throw "Plugin $($plugin.Name) is not built (.millennium\Dist\index.js missing)." }
    $entries["millennium/plugins/$($plugin.Name)/plugin.json"] = Join-Path $plugin.FullName "plugin.json"
    foreach ($file in Get-ChildItem $dist -File) {
        $entries["millennium/plugins/$($plugin.Name)/.millennium/Dist/$($file.Name)"] = $file.FullName
    }
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$zipPath = Join-Path $Out "millennium-$version-windows-x86_64.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($entry in $entries.GetEnumerator()) {
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $entry.Value, $entry.Key, [System.IO.Compression.CompressionLevel]::Optimal)
    }
} finally {
    $zip.Dispose()
}

$item = Get-Item $zipPath
"{0}  {1:N1} MB  {2} files" -f $item.Name, ($item.Length / 1MB), $entries.Count
