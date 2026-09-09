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

// Cuantas cuentas admite como maximo un solo conector. El .mcpb de Claude
// Desktop solo ofrece formulario para las 3 primeras (ver manifest.json); el
// camino de script (Codex, account.json) puede rellenar hasta este limite.
export const MAX_PROFILES = 8;

// Directorio de estado: registro de envios y contador diario.
export const STATE_DIR = path.join(os.homedir(), '.esynapsing-correu');
export const LOG_FILE = path.join(STATE_DIR, 'enviaments.jsonl');
export const CACHE_FILE = path.join(STATE_DIR, 'servidor-detectado.json');

// La autodeteccion de verify_email_setup se guarda aqui, UNA ENTRADA POR
// CORREO, para que el usuario no tenga que escribir a mano ningun nombre de
// servidor, ni siquiera con varias cuentas configuradas a la vez.
// Version del algoritmo/formato de la cache. La 1.0.x sondeaba toda la lista
// de proveedores (credenciales a servidores de terceros). La 3 paso a sondear
// solo el dominio propio y el preset de los MX. La 4 paso de un unico objeto a
// un mapa por correo, para poder cachear varias cuentas a la vez.
const DISCOVERY_VERSION = 4;

function readCacheFile() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!c) return null;
    if (c.discoveryVersion === DISCOVERY_VERSION && typeof c.byEmail === 'object') return c;
    // Formato de la version 3 (un unico correo por fichero, sin byEmail): el
    // algoritmo de deteccion no cambio, solo donde se guarda. Migrarlo en vez
    // de descartarlo evita que instalaciones ya funcionando (una sola cuenta,
    // que era el unico caso que existia hasta ahora) se queden sin SMTP/IMAP
    // hasta que alguien vuelva a llamar a verify_email_setup a mano.
    if (c.discoveryVersion === 3 && c.email && c.smtp?.host) {
      return { discoveryVersion: DISCOVERY_VERSION, byEmail: { [c.email]: { smtp: c.smtp, imap: c.imap, detectedAt: c.detectedAt } } };
    }
    return null;
  } catch {
    return null;
  }
}

export function readDetectedCache(email) {
  const c = readCacheFile();
  const entry = c?.byEmail?.[email];
  if (!entry?.smtp?.host) return null;
  return entry;
}

export function writeDetectedCache(email, smtp, imap) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const current = readCacheFile() || { discoveryVersion: DISCOVERY_VERSION, byEmail: {} };
    current.byEmail[email] = { smtp, imap, detectedAt: new Date().toISOString() };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(current, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Resuelve smtp/imap para UNA cuenta: preset conocido, manual, o "auto" (cache
// de autodeteccion previa). Los campos de servidor escritos a mano siempre
// sobrescriben lo demas, igual que antes de que existieran varias cuentas.
function resolveServer(email, providerKey, env, prefix) {
  const domain = domainOf(email);
  const errors = [];
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
    const sh = str(env[prefix + 'SMTP_HOST']);
    const ih = str(env[prefix + 'IMAP_HOST']);
    if (!sh) errors.push('Proveedor "manual" seleccionado pero falta el servidor SMTP.');
    smtp = { host: sh, port: num(env[prefix + 'SMTP_PORT'], 465) };
    imap = ih ? { host: ih, port: num(env[prefix + 'IMAP_PORT'], 993) } : null;
    providerLabel = 'Manual';
  } else {
    // "auto": usamos lo que detecto verify_email_setup en una ejecucion anterior.
    const cached = readDetectedCache(email);
    if (cached) {
      smtp = cached.smtp;
      imap = cached.imap || null;
      providerLabel = `Detectado automáticamente el ${String(cached.detectedAt).slice(0, 10)}`;
    } else {
      providerLabel = 'Automático (aún sin detectar)';
    }
  }

  // Los campos manuales sobrescriben cualquier preset o deteccion si se han rellenado.
  if (str(env[prefix + 'SMTP_HOST']) && providerKey !== 'manual') {
    smtp = { host: str(env[prefix + 'SMTP_HOST']), port: num(env[prefix + 'SMTP_PORT'], smtp?.port ?? 465) };
    providerLabel += ' (host SMTP sobrescrito a mano)';
  }
  if (str(env[prefix + 'IMAP_HOST']) && providerKey !== 'manual') {
    imap = { host: str(env[prefix + 'IMAP_HOST']), port: num(env[prefix + 'IMAP_PORT'], imap?.port ?? 993) };
  }

  return { smtp, imap, providerLabel, errors };
}

function buildProfile(label, email, password, providerKey, env, prefix) {
  const errors = [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`La dirección "${email}" (cuenta "${label}") no parece válida.`);
  if (!password) errors.push(`Falta la contraseña de la cuenta "${label}".`);

  const { smtp, imap, providerLabel, errors: srvErrors } = resolveServer(email, providerKey, env, prefix);

  return {
    label,
    email,
    password,
    senderName: str(env[prefix + 'SENDER_NAME']) || email,
    providerKey,
    providerLabel,
    smtp,
    imap,
    errors: [...errors, ...srvErrors],
  };
}

// Devuelve una cuenta por cada ACCOUNT{n}_EMAIL que este relleno, en orden. La
// primera de la lista es la cuenta por defecto cuando no se especifica ninguna.
// Compatibilidad: instalaciones de una sola cuenta anteriores a esta version,
// que usaban EMAIL_ADDRESS a secas (sin prefijo), siguen funcionando igual.
export function loadProfiles(env = process.env) {
  const profiles = [];

  const legacyEmail = str(env.EMAIL_ADDRESS);
  if (legacyEmail) {
    profiles.push(buildProfile(
      str(env.SENDER_NAME) || legacyEmail,
      legacyEmail,
      str(env.EMAIL_PASSWORD),
      str(env.EMAIL_PROVIDER, 'auto').toLowerCase(),
      env,
      '',
    ));
  }

  for (let i = 1; i <= MAX_PROFILES; i += 1) {
    const prefix = `ACCOUNT${i}_`;
    const email = str(env[prefix + 'EMAIL']);
    if (!email) continue;
    const label = str(env[prefix + 'LABEL']) || email;
    profiles.push(buildProfile(
      label,
      email,
      str(env[prefix + 'PASSWORD']),
      str(env[prefix + 'PROVIDER'], 'auto').toLowerCase(),
      env,
      prefix,
    ));
  }

  return profiles;
}

// Ajustes compartidos por todas las cuentas de un mismo conector: limites,
// lista blanca de dominios, adjuntos, firma, carpetas legibles.
export function loadGlobalSettings(env = process.env) {
  const allowedDomains = str(env.ALLOWED_RECIPIENT_DOMAINS)
    .split(/[,;\s]+/)
    .map((d) => d.replace(/^@/, '').trim().toLowerCase())
    .filter(Boolean);

  return {
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
  };
}

// Combina una cuenta con los ajustes compartidos en el mismo objeto "cfg" que
// esperan mail.js e inbox.js (sin cambios en esos modulos).
export function mergeProfile(profile, globals) {
  return {
    profileLabel: profile.label,
    email: profile.email,
    password: profile.password,
    senderName: profile.senderName,
    providerKey: profile.providerKey,
    providerLabel: profile.providerLabel,
    smtp: profile.smtp,
    imap: profile.imap,
    ...globals,
    errors: profile.errors,
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
