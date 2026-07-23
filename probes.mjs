import tls from 'node:tls';
import net from 'node:net';
import { lookup } from 'node:dns/promises';

const WHOIS_SERVERS = { tw: 'whois.twnic.net.tw' };

function daysUntil(dateString) {
  const timestamp = Date.parse(dateString);
  if (Number.isNaN(timestamp)) return null;
  return Math.floor((timestamp - Date.now()) / 86_400_000);
}

function evaluateBody(body, { keyword, keywordAbsent }) {
  if (keyword && !body.includes(keyword)) return { ok: false, reason: `Missing text: ${keyword}` };
  if (keywordAbsent && body.includes(keywordAbsent)) return { ok: false, reason: `Unexpected text: ${keywordAbsent}` };
  return { ok: true };
}

function expiryFromRdap(payload) {
  if (!Array.isArray(payload?.events)) return null;
  const expiration = payload.events.find((event) => event?.eventAction === 'expiration');
  return expiration ? expiration.eventDate : null;
}

// Parses the expiry date out of a WHOIS record. TWNIC (.tw) uses "Record expires on";
// other registries use "Registry Expiry Date" / "Expiration Date" / "paid-till".
function expiryFromWhois(text) {
  const patterns = [
    /Record expires on\s+(\d{4}-\d{2}-\d{2})/i,
    /Registry Expiry Date:\s*([0-9T:.\-Z]+)/i,
    /Exp(?:iry|iration) Date:\s*([0-9T:.\-Z]+)/i,
    /paid-till:\s*([0-9T:.\-Z]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function whoisServerFor(domain) {
  return WHOIS_SERVERS[domain.split('.').pop().toLowerCase()] || null;
}

function queryWhois(host, query, timeoutMs) {
  return new Promise((resolve) => {
    let data = '';
    const socket = net.connect(43, host, () => socket.write(`${query}\r\n`));
    socket.setTimeout(timeoutMs);
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('timeout', () => { socket.destroy(); resolve(data); });
    socket.on('error', () => resolve(data));
  });
}

async function checkCertificate(hostname, { port = 443, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let socket;
    let timer;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    try {
      socket = tls.connect({ host: hostname, port, servername: hostname });
      timer = setTimeout(() => {
        socket.destroy();
        finish({ ok: false, error: 'Timed out' });
      }, timeoutMs);
      socket.once('secureConnect', () => {
        try {
          const cert = socket.getPeerCertificate();
          socket.end();
          finish({
            ok: true,
            validTo: cert.valid_to,
            daysRemaining: daysUntil(cert.valid_to),
            issuer: cert.issuer?.O || cert.issuer?.CN || '',
            subject: cert.subject?.CN || hostname,
          });
        } catch (error) {
          socket.destroy();
          finish({ ok: false, error: String(error?.message || error) });
        }
      });
      socket.once('error', (error) => finish({ ok: false, error: String(error?.message || error) }));
    } catch (error) {
      socket?.destroy();
      finish({ ok: false, error: String(error?.message || error) });
    }
  });
}

async function checkDomainExpiry(domain, { timeoutMs = 12000 } = {}) {
  const whoisHost = whoisServerFor(domain);
  if (whoisHost) {
    const text = await queryWhois(whoisHost, domain, timeoutMs);
    const date = expiryFromWhois(text);
    if (date) return { ok: true, expiryDate: date, daysRemaining: daysUntil(date), source: 'whois' };
    return { ok: false, supported: Boolean(text), error: text ? 'No expiry field in WHOIS' : 'WHOIS no response' };
  }
  try {
    const response = await fetch(`https://rdap.org/domain/${domain}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/rdap+json' },
    });
    if (!response.ok) return { ok: false, supported: response.status !== 404, error: `RDAP ${response.status}` };
    const payload = await response.json();
    const date = expiryFromRdap(payload);
    if (!date) return { ok: false, supported: false };
    return { ok: true, expiryDate: date, daysRemaining: daysUntil(date), source: 'rdap' };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function resolveHost(hostname) {
  try {
    const { address } = await lookup(hostname);
    return { ok: true, address };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

export { checkCertificate, checkDomainExpiry, daysUntil, evaluateBody, expiryFromRdap, expiryFromWhois, resolveHost };
