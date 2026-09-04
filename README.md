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

### Codex / app de escritorio de ChatGPT

```bash
codex plugin marketplace add eSynapsing/mcp-plugins
```

Después instala **eSynapsing Correu** desde la pestaña de plugins.

Falta un paso más, porque ni Codex ni ChatGPT tienen almacén de credenciales
para plugins: hay que guardar la contraseña del buzón, cifrada.

```powershell
& "$env:USERPROFILE\.codex\plugins\esynapsing-correu\scripts\configure-windows.ps1" -EmailAddress info@tuempresa.com -AllowedRecipientDomains "tuempresa.com"
```

Pide la contraseña por teclado sin mostrarla y la cifra con DPAPI de Windows:
solo ese usuario de Windows puede descifrarla. No queda en ningún archivo de
texto ni en el historial del terminal.

Luego cierra el cliente por completo y vuelve a abrirlo.

### Claude Desktop

Descarga el `.mcpb` de [`claude-desktop/`](./claude-desktop/) y haz doble clic.
Ahí no hace falta configurador: la extensión trae su propio formulario y la
contraseña va al almacén seguro del sistema operativo.

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
