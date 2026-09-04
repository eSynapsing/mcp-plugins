// Verificador manual del conector, sin passar per Claude Desktop.
// Fa exactament el que fa l'eina verify_email_setup: prova SMTP i IMAP i,
// si no els troba, descobreix el servidor provant els candidats habituals.
//
//   node verificar.mjs
//
// Demana la contrasenya per teclat i no la mostra. Aixi no queda a l'historial
// del terminal ni en cap variable d'entorn ni en cap fitxer.

import readline from 'node:readline';
import { loadConfig } from './server/config.js';
import { verifySetup } from './server/mail.js';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// Lectura sense eco, per a la contrasenya.
function askSecret(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (chunk) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw);
          stdin.pause();
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '') { // Ctrl+C
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const email = process.env.EMAIL_ADDRESS || (await ask('Adreça de correu: '));
const password = process.env.EMAIL_PASSWORD || (await askSecret('Contrasenya (no es mostra): '));
const provider = process.env.EMAIL_PROVIDER || 'auto';

// Passem tot l'entorn perque SMTP_HOST/PORT i IMAP_HOST/PORT tambe hi arribin
// quan es fa servir el proveidor "manual".
const cfg = loadConfig({
  ...process.env,
  EMAIL_ADDRESS: email,
  EMAIL_PASSWORD: password,
  EMAIL_PROVIDER: provider,
});

if (cfg.errors.length) {
  console.error('\nProblemes de configuracio:');
  for (const e of cfg.errors) console.error(' - ' + e);
  process.exit(1);
}

console.log('\nProvant ' + cfg.email + ' (proveidor: ' + cfg.providerLabel + ')...\n');
const r = await verifySetup(cfg);

if (r.smtp) {
  console.log('SMTP ' + r.smtp.host + ':' + r.smtp.port + ' -> ' + (r.smtp.ok ? 'OK' : 'ERROR: ' + r.smtp.error));
}
if (r.imap) {
  console.log('IMAP ' + r.imap.host + ':' + r.imap.port + ' -> '
    + (r.imap.ok ? 'OK' + (r.imap.mailbox ? ' (enviats: "' + r.imap.mailbox + '")' : ' pero sense carpeta d\'enviats') : 'ERROR: ' + r.imap.error));
}

if (r.discovered) {
  const d = r.discovered;
  console.log('\nServidor detectat: ' + d.label);
  console.log('  SMTP: ' + d.smtp.host + ':' + d.smtp.port);
  console.log('  IMAP: ' + d.imap.host + ':' + d.imap.port + ' -> '
    + (d.imapOk ? 'OK' + (d.sentMailbox ? ' (enviats: "' + d.sentMailbox + '")' : '') : 'ERROR: ' + d.imapError));
  console.log('  Desat a disc per a la propera vegada: ' + (d.saved ? 'si' : 'NO'));
}

if (!r.smtp?.ok && !r.discovered) {
  console.log('\nCap servidor ha funcionat. Provats:');
  for (const t of r.tried) console.log(' - ' + t.host + ': ' + (t.error || 'fallada'));
  console.log('\nCauses mes frequents: contrasenya incorrecta (o cal contrasenya');
  console.log("d'aplicacio), servidor SMTP diferent dels provats, o port 465 tancat");
  console.log('pel tallafocs (prova el 587).');
  process.exit(1);
}

console.log('\nConnexio correcta. El conector pot enviar correu.');
