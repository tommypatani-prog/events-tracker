-- ─────────────────────────────────────────────────────────────
-- ДОБИВКА СХЕМЫ.
-- Безопасно выполнять сколько угодно раз: ничего не удаляет,
-- только добавляет недостающее. Данные не трогает.
-- Supabase → SQL Editor → New query → вставить → Run.
-- ─────────────────────────────────────────────────────────────

-- 1. Колонки, которых может не хватать в events
alter table events add column if not exists kind          text not null default 'event';
alter table events add column if not exists forum_id      text;
alter table events add column if not exists subtitle      text;
alter table events add column if not exists owner_company text;
alter table events add column if not exists owner_person  text;
alter table events add column if not exists topics        jsonb default '[]';
alter table events add column if not exists people        jsonb default '[]';
alter table events add column if not exists orgs          jsonb default '[]';
alter table events add column if not exists comms         jsonb default '[]';
alter table events add column if not exists next          jsonb default '{}';
alter table events add column if not exists links         jsonb default '[]';
alter table events add column if not exists source        text default 'web';
alter table events add column if not exists status_note   text;
alter table events add column if not exists about         text;
alter table events add column if not exists owners        jsonb default '[]';
alter table events add column if not exists time_start    text;
alter table events add column if not exists time_end      text;
alter table events add column if not exists created_at    timestamptz default now();
alter table events add column if not exists updated_at    timestamptz default now();

create index if not exists events_date_idx on events (date_start);

-- 2. Таблицы для бота и напоминаний
create table if not exists settings (
  key   text primary key,
  value jsonb not null
);

create table if not exists tg_chats (
  chat_id    bigint primary key,
  user_name  text,
  created_at timestamptz default now()
);

create table if not exists drafts (
  id          uuid primary key default gen_random_uuid(),
  chat_id     bigint not null,
  source_text text,
  payload     jsonb default '{}',
  missing     jsonb default '[]',
  asked       int  default 0,
  status      text default 'open',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists drafts_chat_idx on drafts (chat_id, status);

create table if not exists reminder_rules (
  id          uuid primary key default gen_random_uuid(),
  days_before int  not null,
  requires    jsonb default '[]',
  statuses    jsonb default '[]',
  text        text,
  enabled     boolean default true,
  created_at  timestamptz default now()
);

create table if not exists reminder_log (
  rule_id  uuid,
  event_id text,
  sent_on  date,
  primary key (rule_id, event_id, sent_on)
);

-- 3. Всё закрыто снаружи: ходить в базу может только наш сервер
alter table events         enable row level security;
alter table settings       enable row level security;
alter table tg_chats       enable row level security;
alter table drafts         enable row level security;
alter table reminder_rules enable row level security;
alter table reminder_log   enable row level security;

-- 4. Корзина для вложений из телеграма
insert into storage.buckets (id, name, public)
values ('materials', 'materials', false)
on conflict (id) do nothing;

-- 5. Стартовые справочники и правила напоминаний
insert into settings (key, value) values
  ('formats', '[{"name":"Выступление","color":"#E69F00"},{"name":"Панельная дискуссия","color":"#0072B2"},{"name":"Интервью","color":"#009E73"},{"name":"Мастер-класс","color":"#D55E00"},{"name":"Встреча","color":"#56B4E9"},{"name":"Живая беседа","color":"#CC79A7"},{"name":"Другое","color":"#8C8C93"}]'::jsonb),
  ('companies', '[{"name":"Optimistic Beast","color":"#6C4BF4"},{"name":"Инсайтизатор","color":"#2F855A"}]'::jsonb)
on conflict (key) do nothing;

insert into reminder_rules (days_before, requires, statuses, text)
select * from (values
  (14, '["topics"]'::jsonb, '["conf","talks"]'::jsonb, 'через две недели мероприятие, а тем выступления ещё нет'),
  (7,  '["people"]'::jsonb, '["conf"]'::jsonb,         'через неделю мероприятие, участники не заполнены'),
  (2,  '[]'::jsonb,         '["conf"]'::jsonb,         'послезавтра мероприятие')
) as v(days_before, requires, statuses, text)
where not exists (select 1 from reminder_rules);

-- 6. Что получилось
select 'колонок в events: ' || count(*)::text as проверка
from information_schema.columns where table_name = 'events';
