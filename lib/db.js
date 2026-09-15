// Всё общение с базой. Ключ service_role живёт только здесь, на сервере.
import { createClient } from '@supabase/supabase-js';

// Клиент создаём лениво и с внятной ошибкой, если переменные не заданы.
let _db = null;
function client() {
  if (!_db) {
    // Из панели Supabase адрес часто копируют вместе с хвостом /rest/v1 —
    // библиотека дописывает его сама, поэтому срезаем. Заодно лишние косые черты.
    const url = (process.env.SUPABASE_URL || '').trim()
      .replace(/\/+$/, '')
      .replace(/\/rest\/v1$/i, '')
      .replace(/\/+$/, '');
    const key = (process.env.SUPABASE_SERVICE_KEY || '').trim();
    if (!url || !key) throw new Error('Не заданы переменные SUPABASE_URL и SUPABASE_SERVICE_KEY');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
      throw new Error('SUPABASE_URL должен выглядеть как https://xxxx.supabase.co, а сейчас: ' + url);
    }
    _db = createClient(url, key, { auth: { persistSession: false } });
  }
  return _db;
}

export const db = { from: (table) => client().from(table) };
export const storage = { from: (bucket) => client().storage.from(bucket) };

// База пишет змеиным регистром, интерфейс — верблюжьим. Переводим на границе.
// Внутренние ссылки на вложения одно время сохранялись с лишним хостом — чиним на лету.
function healLinks(list) {
  return (list || []).map((l) => (l && typeof l.url === 'string'
    ? { ...l, url: l.url.replace(/^https?:\/\/api\/file\?/i, '/api/file?') }
    : l));
}

// Держателей может быть несколько. Старые строки с парой колонок читаются как один держатель.
function ownersFrom(r) {
  if (Array.isArray(r.owners) && r.owners.length) return r.owners;
  if (r.owner_company || r.owner_person) return [{ company: r.owner_company || '', person: r.owner_person || '' }];
  return [];
}

export function rowToEvent(r) {
  return {
    id: r.id, kind: r.kind || 'event', forumId: r.forum_id || '',
    title: r.title || '', subtitle: r.subtitle || '',
    dateStart: r.date_start || '', dateEnd: r.date_end || '',
    timeStart: r.time_start || '', timeEnd: r.time_end || '',
    city: r.city || '', venue: r.venue || '',
    status: r.status || 'idea', prob: r.prob ?? 30, fmt: r.fmt || '',
    statusNote: r.status_note || '',
    about: r.about || '',
    owners: ownersFrom(r),
    owner: { company: r.owner_company || '', person: r.owner_person || '' },
    why: r.why || '',
    topics: r.topics || [], people: r.people || [], orgs: r.orgs || [],
    comms: r.comms || [], next: r.next || { text: '', due: '' }, links: healLinks(r.links),
    source: r.source || 'web'
  };
}

export function eventToRow(e) {
  const d = (v) => (v ? v : null);              // пустая строка — не дата
  return {
    id: e.id, kind: e.kind || 'event', forum_id: e.forumId || null,
    title: e.title || '', subtitle: e.subtitle || '',
    date_start: d(e.dateStart), date_end: d(e.dateEnd),
    time_start: e.timeStart || null, time_end: e.timeEnd || null,
    city: e.city || '', venue: e.venue || '',
    status: e.status || 'idea', prob: e.prob ?? 30, fmt: e.fmt || '',
    status_note: e.statusNote || '',
    about: e.about || '',
    owners: e.owners || [],
    owner_company: e.owners?.[0]?.company || e.owner?.company || '',
    owner_person: e.owners?.[0]?.person || e.owner?.person || '',
    why: e.why || '',
    topics: e.topics || [], people: e.people || [], orgs: e.orgs || [],
    comms: e.comms || [], next: e.next || { text: '', due: '' }, links: healLinks(e.links),
    source: e.source || 'web',
    updated_at: new Date().toISOString()
  };
}

export async function loadAll() {
  const [ev, st] = await Promise.all([
    db.from('events').select('*').order('date_start', { ascending: true }),
    db.from('settings').select('*')
  ]);
  if (ev.error) throw ev.error;
  const settings = {};
  for (const row of st.data || []) settings[row.key] = row.value;
  return {
    events: (ev.data || []).map(rowToEvent),
    formats: settings.formats || [],
    companies: settings.companies || []
  };
}

export async function saveEvents(events) {
  if (!events?.length) return;
  const { error } = await db.from('events').upsert(events.map(eventToRow));
  if (error) throw error;
}

export async function saveSettings(formats, companies) {
  const rows = [];
  if (formats) rows.push({ key: 'formats', value: formats });
  if (companies) rows.push({ key: 'companies', value: companies });
  if (!rows.length) return;
  const { error } = await db.from('settings').upsert(rows);
  if (error) throw error;
}

export function newId(kind) {
  return (kind === 'forum' ? 'f' : 'e') + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}
