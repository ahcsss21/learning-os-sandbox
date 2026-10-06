create schema if not exists learning_os;

create table if not exists learning_os.customers (
  customer_id integer primary key,
  customer_name text not null,
  city text not null
);

create table if not exists learning_os.restaurants (
  restaurant_id integer primary key,
  restaurant_name text not null,
  cuisine text not null
);

create table if not exists learning_os.orders (
  order_id integer primary key,
  customer_id integer not null references learning_os.customers(customer_id),
  restaurant_id integer not null references learning_os.restaurants(restaurant_id),
  order_date date not null,
  amount numeric(10, 2) not null check (amount >= 0),
  status text not null check (status in ('Delivered', 'Pending', 'Cancelled'))
);

revoke all on schema learning_os from anon, authenticated;
revoke all on all tables in schema learning_os from anon, authenticated;

-- This migration is intended for a dedicated experiment Supabase project.
-- The anon role may read only the sample learning schema, not unrelated public tables.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant usage on schema learning_os to anon, authenticated;
grant select on all tables in schema learning_os to anon, authenticated;

alter table learning_os.customers enable row level security;
alter table learning_os.restaurants enable row level security;
alter table learning_os.orders enable row level security;

drop policy if exists customers_read_for_learning_os on learning_os.customers;
create policy customers_read_for_learning_os
  on learning_os.customers for select to anon, authenticated using (true);

drop policy if exists restaurants_read_for_learning_os on learning_os.restaurants;
create policy restaurants_read_for_learning_os
  on learning_os.restaurants for select to anon, authenticated using (true);

drop policy if exists orders_read_for_learning_os on learning_os.orders;
create policy orders_read_for_learning_os
  on learning_os.orders for select to anon, authenticated using (true);

create or replace function public.run_learning_os_query(query_text text)
returns jsonb
language plpgsql
security invoker
set search_path = public, learning_os, pg_temp
as $$
#variable_conflict use_variable
declare
  result jsonb;
begin
  if query_text is null or length(trim(query_text)) = 0 then
    raise exception 'Query cannot be empty';
  end if;

  if query_text !~* '^[[:space:]]*(select|with)[[:space:]]'
     or query_text ~ ';[[:space:]]*[^[:space:]]' then
    raise exception 'Only SELECT queries are allowed';
  end if;

  if query_text ~* '(^|[^[:alnum:]_])(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|call|do|execute|prepare|transaction|commit|rollback)([^[:alnum:]_]|$)' then
    raise exception 'Only read-only SELECT queries are allowed';
  end if;

  query_text := regexp_replace(trim(query_text), ';[[:space:]]*$', '');
  set local statement_timeout = '3000ms';
  execute format($query$
    with raw_rows as materialized (
      %s
    ), numbered_rows as materialized (
      select row_number() over () as row_number, row_to_json(raw_rows) as row_data
      from raw_rows
    ), column_names as (
      select coalesce(jsonb_agg(to_jsonb(column_name) order by ordinal), '[]'::jsonb) as columns
      from (
        select key as column_name, row_number() over () as ordinal
        from json_each(coalesce(
          (select row_data from numbered_rows order by row_number limit 1),
          '{}'::json
        ))
      ) as names
    )
    select jsonb_build_object(
      'columns', column_names.columns,
      'rows', coalesce((
        select jsonb_agg(row_data::jsonb order by row_number)
        from numbered_rows
      ), '[]'::jsonb)
    )
    from column_names
  $query$, query_text) into result;

  return result;
end;
$$;

revoke all on function public.run_learning_os_query(text) from public;
grant execute on function public.run_learning_os_query(text) to anon, authenticated;
