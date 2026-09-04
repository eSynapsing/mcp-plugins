# Configurador local de eSynapsing Correu para clientes que no tienen almacen
# seguro propio (ChatGPT de escritorio, Codex y otros clientes MCP).
#
# Claude Desktop NO necesita esto: alli la configuracion se rellena en el
# formulario de la extension y la contrasena va al almacen del sistema.
#
# La contrasena se pide por teclado, no se muestra, y se guarda cifrada con
# DPAPI de Windows: solo este usuario de Windows puede descifrarla.

param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[^\s@]+@[^\s@]+\.[^\s@]+$')]
    [string]$EmailAddress,

    [string]$SenderName = '',

    [ValidateSet('auto', 'ionos-es', 'ionos-com', 'ionos-de', 'ovh', 'strato', 'hostinger', 'zoho-eu', 'zoho-com', 'gmail', 'cpanel', 'manual')]
    [string]$Provider = 'auto',

    [string]$SmtpHost = '',
    [ValidateRange(1, 65535)][int]$SmtpPort = 465,
    [string]$ImapHost = '',
    [ValidateRange(1, 65535)][int]$ImapPort = 993,

    [string]$AllowedRecipientDomains = '',
    [ValidateRange(1, 200)][int]$MaxRecipientsPerEmail = 10,
    [ValidateRange(1, 500)][int]$MaxEmailsPerDay = 20,
    [string]$AttachmentsDir = '',
    [ValidateRange(1, 100)][int]$MaxAttachmentMb = 20,
    [string]$SignatureHtml = '',

    # Lectura del buzon. Vacio = solo INBOX y Enviados. '*' = todas.
    [string]$ReadableFolders = '',
    [ValidateRange(500, 100000)][int]$MaxBodyChars = 8000,

    [switch]$DoNotSaveToSent
)

$ErrorActionPreference = 'Stop'
$stateDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.esynapsing-correu'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

$password = Read-Host 'Contraseña del buzón (no se mostrará)' -AsSecureString
if ($password.Length -eq 0) { throw 'La contraseña no puede estar vacía.' }

$account = [ordered]@{
    EMAIL_ADDRESS = $EmailAddress
    SENDER_NAME = if ($SenderName) { $SenderName } else { $EmailAddress }
    EMAIL_PROVIDER = $Provider
    SMTP_HOST = $SmtpHost
    SMTP_PORT = $SmtpPort
    IMAP_HOST = $ImapHost
    IMAP_PORT = $ImapPort
    SAVE_TO_SENT = (-not $DoNotSaveToSent.IsPresent)
    ALLOWED_RECIPIENT_DOMAINS = $AllowedRecipientDomains
    MAX_RECIPIENTS_PER_EMAIL = $MaxRecipientsPerEmail
    MAX_EMAILS_PER_DAY = $MaxEmailsPerDay
    ATTACHMENTS_DIR = $AttachmentsDir
    MAX_ATTACHMENT_MB = $MaxAttachmentMb
    SIGNATURE_HTML = $SignatureHtml
    READABLE_FOLDERS = $ReadableFolders
    MAX_BODY_CHARS = $MaxBodyChars
}

$accountPath = Join-Path $stateDir 'account.json'
$passwordPath = Join-Path $stateDir 'password.dpapi'
$account | ConvertTo-Json | Set-Content -LiteralPath $accountPath -Encoding UTF8
$password | ConvertFrom-SecureString | Set-Content -LiteralPath $passwordPath -Encoding ASCII

Write-Host ''
Write-Host 'Configuración guardada.' -ForegroundColor Green
Write-Host "Cuenta:            $EmailAddress"
Write-Host "Proveedor:         $Provider"
Write-Host "Límite diario:     $MaxEmailsPerDay correos"
if ($AllowedRecipientDomains) {
    Write-Host "Dominios permitidos: $AllowedRecipientDomains"
} else {
    Write-Host 'Dominios permitidos: TODOS' -ForegroundColor Yellow
    Write-Host '  Recomendado: vuelve a ejecutar con -AllowedRecipientDomains "tudominio.com"' -ForegroundColor Yellow
    Write-Host '  Es el freno que evita que un correo entrante consiga que se escriba a terceros.' -ForegroundColor Yellow
}
if ($ReadableFolders) {
    Write-Host "Carpetas legibles: $ReadableFolders"
} else {
    Write-Host 'Carpetas legibles: bandeja de entrada y Enviados'
}
Write-Host ''
Write-Host 'La contraseña está cifrada con Windows DPAPI: solo este usuario de Windows puede descifrarla.'
Write-Host 'Reinicia el cliente (ChatGPT de escritorio o Codex) y pide:'
Write-Host '  «Usa la herramienta verify_email_setup de eSynapsing Correu»'
