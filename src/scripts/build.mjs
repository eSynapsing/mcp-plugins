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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const marketplace = {
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
for (const dir of ['.agents/plugins', '.claude-plugin']) {
  const f = path.join(market, dir, 'marketplace.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(marketplace, null, 2) + '\n', 'utf8');
}
// El .mcpb tambien va al repo, para quien use Claude Desktop.
copy(mcpb, path.join(market, 'claude-desktop', path.basename(mcpb)));
copy(path.join(root, 'MARKETPLACE.md'), path.join(market, 'README.md'));

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
