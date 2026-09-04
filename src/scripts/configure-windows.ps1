# Configurador de eSynapsing Correu para clientes que no tienen almacen seguro
# propio (Codex y la app de escritorio de ChatGPT).
#
# Claude Desktop NO necesita esto: alli la configuracion se rellena en el
# formulario de la extension y la contrasena va al almacen del sistema.
#
# Se puede ejecutar tantas veces como haga falta, en cualquier momento: si ya
# hay una configuracion guardada, muestra un menu para editar solo lo que se
# quiera cambiar (correo y contrasena / servidor SMTP / servidor IMAP) sin
# tener que repetir el resto. Si no hay nada guardado, hace las mismas tres
# preguntas una detras de otra.
#
# La contrasena se pide siempre por teclado, nunca se muestra, y se guarda
# cifrada en este ordenador con DPAPI de Windows (ver Dpapi.ps1: usa
# crypt32.dll directamente, no el modulo Microsoft.PowerShell.Security, que en
# algunos equipos no carga).
#
# Con parametros, para instalaciones desatendidas de los campos avanzados:
#   .\configure-windows.ps1 -EmailAddress info@empresa.com -AllowedRecipientDomains "empresa.com"
# La contrasena sigue pidiendose por teclado incluso asi: nunca se acepta como
# parametro, para que no quede en el historial de comandos ni en ningun script.

param(
    [ValidatePattern('^$|^[^\s@]+@[^\s@]+\.[^\s@]+$')]
    [string]$EmailAddress = '',

    [string]$SenderName = '',
    [string]$Provider = '',
    [string]$SmtpHost = '',
    [int]$SmtpPort = 0,
    [string]$ImapHost = '',
    [int]$ImapPort = 0,

    [string]$AllowedRecipientDomains = '',
    [int]$MaxRecipientsPerEmail = 0,
    [int]$MaxEmailsPerDay = 0,
    [string]$AttachmentsDir = '',
    [int]$MaxAttachmentMb = 0,
    [string]$SignatureHtml = '',
    [string]$ReadableFolders = '',
    [int]$MaxBodyChars = 0,
    [switch]$DoNotSaveToSent
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Dpapi.ps1')

$stateDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.esynapsing-correu'
$accountFile = Join-Path $stateDir 'account.json'
$passwordFile = Join-Path $stateDir 'password.dpapi'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

# ---------- utilidades de pantalla ----------

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

function Titulo {
    param([string]$Texto)
    Write-Host ''
    Write-Host ("  " + $Texto) -ForegroundColor Cyan
    Write-Host ('  ' + ('-' * $Texto.Length))
}

# ---------- estado: cargar lo que ya hubiera guardado ----------

$cuenta = [ordered]@{
    EMAIL_ADDRESS = ''
    SENDER_NAME = ''
    EMAIL_PROVIDER = 'auto'
    SMTP_HOST = ''
    SMTP_PORT = 465
    IMAP_HOST = ''
    IMAP_PORT = 993
    SAVE_TO_SENT = $true
    ALLOWED_RECIPIENT_DOMAINS = ''
    MAX_RECIPIENTS_PER_EMAIL = 10
    MAX_EMAILS_PER_DAY = 20
    ATTACHMENTS_DIR = ''
    MAX_ATTACHMENT_MB = 20
    SIGNATURE_HTML = ''
    READABLE_FOLDERS = ''
    MAX_BODY_CHARS = 8000
}
$existia = $false
if (Test-Path $accountFile) {
    try {
        $guardado = Get-Content -LiteralPath $accountFile -Raw | ConvertFrom-Json
        foreach ($clave in @($cuenta.Keys)) {
            if ($null -ne $guardado.$clave) { $cuenta[$clave] = $guardado.$clave }
        }
        $existia = $true
    } catch {
        Write-Host '  Aviso: no se pudo leer la configuracion anterior, se parte de cero.' -ForegroundColor Yellow
    }
}
$habiaContrasena = Test-Path $passwordFile

# En una tabla hash, no en una variable suelta: una tabla hash es un tipo por
# referencia en PowerShell, asi que las funciones de abajo pueden modificarla
# sin depender de $script:, que con dot-sourcing no siempre apunta a la misma
# variable que el nivel superior del script (se detecto probando el script:
# la funcion decia "contrasena actualizada" pero Guardar no la escribia).
$estado = @{ NuevaContrasenaB64 = $null }   # $null = no tocar la contrasena guardada

# ---------- secciones ----------

function Editar-CorreoYContrasena {
    Titulo 'Correo y contrasena'
    while ($true) {
        $e = Preguntar 'Direccion de correo' $cuenta['EMAIL_ADDRESS'] -Obligatorio
        if ($e -match '^[^\s@]+@[^\s@]+\.[^\s@]+$') { $cuenta['EMAIL_ADDRESS'] = $e; break }
        Write-Host '  Eso no parece una direccion de correo valida.' -ForegroundColor Yellow
    }
    if (-not $cuenta['SENDER_NAME']) { $cuenta['SENDER_NAME'] = $cuenta['EMAIL_ADDRESS'] }

    $cambiar = if ($habiaContrasena) { PreguntarSiNo 'Cambiar la contrasena guardada?' $false } else { $true }
    if ($cambiar) {
        $secure = Read-Host '  Contrasena del buzon (no se mostrara)' -AsSecureString
        $plain = ConvertFrom-SecureStringPlain $secure
        if ([string]::IsNullOrEmpty($plain)) {
            Write-Host '  La contrasena no puede estar vacia. No se ha cambiado.' -ForegroundColor Yellow
        } else {
            $estado.NuevaContrasenaB64 = Protect-Text $plain
            Write-Host '  Contrasena actualizada (se guardara al confirmar).' -ForegroundColor Green
        }
        $plain = $null
    }
}

function Editar-Servidor {
    param([string]$Etiqueta, [string]$ClaveHost, [string]$ClavePuerto, [int]$PuertoPorDefecto)
    Titulo $Etiqueta
    $actual = if ($cuenta[$ClaveHost]) { $cuenta[$ClaveHost] + ':' + $cuenta[$ClavePuerto] } else { 'automatico (se detecta al verificar)' }
    Write-Host ('  Ahora mismo: ' + $actual)
    Write-Host ''
    Write-Host '  1) Detectar automaticamente (recomendado)'
    Write-Host '  2) Especificar servidor y puerto a mano'
    Write-Host '  0) Volver sin cambiar'
    $op = Preguntar 'Elige una opcion' '0'
    switch ($op) {
        '1' {
            $cuenta[$ClaveHost] = ''
            $cuenta[$ClavePuerto] = $PuertoPorDefecto
            Write-Host '  Se detectara automaticamente.' -ForegroundColor Green
        }
        '2' {
            $h = Preguntar 'Servidor' $cuenta[$ClaveHost] -Obligatorio
            $puertoActual = $cuenta[$ClavePuerto]
            if (-not $puertoActual) { $puertoActual = $PuertoPorDefecto }
            $p = Preguntar 'Puerto' $puertoActual
            $cuenta[$ClaveHost] = $h
            $cuenta[$ClavePuerto] = [int]$p
            Write-Host '  Guardado.' -ForegroundColor Green
        }
        default { Write-Host '  Sin cambios.' }
    }
}

function Guardar {
    if (-not $cuenta['EMAIL_ADDRESS']) { throw 'Falta la direccion de correo. Ve a la opcion 1 antes de guardar.' }
    if (-not $habiaContrasena -and -not $estado.NuevaContrasenaB64) { throw 'Falta la contrasena. Ve a la opcion 1 antes de guardar.' }

    $cuenta | ConvertTo-Json | Set-Content -LiteralPath $accountFile -Encoding UTF8
    if ($estado.NuevaContrasenaB64) {
        Set-Content -LiteralPath $passwordFile -Value $estado.NuevaContrasenaB64 -Encoding ASCII
    }

    Write-Host ''
    Write-Host '  Configuracion guardada.' -ForegroundColor Green
    Write-Host ('  Cuenta: ' + $cuenta['EMAIL_ADDRESS'])
    Write-Host ('  SMTP:   ' + $(if ($cuenta['SMTP_HOST']) { $cuenta['SMTP_HOST'] + ':' + $cuenta['SMTP_PORT'] } else { 'automatico' }))
    Write-Host ('  IMAP:   ' + $(if ($cuenta['IMAP_HOST']) { $cuenta['IMAP_HOST'] + ':' + $cuenta['IMAP_PORT'] } else { 'automatico' }))
    if (-not $cuenta['ALLOWED_RECIPIENT_DOMAINS']) {
        Write-Host ''
        Write-Host '  Nota: no hay ninguna restriccion de dominios de destinatarios, asi' -ForegroundColor Yellow
        Write-Host '  que se podra escribir a cualquier direccion. Para limitarlo, vuelve a' -ForegroundColor Yellow
        Write-Host '  ejecutar este configurador con -AllowedRecipientDomains "tudominio.com".' -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host '  La contrasena esta cifrada con Windows DPAPI: solo este usuario de'
    Write-Host '  Windows puede descifrarla. No queda en ningun archivo de texto.'
    Write-Host ''
    Write-Host '  SIGUIENTE PASO:' -ForegroundColor Cyan
    Write-Host '  1. Cierra Codex o ChatGPT de escritorio del todo y vuelve a abrirlo.'
    Write-Host '  2. Escribe: "Comprueba si mi cuenta de correo esta bien configurada".'
    Write-Host ''
}

# ---------- modo con parametros (instalacion desatendida de campos avanzados) ----------

$modoParametros = $PSBoundParameters.ContainsKey('EmailAddress') -or $PSBoundParameters.ContainsKey('SmtpHost') -or $PSBoundParameters.ContainsKey('ImapHost')

if ($modoParametros) {
    if ($PSBoundParameters.ContainsKey('EmailAddress') -and $EmailAddress) { $cuenta['EMAIL_ADDRESS'] = $EmailAddress }
    if ($SenderName) { $cuenta['SENDER_NAME'] = $SenderName }
    if ($Provider) { $cuenta['EMAIL_PROVIDER'] = $Provider }
    if ($PSBoundParameters.ContainsKey('SmtpHost')) { $cuenta['SMTP_HOST'] = $SmtpHost; $cuenta['SMTP_PORT'] = if ($SmtpPort) { $SmtpPort } else { 465 } }
    if ($PSBoundParameters.ContainsKey('ImapHost')) { $cuenta['IMAP_HOST'] = $ImapHost; $cuenta['IMAP_PORT'] = if ($ImapPort) { $ImapPort } else { 993 } }
    if ($PSBoundParameters.ContainsKey('AllowedRecipientDomains')) { $cuenta['ALLOWED_RECIPIENT_DOMAINS'] = $AllowedRecipientDomains }
    if ($MaxRecipientsPerEmail) { $cuenta['MAX_RECIPIENTS_PER_EMAIL'] = $MaxRecipientsPerEmail }
    if ($MaxEmailsPerDay) { $cuenta['MAX_EMAILS_PER_DAY'] = $MaxEmailsPerDay }
    if ($PSBoundParameters.ContainsKey('AttachmentsDir')) { $cuenta['ATTACHMENTS_DIR'] = $AttachmentsDir }
    if ($MaxAttachmentMb) { $cuenta['MAX_ATTACHMENT_MB'] = $MaxAttachmentMb }
    if ($PSBoundParameters.ContainsKey('SignatureHtml')) { $cuenta['SIGNATURE_HTML'] = $SignatureHtml }
    if ($PSBoundParameters.ContainsKey('ReadableFolders')) { $cuenta['READABLE_FOLDERS'] = $ReadableFolders }
    if ($MaxBodyChars) { $cuenta['MAX_BODY_CHARS'] = $MaxBodyChars }
    if ($DoNotSaveToSent.IsPresent) { $cuenta['SAVE_TO_SENT'] = $false }

    if (-not $cuenta['EMAIL_ADDRESS']) { throw 'Falta -EmailAddress.' }

    $cambiar = if ($habiaContrasena) { PreguntarSiNo 'Cambiar la contrasena guardada?' $false } else { $true }
    if ($cambiar) {
        $secure = Read-Host '  Contrasena del buzon (no se mostrara)' -AsSecureString
        $plain = ConvertFrom-SecureStringPlain $secure
        if ([string]::IsNullOrEmpty($plain)) { throw 'La contrasena no puede estar vacia.' }
        $estado.NuevaContrasenaB64 = Protect-Text $plain
        $plain = $null
    }

    Guardar
    return
}

# ---------- modo interactivo ----------

Write-Host ''
Write-Host '  eSynapsing Correu - configuracion' -ForegroundColor Cyan
Write-Host '  ---------------------------------'

if (-not $existia) {
    # Primera vez: las tres preguntas seguidas, sin menu.
    Write-Host '  Vamos a guardar los datos de tu buzon. La contrasena no se'
    Write-Host '  mostrara y quedara cifrada en este ordenador.'
    Editar-CorreoYContrasena
    Editar-Servidor -Etiqueta 'Servidor SMTP (envio)' -ClaveHost 'SMTP_HOST' -ClavePuerto 'SMTP_PORT' -PuertoPorDefecto 465
    Editar-Servidor -Etiqueta 'Servidor IMAP (lectura del buzon)' -ClaveHost 'IMAP_HOST' -ClavePuerto 'IMAP_PORT' -PuertoPorDefecto 993
    Guardar
    Write-Host '  Pulsa Intro para cerrar.'
    [void](Read-Host)
    return
}

# Ya habia configuracion: menu para tocar solo lo que haga falta.
while ($true) {
    Write-Host ''
    Write-Host '  eSynapsing Correu - configuracion' -ForegroundColor Cyan
    Write-Host '  ---------------------------------'
    Write-Host ('  Correo:      ' + $cuenta['EMAIL_ADDRESS'])
    Write-Host ('  SMTP:        ' + $(if ($cuenta['SMTP_HOST']) { $cuenta['SMTP_HOST'] + ':' + $cuenta['SMTP_PORT'] } else { 'automatico' }))
    Write-Host ('  IMAP:        ' + $(if ($cuenta['IMAP_HOST']) { $cuenta['IMAP_HOST'] + ':' + $cuenta['IMAP_PORT'] } else { 'automatico' }))
    Write-Host ('  Contrasena:  ' + $(if ($estado.NuevaContrasenaB64) { 'cambiada, pendiente de guardar' } elseif ($habiaContrasena) { 'guardada' } else { 'SIN GUARDAR' }))
    Write-Host ''
    Write-Host '  1) Correo y contrasena'
    Write-Host '  2) Servidor SMTP (envio)'
    Write-Host '  3) Servidor IMAP (lectura del buzon)'
    Write-Host '  4) Guardar y salir'
    Write-Host '  0) Salir sin guardar'
    $op = Preguntar 'Elige una opcion' '4'
    switch ($op) {
        '1' { Editar-CorreoYContrasena }
        '2' { Editar-Servidor -Etiqueta 'Servidor SMTP (envio)' -ClaveHost 'SMTP_HOST' -ClavePuerto 'SMTP_PORT' -PuertoPorDefecto 465 }
        '3' { Editar-Servidor -Etiqueta 'Servidor IMAP (lectura del buzon)' -ClaveHost 'IMAP_HOST' -ClavePuerto 'IMAP_PORT' -PuertoPorDefecto 993 }
        '4' { Guardar; Write-Host '  Pulsa Intro para cerrar.'; [void](Read-Host); return }
        '0' { Write-Host '  Saliendo sin guardar cambios.' -ForegroundColor Yellow; return }
        default { Write-Host '  Opcion no reconocida.' -ForegroundColor Yellow }
    }
}
