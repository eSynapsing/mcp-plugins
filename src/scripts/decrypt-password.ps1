param(
    [Parameter(Mandatory = $true)]
    [string]$PasswordFile
)

$ErrorActionPreference = 'Stop'
$encrypted = Get-Content -LiteralPath $PasswordFile -Raw
$secure = ConvertTo-SecureString $encrypted
$credential = New-Object System.Management.Automation.PSCredential('correo', $secure)
[Console]::Out.Write($credential.GetNetworkCredential().Password)
