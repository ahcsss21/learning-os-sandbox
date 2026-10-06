-- Multi-user Learning OS platform records.
-- Learner data is private to auth.uid(); generated answer keys are stored separately.

create table if not exists public.learning_schemas (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  dialect text not null default 'PostgreSQL',
  schema_name text not null default 'public',
  table_names text[] not null default '{}',
  schema_sql text not null,
  data_sql text not null default '',
  source text not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.question_sets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  schema_id uuid not null references public.learning_schemas(id) on delete cascade,
  difficulty text not null check (difficulty in ('low', 'medium', 'high')),
  question_count integer not null check (question_count between 1 and 30),
  focus_concepts text[] not null default '{}',
  generation_provider text,
  generation_model text,
  prompt_version text not null default 'v1',
  created_at timestamptz not null default now()
);

create table if not exists public.practice_questions (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.question_sets(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  ordinal integer not null,
  prompt text not null,
  difficulty text not null check (difficulty in ('low', 'medium', 'high')),
  concepts text[] not null default '{}',
  output_contract jsonb not null default '{}'::jsonb,
  requires_order boolean not null default false,
  created_at timestamptz not null default now(),
  unique (set_id, ordinal)
);

create table if not exists public.practice_question_keys (
  question_id uuid primary key references public.practice_questions(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  reference_sql text not null,
  expected_columns text[] not null,
  expected_rows jsonb not null,
  requires_order boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.practice_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  set_id uuid not null references public.question_sets(id) on delete cascade,
  schema_id uuid not null references public.learning_schemas(id) on delete cascade,
  mode text not null default 'practice' check (mode in ('practice', 'removal')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  summary jsonb not null default '{}'::jsonb
);

create table if not exists public.query_attempts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.practice_sessions(id) on delete cascade,
  question_id uuid not null references public.practice_questions(id) on delete cascade,
  attempt_number integer not null,
  execution_mode text not null check (execution_mode in ('full', 'selection')),
  submitted_sql text not null,
  sql_error text,
  sqlstate text,
  actual_columns text[] not null default '{}',
  actual_rows jsonb not null default '[]'::jsonb,
  correctness boolean,
  mismatch_kind text,
  is_final boolean not null default false,
  elapsed_ms integer,
  created_at timestamptz not null default now(),
  unique (session_id, question_id, attempt_number)
);

create table if not exists public.hint_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.practice_sessions(id) on delete cascade,
  question_id uuid not null references public.practice_questions(id) on delete cascade,
  attempt_id uuid references public.query_attempts(id) on delete set null,
  diagnosis jsonb not null default '{}'::jsonb,
  hint_text text not null,
  provider text,
  model text,
  prompt_version text not null default 'v1',
  created_at timestamptz not null default now()
);

create index if not exists learning_schemas_owner_idx on public.learning_schemas(owner_id, updated_at desc);
create index if not exists question_sets_owner_idx on public.question_sets(owner_id, created_at desc);
create index if not exists practice_sessions_owner_idx on public.practice_sessions(owner_id, started_at desc);
create index if not exists query_attempts_session_idx on public.query_attempts(session_id, question_id, attempt_number);
create index if not exists hint_events_session_idx on public.hint_events(session_id, question_id, created_at);

alter table public.learning_schemas add column if not exists schema_name text not null default 'public';
alter table public.learning_schemas add column if not exists table_names text[] not null default '{}';
alter table public.query_attempts add column if not exists is_final boolean not null default false;

alter table public.learning_schemas enable row level security;
alter table public.question_sets enable row level security;
alter table public.practice_questions enable row level security;
alter table public.practice_question_keys enable row level security;
alter table public.practice_sessions enable row level security;
alter table public.query_attempts enable row level security;
alter table public.hint_events enable row level security;

-- Remove any prior broad policies on these newly introduced tables.
drop policy if exists learning_schemas_owner_all on public.learning_schemas;
create policy learning_schemas_owner_all on public.learning_schemas
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists question_sets_owner_all on public.question_sets;
create policy question_sets_owner_all on public.question_sets
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists practice_questions_owner_all on public.practice_questions;
create policy practice_questions_owner_all on public.practice_questions
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists practice_sessions_owner_all on public.practice_sessions;
create policy practice_sessions_owner_all on public.practice_sessions
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists query_attempts_owner_all on public.query_attempts;
create policy query_attempts_owner_all on public.query_attempts
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists hint_events_owner_all on public.hint_events;
create policy hint_events_owner_all on public.hint_events
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Keys are never directly exposed through the Data API. Edge Functions access them with service role.
revoke all on public.practice_question_keys from anon, authenticated;
revoke all on public.practice_question_keys from public;

-- Retire the previous shared anonymous SQL demo. New sessions use isolated per-request PGlite sandboxes.
revoke all on function public.run_learning_os_query(text) from public, anon, authenticated;
revoke all on schema learning_os from anon, authenticated;
revoke all on all tables in schema learning_os from anon, authenticated;
drop policy if exists customers_read_for_learning_os on learning_os.customers;
drop policy if exists restaurants_read_for_learning_os on learning_os.restaurants;
drop policy if exists orders_read_for_learning_os on learning_os.orders;

-- All authenticated users may use the public API table grants; RLS still restricts rows to the owner.
revoke all on public.learning_schemas, public.question_sets, public.practice_questions,
  public.practice_sessions, public.query_attempts, public.hint_events from authenticated;
grant select on public.learning_schemas, public.question_sets, public.practice_questions,
  public.practice_sessions, public.query_attempts, public.hint_events to authenticated;
grant insert, update on public.practice_sessions to authenticated;
revoke all on public.learning_schemas, public.question_sets, public.practice_questions,
  public.practice_sessions, public.query_attempts, public.hint_events from anon;

comment on table public.practice_question_keys is 'Private evaluator keys. Access only from trusted server-side code; never grant Data API access.';
