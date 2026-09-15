import { db, loadAll } from '../lib/db.js';
import { send, esc } from '../lib/tg.js';

const FIELD_RU = { topics: 'темы', people: 'участники', next: 'следующий шаг', links: 'материалы', owner: 'держатель' };
const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

// Раз в сутки: проверяем правила и шлём напоминания.
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).end();

  try {
    const sent = await run();
    res.json({ ok: true, sent });
  } catch (e) {
    console.error('cron', e);
    res.status(500).json({ error: String(e.message || e) });
  }
}

export async function run() {
  const today = new Date().toISOString().slice(0, 10);
  const [{ data: rules }, { data: chats }, { events }] = await Promise.all([
    db.from('reminder_rules').select('*').eq('enabled', true),
    db.from('tg_chats').select('chat_id'),
    loadAll()
  ]);
  if (!rules?.length || !chats?.length) return 0;

  const upcoming = events.filter((e) => (e.dateStart || '') >= today);
  const hits = [];

  for (const e of upcoming) {
    const days = Math.round((new Date(e.dateStart + 'T00:00:00') - new Date(today + 'T00:00:00')) / 864e5);
    for (const rule of rules) {
      if (days !== rule.days_before) continue;
      if (rule.statuses?.length && !rule.statuses.includes(e.status)) continue;

      const empty = (rule.requires || []).filter((f) => isEmpty(e, f));
      if ((rule.requires || []).length && !empty.length) continue;   // всё заполнено — молчим

      const { data: already } = await db.from('reminder_log').select('rule_id')
        .eq('rule_id', rule.id).eq('event_id', e.id).eq('sent_on', today).maybeSingle();
      if (already) continue;

      hits.push({ rule, event: e, days, empty });
      await db.from('reminder_log').insert({ rule_id: rule.id, event_id: e.id, sent_on: today });
    }
  }

  if (!hits.length) return 0;

  const url = process.env.SITE_URL;
  const text = ['<b>Напоминания на сегодня</b>', '', ...hits.map(({ event, days, empty }) => {
    const when = human(event.dateStart);
    const tail = empty.length ? ` — не заполнено: <b>${empty.map((f) => FIELD_RU[f] || f).join(', ')}</b>` : '';
    return `• <b>${esc(event.title)}</b> — ${dayWord(days)}, ${esc(when)}${tail}`;
  })].join('\n') + (url ? `\n\n<a href="${esc(url)}">Открыть трекер</a>` : '');

  for (const c of chats) await send(c.chat_id, text);
  return hits.length;
}

function isEmpty(e, field) {
  if (field === 'topics') return !(e.topics || []).filter(Boolean).length;
  if (field === 'people') return !(e.people || []).filter((p) => p.name).length;
  if (field === 'links') return !(e.links || []).filter((l) => l.url || l.label).length;
  if (field === 'next') return !e.next?.text;
  if (field === 'owner') return !(e.owner?.company || e.owner?.person);
  return false;
}

function dayWord(d) {
  if (d === 0) return 'сегодня';
  if (d === 1) return 'завтра';
  if (d === 2) return 'послезавтра';
  return `через ${d} дн.`;
}

function human(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${+m[3]} ${MONTHS[+m[2] - 1]}` : iso;
}
