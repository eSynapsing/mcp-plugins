# Plugins de eSynapsing

Marketplace de plugins de eSynapsing para Codex, la app de escritorio de
ChatGPT y Claude Code. Contiene también el paquete para Claude Desktop.

## eSynapsing Correu

Envía, lee y busca correo en un buzón SMTP/IMAP propio, sin depender de los
conectores de Google ni de Microsoft. Para empresas cuyo correo es IMAP
estándar: IONOS, OVH, Strato, Hostinger, Zoho, alojamientos con cPanel, y
también Gmail con contraseña de aplicación.

Ocho herramientas: verificar la configuración, enviar, listar enviados,
auditar el registro local, listar carpetas, listar la bandeja de entrada,
buscar y leer un correo concreto.

## Instalación

Mismo flujo en los dos clientes: añadir el marketplace, instalar el plugin,
configurar la cuenta con el script. Ninguno de los dos tiene un almacén de
credenciales propio para plugins de marketplace, así que la contraseña se
guarda con `configure-windows.ps1`, cifrada con DPAPI de Windows.

### 1. Añadir el marketplace

**Claude Code / Claude Desktop** — Ajustes → Complementos → Tienda → Añadir,
y pega:

```
eSynapsing/mcp-plugins
```

**Codex / app de escritorio de ChatGPT** — en el chat o en el terminal
integrado:

```bash
codex plugin marketplace add eSynapsing/mcp-plugins
```

### 2. Instalar el plugin

En la pestaña de Complementos/Tienda del cliente que uses, busca
**eSynapsing Correu** e instálalo.

### 3. Configurar la cuenta

```powershell
$rutas = @(
  "$env:USERPROFILE\.codex\plugins\cache\*\esynapsing-correu\*\scripts\configure-windows.ps1",
  "$env:USERPROFILE\.claude\plugins\cache\*\esynapsing-correu\*\scripts\configure-windows.ps1"
)
$cfg = Get-ChildItem -Path $rutas -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
& $cfg.FullName
```

Busca en las dos ubicaciones posibles (Codex y Claude instalan en carpetas
distintas, cada una con el número de versión en la ruta) y abre la que
encuentre. Sin parámetros, pregunta el correo, la contraseña, y el servidor
SMTP/IMAP uno a uno; si ya hay una cuenta guardada, muestra un menú para
tocar solo lo que haga falta. La contraseña se pide siempre por teclado, no
se muestra, y no queda en ningún archivo de texto ni en el historial.

Para una instalación desatendida, con parámetros:

```powershell
& $cfg.FullName -EmailAddress info@tuempresa.com -AllowedRecipientDomains "tuempresa.com"
```

(la contraseña se sigue pidiendo por teclado incluso así: nunca se acepta
como parámetro).

Cierra el cliente por completo y vuelve a abrirlo para que recoja la
configuración guardada.

### Alternativa para Claude Desktop: el `.mcpb`

Si prefieres el formulario nativo de Claude Desktop en vez del script (pide
los mismos datos, pero con una pantalla propia y sin usar PowerShell), puedes
saltarte el marketplace: descarga el `.mcpb` de
[`claude-desktop/`](./claude-desktop/) y haz doble clic. Es el mismo plugin,
empaquetado para instalarse fuera del marketplace.

## Comprobar que funciona

En una conversación nueva:

> Usa la herramienta `verify_email_setup` de eSynapsing Correu

Si el servidor de tu proveedor no es de los conocidos, lo detecta consultando
los registros MX del dominio y guarda la configuración.

## Estructura del repositorio

| Ruta | Qué es |
|---|---|
| `.agents/plugins/marketplace.json` | Catálogo que lee Codex |
| `.claude-plugin/marketplace.json` | El mismo catálogo, para Claude Code |
| `plugins/esynapsing-correu/` | El plugin publicado, ya compilado |
| `claude-desktop/` | El `.mcpb` para Claude Desktop |
| `src/` | Código fuente y script de compilación |

El plugin publicado **no lleva `node_modules`**: el servidor va empaquetado en
un único fichero, `plugins/esynapsing-correu/dist/server.mjs`.

## Compilar

```bash
cd src
npm install
npm run build
```

Genera `src/build/` con el `.mcpb`, el `.zip` y el árbol del marketplace. El
build **falla a propósito** si el fichero empaquetado no responde al handshake
MCP, para que no se publique un paquete que no arranca.

Para publicar una versión nueva, copia lo que genera el build sobre
`plugins/` y `claude-desktop/`, y haz commit.

### Notas de mantenimiento

- `nodemailer` debe ir por la versión 9 o superior: la 7.x arrastra seis
  advisories de severidad alta, entre ellas inyección CRLF en cabeceras.
- Al empaquetar en ESM hay que inyectar un `require` real con `createRequire`,
  o `nodemailer` revienta al arrancar con `Dynamic require of "events" is not
  supported`.
- El servidor no debe escribir nunca por stdout nada que no sea JSON-RPC. El
  diagnóstico va por stderr.
- Los clientes MCP no sustituyen los `${user_config.x}` de los campos
  opcionales vacíos: llegan literales. `src/server/config.js` los neutraliza y
  hay tests de regresión. Sin eso, la lista blanca se activa con un dominio
  inventado y bloquea todos los envíos.
- El `name` del `manifest.json` es el identificador de la extensión en Claude
  Desktop. Si cambia, la trata como otra extensión y se pierde la
  configuración guardada del usuario.

## Seguridad

Los límites viven dentro del servidor, no en la conversación, así que se
cumplen aunque se malinterprete una instrucción:

- Lista blanca de dominios de destinatarios
- Tope de destinatarios por correo y de envíos al día
- Carpeta autorizada para adjuntos
- Carpetas del buzón que se pueden leer (por defecto, entrada y enviados)
- Registro local de auditoría de todos los envíos

La lectura del buzón se hace **en modo solo lectura**: no marca como leído, no
mueve y no borra.

**Configura siempre la lista blanca de dominios.** El contenido de un correo
entrante lo escribe un tercero, y esa lista es lo que impide que algo llegado
por correo consiga que se escriba a otra dirección.

## Requisitos

- Windows o macOS
- Node.js 20 o superior en el PATH para Codex; Claude Desktop trae el suyo
- Una cuenta de correo con SMTP e IMAP. **Microsoft 365 no sirve**: está
  retirando el acceso SMTP con contraseña. Usa su conector oficial.

## Licencia

MIT · [eSynapsing](https://www.esynapsing.com) · info@esynapsing.com
