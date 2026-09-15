import { sign } from '../lib/auth.js';

export const config = { runtime: 'edge' };

// Дверь на сайт. Пароль один — SITE_PASSWORD. Правки открываются отдельно, уже внутри.
export default async function handler(req) {
  if (req.method !== 'POST') return new Response('no', { status: 405 });

  let password = '';
  try { ({ password } = await req.json()); } catch { /* пусто */ }
  await new Promise((r) => setTimeout(r, 600));        // тормоз против перебора

  if (!password || password !== process.env.SITE_PASSWORD) {
    return new Response(JSON.stringify({ ok: false }), { status: 401 });
  }

  const token = await sign({ role: 'viewer', exp: Date.now() + 30 * 864e5 }, process.env.SESSION_SECRET);
  return new Response(JSON.stringify({ ok: true, role: 'viewer' }), {
    headers: {
      'content-type': 'application/json',
      'set-cookie': `sd=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=2592000`
    }
  });
}
