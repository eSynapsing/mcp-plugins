# Descifra la contrasena guardada por configure-windows.ps1. Lo llama
# scripts/start.mjs en cada arranque del conector.
#
# No usa ConvertTo-SecureString (modulo Microsoft.PowerShell.Security): ese
# modulo puede fallar a cargar, y si falla aqui el conector no arranca nunca,
# sin ningun aviso claro para quien lo usa. Dpapi.ps1 hace lo mismo por
# P/Invoke directo a crypt32.dll, sin pasar por ningun modulo de PowerShell.

param(
    [Parameter(Mandatory = $true)]
    [string]$PasswordFile
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Dpapi.ps1')

$encrypted = (Get-Content -LiteralPath $PasswordFile -Raw).Trim()
[Console]::Out.Write((Unprotect-Text $encrypted))
