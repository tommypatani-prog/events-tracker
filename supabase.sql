-- ─────────────────────────────────────────────────────────────
-- Схема базы для трекера мероприятий.
-- Выполнить один раз в Supabase → SQL Editor → New query → Run.
-- ─────────────────────────────────────────────────────────────

-- Мероприятия и форумы (форум = kind 'forum', внутри него события с forum_id)
create table if not exists events (
  id            text primary key,
  kind          text not null default 'event',
  forum_id      text,
  title         text,
  subtitle      text,
  date_start    date,
  date_end      date,
  time_start    text,
  time_end      text,
  city          text,
  venue         text,
  status        text default 'idea',
  status_note   text,
  about         text,
  prob          int  default 30,
  fmt           text,
  owners        jsonb default '[]',
  owner_company text,
  owner_person  text,
  why           text,
  topics        jsonb default '[]',
  people        jsonb default '[]',
  orgs          jsonb default '[]',
  comms         jsonb default '[]',
  next          jsonb default '{}',
  links         jsonb default '[]',
  source        text default 'web',      -- web | telegram
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists events_date_idx on events (date_start);

-- Справочники: форматы и компании-держатели
create table if not exists settings (
  key   text primary key,
  value jsonb not null
);

-- Кто может писать боту
create table if not exists tg_chats (
  chat_id    bigint primary key,
  user_name  text,
  created_at timestamptz default now()
);

-- Черновики: бот собрал данные из сообщения и уточняет недостающее
create table if not exists drafts (
  id          uuid primary key default gen_random_uuid(),
  chat_id     bigint not null,
  source_text text,
  payload     jsonb default '{}',
  missing     jsonb default '[]',
  asked       int  default 0,
  status      text default 'open',      -- open | done | cancelled
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists drafts_chat_idx on drafts (chat_id, status);

-- Правила напоминаний
create table if not exists reminder_rules (
  id          uuid primary key default gen_random_uuid(),
  days_before int  not null,
  requires    jsonb default '[]',       -- topics | people | next | links | owner
  statuses    jsonb default '[]',       -- пусто = любой статус
  text        text,
  enabled     boolean default true,
  created_at  timestamptz default now()
);

-- Чтобы одно напоминание не приходило дважды в день
create table if not exists reminder_log (
  rule_id  uuid,
  event_id text,
  sent_on  date,
  primary key (rule_id, event_id, sent_on)
);

-- Данные закрыты для всех снаружи: ходить в базу может только наш сервер
alter table events         enable row level security;
alter table settings       enable row level security;
alter table tg_chats       enable row level security;
alter table drafts         enable row level security;
alter table reminder_rules enable row level security;
alter table reminder_log   enable row level security;

-- Стартовые правила напоминаний (можно менять из бота: /напоминания)
insert into reminder_rules (days_before, requires, statuses, text) values
  (14, '["topics"]'::jsonb, '["conf","talks"]'::jsonb, 'через две недели мероприятие, а тем выступления ещё нет'),
  (7,  '["people"]'::jsonb, '["conf"]'::jsonb,         'через неделю мероприятие, участники не заполнены'),
  (2,  '[]'::jsonb,         '["conf"]'::jsonb,         'послезавтра мероприятие')
on conflict do nothing;

-- Корзина для вложений: программы, афиши, презентации.
-- Закрытая: файлы отдаются только через наш сервер, по временной ссылке.
insert into storage.buckets (id, name, public)
values ('materials', 'materials', false)
on conflict (id) do nothing;

-- Стартовые справочники
insert into settings (key, value) values
  ('formats', '[{"name":"Выступление","color":"#E69F00"},{"name":"Панельная дискуссия","color":"#0072B2"},{"name":"Интервью","color":"#009E73"},{"name":"Мастер-класс","color":"#D55E00"},{"name":"Встреча","color":"#56B4E9"},{"name":"Живая беседа","color":"#CC79A7"},{"name":"Другое","color":"#8C8C93"}]'::jsonb),
  ('companies', '[{"name":"Optimistic Beast","color":"#6C4BF4"},{"name":"Инсайтизатор","color":"#2F855A"}]'::jsonb)
on conflict (key) do nothing;
