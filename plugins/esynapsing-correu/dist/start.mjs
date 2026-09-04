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

const stateDir = path.join(os.homedir(), '.esynapsing-correu');
const accountFile = path.join(stateDir, 'account.json');
const passwordFile = path.join(stateDir, 'password.dpapi');

// Rellenamos solo lo que falte: lo que ya venga por entorno manda siempre.
try {
  const parsed = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (!process.env[key] && value !== undefined && value !== null && value !== '') {
        process.env[key] = String(value);
      }
    }
  }
} catch {
  // No hay configuracion local: normal en Claude Desktop y en la primera
  // ejecucion. El servidor ya avisa si le faltan datos.
}

// La contrasena esta cifrada con DPAPI y solo la puede descifrar este usuario
// de Windows. Solo lo intentamos si no venia ya por entorno.
if (!process.env.EMAIL_PASSWORD && process.platform === 'win32' && fs.existsSync(passwordFile)) {
  try {
    const decryptScript = path.join(import.meta.dirname, 'decrypt-password.ps1');
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', decryptScript, '-PasswordFile', passwordFile],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.status === 0 && result.stdout.trim()) {
      process.env.EMAIL_PASSWORD = result.stdout.trim();
    } else {
      process.stderr.write('[esynapsing-correu] No se pudo descifrar la contrasena guardada. Vuelve a ejecutar scripts/configure-windows.ps1.\n');
    }
  } catch (error) {
    process.stderr.write('[esynapsing-correu] Error al descifrar la contrasena: ' + error.message + '\n');
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
