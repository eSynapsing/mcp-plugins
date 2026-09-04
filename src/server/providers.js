// Presets de proveedores de correo.
// Puerto 465 => TLS implicito (secure: true). Puerto 587 => STARTTLS (secure: false).

export const PROVIDERS = {
  'ionos-es': {
    label: 'IONOS (España, .es)',
    smtp: { host: 'smtp.ionos.es', port: 465 },
    imap: { host: 'imap.ionos.es', port: 993 },
  },
  'ionos-com': {
    label: 'IONOS (internacional, .com)',
    smtp: { host: 'smtp.ionos.com', port: 465 },
    imap: { host: 'imap.ionos.com', port: 993 },
  },
  'ionos-de': {
    label: 'IONOS (Alemania, .de)',
    smtp: { host: 'smtp.ionos.de', port: 465 },
    imap: { host: 'imap.ionos.de', port: 993 },
  },
  ovh: {
    label: 'OVH / OVHcloud',
    smtp: { host: 'ssl0.ovh.net', port: 465 },
    imap: { host: 'ssl0.ovh.net', port: 993 },
  },
  strato: {
    label: 'Strato',
    smtp: { host: 'smtp.strato.de', port: 465 },
    imap: { host: 'imap.strato.de', port: 993 },
  },
  hostinger: {
    label: 'Hostinger',
    smtp: { host: 'smtp.hostinger.com', port: 465 },
    imap: { host: 'imap.hostinger.com', port: 993 },
  },
  'zoho-eu': {
    label: 'Zoho Mail (UE)',
    smtp: { host: 'smtp.zoho.eu', port: 465 },
    imap: { host: 'imap.zoho.eu', port: 993 },
  },
  'zoho-com': {
    label: 'Zoho Mail (internacional)',
    smtp: { host: 'smtp.zoho.com', port: 465 },
    imap: { host: 'imap.zoho.com', port: 993 },
  },
  gmail: {
    label: 'Gmail / Google Workspace (requiere contraseña de aplicación)',
    smtp: { host: 'smtp.gmail.com', port: 465 },
    imap: { host: 'imap.gmail.com', port: 993 },
    note: 'Gmail exige una contraseña de aplicación de 16 caracteres, no la contraseña normal de la cuenta.',
  },
  cpanel: {
    label: 'Alojamiento genérico cPanel/Plesk (mail.tudominio)',
    derive: (domain) => ({
      smtp: { host: `mail.${domain}`, port: 465 },
      imap: { host: `mail.${domain}`, port: 993 },
    }),
  },
};

// Huellas de registros MX. Sirven para identificar el proveedor real del dominio
// SIN tener que probar credenciales contra servidores de terceros.
const MX_FINGERPRINTS = [
  { match: /\bionos\.es$|kundenserver\.de$/i, provider: 'ionos-es' },
  { match: /\bionos\.com$|\b1and1\.com$/i, provider: 'ionos-com' },
  { match: /\bionos\.de$/i, provider: 'ionos-de' },
  { match: /\bovh\.net$/i, provider: 'ovh' },
  { match: /rzone\.de$|\bstrato\./i, provider: 'strato' },
  { match: /hostinger\.com$/i, provider: 'hostinger' },
  { match: /zoho\.eu$/i, provider: 'zoho-eu' },
  { match: /zoho\.com$/i, provider: 'zoho-com' },
  { match: /google\.com$|googlemail\.com$/i, provider: 'gmail' },
];

// Proveedores que NO admiten SMTP con contraseña: no tiene sentido sondearlos.
const UNSUPPORTED_MX = [
  { match: /protection\.outlook\.com$|\boutlook\.com$/i, label: 'Microsoft 365 / Exchange Online' },
];

export function domainOf(email) {
  const at = String(email || '').lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
}

// Devuelve { provider } si los MX identifican un preset conocido,
// { unsupported } si apuntan a un proveedor sin SMTP con contraseña,
// o null si no reconocemos nada.
export function matchProviderByMx(mxHosts = []) {
  const hosts = mxHosts.map((h) => String(h || '').toLowerCase().replace(/\.$/, '')).filter(Boolean);
  for (const h of hosts) {
    for (const u of UNSUPPORTED_MX) if (u.match.test(h)) return { unsupported: u.label, mx: h };
  }
  for (const h of hosts) {
    for (const f of MX_FINGERPRINTS) if (f.match.test(h)) return { provider: f.provider, mx: h };
  }
  return null;
}

// Candidatos que prueba `verify_email_setup` cuando el proveedor es "auto".
//
// IMPORTANTE: solo se sondean servidores del propio dominio del usuario y, como
// maximo, el preset que sus registros MX hayan identificado. Nunca recorremos
// toda la lista de proveedores: eso enviaria el usuario y la contraseña a
// servidores de terceros que no son los suyos.
export function candidateHosts(email, mxHosts = []) {
  const d = domainOf(email);
  const out = [];
  const seen = new Set();
  const push = (label, smtp, imap) => {
    const key = `${smtp.host}:${smtp.port}|${imap.host}:${imap.port}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label, smtp, imap });
  };

  if (d) {
    push(`mail.${d} (cPanel/Plesk habitual)`, { host: `mail.${d}`, port: 465 }, { host: `mail.${d}`, port: 993 });
    push(`smtp.${d} / imap.${d}`, { host: `smtp.${d}`, port: 465 }, { host: `imap.${d}`, port: 993 });
    push(`mail.${d} con STARTTLS (587)`, { host: `mail.${d}`, port: 587 }, { host: `mail.${d}`, port: 993 });
    push(`smtp.${d} con STARTTLS (587)`, { host: `smtp.${d}`, port: 587 }, { host: `imap.${d}`, port: 993 });
    push(`correo.${d}`, { host: `correo.${d}`, port: 465 }, { host: `correo.${d}`, port: 993 });
  }

  const byMx = matchProviderByMx(mxHosts);
  if (byMx?.provider) {
    const p = PROVIDERS[byMx.provider];
    if (p && !p.derive) {
      push(`${p.label} — identificado por los MX del dominio (${byMx.mx})`, p.smtp, p.imap);
      push(
        `${p.label} con STARTTLS (587)`,
        { host: p.smtp.host, port: 587 },
        { host: p.imap.host, port: p.imap.port },
      );
    }
  }

  return out;
}

export function providerList() {
  return Object.entries(PROVIDERS).map(([k, v]) => `${k} — ${v.label}`);
}
