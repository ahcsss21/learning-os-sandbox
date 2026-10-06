create table if not exists public.hint_attempt_claims (
  attempt_id uuid primary key references public.query_attempts(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  claimed_at timestamptz not null default now()
);

insert into public.hint_attempt_claims (attempt_id, owner_id)
select distinct on (attempt_id) attempt_id, owner_id
from public.hint_events
where attempt_id is not null
order by attempt_id, created_at
on conflict (attempt_id) do nothing;

alter table public.hint_attempt_claims enable row level security;
revoke all on public.hint_attempt_claims from public, anon, authenticated;
grant all on public.hint_attempt_claims to service_role;

create table if not exists public.learner_skill_evidence (
  owner_id uuid not null references auth.users(id) on delete cascade,
  skill_key text not null,
  independent_successes integer not null default 0,
  assisted_successes integer not null default 0,
  highest_hint_level integer not null default 0 check (highest_hint_level between 0 and 5),
  updated_at timestamptz not null default now(),
  primary key (owner_id, skill_key)
);

alter table public.learner_skill_evidence enable row level security;
revoke all on public.learner_skill_evidence from public, anon, authenticated;
grant all on public.learner_skill_evidence to service_role;

create or replace function public.record_learner_skill_success(
  p_owner_id uuid,
  p_skill_key text,
  p_was_assisted boolean,
  p_support_level integer
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.learner_skill_evidence (
    owner_id, skill_key, independent_successes, assisted_successes, highest_hint_level
  ) values (
    p_owner_id,
    left(p_skill_key, 80),
    case when p_was_assisted then 0 else 1 end,
    case when p_was_assisted then 1 else 0 end,
    case when p_was_assisted then greatest(1, least(p_support_level, 5)) else 0 end
  )
  on conflict (owner_id, skill_key) do update set
    independent_successes = learner_skill_evidence.independent_successes + excluded.independent_successes,
    assisted_successes = learner_skill_evidence.assisted_successes + excluded.assisted_successes,
    highest_hint_level = greatest(learner_skill_evidence.highest_hint_level, excluded.highest_hint_level),
    updated_at = now();
$$;

revoke all on function public.record_learner_skill_success(uuid, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.record_learner_skill_success(uuid, text, boolean, integer) to service_role;