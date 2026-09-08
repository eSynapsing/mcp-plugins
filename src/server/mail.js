import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { ImapFlow } from 'imapflow';
import { smtpOptions, imapOptions, STATE_DIR, LOG_FILE, writeDetectedCache } from './config.js';
import { candidateHosts, domainOf, matchProviderByMx } from './providers.js';

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

// Defensa en profundidad contra inyeccion de cabeceras (CRLF).
export function sanitizeHeader(value) {
  return String(value ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function htmlFromText(text, signatureHtml) {
  const body = escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => '<p style="margin:0 0 14px 0;">' + p.replace(/\n/g, '<br>') + '</p>')
    .join('\n');
  const sig = signatureHtml
    ? '<div style="margin-top:24px;padding-top:14px;border-top:1px solid #e2e2e2;color:#555;font-size:13px;">' + signatureHtml + '</div>'
    : '';
  return '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;max-width:640px;">\n'
    + body + '\n' + sig + '\n</div>';
}

// ---------- Guardarrailes ----------

export function normalizeRecipients(raw, field) {
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .flatMap((v) => String(v).split(/[,;]/))
    .map((v) => v.trim())
    .filter(Boolean);
  for (const addr of list) {
    if (!EMAIL_RE.test(addr)) {
      throw new Error('La direccion "' + addr + '" del campo ' + field + ' no es valida. Usa direcciones simples, sin nombre ni signos < >.');
    }
  }
  return list;
}

export function enforceGuards(cfg, { to, cc, bcc }) {
  const all = [...to, ...cc, ...bcc];
  if (all.length === 0) throw new Error('No hay ningun destinatario.');

  if (all.length > cfg.maxRecipients) {
    throw new Error('Bloqueado: ' + all.length + ' destinatarios supera el maximo configurado (' + cfg.maxRecipients + '). Cambialo en los ajustes de la extension si de verdad hace falta.');
  }

  if (cfg.allowedDomains.length > 0) {
    const bad = all.filter((a) => !cfg.allowedDomains.includes(domainOf(a)));
    if (bad.length > 0) {
      throw new Error('Bloqueado por la lista blanca de dominios. No permitidos: ' + bad.join(', ') + '. Dominios autorizados: ' + cfg.allowedDomains.join(', ') + '.');
    }
  }

  const sentToday = countSentToday();
  if (sentToday >= cfg.maxPerDay) {
    throw new Error('Bloqueado: ya se han enviado ' + sentToday + ' correos hoy y el limite diario es ' + cfg.maxPerDay + '.');
  }
}

export function resolveAttachments(cfg, paths) {
  const list = Array.isArray(paths) ? paths : [];
  const out = [];
  let total = 0;
  for (const p of list) {
    const abs = path.resolve(String(p));
    if (cfg.attachmentsDir) {
      const root = path.resolve(cfg.attachmentsDir);
      const rel = path.relative(root, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('Adjunto bloqueado: "' + abs + '" esta fuera de la carpeta autorizada (' + root + ').');
      }
    }
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      throw new Error('No se encuentra el archivo adjunto: ' + abs);
    }
    if (!st.isFile()) throw new Error('El adjunto "' + abs + '" no es un archivo.');
    total += st.size;
    if (total > cfg.maxAttachmentBytes) {
      throw new Error('Los adjuntos suman mas de ' + Math.round(cfg.maxAttachmentBytes / 1024 / 1024) + ' MB. Reduce el tamano o compartelos por otra via.');
    }
    out.push({ filename: path.basename(abs), path: abs });
  }
  return out;
}

// ---------- Registro de auditoria ----------

export function appendLog(entry) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    /* el registro nunca debe romper un envio */
  }
}

export function countSentToday() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    let n = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.ok && typeof e.at === 'string' && e.at.slice(0, 10) === today) n += 1;
      } catch { /* linea corrupta, se ignora */ }
    }
    return n;
  } catch {
    return 0;
  }
}

export function readLog(limit = 20) {
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

// ---------- SMTP / IMAP ----------

const SENT_NAMES = ['sent', 'sent items', 'sent mail', 'enviados', 'elementos enviados', 'enviats', 'elements enviats', 'gesendet', 'envoyes'];

export async function findSentMailbox(client) {
  const list = await client.list();
  const special = list.find((m) => m.specialUse === '\\Sent');
  if (special) return special.path;
  const byName = list.find((m) => SENT_NAMES.includes(String(m.name || '').toLowerCase()));
  if (byName) return byName.path;
  const byPath = list.find((m) => SENT_NAMES.some((n) => String(m.path || '').toLowerCase().endsWith(n)));
  return byPath ? byPath.path : null;
}

async function appendToSent(cfg, rawBuffer, date) {
  const client = new ImapFlow(imapOptions(cfg));
  try {
    await client.connect();
    const mailbox = await findSentMailbox(client);
    if (!mailbox) return 'no se encontro la carpeta de enviados';
    await client.append(mailbox, rawBuffer, ['\\Seen'], date);
    return 'guardada en "' + mailbox + '"';
  } finally {
    try { await client.logout(); } catch { /* ignorar */ }
  }
}

export async function sendEmail(cfg, args) {
  if (!cfg.smtp?.host) {
    throw new Error('No hay servidor SMTP configurado. Ejecuta primero verify_email_setup para detectarlo.');
  }

  const to = normalizeRecipients(args.to, 'to');
  const cc = normalizeRecipients(args.cc, 'cc');
  const bcc = normalizeRecipients(args.bcc, 'bcc');
  enforceGuards(cfg, { to, cc, bcc });

  const subject = sanitizeHeader(args.subject);
  if (!subject) throw new Error('El asunto no puede estar vacio.');
  const bodyText = String(args.body_text ?? '').trim();
  if (!bodyText && !args.body_html) throw new Error('El correo no tiene cuerpo.');

  const attachments = resolveAttachments(cfg, args.attachments);
  const messageId = '<' + crypto.randomUUID() + '@' + (domainOf(cfg.email) || 'localhost') + '>';
  const date = new Date();

  const message = {
    from: { name: sanitizeHeader(cfg.senderName), address: cfg.email },
    to,
    cc,
    bcc,
    subject,
    text: bodyText || undefined,
    html: args.body_html || htmlFromText(bodyText, cfg.signatureHtml),
    attachments,
    messageId,
    date,
    disableUrlAccess: true,
  };
  if (args.reply_to) {
    message.replyTo = normalizeRecipients(args.reply_to, 'reply_to')[0];
  }

  const transporter = nodemailer.createTransport(smtpOptions(cfg));
  let info;
  try {
    info = await transporter.sendMail(message);
  } catch (err) {
    appendLog({ at: date.toISOString(), ok: false, profile: cfg.profileLabel, to, cc, bcc, subject, error: String(err?.message || err) });
    throw new Error('Fallo al enviar por SMTP (' + cfg.smtp.host + ':' + cfg.smtp.port + '): ' + (err?.message || err));
  } finally {
    transporter.close();
  }

  appendLog({ at: date.toISOString(), ok: true, profile: cfg.profileLabel, to, cc, bcc, subject, messageId, attachments: attachments.map((a) => a.filename) });

  let sentCopy = 'no solicitada';
  if (cfg.saveToSent && cfg.imap?.host) {
    try {
      const raw = await new MailComposer(message).compile().build();
      sentCopy = await appendToSent(cfg, raw, date);
    } catch (err) {
      sentCopy = 'no se pudo guardar (' + (err?.message || err) + ') pero el correo SI se envio';
    }
  } else if (cfg.saveToSent) {
    sentCopy = 'no hay IMAP configurado';
  }

  return { info, to, cc, bcc, subject, messageId, sentCopy, attachments, sentToday: countSentToday() };
}

export async function listRecentSent(cfg, limit = 10) {
  if (!cfg.imap?.host) throw new Error('No hay IMAP configurado, asi que no puedo leer la carpeta de enviados.');
  const client = new ImapFlow(imapOptions(cfg));
  try {
    await client.connect();
    const mailbox = await findSentMailbox(client);
    if (!mailbox) throw new Error('No se encontro la carpeta de enviados en este buzon.');
    const lock = await client.getMailboxLock(mailbox);
    try {
      const total = client.mailbox.exists;
      if (!total) return { mailbox, messages: [] };
      const from = Math.max(1, total - limit + 1);
      const messages = [];
      for await (const msg of client.fetch(from + ':' + total, { envelope: true })) {
        messages.push({
          date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
          subject: msg.envelope?.subject || '(sin asunto)',
          to: (msg.envelope?.to || []).map((a) => a.address).join(', '),
        });
      }
      return { mailbox, messages: messages.reverse() };
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch { /* ignorar */ }
  }
}

async function trySmtp(cfg, host) {
  const t = nodemailer.createTransport({
    ...smtpOptions(cfg, host),
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000,
  });
  try {
    await t.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    t.close();
  }
}

async function tryImap(cfg, host) {
  const opts = imapOptions(cfg, host);
  if (!opts) return { ok: false, error: 'sin host IMAP' };
  const client = new ImapFlow({ ...opts, socketTimeout: 8000 });
  try {
    await client.connect();
    const mailbox = await findSentMailbox(client);
    return { ok: true, mailbox };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    try { await client.logout(); } catch { /* ignorar */ }
  }
}

// Los MX del dominio identifican al proveedor real sin enviar credenciales a
// nadie. Si falla la consulta, seguimos: solo perdemos una pista.
async function resolveMx(domain) {
  if (!domain) return [];
  try {
    const records = await dns.resolveMx(domain);
    return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
  } catch {
    return [];
  }
}

export async function verifySetup(cfg) {
  const report = { configured: !!cfg.smtp?.host, smtp: null, imap: null, discovered: null, tried: [], mx: [], unsupported: null };

  if (cfg.smtp?.host) {
    report.smtp = { ...cfg.smtp, ...(await trySmtp(cfg, cfg.smtp)) };
    if (cfg.imap?.host) report.imap = { ...cfg.imap, ...(await tryImap(cfg, cfg.imap)) };
    if (report.smtp.ok) return report;
  }

  // Descubrimiento. Primero los MX, que nos dicen de quien es el buzon.
  report.mx = await resolveMx(domainOf(cfg.email));
  const byMx = matchProviderByMx(report.mx);
  if (byMx?.unsupported) {
    report.unsupported = byMx.unsupported;
    return report;
  }

  // Solo sondeamos hosts del propio dominio y, como maximo, el preset que los
  // MX hayan identificado. Nunca la lista completa de proveedores.
  for (const cand of candidateHosts(cfg.email, report.mx).slice(0, 8)) {
    const smtpRes = await trySmtp(cfg, cand.smtp);
    report.tried.push({
      label: cand.label,
      host: cand.smtp.host + ':' + cand.smtp.port,
      ok: smtpRes.ok,
      error: smtpRes.error,
    });
    if (smtpRes.ok) {
      const imapRes = await tryImap(cfg, cand.imap);
      // Fijamos lo detectado en la config viva y lo guardamos en disco, para que
      // el envio funcione ya en esta misma sesion y en los arranques siguientes.
      cfg.smtp = { ...cand.smtp };
      cfg.imap = imapRes.ok ? { ...cand.imap } : cfg.imap;
      const saved = writeDetectedCache(cfg.email, cfg.smtp, cfg.imap);
      report.discovered = {
        label: cand.label,
        smtp: cand.smtp,
        imap: cand.imap,
        imapOk: imapRes.ok,
        imapError: imapRes.error,
        sentMailbox: imapRes.mailbox,
        saved,
      };
      break;
    }
  }
  return report;
}
