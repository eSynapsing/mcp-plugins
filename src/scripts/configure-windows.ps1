# Configurador de eSynapsing Correu para clientes que no tienen almacen seguro
# propio (Codex y la app de escritorio de ChatGPT).
#
# Claude Desktop NO necesita esto: alli la configuracion se rellena en el
# formulario de la extension (hasta 3 cuentas) y la contrasena va al almacen
# del sistema.
#
# Admite VARIAS cuentas de correo a la vez. Se puede ejecutar tantas veces
# como haga falta, en cualquier momento: si ya hay cuentas guardadas, muestra
# un menu para anadir, editar, borrar o cambiar cual es la principal, sin
# tener que repetir el resto. Si no hay nada guardado, pide los datos de la
# primera cuenta seguidos.
#
# Las contrasenas se piden siempre por teclado, nunca se muestran, y se
# guardan cifradas en este ordenador con DPAPI de Windows (ver Dpapi.ps1: usa
# crypt32.dll directamente, no el modulo Microsoft.PowerShell.Security, que en
# algunos equipos no carga). Cada cuenta tiene su propio fichero de
# contrasena cifrada.
#
# Con parametros, para instalar la PRIMERA cuenta sin menu (instalacion
# desatendida):
#   .\configure-windows.ps1 -EmailAddress info@empresa.com -AllowedRecipientDomains "empresa.com"
# La contrasena sigue pidiendose por teclado incluso asi: nunca se acepta como
# parametro, para que no quede en el historial de comandos ni en ningun script.
# Para anadir mas cuentas o editar las que ya hay, ejecuta sin parametros y usa el menu.

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

function Slug {
    param([string]$Texto)
    $s = ($Texto -replace '[^a-zA-Z0-9]+', '-').Trim('-').ToLower()
    if (-not $s) { $s = 'cuenta' }
    return $s
}

function NombreArchivoContrasena {
    param($Perfiles, [string]$Label, [int]$ExcluirIndice)
    $base = Slug $Label
    $candidato = $base
    $n = 2
    while ($true) {
        $enUso = $false
        for ($i = 0; $i -lt $Perfiles.Count; $i++) {
            if ($i -eq $ExcluirIndice) { continue }
            if ($Perfiles[$i].PASSWORD_FILE -eq ('password.' + $candidato + '.dpapi')) { $enUso = $true; break }
        }
        if (-not $enUso) { break }
        $candidato = $base + '-' + $n
        $n++
    }
    return 'password.' + $candidato + '.dpapi'
}

# ---------- estado: cargar lo que ya hubiera guardado ----------

# $perfiles es una lista de cuentas (ArrayList de hashtables ordenadas: tipo
# por referencia, asi que las funciones de abajo pueden modificar una cuenta
# sin depender de $script:, que con dot-sourcing no siempre apunta a la misma
# variable que el nivel superior del script).
$perfiles = New-Object System.Collections.ArrayList

$global = [ordered]@{
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
        foreach ($clave in @($global.Keys)) {
            if ($null -ne $guardado.$clave) { $global[$clave] = $guardado.$clave }
        }
        if ($guardado.PROFILES) {
            foreach ($p in $guardado.PROFILES) {
                [void]$perfiles.Add([ordered]@{
                    LABEL         = [string]$p.LABEL
                    EMAIL_ADDRESS = [string]$p.EMAIL_ADDRESS
                    SENDER_NAME   = [string]$p.SENDER_NAME
                    EMAIL_PROVIDER = if ($p.EMAIL_PROVIDER) { [string]$p.EMAIL_PROVIDER } else { 'auto' }
                    SMTP_HOST     = [string]$p.SMTP_HOST
                    SMTP_PORT     = if ($p.SMTP_PORT) { [int]$p.SMTP_PORT } else { 465 }
                    IMAP_HOST     = [string]$p.IMAP_HOST
                    IMAP_PORT     = if ($p.IMAP_PORT) { [int]$p.IMAP_PORT } else { 993 }
                    PASSWORD_FILE = [string]$p.PASSWORD_FILE
                })
            }
        } elseif ($guardado.EMAIL_ADDRESS) {
            # Migracion automatica desde el formato de una sola cuenta (versiones
            # anteriores a que existieran varias). Reutiliza el mismo fichero de
            # contrasena: no hace falta volver a escribirla.
            [void]$perfiles.Add([ordered]@{
                LABEL         = if ($guardado.SENDER_NAME) { [string]$guardado.SENDER_NAME } else { [string]$guardado.EMAIL_ADDRESS }
                EMAIL_ADDRESS = [string]$guardado.EMAIL_ADDRESS
                SENDER_NAME   = [string]$guardado.SENDER_NAME
                EMAIL_PROVIDER = if ($guardado.EMAIL_PROVIDER) { [string]$guardado.EMAIL_PROVIDER } else { 'auto' }
                SMTP_HOST     = [string]$guardado.SMTP_HOST
                SMTP_PORT     = if ($guardado.SMTP_PORT) { [int]$guardado.SMTP_PORT } else { 465 }
                IMAP_HOST     = [string]$guardado.IMAP_HOST
                IMAP_PORT     = if ($guardado.IMAP_PORT) { [int]$guardado.IMAP_PORT } else { 993 }
                PASSWORD_FILE = 'password.dpapi'
            })
        }
        $existia = $true
    } catch {
        Write-Host '  Aviso: no se pudo leer la configuracion anterior, se parte de cero.' -ForegroundColor Yellow
    }
}

# Contrasenas nuevas pendientes de guardar, por indice de $perfiles (como
# texto, porque las claves de hashtable en PowerShell son mas fiables asi).
# Cada entrada: @{ B64 = <cifrado>; Plain = <copia temporal para verificar> }.
$estado = @{ NuevasContrasenas = @{} }

# ---------- gestion de una cuenta ----------

function Editar-CuentaCorreoYContrasena {
    param([int]$Indice)
    $p = $perfiles[$Indice]
    Titulo ('Cuenta: ' + $p.LABEL)

    $e = Preguntar 'Direccion de correo' $p.EMAIL_ADDRESS -Obligatorio
    while ($e -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
        Write-Host '  Eso no parece una direccion de correo valida.' -ForegroundColor Yellow
        $e = Preguntar 'Direccion de correo' $p.EMAIL_ADDRESS -Obligatorio
    }
    $p.EMAIL_ADDRESS = $e
    if (-not $p.SENDER_NAME) { $p.SENDER_NAME = $e }
    $p.LABEL = Preguntar 'Nombre para identificar esta cuenta' $p.LABEL -Obligatorio

    $habiaContrasena = [bool]$p.PASSWORD_FILE -and (Test-Path (Join-Path $stateDir $p.PASSWORD_FILE))
    $cambiar = if ($habiaContrasena) { PreguntarSiNo 'Cambiar la contrasena guardada?' $false } else { $true }
    if ($cambiar) {
        $secure = Read-Host '  Contrasena del buzon (no se mostrara)' -AsSecureString
        $plain = ConvertFrom-SecureStringPlain $secure
        if ([string]::IsNullOrEmpty($plain)) {
            Write-Host '  La contrasena no puede estar vacia. No se ha cambiado.' -ForegroundColor Yellow
        } else {
            if (-not $p.PASSWORD_FILE) { $p.PASSWORD_FILE = NombreArchivoContrasena $perfiles $p.LABEL $Indice }
            $estado.NuevasContrasenas[[string]$Indice] = @{ B64 = (Protect-Text $plain); Plain = $plain }
            Write-Host '  Contrasena actualizada (se guardara al confirmar).' -ForegroundColor Green
        }
        $plain = $null
    }
}

function Editar-CuentaServidor {
    param([int]$Indice, [string]$Etiqueta, [string]$ClaveHost, [string]$ClavePuerto, [int]$PuertoPorDefecto)
    $p = $perfiles[$Indice]
    Titulo ($Etiqueta + ' — ' + $p.LABEL)
    $actual = if ($p[$ClaveHost]) { $p[$ClaveHost] + ':' + $p[$ClavePuerto] } else { 'automatico (se detecta al verificar)' }
    Write-Host ('  Ahora mismo: ' + $actual)
    Write-Host ''
    Write-Host '  1) Detectar automaticamente (recomendado)'
    Write-Host '  2) Especificar servidor y puerto a mano'
    Write-Host '  0) Volver sin cambiar'
    $op = Preguntar 'Elige una opcion' '0'
    switch ($op) {
        '1' {
            $p[$ClaveHost] = ''
            $p[$ClavePuerto] = $PuertoPorDefecto
            Write-Host '  Se detectara automaticamente.' -ForegroundColor Green
        }
        '2' {
            $h = Preguntar 'Servidor' $p[$ClaveHost] -Obligatorio
            $puertoActual = $p[$ClavePuerto]
            if (-not $puertoActual) { $puertoActual = $PuertoPorDefecto }
            $pu = Preguntar 'Puerto' $puertoActual
            $p[$ClaveHost] = $h
            $p[$ClavePuerto] = [int]$pu
            Write-Host '  Guardado.' -ForegroundColor Green
        }
        default { Write-Host '  Sin cambios.' }
    }
}

function Anadir-Cuenta {
    Titulo 'Anadir cuenta nueva'
    $nombre = Preguntar 'Nombre para identificar esta cuenta (ej. Trabajo)' '' -Obligatorio
    $e = Preguntar 'Direccion de correo' '' -Obligatorio
    while ($e -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
        Write-Host '  Eso no parece una direccion de correo valida.' -ForegroundColor Yellow
        $e = Preguntar 'Direccion de correo' '' -Obligatorio
    }
    $secure = Read-Host '  Contrasena del buzon (no se mostrara)' -AsSecureString
    $plain = ConvertFrom-SecureStringPlain $secure
    if ([string]::IsNullOrEmpty($plain)) {
        Write-Host '  La contrasena no puede estar vacia. No se ha anadido la cuenta.' -ForegroundColor Yellow
        return
    }
    $nuevo = [ordered]@{
        LABEL = $nombre
        EMAIL_ADDRESS = $e
        SENDER_NAME = $e
        EMAIL_PROVIDER = 'auto'
        SMTP_HOST = ''
        SMTP_PORT = 465
        IMAP_HOST = ''
        IMAP_PORT = 993
        PASSWORD_FILE = (NombreArchivoContrasena $perfiles $nombre -1)
    }
    [void]$perfiles.Add($nuevo)
    $indice = $perfiles.Count - 1
    $estado.NuevasContrasenas[[string]$indice] = @{ B64 = (Protect-Text $plain); Plain = $plain }
    $plain = $null
    Write-Host '  Cuenta anadida. Se guardara al confirmar.' -ForegroundColor Green
}

function Borrar-Cuenta {
    param([int]$Indice)
    $p = $perfiles[$Indice]
    if (-not (PreguntarSiNo ('Borrar la cuenta "' + $p.LABEL + '" (' + $p.EMAIL_ADDRESS + ')?') $false)) { return }
    if ($p.PASSWORD_FILE) {
        $archivo = Join-Path $stateDir $p.PASSWORD_FILE
        if (Test-Path $archivo) { Remove-Item -LiteralPath $archivo -Force }
    }
    $perfiles.RemoveAt($Indice)
    # Los indices de las contrasenas pendientes ya no coinciden tras el
    # borrado. Es un caso raro (borrar justo despues de cambiar la contrasena
    # de OTRA cuenta en la misma sesion); se limpian para no arriesgarse a
    # guardarla en la cuenta equivocada. Si pasa, hay que repetirla.
    $estado.NuevasContrasenas = @{}
    Write-Host '  Cuenta borrada.' -ForegroundColor Green
}

function Poner-Como-Principal {
    param([int]$Indice)
    if ($Indice -eq 0) { Write-Host '  Ya es la principal.'; return }
    $p = $perfiles[$Indice]
    $perfiles.RemoveAt($Indice)
    $perfiles.Insert(0, $p)
    $estado.NuevasContrasenas = @{}
    Write-Host '  Ahora es la cuenta principal (la primera de la lista).' -ForegroundColor Green
}

function Menu-Cuentas {
    while ($true) {
        Write-Host ''
        Write-Host '  Cuentas de correo' -ForegroundColor Cyan
        Write-Host '  -----------------'
        if ($perfiles.Count -eq 0) {
            Write-Host '  (ninguna configurada todavia)'
        } else {
            for ($i = 0; $i -lt $perfiles.Count; $i++) {
                $p = $perfiles[$i]
                $marca = if ($i -eq 0) { '  [principal]' } else { '' }
                if ($estado.NuevasContrasenas.ContainsKey([string]$i)) {
                    $notaContrasena = ', contrasena pendiente de guardar'
                } elseif ($p.PASSWORD_FILE -and (Test-Path (Join-Path $stateDir $p.PASSWORD_FILE))) {
                    $notaContrasena = ''
                } else {
                    $notaContrasena = ', SIN CONTRASENA'
                }
                Write-Host ('  ' + ($i + 1) + ') ' + $p.LABEL + ' — ' + $p.EMAIL_ADDRESS + $marca + $notaContrasena)
            }
        }
        Write-Host ''
        Write-Host '  Para una cuenta concreta (sustituye n por su numero):'
        Write-Host '    en   editar correo/nombre/contrasena  (ej. e1)'
        Write-Host '    sn   servidor SMTP'
        Write-Host '    in   servidor IMAP'
        Write-Host '    dn   borrar'
        Write-Host '    pn   ponerla como principal'
        Write-Host '  a    anadir una cuenta nueva'
        Write-Host '  v    volver'
        $op = (Preguntar 'Elige una opcion' 'v').Trim().ToLower()
        if ($op -eq 'v' -or $op -eq '') { return }
        if ($op -eq 'a') { Anadir-Cuenta; continue }
        if ($op -match '^([esidp])(\d+)$') {
            $accion = $Matches[1]
            $n = [int]$Matches[2] - 1
            if ($n -lt 0 -or $n -ge $perfiles.Count) {
                Write-Host '  No existe esa cuenta.' -ForegroundColor Yellow
                continue
            }
            switch ($accion) {
                'e' { Editar-CuentaCorreoYContrasena -Indice $n }
                's' { Editar-CuentaServidor -Indice $n -Etiqueta 'Servidor SMTP (envio)' -ClaveHost 'SMTP_HOST' -ClavePuerto 'SMTP_PORT' -PuertoPorDefecto 465 }
                'i' { Editar-CuentaServidor -Indice $n -Etiqueta 'Servidor IMAP (lectura del buzon)' -ClaveHost 'IMAP_HOST' -ClavePuerto 'IMAP_PORT' -PuertoPorDefecto 993 }
                'd' { Borrar-Cuenta -Indice $n }
                'p' { Poner-Como-Principal -Indice $n }
            }
            continue
        }
        Write-Host '  Opcion no reconocida.' -ForegroundColor Yellow
    }
}

# ---------- guardar ----------

function Guardar {
    if ($perfiles.Count -eq 0) { throw 'No hay ninguna cuenta configurada. Anade al menos una antes de guardar.' }
    for ($i = 0; $i -lt $perfiles.Count; $i++) {
        $p = $perfiles[$i]
        if (-not $p.EMAIL_ADDRESS) { throw ('Falta la direccion de correo de la cuenta "' + $p.LABEL + '".') }
        $tieneArchivo = $p.PASSWORD_FILE -and (Test-Path (Join-Path $stateDir $p.PASSWORD_FILE))
        $tienePendiente = $estado.NuevasContrasenas.ContainsKey([string]$i)
        if (-not $tieneArchivo -and -not $tienePendiente) {
            throw ('Falta la contrasena de la cuenta "' + $p.LABEL + '".')
        }
    }

    # Contrasenas pendientes: cifrar, guardar, y comprobar en un PROCESO NUEVO
    # -- exactamente como hara start.mjs cada vez que arranque el conector.
    # Si esto falla, es mejor saberlo ahora que descubrir despues que el
    # conector nunca arranca.
    foreach ($clave in @($estado.NuevasContrasenas.Keys)) {
        $i = [int]$clave
        $p = $perfiles[$i]
        $pendiente = $estado.NuevasContrasenas[$clave]
        $archivo = Join-Path $stateDir $p.PASSWORD_FILE
        Set-Content -LiteralPath $archivo -Value $pendiente.B64 -Encoding ASCII

        $decryptScript = Join-Path $PSScriptRoot 'decrypt-password.ps1'
        $descifrado = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $decryptScript -PasswordFile $archivo 2>$null
        $funciono = ($LASTEXITCODE -eq 0) -and ($descifrado -eq $pendiente.Plain)
        if (-not $funciono) {
            throw (
                'La contrasena de la cuenta "' + $p.LABEL + '" se ha cifrado pero no se ha podido volver a leer ' +
                'correctamente desde un proceso nuevo (asi es como la lee el conector cada vez que arranca). ' +
                'No se ha guardado como buena. Vuelve a intentarlo; si se repite, puede ser que DPAPI no funcione ' +
                'igual entre sesiones en este equipo (por ejemplo, en una sesion de escritorio remoto o una tarea ' +
                'programada sin sesion interactiva).'
            )
        }
    }
    foreach ($clave in @($estado.NuevasContrasenas.Keys)) { $estado.NuevasContrasenas[$clave].Plain = $null }
    $estado.NuevasContrasenas = @{}

    # UTF-8 sin BOM: si se escribe con Set-Content -Encoding UTF8 (que en este
    # PowerShell SIEMPRE anade BOM), Node no puede leer el fichero despues.
    $salida = [ordered]@{}
    foreach ($clave in $global.Keys) { $salida[$clave] = $global[$clave] }
    $salida['PROFILES'] = @($perfiles | ForEach-Object {
        [ordered]@{
            LABEL         = $_.LABEL
            EMAIL_ADDRESS = $_.EMAIL_ADDRESS
            SENDER_NAME   = $_.SENDER_NAME
            EMAIL_PROVIDER = $_.EMAIL_PROVIDER
            SMTP_HOST     = $_.SMTP_HOST
            SMTP_PORT     = $_.SMTP_PORT
            IMAP_HOST     = $_.IMAP_HOST
            IMAP_PORT     = $_.IMAP_PORT
            PASSWORD_FILE = $_.PASSWORD_FILE
        }
    })
    Set-Utf8NoBom -Path $accountFile -Content ($salida | ConvertTo-Json -Depth 6)

    # Tambien comprobamos que lo que acabamos de escribir se puede releer, para
    # detectar aqui cualquier problema de formato en vez de que aparezca
    # despues, en el arranque del conector.
    try {
        $releido = Get-Content -LiteralPath $accountFile -Raw | ConvertFrom-Json
        if (-not $releido.PROFILES -or @($releido.PROFILES).Count -ne $perfiles.Count) { throw 'no coincide' }
    } catch {
        throw 'El fichero de configuracion se ha guardado pero no se ha podido releer correctamente. Vuelve a intentarlo.'
    }

    Write-Host ''
    Write-Host '  Configuracion guardada y verificada.' -ForegroundColor Green
    Write-Host ('  Cuentas configuradas: ' + $perfiles.Count)
    for ($i = 0; $i -lt $perfiles.Count; $i++) {
        $p = $perfiles[$i]
        $marca = if ($i -eq 0) { ' [principal]' } else { '' }
        Write-Host ('   - ' + $p.LABEL + ' (' + $p.EMAIL_ADDRESS + ')' + $marca)
    }
    if ($perfiles.Count -gt 1) {
        Write-Host ''
        Write-Host '  Con mas de una cuenta, Claude preguntara con cual quieres enviar o leer cada vez.'
    }
    if (-not $global['ALLOWED_RECIPIENT_DOMAINS']) {
        Write-Host ''
        Write-Host '  Nota: no hay ninguna restriccion de dominios de destinatarios (se aplica a' -ForegroundColor Yellow
        Write-Host '  todas las cuentas), asi que se podra escribir a cualquier direccion. Para' -ForegroundColor Yellow
        Write-Host '  limitarlo, vuelve a ejecutar este configurador con -AllowedRecipientDomains "tudominio.com".' -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host '  Las contrasenas estan cifradas con Windows DPAPI: solo este usuario de'
    Write-Host '  Windows puede descifrarlas. No quedan en ningun archivo de texto.'
    Write-Host ''
    Write-Host '  SIGUIENTE PASO:' -ForegroundColor Cyan
    Write-Host '  1. Cierra Codex o ChatGPT de escritorio del todo y vuelve a abrirlo.'
    Write-Host '  2. Escribe: "Comprueba si mi cuenta de correo esta bien configurada".'
    Write-Host ''
}

# ---------- modo con parametros (instalacion desatendida de la primera cuenta) ----------

$modoParametros = $PSBoundParameters.ContainsKey('EmailAddress') -or $PSBoundParameters.ContainsKey('SmtpHost') -or $PSBoundParameters.ContainsKey('ImapHost')

if ($modoParametros) {
    if ($perfiles.Count -eq 0) {
        [void]$perfiles.Add([ordered]@{
            LABEL = ''; EMAIL_ADDRESS = ''; SENDER_NAME = ''; EMAIL_PROVIDER = 'auto'
            SMTP_HOST = ''; SMTP_PORT = 465; IMAP_HOST = ''; IMAP_PORT = 993; PASSWORD_FILE = 'password.dpapi'
        })
    }
    $p = $perfiles[0]
    if ($PSBoundParameters.ContainsKey('EmailAddress') -and $EmailAddress) {
        $p.EMAIL_ADDRESS = $EmailAddress
        if (-not $p.LABEL) { $p.LABEL = $EmailAddress }
    }
    if ($SenderName) { $p.SENDER_NAME = $SenderName }
    if ($Provider) { $p.EMAIL_PROVIDER = $Provider }
    if ($PSBoundParameters.ContainsKey('SmtpHost')) { $p.SMTP_HOST = $SmtpHost; $p.SMTP_PORT = if ($SmtpPort) { $SmtpPort } else { 465 } }
    if ($PSBoundParameters.ContainsKey('ImapHost')) { $p.IMAP_HOST = $ImapHost; $p.IMAP_PORT = if ($ImapPort) { $ImapPort } else { 993 } }
    if ($PSBoundParameters.ContainsKey('AllowedRecipientDomains')) { $global['ALLOWED_RECIPIENT_DOMAINS'] = $AllowedRecipientDomains }
    if ($MaxRecipientsPerEmail) { $global['MAX_RECIPIENTS_PER_EMAIL'] = $MaxRecipientsPerEmail }
    if ($MaxEmailsPerDay) { $global['MAX_EMAILS_PER_DAY'] = $MaxEmailsPerDay }
    if ($PSBoundParameters.ContainsKey('AttachmentsDir')) { $global['ATTACHMENTS_DIR'] = $AttachmentsDir }
    if ($MaxAttachmentMb) { $global['MAX_ATTACHMENT_MB'] = $MaxAttachmentMb }
    if ($PSBoundParameters.ContainsKey('SignatureHtml')) { $global['SIGNATURE_HTML'] = $SignatureHtml }
    if ($PSBoundParameters.ContainsKey('ReadableFolders')) { $global['READABLE_FOLDERS'] = $ReadableFolders }
    if ($MaxBodyChars) { $global['MAX_BODY_CHARS'] = $MaxBodyChars }
    if ($DoNotSaveToSent.IsPresent) { $global['SAVE_TO_SENT'] = $false }

    if (-not $p.EMAIL_ADDRESS) { throw 'Falta -EmailAddress.' }

    $habiaContrasena = $p.PASSWORD_FILE -and (Test-Path (Join-Path $stateDir $p.PASSWORD_FILE))
    $cambiar = if ($habiaContrasena) { PreguntarSiNo 'Cambiar la contrasena guardada?' $false } else { $true }
    if ($cambiar) {
        $secure = Read-Host '  Contrasena del buzon (no se mostrara)' -AsSecureString
        $plain = ConvertFrom-SecureStringPlain $secure
        if ([string]::IsNullOrEmpty($plain)) { throw 'La contrasena no puede estar vacia.' }
        if (-not $p.PASSWORD_FILE) { $p.PASSWORD_FILE = 'password.dpapi' }
        $estado.NuevasContrasenas['0'] = @{ B64 = (Protect-Text $plain); Plain = $plain }
        $plain = $null
    }

    Guardar
    return
}

# ---------- modo interactivo ----------

Write-Host ''
Write-Host '  eSynapsing Correu - configuracion' -ForegroundColor Cyan
Write-Host '  ---------------------------------'

if (-not $existia -or $perfiles.Count -eq 0) {
    Write-Host '  Vamos a guardar los datos de tu primer buzon. La contrasena no se'
    Write-Host '  mostrara y quedara cifrada en este ordenador. Podras anadir mas cuentas'
    Write-Host '  despues, si hace falta, volviendo a ejecutar esto.'
    Anadir-Cuenta
    if ($perfiles.Count -gt 0) {
        Editar-CuentaServidor -Indice 0 -Etiqueta 'Servidor SMTP (envio)' -ClaveHost 'SMTP_HOST' -ClavePuerto 'SMTP_PORT' -PuertoPorDefecto 465
        Editar-CuentaServidor -Indice 0 -Etiqueta 'Servidor IMAP (lectura del buzon)' -ClaveHost 'IMAP_HOST' -ClavePuerto 'IMAP_PORT' -PuertoPorDefecto 993
        Guardar
    } else {
        Write-Host '  No se ha anadido ninguna cuenta. Nada que guardar.' -ForegroundColor Yellow
    }
    Write-Host '  Pulsa Intro para cerrar.'
    [void](Read-Host)
    return
}

# Ya habia configuracion: menu principal.
while ($true) {
    Write-Host ''
    Write-Host '  eSynapsing Correu - configuracion' -ForegroundColor Cyan
    Write-Host '  ---------------------------------'
    Write-Host ('  Cuentas configuradas: ' + $perfiles.Count)
    foreach ($p in $perfiles) { Write-Host ('   - ' + $p.LABEL + ' (' + $p.EMAIL_ADDRESS + ')') }
    Write-Host ''
    Write-Host '  1) Gestionar cuentas de correo (anadir, editar, borrar, cambiar principal)'
    Write-Host '  2) Guardar y salir'
    Write-Host '  0) Salir sin guardar'
    $op = Preguntar 'Elige una opcion' '2'
    switch ($op) {
        '1' { Menu-Cuentas }
        '2' { Guardar; Write-Host '  Pulsa Intro para cerrar.'; [void](Read-Host); return }
        '0' { Write-Host '  Saliendo sin guardar cambios.' -ForegroundColor Yellow; return }
        default { Write-Host '  Opcion no reconocida.' -ForegroundColor Yellow }
    }
}
