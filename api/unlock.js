import { sign, verify, cookieOf } from '../lib/auth.js';

export const config = { runtime: 'edge' };

// Админский замок внутри сайта: открыть правки паролем EDIT_PASSWORD и закрыть обратно.
export default async function handler(req) {
  if (req.method !== 'POST') return new Response('no', { status: 405 });

  const session = await verify(cookieOf(req.headers.get('cookie'), 'sd'), process.env.SESSION_SECRET);
  if (!session) return json({ ok: false, error: 'нужен вход' }, 401);

  let body = {};
  try { body = await req.json(); } catch { /* пусто */ }

  if (body.lock) return withCookie(await token('viewer'), { ok: true, role: 'viewer' });

  await new Promise((r) => setTimeout(r, 600));
  if (!body.password || body.password !== process.env.EDIT_PASSWORD) return json({ ok: false }, 401);

  return withCookie(await token('editor'), { ok: true, role: 'editor' });
}

const token = (role) => sign({ role, exp: Date.now() + 30 * 864e5 }, process.env.SESSION_SECRET);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const withCookie = (t, data) =>
  new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json',
      'set-cookie': `sd=${t}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=2592000`
    }
  });
