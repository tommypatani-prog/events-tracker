import { db, loadAll, saveEvents, newId } from '../lib/db.js';
import { parseMessage, refineDraft, answerQuestion } from '../lib/ai.js';
import { send, typing, esc, keyboard, answerCallback, editText, download } from '../lib/tg.js';
import { storage } from '../lib/db.js';

const STATUS_RU = { idea: 'Идея', talks: 'Обсуждение', conf: 'Подтверждено', decl: 'Отказ', done: 'Прошло' };
const ST_ORDER = ['idea', 'talks', 'conf', 'decl', 'done'];
const FIELD_RU = { topics: 'темы', people: 'участники', next: 'следующий шаг', links: 'материалы', owner: 'держатель' };
const FIELD_ALIAS = {
  темы: 'topics', тезисы: 'topics', тема: 'topics',
  участники: 'people', спикеры: 'people', гости: 'people',
  шаг: 'next', 'следующий шаг': 'next', задача: 'next',
  материалы: 'links', ссылки: 'links', сценарий: 'links',
  держатель: 'owner', ответственный: 'owner'
};
const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

export const config = { maxDuration: 60 };     // потолок бесплатного тарифа Vercel

export default async function handler(req, res) {
  if (req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).end();
  }
  try {
    await handleUpdate(req.body || {});
  } catch (e) {
    console.error('telegram', e);
    // Молчаливое падение — худшее, что может быть: человек ждёт ответа и не понимает, что не так.
    const chatId = req.body?.message?.chat?.id || req.body?.callback_query?.message?.chat?.id;
    if (chatId) await send(chatId, friendlyError(e)).catch(() => {});
  }
  res.status(200).json({ ok: true });     // всегда 200, иначе телеграм будет слать повторы
}

// Понятная причина вместо стека вызовов: чаще всего дело не в коде.
function friendlyError(e) {
  const raw = String(e?.message || e);
  const status = e?.status;

  if (/credit balance is too low/i.test(raw)) {
    return '💳 <b>Закончились деньги на счёте Anthropic.</b>\n\n'
      + 'Пополните баланс на <a href="https://console.anthropic.com/settings/billing">console.anthropic.com</a> — '
      + 'и я сразу заработаю. Перезапускать ничего не нужно.';
  }
  if (status === 401 || /authentication|invalid x-api-key/i.test(raw)) {
    return '🔑 <b>Ключ Anthropic не принят.</b> Проверьте переменную ANTHROPIC_API_KEY в настройках Vercel: '
      + 'возможно, ключ отозван или скопирован не полностью.';
  }
  if (status === 429 || /rate limit/i.test(raw)) {
    return '⏳ Слишком много запросов подряд. Подождите минуту и пришлите ещё раз.';
  }
  if (/timeout|aborted|ETIMEDOUT/i.test(raw)) {
    return '⏱ Не успел разобрать за отведённое время. Если это большой документ, пришлите его частями.';
  }
  if (/SUPABASE|supabaseUrl|PGRST/i.test(raw)) {
    return '🗄 Не достучался до базы. Проверьте SUPABASE_URL и SUPABASE_SERVICE_KEY в настройках Vercel.';
  }
  return '⚠️ Что-то сломалось у меня внутри.\n\n<code>' + esc(raw.slice(0, 300)) + '</code>';
}

async function handleUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat.id;
  if (!(await allowed(chatId, msg.from))) {
    return send(chatId, `Не знаю вас. Попросите добавить ваш id <code>${esc(chatId)}</code> в настройку TG_ALLOWED_IDS.`);
  }

  const text = (msg.text || msg.caption || '').trim();
  if (text.startsWith('/')) return handleCommand(chatId, text, msg);

  const attachments = pickAttachments(msg);
  const mime = msg.document?.mime_type || '';
  if (!attachments.length && /word|msword|officedocument/.test(mime)) {
    return send(chatId, '📄 Word я пока не читаю. Сохраните файл как PDF и пришлите снова — '
      + 'в Word это «Файл → Сохранить как → PDF».');
  }
  if (!text && !attachments.length) {
    return send(chatId, 'Пока понимаю текст, картинки, PDF и текстовые файлы. '
      + 'Голосовые и видео не читаю — перескажите словами.');
  }

  await typing(chatId);
  const ctx = await buildContext(msg);

  let files = [];
  try {
    files = await fetchFiles(attachments);
  } catch (e) {
    console.error('файлы', e);
    await send(chatId, 'Не смог скачать вложение — разбираю по тексту.');
  }
  if (files.length) {
    await typing(chatId);
    await send(chatId, '📄 Читаю документ. Если внутри список мероприятий, это займёт до минуты.');
  }

  // Если открыт черновик — считаем сообщение ответом на уточняющий вопрос
  const draft = await openDraft(chatId);
  if (draft?.payload?._batch) {
    const { kept, removed } = dropByNumbers(draft.payload._batch, text);
    if (!removed) return send(chatId, 'Напишите номера, которые не нужно заносить: <code>3, 7-9</code>.');
    if (!kept.length) {
      await db.from('drafts').update({ status: 'cancelled' }).eq('id', draft.id);
      return send(chatId, 'Убрал все — заносить нечего.');
    }
    const payload = { ...draft.payload, _batch: kept };
    await db.from('drafts').update({ payload, status: 'ready', updated_at: new Date().toISOString() }).eq('id', draft.id);
    return send(chatId, batchPreview(kept, payload._files), keyboard(batchKeys(draft.id, kept.length)));
  }

  if (draft) {
    const parsed = await refineDraft(draft, text, ctx, files);
    // служебные пометки режима правки не должны потеряться при слиянии
    if (draft.payload?._mode) {
      parsed.event = { ...(parsed.event || {}), _mode: draft.payload._mode, _target: draft.payload._target };
    }
    return continueDraft(chatId, draft, parsed, ctx, files);
  }

  console.log('разбор:', JSON.stringify({
    файлов: files.length,
    файлы: files.map((f) => `${f.name}/${f.type}/${f.base64 ? Math.round(f.base64.length * 0.75 / 1024) + 'КБ' : 'текст'}`),
    вложений_замечено: attachments.length,
    длина_текста: text.length
  }));
  const parsed = await parseMessage(text, ctx, files);
  console.log('модель вернула:', JSON.stringify({
    intent: parsed.intent, записей: parsed.items?.length || 0,
    есть_event: !!parsed.event?.title, note: parsed.note, вопрос: parsed.question
  }));

  if (parsed.intent === 'question') {
    const { events } = await loadAll();
    const answer = await answerQuestion(text, events, ctx);
    return send(chatId, esc(answer));
  }

  if (parsed.intent === 'update' || parsed.intent === 'delete') {
    const target = ctx.events.find((e) => e.id === parsed.targetId);
    if (!target) {
      return send(chatId, parsed.question
        ? esc(parsed.question)
        : 'Не понял, о какой записи речь. Назовите её точнее — например, «сессия Открытый диалог на ВЭФ».');
    }
    return proposeChange(chatId, target, parsed, text);
  }

  if (parsed.items?.length) {
    const stored = await keepFiles(files);
    const { data } = await db.from('drafts')
      .insert({
        chat_id: chatId,
        source_text: text || '(документ без текста)',
        payload: { _batch: parsed.items, _files: stored },
        missing: [], status: 'ready'
      }).select().single();
    return send(chatId, batchPreview(parsed.items, stored), keyboard(batchKeys(data.id, parsed.items.length)));
  }

  if (parsed.intent !== 'add' || !parsed.event) {
    if (files.length) {
      const what = files.map((f) => `${f.name} (${f.type === 'pdf' ? 'PDF' : f.type})`).join(', ');
      return send(chatId, `Файл прочитал — <b>${esc(what)}</b> — но мероприятий в нём не распознал.\n\n`
        + (parsed.note ? `<i>${esc(parsed.note)}</i>\n\n` : '')
        + 'Если внутри всё-таки список — напишите одной строкой, что искать: '
        + '«занеси все мероприятия из файла».');
    }
    return send(chatId, 'Не увидел здесь мероприятия. Перешлите приглашение или анонс — занесу. '
      + (parsed.note ? `\n\n<i>${esc(parsed.note)}</i>` : '')
      + '\n\nИли спросите что-нибудь про то, что уже в базе.');
  }

  const stored = await keepFiles(files);
  const { data } = await db.from('drafts')
    .insert({
      chat_id: chatId,
      source_text: text || '(вложение без текста)',
      payload: {
        ...(parsed.event || {}),
        links: parsed.event?.links || [],
        _children: parsed.children || [],
        _files: stored,
        _filesTo: parsed.attachFilesTo || 'parent'
      },
      missing: parsed.missing || []
    })
    .select().single();
  return continueDraft(chatId, data, parsed, ctx, []);
}

// ── дополнить или удалить существующую запись ───────────────────
async function proposeChange(chatId, target, parsed, text) {
  const mode = parsed.intent;
  const patch = mode === 'update' ? (parsed.event || {}) : {};
  const stored = await keepFiles([]);            // файлы сюда не тянем — только правка полей
  const { data: draft } = await db.from('drafts')
    .insert({
      chat_id: chatId,
      source_text: text,
      payload: { _mode: mode, _target: target.id, ...patch, links: [...(patch.links || []), ...stored] },
      missing: []
    }).select().single();

  if (mode === 'delete') {
    return send(chatId, `Удалить <b>${esc(target.title)}</b> (${esc(human(target.dateStart))})?`,
      keyboard([[
        { text: '🗑 Удалить', callback_data: `save:${draft.id}` },
        { text: '✖️ Оставить', callback_data: `drop:${draft.id}` }
      ]]));
  }

  const diff = describePatch(target, patch);
  if (!diff.length) return send(chatId, 'Не понял, что именно поменять. Скажите конкретнее.');
  return send(chatId, `<b>${esc(target.title)}</b>\n<i>${esc(human(target.dateStart))}</i>\n\n`
    + diff.map((d) => '• ' + d).join('\n'),
    keyboard([
      [{ text: '✅ Дополнить', callback_data: `save:${draft.id}` },
       { text: '✖️ Не надо', callback_data: `drop:${draft.id}` }],
      [{ text: '✏️ Поправить', callback_data: `edit:${draft.id}` }]
    ]));
}

function describePatch(target, p) {
  const out = [];
  const named = { title: 'название', dateStart: 'дата', dateEnd: 'дата окончания',
    timeStart: 'начало', timeEnd: 'окончание', city: 'город',
    venue: 'площадка', fmt: 'формат', status: 'статус', statusNote: 'комментарий',
    about: 'описание', why: 'чем интересно', subtitle: 'подзаголовок' };
  for (const k of Object.keys(named)) {
    if (p[k] !== undefined && p[k] !== '' && String(p[k]) !== String(target[k] ?? '')) {
      out.push(`${named[k]}: <b>${esc(p[k])}</b>`);
    }
  }
  if (p.people?.length) out.push(`участники: <b>+${p.people.map((x) => esc(x.name)).join(', ')}</b>`);
  if (p.orgs?.length) out.push(`организаторы: <b>+${p.orgs.map((x) => esc(x.name)).join(', ')}</b>`);
  if (p.owners?.length) out.push(`держатели: <b>+${p.owners.map((x) => esc([x.company, x.person].filter(Boolean).join(' · '))).join(', ')}</b>`);
  if (p.links?.length) out.push(`материалы: <b>+${p.links.length}</b>`);
  if (p.next?.text) out.push(`следующий шаг: <b>${esc(p.next.text)}</b>`);
  return out;
}

// ── черновик: уточняем, пока не хватает критичного ──────────────
async function continueDraft(chatId, draft, parsed, ctx, files = []) {
  const payload = { ...(draft.payload || {}), ...(parsed.event || {}) };
  const keptLinks = [...(draft.payload?.links || []), ...(await keepFiles(files))];
  if (keptLinks.length) {
    const seen = new Set();
    payload.links = [...keptLinks, ...(parsed.event?.links || [])]
      .filter((l) => l && l.url && !seen.has(l.url) && seen.add(l.url));
  }
  const missing = payload._mode ? [] : criticalMissing(payload);
  const asked = (draft.asked || 0) + (parsed.question ? 1 : 0);

  if (missing.length && parsed.question && asked <= 3) {
    await db.from('drafts').update({ payload, missing, asked, status: 'asking', updated_at: new Date().toISOString() })
      .eq('id', draft.id);
    return send(chatId, `${esc(parsed.question)}\n\n<i>Или /отмена, чтобы не заносить.</i>`);
  }

  await db.from('drafts').update({ payload, missing, asked, status: 'ready', updated_at: new Date().toISOString() })
    .eq('id', draft.id);

  const note = missing.length
    ? `\n\n<i>Не хватает: ${missing.map((m) => FIELD_RU[m] || m).join(', ')}. Можно занести и дописать на сайте.</i>`
    : '';
  return send(chatId, preview(payload) + note, keyboard(mainKeys(draft.id)));
}

/* ── массовый занос ──────────────────────────────────────────── */
const TG_LIMIT = 3600;

function batchPreview(items, files) {
  const head = `📋 <b>Нашёл мероприятий: ${items.length}</b>`
    + (files?.length ? `\n📎 ${esc(files.map((f) => f.label).join(', '))}` : '') + '\n';
  const lines = [];
  let used = head.length;
  items.forEach((it, i) => {
    const kids = it.children?.length ? ` <i>(+${it.children.length} внутри)</i>` : '';
    const line = `${i + 1}. <b>${esc(it.title || 'без названия')}</b>`
      + (it.dateStart ? ` · ${esc(human(it.dateStart))}` : ' · <i>дата не указана</i>')
      + (it.city ? ` · ${esc(it.city)}` : '') + kids;
    if (used + line.length < TG_LIMIT) { lines.push(line); used += line.length + 1; }
  });
  const rest = items.length - lines.length;
  return head + lines.join('\n') + (rest > 0 ? `\n\n<i>…и ещё ${rest} — все они тоже занесутся</i>` : '');
}

function batchKeys(id, n) {
  return [
    [{ text: `✅ Занести все (${n})`, callback_data: `save:${id}` },
     { text: '✖️ Не надо', callback_data: `drop:${id}` }],
    [{ text: '✏️ Убрать лишние', callback_data: `edit:${id}` }]
  ];
}

// «3, 7-9» → выкидываем эти номера из списка
function dropByNumbers(items, text) {
  const kill = new Set();
  const re = /(\d+)\s*(?:[-–—]\s*(\d+))?/g;
  let m;
  while ((m = re.exec(text))) {
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let i = a; i <= b; i++) kill.add(i);
  }
  return { kept: items.filter((_, i) => !kill.has(i + 1)), removed: kill.size };
}

/* ── кнопки под карточкой ────────────────────────────────────── */
function mainKeys(id) {
  return [
    [{ text: '✅ Занести', callback_data: `save:${id}` }, { text: '✖️ Не надо', callback_data: `drop:${id}` }],
    [{ text: '✏️ Поправить', callback_data: `edit:${id}` }]
  ];
}

// Клавиатура правки: списочные поля — кнопками, остальное — сообщением.
async function editKeys(id, payload) {
  const { formats } = await loadAll();
  const rows = [];
  rows.push(ST_ORDER.slice(0, 3).map((k) => ({
    text: (payload.status === k ? '• ' : '') + STATUS_RU[k],
    callback_data: `set:${id}:status:${k}`
  })));
  rows.push(ST_ORDER.slice(3).map((k) => ({
    text: (payload.status === k ? '• ' : '') + STATUS_RU[k],
    callback_data: `set:${id}:status:${k}`
  })));
  for (let i = 0; i < formats.length; i += 2) {
    rows.push(formats.slice(i, i + 2).map((f, j) => ({
      text: (payload.fmt === f.name ? '• ' : '') + f.name,
      callback_data: `set:${id}:fmt:${i + j}`
    })));
  }
  rows.push([{ text: '◀️ Готово', callback_data: `back:${id}` }]);
  return rows;
}

const EDIT_HINT = '\n\n<i>Что поправить — напишите словами: «дата 12 ноября», «город Казань», '
  + '«площадка Экспофорум», «убери держателя». Статус и формат — кнопками ниже.</i>';

function criticalMissing(p) {
  const out = [];
  if (!p.title) out.push('title');
  if (!p.dateStart) out.push('dateStart');
  return out;
}

function preview(p) {
  const lines = [`<b>${esc(p.title || 'Без названия')}</b>`];
  if (p.kind === 'forum') lines[0] = '🗂 ' + lines[0] + '  <i>(форум)</i>';
  const when = [p.dateStart, p.dateEnd].filter(Boolean).map(human).join(' — ');
  if (when) lines.push(`📅 ${esc(when)}`
    + (p.timeStart ? ` · 🕐 ${esc(p.timeStart)}${p.timeEnd ? '–' + esc(p.timeEnd) : ''}` : ''));
  const place = [p.city, p.venue].filter(Boolean).join(', ');
  if (place) lines.push(`📍 ${esc(place)}`);
  if (p.fmt || p.status) lines.push(`🎤 ${esc(p.fmt || 'формат не выбран')}`
    + (p.status ? ' · ' + esc((STATUS_RU[p.status] || p.status).toLowerCase()) : '')
    + (p.statusNote ? ` — <i>${esc(p.statusNote)}</i>` : ''));
  const owner = (p.owners || []).map((o) => [o.company, o.person].filter(Boolean).join(' · ')).filter(Boolean).join('; ');
  if (owner) lines.push(`👤 ${esc(owner)}`);

  if (p.orgs?.length) lines.push(`✉️ ${esc(p.orgs.map((o) => [o.name, o.contact].filter(Boolean).join(', ')).join(' / '))}`);
  var att = [...(p.links || []), ...(p._files || [])];
  if (att.length) lines.push(`📎 ${esc(att.map((l) => l.label || l.url).join(', '))}`);
  if (p._children?.length) {
    lines.push('');
    lines.push(`<b>Внутри — ${p._children.length}:</b>`);
    p._children.forEach((c, i) => {
      const where = String(p._filesTo) === String(i) ? ' 📎' : '';
      lines.push(`${i + 1}. ${esc(c.title || 'без названия')}`
        + (c.dateStart ? ` · <i>${esc(human(c.dateStart))}</i>` : '')
        + (c.fmt ? ` · ${esc(c.fmt)}` : '') + where);
    });
  }
  if (p.next?.text) lines.push(`➡️ ${esc(p.next.text)}${p.next.due ? ' · до ' + esc(human(p.next.due)) : ''}`);
  if (p.why) lines.push(`\n<i>${esc(p.why.slice(0, 240))}</i>`);
  return lines.join('\n');
}

function human(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
}

// ── кнопки ──────────────────────────────────────────────────────
async function handleCallback(cq) {
  const [action, id, field, value] = (cq.data || '').split(':');
  const chatId = cq.message.chat.id;
  if (!(await allowed(chatId, cq.from))) return answerCallback(cq.id, 'Нет доступа');

  const { data: draft } = await db.from('drafts').select('*').eq('id', id).single();
  if (!draft) return answerCallback(cq.id, 'Черновик уже закрыт');

  if (action === 'edit' && draft.payload?._batch) {
    await db.from('drafts').update({ status: 'editing' }).eq('id', id);
    await answerCallback(cq.id, 'Какие убрать?');
    return send(chatId, 'Напишите номера, которые не нужно заносить — например <code>3, 7-9</code>. '
      + 'Остальные занесу.');
  }

  if (action === 'edit') {
    await db.from('drafts').update({ status: 'editing' }).eq('id', id);
    await answerCallback(cq.id, 'Что поправить?');
    return editText(chatId, cq.message.message_id, preview(draft.payload) + EDIT_HINT,
      keyboard(await editKeys(id, draft.payload)));
  }

  if (action === 'set') {
    const payload = { ...(draft.payload || {}) };
    if (field === 'status') payload.status = value;
    if (field === 'fmt') {
      const { formats } = await loadAll();
      payload.fmt = formats[+value]?.name || payload.fmt;
    }
    await db.from('drafts').update({ payload, updated_at: new Date().toISOString() }).eq('id', id);
    await answerCallback(cq.id, 'Поправил');
    return editText(chatId, cq.message.message_id, preview(payload) + EDIT_HINT,
      keyboard(await editKeys(id, payload)));
  }

  if (action === 'back') {
    await db.from('drafts').update({ status: 'ready' }).eq('id', id);
    await answerCallback(cq.id, '');
    return editText(chatId, cq.message.message_id, preview(draft.payload), keyboard(mainKeys(id)));
  }

  if (action === 'drop') {
    await db.from('drafts').update({ status: 'cancelled' }).eq('id', id);
    await answerCallback(cq.id, 'Отменил');
    return editText(chatId, cq.message.message_id, '<s>' + preview(draft.payload) + '</s>\n\n<i>Не занесено.</i>');
  }

  if (action === 'save' && draft.payload?._mode === 'delete') {
    await db.from('events').delete().eq('id', draft.payload._target);
    await db.from('drafts').update({ status: 'done' }).eq('id', id);
    await answerCallback(cq.id, 'Удалил');
    return editText(chatId, cq.message.message_id, '🗑 <b>Удалено</b>');
  }

  if (action === 'save' && draft.payload?._mode === 'update') {
    const { events } = await loadAll();
    const target = events.find((e) => e.id === draft.payload._target);
    if (!target) return answerCallback(cq.id, 'Записи уже нет');
    const p = draft.payload;
    const merged = { ...target };
    ['title', 'subtitle', 'dateStart', 'dateEnd', 'timeStart', 'timeEnd', 'city', 'venue', 'status', 'fmt', 'statusNote']
      .forEach((k) => { if (p[k]) merged[k] = p[k]; });
    if (p.prob != null) merged.prob = p.prob;
    if (p.why) merged.why = p.why;
    if (p.about) merged.about = p.about;
    if (p.owners?.length) merged.owners = appendUnique(target.owners, p.owners, 'company');
    if (p.next?.text) merged.next = p.next;
    merged.people = appendUnique(target.people, p.people, 'name');
    merged.orgs = appendUnique(target.orgs, p.orgs, 'name');
    merged.links = appendUnique(target.links, (p.links || []).map(fixLink), 'url');
    const changed = describePatch(target, p).map(stripTags).join('; ');
    merged.comms = [...(target.comms || []),
      { date: new Date().toISOString().slice(0, 10), text: changed ? 'Дополнено: ' + changed : 'Дополнено из телеграма' }];
    await saveEvents([merged]);
    await db.from('drafts').update({ status: 'done' }).eq('id', id);
    await answerCallback(cq.id, 'Дополнил');
    const url = process.env.SITE_URL ? `\n\n<a href="${esc(process.env.SITE_URL)}">Открыть в трекере</a>` : '';
    return editText(chatId, cq.message.message_id,
      `<b>${esc(merged.title)}</b>\n✅ <b>Дополнено</b>` + url);
  }

  if (action === 'save' && draft.payload?._batch) {
    const items = draft.payload._batch;
    const files = draft.payload._files || [];
    const today = new Date().toISOString().slice(0, 10);
    const rows = [];
    items.forEach((it) => {
      const isForum = it.children?.length || it.kind === 'forum';
      const pid = newId(isForum ? 'forum' : 'event');
      rows.push(buildRow(it, pid, isForum ? 'forum' : 'event', '', today, []));
      (it.children || []).forEach((c) => rows.push(buildRow(c, newId('event'), 'event', pid, today, [])));
    });
    if (files.length && rows[0]) rows[0].links = [...rows[0].links, ...files].map(fixLink);
    await saveEvents(rows);
    await db.from('drafts').update({ status: 'done' }).eq('id', id);
    await answerCallback(cq.id, `Занёс: ${rows.length}`);
    const url = process.env.SITE_URL ? `\n\n<a href="${esc(process.env.SITE_URL)}">Открыть в трекере</a>` : '';
    return editText(chatId, cq.message.message_id,
      `📋 ✅ <b>Занесено записей: ${rows.length}</b>` + url);
  }

  if (action === 'save') {
    const p = draft.payload || {};
    const files = p._files || [];
    const kids = p._children || [];
    const parentId = newId(p.kind === 'forum' ? 'forum' : 'event');
    const toChild = kids.length && String(p._filesTo) !== 'parent' && kids[+p._filesTo];
    const event = {
      id: parentId,
      kind: p.kind === 'forum' ? 'forum' : 'event',
      forumId: '',
      title: p.title || 'Без названия',
      subtitle: p.subtitle || '',
      dateStart: p.dateStart || new Date().toISOString().slice(0, 10),
      dateEnd: p.dateEnd || '', timeStart: p.timeStart || '', timeEnd: p.timeEnd || '',
      city: p.city || '', venue: p.venue || '',
      status: p.status || 'idea', prob: p.prob ?? 30, fmt: p.fmt || '', statusNote: p.statusNote || '',
      owners: p.owners || [],
      why: p.why || '', about: p.about || '',
      topics: [], people: p.people || [], orgs: p.orgs || [],
      comms: [{ date: new Date().toISOString().slice(0, 10), text: 'Занесено из телеграма' }],
      next: p.next || { text: '', due: '' },
      links: [...(p.links || []), ...(toChild ? [] : files)].map(fixLink),
      source: 'telegram'
    };

    const rows = [event, ...kids.map((c, i) => ({
      id: newId('event'),
      kind: 'event',
      forumId: parentId,
      title: c.title || 'Без названия',
      subtitle: '',
      dateStart: c.dateStart || event.dateStart,
      dateEnd: c.dateEnd || '', timeStart: c.timeStart || '', timeEnd: c.timeEnd || '', timeStart: c.timeStart || '', timeEnd: c.timeEnd || '',
      city: c.city || event.city, venue: c.venue || '',
      status: c.status || event.status, prob: c.prob ?? event.prob, fmt: c.fmt || '', statusNote: c.statusNote || '',
      owners: c.owners || [],
      why: c.why || '', about: c.about || '', about: c.about || '',
      topics: [], people: c.people || [], orgs: c.orgs || [],
      comms: [{ date: new Date().toISOString().slice(0, 10), text: 'Занесено из телеграма' }],
      next: c.next || { text: '', due: '' },
      links: [...(c.links || []), ...(String(p._filesTo) === String(i) ? files : [])].map(fixLink),
      source: 'telegram'
    }))];
    await saveEvents(rows);
    await db.from('drafts').update({ status: 'done' }).eq('id', id);
    await answerCallback(cq.id, kids.length ? `Занёс: ${rows.length}` : 'Занёс');
    const url = process.env.SITE_URL ? `\n\n<a href="${esc(process.env.SITE_URL)}">Открыть в трекере</a>` : '';
    const what = kids.length ? `✅ <b>Занесено: форум и ${kids.length} внутри</b>` : '✅ <b>Занесено</b>';
    return editText(chatId, cq.message.message_id, preview(p) + '\n\n' + what + url);
  }
}

// ── команды ─────────────────────────────────────────────────────
async function handleCommand(chatId, text, msg) {
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();

  if (cmd === '/start') {
    await db.from('tg_chats').upsert({
      chat_id: chatId,
      user_name: [msg.from?.first_name, msg.from?.username].filter(Boolean).join(' @')
    });
    return send(chatId, help());
  }
  if (cmd === '/help' || cmd === '/помощь') return send(chatId, help());

  if (cmd === '/отмена' || cmd === '/cancel') {
    const draft = await openDraft(chatId);
    if (!draft) return send(chatId, 'Нечего отменять.');
    await db.from('drafts').update({ status: 'cancelled' }).eq('id', draft.id);
    return send(chatId, 'Отменил, ничего не занёс.');
  }

  if (cmd === '/напоминания' || cmd === '/reminders') return listRules(chatId);

  if (cmd === '/напоминание') {
    const days = parseInt(args[0], 10);
    if (!days) return send(chatId, 'Формат: <code>/напоминание 7 темы участники</code> — за 7 дней, если не заполнены темы или участники.');
    const requires = args.slice(1).map((w) => FIELD_ALIAS[w.toLowerCase()]).filter(Boolean);
    const label = requires.length
      ? `за ${days} дн. не заполнено: ${requires.map((r) => FIELD_RU[r]).join(', ')}`
      : `за ${days} дн. до мероприятия`;
    await db.from('reminder_rules').insert({ days_before: days, requires, statuses: [], text: label });
    return listRules(chatId, 'Добавил.');
  }

  if (cmd === '/удалить_напоминание') {
    const n = parseInt(args[0], 10);
    const { data } = await db.from('reminder_rules').select('*').order('days_before', { ascending: false });
    const rule = (data || [])[n - 1];
    if (!rule) return send(chatId, 'Нет такого номера. Посмотрите /напоминания.');
    await db.from('reminder_rules').delete().eq('id', rule.id);
    return listRules(chatId, 'Удалил.');
  }

  return send(chatId, 'Не знаю такой команды. ' + help());
}

async function listRules(chatId, prefix) {
  const { data } = await db.from('reminder_rules').select('*').order('days_before', { ascending: false });
  const lines = (data || []).map((r, i) =>
    `${i + 1}. за <b>${r.days_before}</b> дн.`
    + (r.requires?.length ? `, если не заполнено: ${r.requires.map((x) => FIELD_RU[x] || x).join(', ')}` : '')
    + (r.statuses?.length ? ` <i>(статус: ${r.statuses.map((s) => STATUS_RU[s] || s).join(', ')})</i>` : ''));
  return send(chatId, [
    prefix, lines.length ? '<b>Напоминания</b>\n' + lines.join('\n') : 'Напоминаний пока нет.',
    '\nДобавить: <code>/напоминание 7 темы участники</code>',
    'Удалить: <code>/удалить_напоминание 2</code>',
    'Поля: темы, участники, шаг, материалы, держатель'
  ].filter(Boolean).join('\n'));
}

function help() {
  return [
    '<b>Что я умею</b>',
    '',
    '📥 <b>Заношу мероприятия.</b> Перешлите приглашение, анонс или переписку — разберу и покажу карточку. '
    + 'Если чего-то не хватает, спрошу.',
    '',
    '✏️ <b>Даю поправить.</b> Под карточкой есть кнопка «Поправить»: статус и формат меняются кнопками, '
    + 'остальное — сообщением вроде «дата 12 ноября» или «город Казань».',
    '',
    '📎 <b>Читаю файлы.</b> Программу форума в PDF, афишу картинкой, текстовый файл — вытащу оттуда даты, '
    + 'площадку и состав программы. Файл сохраню в «Материалы» карточки.',
    '',
    '📋 <b>Заношу списками.</b> Пришлите PDF с планом мероприятий на месяц или год — разберу весь документ '
    + 'и покажу список. Одно нажатие — и все записи в календаре. Лишние можно убрать по номерам.',
    '',
    '❓ <b>Отвечаю на вопросы.</b> Спросите: «что в сентябре?», «где ещё нет тем?», «сколько подтверждённых до конца года?»',
    '',
    '🔔 <b>Напоминаю.</b> /напоминания — посмотреть и настроить правила.',
    '',
    '/отмена — бросить начатый черновик'
  ].join('\n');
}

const stripTags = (t) => String(t).replace(/<[^>]+>/g, '');

// Одна запись базы из того, что вернула модель.
function buildRow(c, id, kind, forumId, today, extraLinks) {
  return {
    id, kind, forumId,
    title: c.title || 'Без названия',
    subtitle: c.subtitle || '',
    dateStart: c.dateStart || today,
    dateEnd: c.dateEnd || '',
    city: c.city || '', venue: c.venue || '',
    status: c.status || 'idea', prob: c.prob ?? 30, fmt: c.fmt || '', statusNote: c.statusNote || '',
    owners: c.owners || [],
    why: c.why || '',
    topics: [], people: c.people || [], orgs: c.orgs || [],
    comms: [{ date: today, text: 'Занесено из телеграма' }],
    next: c.next || { text: '', due: '' },
    links: [...(c.links || []), ...extraLinks].map(fixLink),
    source: 'telegram'
  };
}

function appendUnique(base, add, key) {
  const out = [...(base || [])];
  for (const item of add || []) {
    if (!item || !item[key]) continue;
    if (out.some((x) => String(x[key]).toLowerCase() === String(item[key]).toLowerCase())) continue;
    out.push(item);
  }
  return out;
}

// Без схемы браузер считает адрес путём внутри сайта — дописываем https://
function fixLink(l) {
  let u = String(l?.url || '').trim();
  if (!u) return l;
  u = u.replace(/^https?:\/\/api\/file\?/i, '/api/file?');
  if (/^\/(?!\/)/.test(u)) return { ...l, url: u };            // ссылка на наш же сервер
  const url = /^(https?:|mailto:|tel:)/i.test(u) ? u : 'https://' + u;
  return { ...l, url };
}

// ── вложения ────────────────────────────────────────────────────
const MAX_FILE = 18 * 1024 * 1024;          // Bot API отдаёт максимум 20 МБ
const TEXT_MIMES = ['text/plain', 'text/markdown', 'text/csv', 'application/json'];

function pickAttachments(msg) {
  const out = [];
  if (msg.photo?.length) {
    const best = msg.photo[msg.photo.length - 1];       // последний — самый крупный
    out.push({ id: best.file_id, type: 'image', media_type: 'image/jpeg', name: 'фото.jpg', size: best.file_size });
  }
  const d = msg.document;
  if (d) {
    const mime = d.mime_type || '';
    const type = mime === 'application/pdf' ? 'pdf'
      : mime.startsWith('image/') ? 'image'
      : TEXT_MIMES.includes(mime) ? 'text' : null;
    if (type) out.push({ id: d.file_id, type, media_type: mime, name: d.file_name || 'файл', size: d.file_size });
  }
  return out.filter((f) => !f.size || f.size <= MAX_FILE);
}

async function fetchFiles(attachments) {
  const out = [];
  for (const a of attachments.slice(0, 3)) {          // больше трёх за раз не берём
    const got = await download(a.id);
    if (!got) continue;
    out.push(a.type === 'text'
      ? { ...a, text: got.buffer.toString('utf8').slice(0, 40000) }
      : { ...a, base64: got.buffer.toString('base64'), buffer: got.buffer });
  }
  return out;
}

// Кладём файл в хранилище и возвращаем ссылку через наш сервер.
async function keepFiles(files) {
  const out = [];
  for (const f of files) {
    if (!f.buffer) continue;
    const ext = f.type === 'pdf' ? 'pdf' : (f.media_type?.split('/')[1] || 'bin');
    const path = `${new Date().toISOString().slice(0, 10)}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const { error } = await storage.from('materials')
      .upload(path, f.buffer, { contentType: f.media_type, upsert: false });
    if (error) { console.error('хранилище', error.message); continue; }
    out.push({ label: f.name || 'вложение', url: `/api/file?path=${encodeURIComponent(path)}` });
  }
  return out;
}

// ── вспомогательное ─────────────────────────────────────────────
async function allowed(chatId, from) {
  const list = (process.env.TG_ALLOWED_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes(String(chatId)) || list.includes(String(from?.id))) return true;
  const { data } = await db.from('tg_chats').select('chat_id').eq('chat_id', chatId).maybeSingle();
  return !!data && list.length === 0;
}

// asking — бот задал вопрос и ждёт ответа; editing — человек нажал «Поправить».
// ready — карточка показана, ждём кнопку: обычные сообщения в неё не попадают.
async function openDraft(chatId) {
  const { data } = await db.from('drafts').select('*')
    .eq('chat_id', chatId).in('status', ['asking', 'editing'])
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data || null;
}

async function buildContext(msg) {
  const { formats, companies, events } = await loadAll();
  const msgDate = new Date((msg.forward_date || msg.date) * 1000).toISOString().slice(0, 10);
  const byId = {};
  events.forEach((e) => { byId[e.id] = e.title; });
  return {
    today: new Date().toISOString().slice(0, 10),
    messageDate: msgDate,
    formats: formats.map((f) => f.name),
    companies: companies.map((c) => c.name),
    events,
    base: events.map((e) => ({
      id: e.id,
      тип: e.kind === 'forum' ? 'форум' : 'мероприятие',
      название: e.title,
      даты: [e.dateStart, e.dateEnd].filter(Boolean).join(' — '),
      город: e.city || undefined,
      площадка: e.venue || undefined,
      формат: e.fmt || undefined,
      внутри_форума: e.forumId ? (byId[e.forumId] || e.forumId) : undefined,
      участники: e.people?.length ? e.people.map((p) => p.name).join(', ') : undefined
    }))
  };
}
