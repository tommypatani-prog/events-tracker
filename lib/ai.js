// Разбор сообщений и ответы на вопросы через Claude.
import Anthropic from '@anthropic-ai/sdk';

// Клиент создаём лениво: без ключа модуль всё равно должен импортироваться.
let _client = null;
const client = () => (_client ||= new Anthropic());
const MODEL = 'claude-opus-5';

const EVENT_FIELDS = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['event', 'forum'], description: 'forum — если это большое мероприятие с программой из нескольких активностей внутри' },
    title: { type: 'string' },
    subtitle: { type: 'string' },
    dateStart: { type: 'string', description: 'ГГГГ-ММ-ДД' },
    timeStart: { type: 'string', description: 'ЧЧ:ММ — время начала, только если прямо указано в тексте' },
    timeEnd: { type: 'string', description: 'ЧЧ:ММ — время окончания, только если указано' },
    dateEnd: { type: 'string', description: 'ГГГГ-ММ-ДД. Заполняй ТОЛЬКО если в тексте прямо указан диапазон дат. Иначе оставь пустым' },
    city: { type: 'string' },
    venue: { type: 'string', description: 'площадка, зал, адрес, время' },
    fmt: { type: 'string', description: 'формат участия из списка доступных' },
    status: { type: 'string', enum: ['idea', 'talks', 'conf', 'decl', 'done'] },
    statusNote: {
      type: 'string',
      description: 'короткое пояснение к статусу по фактам из сообщения: «ждём ответ до 5 сентября», '
        + '«повестка не подходит», «приглашение подтверждено». Одна строка. Нечего сказать — оставь пустым'
    },
    about: {
      type: 'string',
      description: 'коротко о самом мероприятии: что это, масштаб, аудитория, формат площадки. '
        + 'Нейтральное описание по фактам — без оценки, полезно нам или нет'
    },
    why: { type: 'string', description: 'чем мероприятие интересно ИМЕННО НАМ: повод, контакты, возможность. Не путать с about' },
    orgs: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, contact: { type: 'string' } } }
    },
    people: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'имя или описание группы участников' },
          note: { type: 'string', description: 'кто это: должность, роль на мероприятии. Не указание, что с ним сделать' }
        }
      }
    },
    next: {
      type: 'object',
      description: 'реальное дело по мероприятию, о котором сказано в сообщении: отправить тезисы, согласовать хронометраж. '
        + 'Не описание того, что нужно поправить в базе. Если такого дела не названо — не заполняй',
      properties: { text: { type: 'string' }, due: { type: 'string' } }
    },
    links: {
      type: 'array',
      items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } } }
    },
    owners: {
      type: 'array',
      description: 'кто ведёт мероприятие с нашей стороны. Держателей может быть несколько',
      items: {
        type: 'object',
        properties: {
          company: { type: 'string', description: 'компания из списка держателей' },
          person: { type: 'string', description: 'имя человека' }
        }
      }
    }
  }
};

// Одна запись вместе с вложенными активностями — из такого состоит список.
const PACKAGE = {
  type: 'object',
  properties: Object.assign({}, EVENT_FIELDS.properties, {
    children: { type: 'array', items: EVENT_FIELDS, description: 'активности внутри этого форума' }
  })
};

const PARSE_TOOL = {
  name: 'parse_message',
  description: 'Разобрать сообщение: понять намерение и вытащить данные о мероприятии.',
  input_schema: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: ['add', 'update', 'delete', 'question', 'chat'],
        description: 'add — новая запись, которой в базе ещё нет; update — дополнить или поправить существующую; '
          + 'delete — удалить существующую; question — вопрос про то, что уже в базе; chat — ничего из перечисленного'
      },
      targetId: {
        type: 'string',
        description: 'id существующей записи из списка базы. Обязателен для update и delete'
      },
      event: EVENT_FIELDS,
      children: {
        type: 'array',
        description: 'мероприятия внутри форума, если в сообщении названы конкретные активности, '
          + 'в которых мы можем участвовать. Каждое — отдельная запись со своей датой и форматом',
        items: EVENT_FIELDS
      },
      items: {
        type: 'array',
        description: 'список записей, если в сообщении или файле их много: календарь, план, таблица мероприятий. '
          + 'Одна запись на мероприятие. Когда список заполнен, поле event оставь пустым',
        items: PACKAGE
      },
      attachFilesTo: {
        type: 'string',
        description: 'куда отнести приложенные файлы: parent — к самому форуму, либо номер мероприятия '
          + 'внутри начиная с 0, если файл описывает именно его'
      },
      missing: {
        type: 'array',
        items: { type: 'string' },
        description: 'только для add: критично важные поля, которых в сообщении нет — title, dateStart'
      },
      question: { type: 'string', description: 'один короткий уточняющий вопрос на русском, если чего-то критичного не хватает' },
      note: {
        type: 'string',
        description: 'если заносить нечего — короткое объяснение почему: «все мероприятия уже есть в базе», '
          + '«в файле только программа чужих сессий», «файл не читается». Обязательно, когда items и event пустые'
      },
      confidence: { type: 'number', description: '0–1, насколько уверенно распознано' }
    },
    required: ['intent']
  }
};

function systemPrompt(ctx) {
  return [
    'Ты помощник, который ведёт трекер деловых мероприятий.',
    `Сегодня ${ctx.today}. Сообщение получено ${ctx.messageDate}.`,
    'Относительные даты («в следующий четверг», «через две недели») считай от даты сообщения, а не от сегодня.',
    `Доступные форматы участия: ${ctx.formats.join(', ')}.`,
    `Компании-держатели: ${ctx.companies.join(', ') || 'не заданы'}.`,
    '',
    'ЧТО УЖЕ ЕСТЬ В БАЗЕ (форумы и мероприятия внутри них):',
    ctx.base && ctx.base.length ? JSON.stringify(ctx.base, null, 1) : '(база пуста)',
    '',
    'Главное правило: сначала посмотри в базу, потом решай.',
    '— Если человек говорит про то, что там уже есть — не создавай дубль. Ставь intent = update '
      + 'и targetId нужной записи, а в event клади только то, что нужно дописать или поправить.',
    '— Мероприятие узнаётся по названию, сокращению (ВЭФ, ПМЭФ), дате, городу, участникам или форуму, внутри которого идёт. '
      + 'Сессия внутри форума — это отдельная запись со своим id и полем forumId.',
    '— Просят удалить, отменить, убрать запись — intent = delete и targetId.',
    '— Если в базе есть похожая запись, но ты не уверен, что речь о ней, — задай уточняющий вопрос, а не создавай новую.',
    '',
    'КАК ЗАПОЛНЯТЬ ПОЛЯ. В базу попадают только факты о мероприятии — так, будто их занёс человек, '
      + 'который знает предмет и не видел переписки.',
    '— Никаких пересказов сообщения, рассуждений и заметок самому себе. '
      + 'Строки вида «не создавать новую запись», «дописать участника», «удалить черновик» в полях недопустимы: '
      + 'это твоя работа, а не содержимое карточки.',
    '— «Следующий шаг» — настоящее дело по мероприятию («Отправить тезисы», «Согласовать хронометраж»). '
      + 'Если человек просто просит что-то поправить в базе — поле не трогай.',
    '— Заметка об участнике описывает, кто это: должность, роль. Не что с ним сделать.',
    '— Нечем заполнить фактами — оставь поле пустым. Пустое поле лучше выдуманного или служебного.',
    '',
    'Остальные правила:',
    '— Не выдумывай данные. Если города или даты в тексте нет, не подставляй их.',
    '— Дата окончания только по прямому указанию диапазона в тексте. Не растягивай запись на несколько дней '
      + '«на всякий случай»: в календаре это превращается в широкую полосу поверх недели. '
      + 'Непонятно, один день или несколько, — спроси одним вопросом.',
    '— Статус по умолчанию idea. talks — идёт обсуждение, conf — участие подтверждено.',
    '— Составное сообщение: форум и внутри него конкретные активности, в которых мы можем участвовать, — '
      + 'верни форум в event (kind = forum), а активности в children. Каждая активность получает свою дату, '
      + 'формат и описание. Не сваливай их в текст описания форума.',
    '— В children попадают только активности, названные как возможные точки входа для нас. '
      + 'Полная программа чужих сессий в children не нужна. Это правило про children и не касается items: '
      + 'документ со списком мероприятий разбирается целиком.',
    '— Если в файле или сообщении СПИСОК мероприятий — календарь, план, таблица на месяц или год, — '
      + 'заполни items: по одной записи на каждое мероприятие, с его датой, городом и форматом. '
      + 'Поле event в этом случае не заполняй. Разбирай весь документ целиком, а не первые несколько строк.',
    '— В списке пропускай только точные дубли: то же мероприятие И та же дата. Похожее название при другой дате — '
      + 'это другое мероприятие, его надо занести. Если из-за дублей список получился пустым, так и напиши в note.',
    '— У записи из списка нет даты — всё равно включи её, дату оставь пустой: человек допишет сам. '
      + 'Выдумывать даты нельзя ни при каких условиях.',
    '— Если приложенный файл описывает одну конкретную активность из children, укажи её номер в attachFilesTo. '
      + 'Если файл про форум целиком — attachFilesTo = parent.',
    '— Поле «предлагаемые темы выступления» заполняется только вручную. Никогда его не трогай.',
    '— Один уточняющий вопрос за раз, самый важный. Коротко, по-человечески, без канцелярита.',
    '— Если приложен файл (программа, афиша, письмо), читай его как основной источник: '
    + 'оттуда обычно точные даты, площадка и состав программы.',
    '— Программа форума из нескольких пунктов: kind = forum, а пункты перечисли в topics по одному.'
  ].join('\n');
}

// Файлы: PDF и картинки уходят модели как есть, текстовые — вклеиваются в сообщение.
function contentWith(text, files = []) {
  const content = [];
  for (const f of files) {
    if (f.type === 'pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.base64 } });
    } else if (f.type === 'image') {
      content.push({ type: 'image', source: { type: 'base64', media_type: f.media_type, data: f.base64 } });
    }
  }
  const inline = files.filter((f) => f.type === 'text')
    .map((f) => `\n\n<файл имя="${f.name}">\n${f.text}\n</файл>`).join('');
  const names = files.filter((f) => f.type !== 'text').map((f) => f.name).filter(Boolean);
  content.push({
    type: 'text',
    text: `Разбери это сообщение:\n\n<сообщение>\n${text || '(без текста, смотри вложение)'}\n</сообщение>${inline}`
      + (names.length ? `\n\nПриложены файлы: ${names.join(', ')}. Данные из них учитывай наравне с текстом.` : '')
  });
  return content;
}

// Один вызов: классификация намерения + извлечение данных.
export async function parseMessage(text, ctx, files = []) {
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: files.length ? 16000 : 8000,     // список на тридцать мероприятий в 8000 не влезет
    output_config: { effort: 'medium' },         // на бесплатном Vercel у функции всего 60 секунд
    system: systemPrompt(ctx),
    tools: [PARSE_TOOL],
    messages: [{ role: 'user', content: contentWith(text, files) }]
  });
  return pickToolInput(res, 'parse_message') || { intent: 'chat' };
}

// Ответ человека на уточняющий вопрос — дополняем черновик.
export async function refineDraft(draft, reply, ctx, files = []) {
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: 'medium' },
    system: systemPrompt(ctx) + '\n\nСейчас ты уточняешь уже начатый черновик. Верни его целиком, дополнив ответом человека.',
    tools: [PARSE_TOOL],
    messages: [{
      role: 'user',
      content: contentWith(
        `Черновик:\n${JSON.stringify(draft.payload, null, 1)}\n\n`
        + `Исходное сообщение:\n${draft.source_text}\n\n`
        + `Ответ человека на уточняющий вопрос:\n${reply}\n\n`
        + 'Верни обновлённый черновик через инструмент parse_message с intent = add.',
        files)
    }]
  });
  return pickToolInput(res, 'parse_message') || { intent: 'add', event: draft.payload };
}

// Вопрос про то, что уже в базе.
export async function answerQuestion(question, events, ctx) {
  const compact = events.map((e) => ({
    id: e.id, тип: e.kind === 'forum' ? 'форум' : 'мероприятие',
    название: e.title, даты: [e.dateStart, e.dateEnd].filter(Boolean).join(' — '),
    время: [e.timeStart, e.timeEnd].filter(Boolean).join('–') || undefined,
    город: e.city, площадка: e.venue,
    статус: { idea: 'идея', talks: 'обсуждение', conf: 'подтверждено', decl: 'отказ', done: 'прошло' }[e.status] || e.status,
    вероятность: e.prob, формат: e.fmt,
    держатель: (e.owners || []).map((o) => [o.company, o.person].filter(Boolean).join(' · ')).join('; ') || undefined,
    внутри_форума: e.forumId || undefined,
    темы: e.topics?.length ? e.topics : undefined,
    следующий_шаг: e.next?.text ? `${e.next.text}${e.next.due ? ' до ' + e.next.due : ''}` : undefined,
    последняя_переписка: e.comms?.length ? e.comms[e.comms.length - 1].text.slice(0, 160) : undefined
  }));

  const res = await client().messages.create({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: 'high' },
    system: [
      'Ты отвечаешь на вопросы по базе деловых мероприятий.',
      `Сегодня ${ctx.today}.`,
      'Отвечай коротко и по делу, обычным разговорным русским. Без markdown-заголовков и списков со звёздочками.',
      'Считай только по данным ниже. Если ответа в данных нет — так и скажи, не додумывай.',
      'Даты пиши по-человечески: «17 сентября», а не «2026-09-17».'
    ].join('\n'),
    messages: [{
      role: 'user',
      content: `База мероприятий:\n${JSON.stringify(compact, null, 1)}\n\nВопрос: ${question}`
    }]
  });
  return textOf(res) || 'Не смог разобраться с этим вопросом.';
}

function pickToolInput(res, name) {
  for (const block of res.content) {
    if (block.type === 'tool_use' && block.name === name) return block.input;
  }
  // На случай, если модель ответила текстом с JSON вместо вызова инструмента
  const t = textOf(res);
  const m = t && t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* пусто */ } }
  return null;
}

function textOf(res) {
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
