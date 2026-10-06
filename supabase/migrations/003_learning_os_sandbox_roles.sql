-- Dedicated database roles for the native Postgres SQL sandbox.
-- The Render service connects as the manager role; learner SQL runs as the reader role.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'learning_os_sandbox_reader') then
    create role learning_os_sandbox_reader nologin noinherit;
  else
    alter role learning_os_sandbox_reader nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'learning_os_sandbox_manager') then
    create role learning_os_sandbox_manager login noinherit;
  else
    alter role learning_os_sandbox_manager login noinherit;
  end if;
end;
$$;

grant connect, create on database postgres to learning_os_sandbox_manager;
grant learning_os_sandbox_reader to learning_os_sandbox_manager;

comment on role learning_os_sandbox_reader is 'No-login role used only to run learner SELECT queries against one temporary schema.';
comment on role learning_os_sandbox_manager is 'Restricted service login that creates temporary schemas and can SET ROLE to learning_os_sandbox_reader.';
