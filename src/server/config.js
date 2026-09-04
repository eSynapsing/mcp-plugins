import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDERS, domainOf } from './providers.js';

// Claude Desktop NO substitueix els ${user_config.x} dels camps opcionals que
// l'usuari deixa buits: arriben literals. Si no els neutralitzem, la llista
// blanca de dominis s'activa amb un domini inventat i bloqueja tots els
// enviaments, i el nom del remitent surt amb aquest text a dins.
const UNSUBSTITUTED = /^\$\{\s*user_config\.[^}]*\}$/;

export function isUnsubstituted(v) {
  return typeof v === 'string' && UNSUBSTITUTED.test(v.trim());
}

const str = (v, def = '') => {
  if (v === undefined || v === null) return def;
  const s = String(v).trim();
  if (s === '' || UNSUBSTITUTED.test(s)) return def;
  return s;
};
const num = (v, def) => {
  const raw = str(v);
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const bool = (v, def) => {
  const s = str(v).toLowerCase();
  if (['true', '1', 'si', 'sí', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return def;
};

// Directorio de estado: registro de envios y contador diario.
export const STATE_DIR = path.join(os.homedir(), '.esynapsing-correu');
export const LOG_FILE = path.join(STATE_DIR, 'enviaments.jsonl');
export const CACHE_FILE = path.join(STATE_DIR, 'servidor-detectado.json');

// La autodeteccion de verify_email_setup se guarda aqui para que el usuario
// no tenga que escribir a mano ningun nombre de servidor.
// Version del algoritmo de deteccion. La 1.0.x sondeaba toda la lista de
// proveedores, lo que enviaba las credenciales a servidores de terceros. Desde
// la version 3 solo se sondea el dominio propio y el preset que identifican los
// registros MX, asi que descartamos las cachés escritas por el metodo antiguo.
const DISCOVERY_VERSION = 3;

export function readDetectedCache(email) {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!c || c.discoveryVersion !== DISCOVERY_VERSION || c.email !== email || !c.smtp?.host) return null;
    return c;
  } catch {
    return null;
  }
}

export function writeDetectedCache(email, smtp, imap) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ discoveryVersion: DISCOVERY_VERSION, email, smtp, imap, detectedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env = process.env) {
  const email = str(env.EMAIL_ADDRESS);
  const password = str(env.EMAIL_PASSWORD);
  const providerKey = str(env.EMAIL_PROVIDER, 'auto').toLowerCase();

  const errors = [];
  if (!email) errors.push('Falta la dirección de correo (EMAIL_ADDRESS).');
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`La dirección "${email}" no parece válida.`);
  if (!password) errors.push('Falta la contraseña (EMAIL_PASSWORD).');

  const domain = domainOf(email);
  let smtp = null;
  let imap = null;
  let providerLabel = providerKey;

  const preset = PROVIDERS[providerKey];
  if (preset) {
    const resolved = preset.derive ? preset.derive(domain) : preset;
    smtp = { ...resolved.smtp };
    imap = { ...resolved.imap };
    providerLabel = preset.label;
  } else if (providerKey === 'manual') {
    const sh = str(env.SMTP_HOST);
    const ih = str(env.IMAP_HOST);
    if (!sh) errors.push('Proveedor "manual" seleccionado pero falta SMTP_HOST.');
    smtp = { host: sh, port: num(env.SMTP_PORT, 465) };
    imap = ih ? { host: ih, port: num(env.IMAP_PORT, 993) } : null;
    providerLabel = 'Manual';
  } else {
    // "auto": usamos lo que detectó verify_email_setup en una ejecución anterior.
    const cached = readDetectedCache(email);
    if (cached) {
      smtp = cached.smtp;
      imap = cached.imap || null;
      providerLabel = `Detectado automáticamente el ${String(cached.detectedAt).slice(0, 10)}`;
    } else {
      providerLabel = 'Automático (aún sin detectar)';
    }
  }

  // Los campos manuales sobrescriben cualquier preset si se han rellenado.
  if (str(env.SMTP_HOST) && providerKey !== 'manual') {
    smtp = { host: str(env.SMTP_HOST), port: num(env.SMTP_PORT, smtp?.port ?? 465) };
    providerLabel += ' (host SMTP sobrescrito a mano)';
  }
  if (str(env.IMAP_HOST) && providerKey !== 'manual') {
    imap = { host: str(env.IMAP_HOST), port: num(env.IMAP_PORT, imap?.port ?? 993) };
  }

  const allowedDomains = str(env.ALLOWED_RECIPIENT_DOMAINS)
    .split(/[,;\s]+/)
    .map((d) => d.replace(/^@/, '').trim().toLowerCase())
    .filter(Boolean);

  return {
    email,
    password,
    senderName: str(env.SENDER_NAME) || email,
    providerKey,
    providerLabel,
    smtp,
    imap,
    saveToSent: bool(env.SAVE_TO_SENT, true),
    signatureHtml: str(env.SIGNATURE_HTML),
    allowedDomains,
    maxRecipients: num(env.MAX_RECIPIENTS_PER_EMAIL, 10),
    maxPerDay: num(env.MAX_EMAILS_PER_DAY, 20),
    attachmentsDir: str(env.ATTACHMENTS_DIR),
    maxAttachmentBytes: num(env.MAX_ATTACHMENT_MB, 20) * 1024 * 1024,
    // Lectura del buzon (v1.1.0). Vacio = solo INBOX y Enviados. "*" = todas.
    readableFolders: str(env.READABLE_FOLDERS)
      .split(/[,;]+/)
      .map((f) => f.trim().toLowerCase())
      .filter(Boolean),
    maxBodyChars: num(env.MAX_BODY_CHARS, 8000),
    errors,
  };
}

export function smtpOptions(cfg, hostOverride) {
  const s = hostOverride || cfg.smtp;
  return {
    host: s.host,
    port: s.port,
    secure: s.port === 465,
    requireTLS: s.port !== 465,
    auth: { user: cfg.email, pass: cfg.password },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  };
}

export function imapOptions(cfg, hostOverride) {
  const i = hostOverride || cfg.imap;
  if (!i) return null;
  return {
    host: i.host,
    port: i.port,
    secure: i.port === 993,
    auth: { user: cfg.email, pass: cfg.password },
    logger: false,
    emitLogs: false,
  };
}
