# Instalador de eSynapsing Correu para Codex y la app de escritorio de ChatGPT.
#
# Hace de una sola pasada lo que en Claude Desktop hace el doble clic:
#   1. Copia el conector a una carpeta estable.
#   2. Pide la cuenta y la contrasena (sin mostrarla) y la cifra con DPAPI.
#   3. Registra el servidor en ~/.codex/config.toml.
#
# Uso, desde la carpeta descomprimida:
#   .\scripts\instalar-codex.ps1 -EmailAddress info@tuempresa.com -AllowedRecipientDomains "tuempresa.com"

param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[^\s@]+@[^\s@]+\.[^\s@]+$')]
    [string]$EmailAddress,

    [string]$SenderName = '',
    [string]$AllowedRecipientDomains = '',
    [string]$AttachmentsDir = '',
    [string]$ReadableFolders = '',

    # Nombre con el que aparecera el servidor en Codex.
    [string]$ServerName = 'correo',

    # Donde queda instalado. Por defecto, fuera de Descargas, para que no se
    # borre sin querer.
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'eSynapsing\correu')
)

$ErrorActionPreference = 'Stop'
$sourceDir = Split-Path -Parent $PSScriptRoot

Write-Host ''
Write-Host 'eSynapsing Correu — instalador para Codex / ChatGPT de escritorio' -ForegroundColor Cyan
Write-Host ''

# ---------- 1. Comprobaciones previas ----------

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'No encuentro Node.js en el PATH. Instalalo desde https://nodejs.org y vuelve a ejecutar este script.'
}
Write-Host ("Node encontrado: " + (& node --version)) -ForegroundColor Green

if (-not (Test-Path (Join-Path $sourceDir 'server\index.js'))) {
    throw "No encuentro server\index.js en $sourceDir. Ejecuta el script desde la carpeta descomprimida del conector."
}
if (-not (Test-Path (Join-Path $sourceDir 'node_modules'))) {
    throw "Falta la carpeta node_modules en $sourceDir. Descomprime el paquete completo, no solo el codigo."
}

# ---------- 2. Copiar a una carpeta estable ----------

if ($sourceDir -ne $InstallDir) {
    Write-Host "Copiando a $InstallDir ..."
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Copy-Item -Path (Join-Path $sourceDir '*') -Destination $InstallDir -Recurse -Force
    Write-Host 'Copiado.' -ForegroundColor Green
} else {
    Write-Host "Ya estas en la carpeta de instalacion, no copio nada."
}

# ---------- 3. Cuenta y contrasena ----------

$configure = Join-Path $InstallDir 'scripts\configure-windows.ps1'
$configArgs = @{
    EmailAddress = $EmailAddress
    AllowedRecipientDomains = $AllowedRecipientDomains
}
if ($SenderName) { $configArgs['SenderName'] = $SenderName }
if ($AttachmentsDir) { $configArgs['AttachmentsDir'] = $AttachmentsDir }
if ($ReadableFolders) { $configArgs['ReadableFolders'] = $ReadableFolders }

Write-Host ''
& $configure @configArgs

# ---------- 4. Registrar en Codex ----------

$codexDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
$codexConfig = Join-Path $codexDir 'config.toml'
New-Item -ItemType Directory -Path $codexDir -Force | Out-Null

$launcher = Join-Path $InstallDir 'scripts\start.mjs'
# Comillas simples: en TOML las dobles interpretan la barra invertida como
# escape y destrozarian una ruta de Windows.
$block = @"
[mcp_servers.$ServerName]
command = "node"
args = ['$launcher']
startup_timeout_sec = 20
tool_timeout_sec = 90
"@

$existing = if (Test-Path $codexConfig) { Get-Content -LiteralPath $codexConfig -Raw } else { '' }

if ($existing -match "(?ms)^\[mcp_servers\.$([regex]::Escape($ServerName))\].*?(?=^\[|\z)") {
    # Ya estaba: sustituimos solo ese bloque y dejamos el resto intacto.
    $backup = "$codexConfig.bak"
    Set-Content -LiteralPath $backup -Value $existing -Encoding UTF8
    $updated = [regex]::Replace(
        $existing,
        "(?ms)^\[mcp_servers\.$([regex]::Escape($ServerName))\].*?(?=^\[|\z)",
        ($block + "`n`n")
    )
    Set-Content -LiteralPath $codexConfig -Value $updated -Encoding UTF8
    Write-Host ''
    Write-Host "Actualizado el servidor '$ServerName' en config.toml (copia previa en config.toml.bak)." -ForegroundColor Green
} else {
    $nuevo = if ($existing.Trim()) { $existing.TrimEnd() + "`n`n" + $block + "`n" } else { $block + "`n" }
    Set-Content -LiteralPath $codexConfig -Value $nuevo -Encoding UTF8
    Write-Host ''
    Write-Host "Registrado el servidor '$ServerName' en $codexConfig" -ForegroundColor Green
}

# ---------- 5. Comprobacion rapida ----------

Write-Host ''
Write-Host 'Comprobando que el conector arranca...'
$test = Start-Process -FilePath 'node' -ArgumentList @("`"$launcher`"") -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
if ($test.HasExited) {
    Write-Host "AVISO: el conector se ha cerrado solo (codigo $($test.ExitCode)). Revisa la configuracion." -ForegroundColor Yellow
} else {
    try { Stop-Process -Id $test.Id -Force -ErrorAction Stop } catch { }
    Write-Host 'El conector arranca correctamente.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'LISTO.' -ForegroundColor Cyan
Write-Host '1. Cierra Codex o la app de escritorio de ChatGPT por completo y vuelve a abrirla.'
Write-Host '2. Pide: «Usa la herramienta verify_email_setup de eSynapsing Correu».'
Write-Host ''
if (-not $AllowedRecipientDomains) {
    Write-Host 'RECOMENDADO: no has puesto dominios permitidos, asi que se podra escribir a' -ForegroundColor Yellow
    Write-Host 'cualquier direccion. Vuelve a ejecutar con -AllowedRecipientDomains "tudominio.com".' -ForegroundColor Yellow
}
