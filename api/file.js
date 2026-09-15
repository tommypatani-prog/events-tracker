import { verify, cookieOf } from '../lib/auth.js';
import { storage } from '../lib/db.js';

// Отдаёт вложение по временной ссылке — и только тому, кто вошёл на сайт.
export default async function handler(req, res) {
  const session = await verify(cookieOf(req.headers.cookie, 'sd'), process.env.SESSION_SECRET);
  if (!session) return res.status(401).json({ error: 'нужен вход' });

  const path = String(req.query.path || '');
  if (!path || path.includes('..')) return res.status(400).json({ error: 'плохой путь' });

  const { data, error } = await storage.from('materials').createSignedUrl(path, 300);
  if (error || !data?.signedUrl) return res.status(404).json({ error: 'файл не найден' });

  res.redirect(302, data.signedUrl);
}
