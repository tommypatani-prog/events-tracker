// Пропуск для сайта: подписанная строка в куке. Подделать нельзя, не зная SESSION_SECRET.
const enc = new TextEncoder();
const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function sign(payload, secret) {
  const body = b64(enc.encode(JSON.stringify(payload)));
  const mac = b64(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return body + '.' + mac;
}

export async function verify(token, secret) {
  if (!token || !secret || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expect = b64(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  if (mac.length !== expect.length) return null;
  let diff = 0;                                   // сравнение без утечки по времени
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const json = atob(body.replace(/-/g, '+').replace(/_/g, '/'));
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}

export function cookieOf(header, name) {
  const m = (header || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
