-- VOZRA PID — persistencia y anti-abuso para llamadas demo
-- Ejecutar una sola vez en Supabase SQL Editor.

create extension if not exists pgcrypto;
create schema if not exists vozra_orders;

create table if not exists vozra_orders.demo_callbacks (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null,
  country text,
  ip text,
  user_agent text,
  status text not null check (status in ('reserved', 'dispatched', 'failed', 'rate_limited')),
  reason text,
  provider_conversation_id text,
  provider_call_sid text,
  provider_message text,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists demo_callbacks_phone_created_idx
  on vozra_orders.demo_callbacks (phone_e164, created_at desc);

create index if not exists demo_callbacks_created_idx
  on vozra_orders.demo_callbacks (created_at desc);

create or replace function vozra_orders.reserve_demo_callback(
  p_phone text,
  p_country text default null,
  p_ip text default null,
  p_user_agent text default null,
  p_daily_cap integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = vozra_orders, public
as $$
declare
  v_attempt_id uuid;
  v_recent_count integer;
  v_phone_day_count integer;
  v_global_day_count integer;
  v_retry_after integer;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_cap integer := greatest(1, coalesce(p_daily_cap, 50));
begin
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid_phone';
  end if;

  -- Orden fijo de locks para evitar carreras entre el límite global y el del número.
  perform pg_advisory_xact_lock(hashtextextended('vozra-demo-global-' || v_day_start::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('vozra-demo-phone-' || p_phone, 0));

  select count(*)
    into v_recent_count
    from vozra_orders.demo_callbacks
   where phone_e164 = p_phone
     and status in ('reserved', 'dispatched', 'failed')
     and created_at >= now() - interval '10 minutes';

  if v_recent_count > 0 then
    select greatest(
             1,
             ceil(extract(epoch from ((max(created_at) + interval '10 minutes') - now())))::integer
           )
      into v_retry_after
      from vozra_orders.demo_callbacks
     where phone_e164 = p_phone
       and status in ('reserved', 'dispatched', 'failed')
       and created_at >= now() - interval '10 minutes';

    insert into vozra_orders.demo_callbacks
      (phone_e164, country, ip, user_agent, status, reason)
    values
      (p_phone, p_country, p_ip, p_user_agent, 'rate_limited', 'cooldown');

    return jsonb_build_object(
      'allowed', false,
      'reason', 'cooldown',
      'retry_after_seconds', coalesce(v_retry_after, 600)
    );
  end if;

  select count(*)
    into v_phone_day_count
    from vozra_orders.demo_callbacks
   where phone_e164 = p_phone
     and status in ('reserved', 'dispatched', 'failed')
     and created_at >= v_day_start;

  if v_phone_day_count >= 2 then
    insert into vozra_orders.demo_callbacks
      (phone_e164, country, ip, user_agent, status, reason)
    values
      (p_phone, p_country, p_ip, p_user_agent, 'rate_limited', 'phone_daily_cap');

    return jsonb_build_object(
      'allowed', false,
      'reason', 'phone_daily_cap',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from ((v_day_start + interval '1 day') - now())))::integer)
    );
  end if;

  select count(*)
    into v_global_day_count
    from vozra_orders.demo_callbacks
   where status in ('reserved', 'dispatched', 'failed')
     and created_at >= v_day_start;

  if v_global_day_count >= v_cap then
    insert into vozra_orders.demo_callbacks
      (phone_e164, country, ip, user_agent, status, reason)
    values
      (p_phone, p_country, p_ip, p_user_agent, 'rate_limited', 'global_daily_cap');

    return jsonb_build_object(
      'allowed', false,
      'reason', 'global_daily_cap',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from ((v_day_start + interval '1 day') - now())))::integer)
    );
  end if;

  insert into vozra_orders.demo_callbacks
    (phone_e164, country, ip, user_agent, status)
  values
    (p_phone, p_country, p_ip, p_user_agent, 'reserved')
  returning id into v_attempt_id;

  return jsonb_build_object(
    'allowed', true,
    'attempt_id', v_attempt_id,
    'retry_after_seconds', 0
  );
end;
$$;

revoke all on function vozra_orders.reserve_demo_callback(text, text, text, text, integer) from public;
grant execute on function vozra_orders.reserve_demo_callback(text, text, text, text, integer) to service_role;

grant usage on schema vozra_orders to service_role;
grant select, insert, update on vozra_orders.demo_callbacks to service_role;
