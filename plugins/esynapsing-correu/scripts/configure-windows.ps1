# Configurador de eSynapsing Correu para clientes que no tienen almacen seguro
# propio (Codex y la app de escritorio de ChatGPT).
#
# Claude Desktop NO necesita esto: alli la configuracion se rellena en el
# formulario de la extension y la contrasena va al almacen del sistema.
#
# Dos formas de usarlo:
#
#   1. Interactiva, que es lo normal. Sin parametros, pregunta los datos uno a
#      uno como un formulario:
#        .\configure-windows.ps1
#
#   2. Con parametros, para instalaciones desatendidas:
#        .\configure-windows.ps1 -EmailAddress info@empresa.com -AllowedRecipientDomains "empresa.com"
#
# La contrasena se pide siempre por teclado, nunca se muestra, y se guarda
# cifrada con DPAPI de Windows: solo este usuario de Windows puede descifrarla.

param(
    [ValidatePattern('^$|^[^\s@]+@[^\s@]+\.[^\s@]+$')]
    [string]$EmailAddress = '',

    [string]$SenderName = '',

    [ValidateSet('', 'auto', 'ionos-es', 'ionos-com', 'ionos-de', 'ovh', 'strato', 'hostinger', 'zoho-eu', 'zoho-com', 'gmail', 'cpanel', 'manual')]
    [string]$Provider = '',

    [string]$SmtpHost = '',
    [ValidateRange(0, 65535)][int]$SmtpPort = 0,
    [string]$ImapHost = '',
    [ValidateRange(0, 65535)][int]$ImapPort = 0,

    [string]$AllowedRecipientDomains = '',
    [ValidateRange(0, 200)][int]$MaxRecipientsPerEmail = 0,
    [ValidateRange(0, 500)][int]$MaxEmailsPerDay = 0,
    [string]$AttachmentsDir = '',
    [ValidateRange(0, 100)][int]$MaxAttachmentMb = 0,
    [string]$SignatureHtml = '',
    [string]$ReadableFolders = '',
    [ValidateRange(0, 100000)][int]$MaxBodyChars = 0,

    [switch]$DoNotSaveToSent
)

$ErrorActionPreference = 'Stop'

# Modo interactivo si no nos han dado el correo por parametro.
$interactivo = [string]::IsNullOrWhiteSpace($EmailAddress)

function Preguntar {
    param([string]$Texto, [string]$PorDefecto = '', [switch]$Obligatorio)
    while ($true) {
        $sufijo = if ($PorDefecto) { " [$PorDefecto]" } else { '' }
        $r = Read-Host ("  " + $Texto + $sufijo)
        if ([string]::IsNullOrWhiteSpace($r)) { $r = $PorDefecto }
        if ($Obligatorio -and [string]::IsNullOrWhiteSpace($r)) {
            Write-Host '  Este dato es obligatorio.' -ForegroundColor Yellow
            continue
        }
        return $r.Trim()
    }
}

function PreguntarSiNo {
    param([string]$Texto, [bool]$PorDefecto = $true)
    $sufijo = if ($PorDefecto) { '[S/n]' } else { '[s/N]' }
    $r = (Read-Host ("  " + $Texto + " " + $sufijo)).Trim().ToLower()
    if ($r -eq '') { return $PorDefecto }
    return ($r -eq 's' -or $r -eq 'si' -or $r -eq 'y' -or $r -eq 'yes')
}

if ($interactivo) {
    Write-Host ''
    Write-Host '  eSynapsing Correu - configuracion' -ForegroundColor Cyan
    Write-Host '  ---------------------------------'
    Write-Host '  Vamos a guardar los datos de tu buzon. La contrasena no se'
    Write-Host '  mostrara y quedara cifrada en este ordenador.'
    Write-Host ''

    while ($true) {
        $EmailAddress = Preguntar 'Tu direccion de correo' -Obligatorio
        if ($EmailAddress -match '^[^\s@]+@[^\s@]+\.[^\s@]+$') { break }
        Write-Host '  Eso no parece una direccion de correo valida.' -ForegroundColor Yellow
    }

    $dominio = $EmailAddress.Split('@')[-1]
    $SenderName = Preguntar 'Nombre que vera quien reciba tus correos' $EmailAddress

    Write-Host ''
    Write-Host '  Seguridad' -ForegroundColor Cyan
    Write-Host '  Conviene limitar a que dominios se puede escribir. Es lo que'
    Write-Host '  impide que un correo recibido consiga que se escriba a un tercero.'
    $AllowedRecipientDomains = Preguntar 'Dominios permitidos (separados por comas)' $dominio

    Write-Host ''
    if (PreguntarSiNo 'Quieres revisar las opciones avanzadas?' $false) {
        Write-Host ''
        Write-Host '  Avanzado' -ForegroundColor Cyan
        Write-Host '  Deja en blanco lo que quieras que se detecte solo.'
        $Provider = Preguntar 'Proveedor (auto, ionos-es, ovh, gmail, manual...)' 'auto'
        $SmtpHost = Preguntar 'Servidor SMTP (en blanco = detectar)' ''
        if ($SmtpHost) { $SmtpPort = [int](Preguntar 'Puerto SMTP' '465') }
        $ImapHost = Preguntar 'Servidor IMAP (en blanco = detectar)' ''
        if ($ImapHost) { $ImapPort = [int](Preguntar 'Puerto IMAP' '993') }
        $MaxRecipientsPerEmail = [int](Preguntar 'Maximo de destinatarios por correo' '10')
        $MaxEmailsPerDay = [int](Preguntar 'Maximo de correos al dia' '20')
        $AttachmentsDir = Preguntar 'Carpeta autorizada para adjuntos (en blanco = sin limite)' ''
        $ReadableFolders = Preguntar 'Carpetas legibles (en blanco = entrada y enviados)' ''
    }
    Write-Host ''
}

# Valores por defecto de lo que no se haya indicado.
if (-not $Provider) { $Provider = 'auto' }
if ($SmtpPort -eq 0) { $SmtpPort = 465 }
if ($ImapPort -eq 0) { $ImapPort = 993 }
if ($MaxRecipientsPerEmail -eq 0) { $MaxRecipientsPerEmail = 10 }
if ($MaxEmailsPerDay -eq 0) { $MaxEmailsPerDay = 20 }
if ($MaxAttachmentMb -eq 0) { $MaxAttachmentMb = 20 }
if ($MaxBodyChars -eq 0) { $MaxBodyChars = 8000 }
if (-not $SenderName) { $SenderName = $EmailAddress }

$stateDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.esynapsing-correu'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

$password = Read-Host '  Contrasena del buzon (no se mostrara)' -AsSecureString
if ($password.Length -eq 0) { throw 'La contrasena no puede estar vacia.' }

$account = [ordered]@{
    EMAIL_ADDRESS = $EmailAddress
    SENDER_NAME = $SenderName
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

$account | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir 'account.json') -Encoding UTF8
$password | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $stateDir 'password.dpapi') -Encoding ASCII

Write-Host ''
Write-Host '  Configuracion guardada.' -ForegroundColor Green
Write-Host ("  Cuenta:              " + $EmailAddress)
Write-Host ("  Remitente:           " + $SenderName)
Write-Host ("  Limite diario:       " + $MaxEmailsPerDay + " correos")
if ($AllowedRecipientDomains) {
    Write-Host ("  Dominios permitidos: " + $AllowedRecipientDomains)
} else {
    Write-Host '  Dominios permitidos: TODOS' -ForegroundColor Yellow
    Write-Host '    Sin esta lista se puede escribir a cualquier direccion.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '  La contrasena esta cifrada con Windows DPAPI: solo este usuario de'
Write-Host '  Windows puede descifrarla. No queda en ningun archivo de texto.'
Write-Host ''
Write-Host '  SIGUIENTE PASO:' -ForegroundColor Cyan
Write-Host '  1. Cierra Codex o ChatGPT de escritorio del todo y vuelve a abrirlo.'
Write-Host '  2. Escribe: "Comprueba si mi cuenta de correo esta bien configurada".'
Write-Host ''

if ($interactivo) {
    Write-Host '  Pulsa Intro para cerrar.'
    [void](Read-Host)
}
