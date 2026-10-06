-- Learner working time on a question when the attempt was submitted; elapsed_ms remains sandbox latency.
alter table public.query_attempts add column if not exists task_elapsed_ms integer;
