# Builds the o2steam installer: stages the files from ..\build into payload\o2steam.zip, then publishes one self-contained exe.
param([string] $Out = "")
$ErrorActionPreference = "Stop"
$Here = $PSScriptRoot
$Build = Join-Path (Split-Path -Parent $Here) "build"
if (-not $Out) { $Out = Join-Path $Here "out" }

$files = @{
    "lib/millennium.dll"                = "millennium.dll"
    "lib/millennium.hhx64.dll"          = "millennium.hhx64.dll"
    "lib/millennium.bootstrap64.dll"    = "millennium.bootstrap64.dll"
    "bin/millennium.crashhandler64.exe" = "millennium.crashhandler64.exe"
    "bin/millennium.luavm64.exe"        = "millennium.luavm64.exe"
    "root/wsock32.dll"                  = "millennium.bootstrap64.dll"
}
foreach ($f in $files.Values) { if (-not (Test-Path (Join-Path $Build $f))) { throw "Missing $f in $Build - build o2steam first (build-o2steam.bat)." } }

$stage = Join-Path $Here "payload-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
foreach ($entry in $files.GetEnumerator()) {
    $dest = Join-Path $stage $entry.Key
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item (Join-Path $Build $entry.Value) $dest
}
New-Item -ItemType Directory -Force -Path (Join-Path $Here "payload") | Out-Null
$zip = Join-Path $Here "payload\o2steam.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
Remove-Item $stage -Recurse -Force

dotnet publish (Join-Path $Here "o2steam-installer.csproj") -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $Out
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }
Get-ChildItem $Out -Filter *.exe | Select-Object Name, Length
