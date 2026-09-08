#!/usr/bin/env node
//
// Lanzador para clientes MCP que no tienen almacen seguro propio
// (ChatGPT de escritorio, Codex y similares).
//
// Claude Desktop NO pasa por aqui: su manifest arranca server/index.js
// directamente, porque las variables ya le llegan del formulario de la
// extension y meter un proceso intermedio solo anade formas de fallar.
//
// IMPORTANTE: este lanzador NO crea un proceso hijo. Rellena process.env y
// carga el servidor en el MISMO proceso. Lanzar un hijo con process.execPath
// es fragil en clientes que empaquetan su propio Node: puede relanzar la
// aplicacion entera en vez del servidor, y el cliente solo ve "Connection
// closed" sin ningun log.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseAccountJson } from './account-format.mjs';

const stateDir = path.join(os.homedir(), '.esynapsing-correu');
const accountFile = path.join(stateDir, 'account.json');

function decryptPassword(passwordFile) {
  if (process.platform !== 'win32' || !fs.existsSync(passwordFile)) return null;
  try {
    // decrypt-password.ps1 vive junto a start.mjs en el arbol fuente, pero en
    // el paquete publicado start.mjs se copia a dist/ mientras que el script
    // se queda en scripts/, un nivel por encima. Subir un nivel y volver a
    // entrar en 'scripts' resuelve bien en los dos layouts: en el fuente
    // (scripts/../scripts/ = la misma carpeta) y en el paquete (dist/../scripts/).
    const decryptScript = path.join(import.meta.dirname, '..', 'scripts', 'decrypt-password.ps1');
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', decryptScript, '-PasswordFile', passwordFile],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    process.stderr.write('[esynapsing-correu] No se pudo descifrar ' + passwordFile + '. Vuelve a ejecutar scripts/configure-windows.ps1.\n');
  } catch (error) {
    process.stderr.write('[esynapsing-correu] Error al descifrar ' + passwordFile + ': ' + error.message + '\n');
  }
  return null;
}

// Rellenamos solo lo que falte: lo que ya venga por entorno manda siempre.
function setIfEmpty(key, value) {
  if (!process.env[key] && value !== undefined && value !== null && value !== '') {
    process.env[key] = String(value);
  }
}

try {
  const parsed = parseAccountJson(fs.readFileSync(accountFile, 'utf8'));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (Array.isArray(parsed.PROFILES)) {
      // Formato multi-cuenta: una entrada por cuenta (con su propio fichero de
      // contrasena cifrada), mas los ajustes compartidos al mismo nivel.
      parsed.PROFILES.forEach((p, i) => {
        const n = i + 1;
        setIfEmpty('ACCOUNT' + n + '_LABEL', p.LABEL);
        setIfEmpty('ACCOUNT' + n + '_EMAIL', p.EMAIL_ADDRESS);
        setIfEmpty('ACCOUNT' + n + '_SENDER_NAME', p.SENDER_NAME);
        setIfEmpty('ACCOUNT' + n + '_PROVIDER', p.EMAIL_PROVIDER);
        setIfEmpty('ACCOUNT' + n + '_SMTP_HOST', p.SMTP_HOST);
        setIfEmpty('ACCOUNT' + n + '_SMTP_PORT', p.SMTP_PORT);
        setIfEmpty('ACCOUNT' + n + '_IMAP_HOST', p.IMAP_HOST);
        setIfEmpty('ACCOUNT' + n + '_IMAP_PORT', p.IMAP_PORT);
        if (p.PASSWORD_FILE) {
          setIfEmpty('ACCOUNT' + n + '_PASSWORD', decryptPassword(path.join(stateDir, p.PASSWORD_FILE)));
        }
      });
      for (const [key, value] of Object.entries(parsed)) {
        if (key === 'PROFILES') continue;
        setIfEmpty(key, value);
      }
    } else {
      // Formato antiguo (una sola cuenta, de antes de que existieran varias):
      // se pasa tal cual. config.js lo sigue entendiendo (EMAIL_ADDRESS a secas).
      for (const [key, value] of Object.entries(parsed)) {
        setIfEmpty(key, value);
      }
      if (!process.env.EMAIL_PASSWORD) {
        setIfEmpty('EMAIL_PASSWORD', decryptPassword(path.join(stateDir, 'password.dpapi')));
      }
    }
  }
} catch (error) {
  if (error && error.code === 'ENOENT') {
    // No hay configuracion local: normal en Claude Desktop y en la primera
    // ejecucion. El servidor ya avisa si le faltan datos.
  } else {
    // El fichero existe pero no se ha podido leer o interpretar. Antes esto
    // se tragaba en silencio y el conector se quedaba sin datos sin que se
    // viera por que. Lo dejamos en el log de la extension, para diagnostico.
    process.stderr.write('[esynapsing-correu] No se pudo leer ' + accountFile + ': ' + error.message + '\n');
  }
}

// Cargamos el servidor en este mismo proceso. Nada de stdio heredado ni de
// procesos hijo: el transporte stdio del servidor usa directamente los
// descriptores que ya nos ha dado el cliente.
//
// Buscamos el servidor en dos sitios, para que este mismo fichero sirva tanto
// en el paquete compilado (dist/server.mjs al lado) como en el codigo fuente.
const candidatos = ['./server.mjs', '../server/index.js'];
const servidor = candidatos
  .map((rel) => new URL(rel, import.meta.url))
  .find((url) => fs.existsSync(url));

if (!servidor) {
  process.stderr.write('[esynapsing-correu] No encuentro el servidor. Busque en: ' + candidatos.join(', ') + '\n');
  process.exit(1);
}

await import(servidor.href);
