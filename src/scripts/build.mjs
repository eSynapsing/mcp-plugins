// Compila todo el conector con un solo comando:
//
//   npm run build
//
// Produce, dentro de build/:
//   esynapsing-correu-<version>.mcpb   -> Claude Desktop (doble clic)
//   esynapsing-correu-<version>.zip    -> mismo archivo, para Codex a mano
//   marketplace/                       -> repo listo para subir a GitHub
//
// El servidor se empaqueta en UN fichero con esbuild, asi que ni el .mcpb ni
// el repo llevan node_modules.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'build');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const log = (msg) => process.stdout.write(msg + '\n');
const paso = (n, msg) => log('\n[' + n + '/5] ' + msg);

// En Windows, npx y npm son .cmd y necesitan shell. Un binario con ruta
// absoluta NO debe ir por shell: si la ruta lleva espacios ("C:\Program
// Files\..."), cmd.exe la parte por la mitad.
function run(cmd, args, opts = {}) {
  const needsShell = process.platform === 'win32' && /^(npx|npm)$/.test(cmd);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: needsShell, ...opts });
  if (r.status !== 0) {
    throw new Error('Fallo el comando: ' + cmd + ' ' + args.join(' '));
  }
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

log('eSynapsing Correu — compilando version ' + version);

// ---------- 1. Empaquetar el servidor en un solo fichero ----------

paso(1, 'Empaquetando el servidor con esbuild...');
rmrf(dist);
fs.mkdirSync(dist, { recursive: true });

// nodemailer y mailparser son CommonJS y usan require() dinamico. En salida
// ESM hay que inyectarles un require real o revientan al arrancar con
// "Dynamic require of events is not supported".
const BANNER = "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);";

// Buscamos esbuild donde pueda estar, y si no esta lo decimos claro en vez de
// soltar un error de npm que no dice nada.
function esbuildCmd() {
  if (process.env.ESBUILD && fs.existsSync(process.env.ESBUILD)) {
    return { cmd: process.execPath, pre: [process.env.ESBUILD] };
  }
  const local = path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild');
  if (fs.existsSync(local)) return { cmd: process.execPath, pre: [local] };
  const probe = spawnSync('npx', ['--no-install', 'esbuild', '--version'], {
    encoding: 'utf8', shell: process.platform === 'win32',
  });
  if (probe.status === 0) return { cmd: 'npx', pre: ['esbuild'] };
  throw new Error(
    'No encuentro esbuild, que hace falta para empaquetar.\n'
    + 'Ejecuta primero:  npm install\n'
    + 'Si sigue fallando, instalalo aparte y apunta la variable ESBUILD a su binario:\n'
    + '  npm install -g esbuild\n'
    + '  ESBUILD=<ruta al binario de esbuild> npm run build',
  );
}

const esb = esbuildCmd();
run(esb.cmd, [
  ...esb.pre,
  path.join(root, 'server', 'index.js'),
  '--bundle', '--platform=node', '--format=esm', '--target=node20',
  '--outfile=' + path.join(dist, 'server.mjs'),
  '--banner:js=' + BANNER,
]);

// El lanzador no se empaqueta: no tiene dependencias y busca el servidor al
// lado (dist/server.mjs) o en el codigo fuente.
copy(path.join(root, 'scripts', 'start.mjs'), path.join(dist, 'start.mjs'));
copy(path.join(root, 'scripts', 'account-format.mjs'), path.join(dist, 'account-format.mjs'));

const kb = (p) => Math.round(fs.statSync(p).size / 1024);
log('    dist/server.mjs  ' + kb(path.join(dist, 'server.mjs')) + ' KB');

// ---------- 2. Comprobar que el fichero empaquetado arranca ----------

paso(2, 'Comprobando que el servidor empaquetado arranca...');
const test = spawnSync(process.execPath, [path.join(dist, 'server.mjs')], {
  input: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'build', version: '1' } },
  }) + '\n',
  encoding: 'utf8',
  timeout: 20000,
  env: { ...process.env, EMAIL_ADDRESS: 'build@ejemplo.com', EMAIL_PASSWORD: 'x' },
});
if (!String(test.stdout).includes('esynapsing-correu')) {
  throw new Error('El servidor empaquetado no responde al handshake MCP.\n' + test.stderr);
}
log('    Responde correctamente al handshake MCP.');

// ---------- 2b. account.json con BOM: parseAccountJson lo debe tolerar ----------
//
// Windows PowerShell 5.1 escribe UTF-8 CON BOM aunque se pida -Encoding
// UTF8. JSON.parse normal lo rechaza. Esta es la prueba unitaria mas rapida
// de las cuatro: nada de procesos, solo la funcion pura.

paso('2b', 'Comprobando que parseAccountJson tolera BOM...');
{
  const { parseAccountJson } = await import(
    pathToFileURL(path.join(root, 'scripts', 'account-format.mjs')).href
  );
  const objetivo = { EMAIL_ADDRESS: 'x@y.com' };
  const conBom = '\uFEFF' + JSON.stringify(objetivo);
  const sinBom = JSON.stringify(objetivo);
  const r1 = parseAccountJson(conBom);
  const r2 = parseAccountJson(sinBom);
  if (r1.EMAIL_ADDRESS !== 'x@y.com' || r2.EMAIL_ADDRESS !== 'x@y.com') {
    throw new Error('parseAccountJson no interpreta correctamente el JSON con o sin BOM.');
  }
  log('    Lee igual con BOM y sin BOM.');
}

// ---------- 2c. Cifrado y descifrado DPAPI entre procesos distintos ----------
//
// Cifrar y descifrar en el MISMO proceso no habria detectado nunca el fallo
// real (el modulo de PowerShell que no cargaba). Hay que cruzar procesos,
// que es como lo usa de verdad configure-windows.ps1 (escribe) y start.mjs
// (lee, mas tarde, en otro arranque).

if (process.platform === 'win32') {
  paso('2c', 'Comprobando DPAPI cifrando en un proceso y descifrando en otro...');
  const dpapiScript = path.join(root, 'scripts', 'Dpapi.ps1');
  const decryptScript = path.join(root, 'scripts', 'decrypt-password.ps1');
  const secreto = 'clave-de-prueba-ñ-áéíóú-' + Date.now();

  const cifrar = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    '. "' + dpapiScript + '"; Protect-Text ([Console]::In.ReadToEnd())',
  ], { input: secreto, encoding: 'utf8', timeout: 20000 });
  if (cifrar.status !== 0 || !cifrar.stdout.trim()) {
    throw new Error('No se pudo cifrar con DPAPI durante el build.\n' + cifrar.stderr);
  }
  const cifradoB64 = cifrar.stdout.trim();

  const tmpPwdFile = path.join(os.tmpdir(), 'escorreu-build-dpapi-' + process.pid + '.dpapi');
  fs.writeFileSync(tmpPwdFile, cifradoB64, 'ascii');
  const descifrar = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', decryptScript, '-PasswordFile', tmpPwdFile,
  ], { encoding: 'utf8', timeout: 20000 });
  fs.rmSync(tmpPwdFile, { force: true });

  if (descifrar.status !== 0 || descifrar.stdout !== secreto) {
    throw new Error(
      'El roundtrip de DPAPI entre procesos distintos ha fallado. Cifrado en un proceso, '
      + 'descifrado (decrypt-password.ps1) en otro, no ha devuelto el mismo texto.\n'
      + 'Esperado: ' + JSON.stringify(secreto) + '\nObtenido: ' + JSON.stringify(descifrar.stdout) + '\n' + descifrar.stderr,
    );
  }
  log('    Cifrado en un proceso, descifrado en otro: coincide.');
}

// ---------- 2d. Arranque real de start.mjs tal como queda publicado ----------
//
// Esta es la prueba que habria detectado el bug real: dist/start.mjs busca
// decrypt-password.ps1 en ../scripts/ (un nivel por encima de dist/), y
// account.json puede llegar con BOM. Se reconstruye aqui la misma forma que
// tiene el paquete final -dist/ y scripts/ como hermanos- y se arranca de
// verdad, sin atajos por variables de entorno.

if (process.platform === 'win32') {
  paso('2d', 'Comprobando el arranque real de start.mjs (paquete publicado)...');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'escorreu-build-home-'));
  const stateDir = path.join(fakeHome, '.esynapsing-correu');
  fs.mkdirSync(stateDir, { recursive: true });

  const dpapiScript = path.join(root, 'scripts', 'Dpapi.ps1');
  const secreto = 'clave-de-prueba-del-build-' + Date.now();
  const cifrar = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    '. "' + dpapiScript + '"; Protect-Text ([Console]::In.ReadToEnd())',
  ], { input: secreto, encoding: 'utf8', timeout: 20000 });
  if (cifrar.status !== 0 || !cifrar.stdout.trim()) {
    throw new Error('No se pudo preparar la contrasena de prueba para el arranque real.\n' + cifrar.stderr);
  }
  fs.writeFileSync(path.join(stateDir, 'password.dpapi'), cifrar.stdout.trim(), 'ascii');

  // Con BOM a proposito: es como lo escribe -Encoding UTF8 en PowerShell 5.1.
  const cuentaPrueba = { EMAIL_ADDRESS: 'build-test@ejemplo.com', SENDER_NAME: 'Build Test' };
  fs.writeFileSync(path.join(stateDir, 'account.json'), '\uFEFF' + JSON.stringify(cuentaPrueba, null, 2), 'utf8');

  // dist/ y scripts/ como hermanos bajo la misma raiz, igual que en el
  // paquete final (build.mjs los junta ahi mas abajo, en el paso 3).
  const fakePluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'escorreu-build-plugin-'));
  copy(dist, path.join(fakePluginRoot, 'dist'));
  copy(path.join(root, 'scripts'), path.join(fakePluginRoot, 'scripts'));
  fs.rmSync(path.join(fakePluginRoot, 'scripts', 'build.mjs'), { force: true });

  const arranque = spawnSync(process.execPath, [path.join(fakePluginRoot, 'dist', 'start.mjs')], {
    input: [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'build', version: '1' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'verify_email_setup', arguments: {} } }),
    ].join('\n') + '\n',
    encoding: 'utf8',
    timeout: 25000,
    env: { ...process.env, USERPROFILE: fakeHome },
  });

  const salida = String(arranque.stdout);
  const stderr = String(arranque.stderr);

  if (!salida.includes('esynapsing-correu')) {
    throw new Error('start.mjs (paquete publicado) no responde al handshake MCP.\n' + stderr);
  }
  if (stderr.includes('No se pudo descifrar la contrasena guardada')) {
    throw new Error(
      'start.mjs no ha encontrado o no ha podido ejecutar decrypt-password.ps1 desde su ubicacion '
      + 'publicada (dist/../scripts/). Salida de error:\n' + stderr,
    );
  }
  if (!salida.includes('build-test@ejemplo.com')) {
    throw new Error(
      'El conector arrancado desde el paquete publicado no ha recogido el EMAIL_ADDRESS de un '
      + 'account.json con BOM. Salida:\n' + salida.slice(0, 2000),
    );
  }
  log('    Encuentra decrypt-password.ps1 en ../scripts/ y lee account.json con BOM.');

  rmrf(fakeHome);
  rmrf(fakePluginRoot);
}

// ---------- 3. Preparar el contenido comun ----------

paso(3, 'Preparando el paquete...');
rmrf(build);
const staging = path.join(build, 'paquete');
fs.mkdirSync(staging, { recursive: true });

for (const item of ['dist', 'skills', 'scripts', 'assets', '.codex-plugin', '.mcp.json', 'icon.png', 'README.md']) {
  const from = path.join(root, item);
  if (fs.existsSync(from)) copy(from, path.join(staging, item));
}
// El codigo fuente ya esta dentro de dist/server.mjs; en el paquete no hacen
// falta ni el build ni el lanzador suelto (va copiado en dist/).
rmrf(path.join(staging, 'scripts', 'build.mjs'));
rmrf(path.join(staging, 'scripts', 'start.mjs'));
rmrf(path.join(staging, 'scripts', 'account-format.mjs'));

// En el paquete compilado el lanzador vive en dist/, junto al servidor. Si el
// .mcp.json siguiera apuntando a scripts/start.mjs, no encontraria nada.
const mcpJson = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
const servidores = mcpJson.mcpServers ?? mcpJson;
for (const s of Object.values(servidores)) {
  s.args = ['./dist/start.mjs'];
}
fs.writeFileSync(path.join(staging, '.mcp.json'), JSON.stringify(mcpJson, null, 2) + '\n', 'utf8');

// manifest.json para Claude Desktop, apuntando al fichero empaquetado.
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
manifest.server.entry_point = 'dist/server.mjs';
manifest.server.mcp_config.args = ['${__dirname}/dist/server.mjs'];
fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// package.json minimo: sin dependencias, porque van dentro del bundle.
fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({
  name: pkg.name, version, description: pkg.description, type: 'module', private: true, license: pkg.license,
}, null, 2) + '\n', 'utf8');

// ---------- 4. Generar el .mcpb y el .zip ----------

paso(4, 'Generando .mcpb y .zip...');
const mcpb = path.join(build, 'esynapsing-correu-' + version + '.mcpb');
run('npx', ['--yes', '@anthropic-ai/mcpb@latest', 'pack', staging, mcpb], { stdio: 'ignore' });
const zip = path.join(build, 'esynapsing-correu-' + version + '.zip');
fs.copyFileSync(mcpb, zip);
log('    ' + path.basename(mcpb) + '  ' + kb(mcpb) + ' KB');

// ---------- 5. Generar el repo del marketplace ----------

paso(5, 'Generando el repo del marketplace...');
const market = path.join(build, 'marketplace');
const pluginDir = path.join(market, 'plugins', 'esynapsing-correu');
copy(staging, pluginDir);
// Dentro del plugin no pinta nada el manifest de Claude Desktop.
rmrf(path.join(pluginDir, 'manifest.json'));

// Codex y Claude Code leen marketplace.json con esquemas distintos: mezclar
// los dos en un unico objeto es lo que rompia "Agregar marketplace" en Claude
// con "No se pudo agregar el marketplace" (le faltaba el "owner" obligatorio
// y su "source" no admite el objeto {source:'local', path:...} de Codex).

// Codex: .agents/plugins/marketplace.json
const marketplaceCodex = {
  name: 'esynapsing',
  interface: { displayName: 'eSynapsing' },
  plugins: [
    {
      name: 'esynapsing-correu',
      source: { source: 'local', path: './plugins/esynapsing-correu' },
      policy: { installation: 'AVAILABLE' },
      category: 'Productivity',
    },
  ],
};
{
  const f = path.join(market, '.agents/plugins', 'marketplace.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(marketplaceCodex, null, 2) + '\n', 'utf8');
}

// Claude Code: .claude-plugin/marketplace.json. Exige "owner", y la fuente de
// cada plugin es una ruta relativa en string, no un objeto.
const marketplaceClaude = {
  name: 'esynapsing',
  owner: { name: 'eSynapsing', email: 'info@esynapsing.com', url: 'https://www.esynapsing.com' },
  description: 'Plugins de eSynapsing para Claude Code.',
  plugins: [
    {
      name: 'esynapsing-correu',
      source: './plugins/esynapsing-correu',
      description: 'Envia, lee y busca correo en un buzon SMTP/IMAP propio, sin depender de Google ni Microsoft.',
      version,
      author: { name: 'eSynapsing', email: 'info@esynapsing.com' },
      homepage: 'https://www.esynapsing.com',
      license: 'MIT',
      category: 'Productivity',
      keywords: ['correo', 'email', 'smtp', 'imap'],
    },
  ],
};
{
  const f = path.join(market, '.claude-plugin', 'marketplace.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(marketplaceClaude, null, 2) + '\n', 'utf8');
}
// El .mcpb tambien va al repo, para quien use Claude Desktop.
copy(mcpb, path.join(market, 'claude-desktop', path.basename(mcpb)));
copy(path.join(root, 'MARKETPLACE.md'), path.join(market, 'README.md'));

// Los tres ficheros de los que depende el arranque real en Codex tienen que
// estar todos en el plugin que se publica, y en el sitio correcto. Si falta
// alguno, mejor que el build falle aqui a que falle en silencio en casa del
// cliente.
{
  const requeridos = [
    path.join(pluginDir, 'dist', 'start.mjs'),
    path.join(pluginDir, 'dist', 'account-format.mjs'),
    path.join(pluginDir, 'scripts', 'decrypt-password.ps1'),
    path.join(pluginDir, 'scripts', 'Dpapi.ps1'),
    path.join(pluginDir, 'scripts', 'configure-windows.ps1'),
  ];
  const faltan = requeridos.filter((f) => !fs.existsSync(f));
  if (faltan.length) {
    throw new Error('Faltan ficheros en el plugin publicado:\n' + faltan.join('\n'));
  }
  log('    Presentes: decrypt-password.ps1, Dpapi.ps1, configure-windows.ps1, start.mjs, account-format.mjs.');
}

rmrf(staging);

log('');
log('LISTO. Todo esta en build/');
log('  ' + path.basename(mcpb) + '   -> Claude Desktop (doble clic)');
log('  ' + path.basename(zip) + '    -> Codex a mano');
log('  marketplace/                  -> subir a GitHub como repo');
log('');
log('Para publicar el marketplace:');
log('  cd build/marketplace && git init && git add . && git commit -m "v' + version + '"');
log('  git remote add origin https://github.com/TU-ORG/plugins.git && git push -u origin main');
