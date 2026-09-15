import { verify, cookieOf } from '../lib/auth.js';
import { db, loadAll, saveEvents, saveSettings } from '../lib/db.js';

export default async function handler(req, res) {
  const session = await verify(cookieOf(req.headers.cookie, 'sd'), process.env.SESSION_SECRET);
  if (!session) return res.status(401).json({ error: 'нужен вход' });

  try {
    if (req.method === 'GET') {
      const data = await loadAll();
      return res.json({ ...data, role: session.role });
    }

    if (req.method === 'PUT') {
      if (session.role !== 'editor') return res.status(403).json({ error: 'только чтение' });
      const { events, formats, companies, deleted } = req.body || {};
      if (deleted?.length) await db.from('events').delete().in('id', deleted);
      await saveEvents(events);
      await saveSettings(formats, companies);
      return res.json({ ok: true });
    }

    res.status(405).end();
  } catch (e) {
    // Подсказка в логах, чтобы не гадать над кодами PostgREST
    const hint =
      e.code === 'PGRST205' ? 'Таблицы нет — выполните supabase.sql в SQL Editor'
      : e.code === 'PGRST125' ? 'Проверьте SUPABASE_URL: он должен быть https://xxxx.supabase.co без косой черты на конце'
      : e.code === '42P01' ? 'Таблица events не создана — выполните supabase.sql'
      : e.message && e.message.includes('SUPABASE_URL') ? e.message
      : 'Неизвестная ошибка базы';
    console.error('events:', hint, e.code || '', e.message || '');
    res.status(500).json({ error: hint });
  }
}
