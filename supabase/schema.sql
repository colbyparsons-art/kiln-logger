-- Kiln Monitor: Supabase database setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Run it once on a new project.
--
-- Everything is stored in °C. The dashboard converts to °F for display.
-- The logger (ESP32) and the simulator call public.ingest() through Supabase's REST API.

create extension if not exists pg_net;   -- lets the database send alerts to ntfy
create extension if not exists pg_cron;  -- runs the "logger offline" check every 5 minutes

create schema if not exists private;     -- not exposed through the API
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Secrets. Only the database itself can read these (no API access).
create table private.config (
  id          int primary key default 1 check (id = 1),
  device_key  text not null default replace(gen_random_uuid()::text, '-', ''),
  ntfy_topic  text not null default 'kiln-' || left(replace(gen_random_uuid()::text, '-', ''), 16),
  ntfy_server text not null default 'https://ntfy.sh'
);
insert into private.config default values;

-- Alert and firing-detection settings. Anyone can read; staff can edit from the dashboard.
create table public.settings (
  id                  int primary key default 1 check (id = 1),
  start_temp_c        real not null default 93.3,  -- 200 °F: a new firing starts when the kiln climbs past this
  end_temp_c          real not null default 121.1, -- 250 °F: a firing ends when it cools below this...
  min_peak_c          real not null default 537.8, -- 1000 °F: ...but only after it got at least this hot
  max_temp_c          real not null default 1330,  -- 2426 °F: overshoot limit when a firing has no target
  overshoot_margin_c  real not null default 13.9,  -- 25 °F: allowed over a firing's target before alerting
  stall_rate_c_per_hr real not null default 5.6,   -- 10 °F/hr: slower than this counts as a stalled climb
  stall_window_min    int  not null default 60,    -- measured over this many minutes
  offline_minutes     int  not null default 10,    -- alert if no data this long during a firing
  alerts_enabled      boolean not null default true,
  dashboard_url       text                         -- link opened when you tap a phone alert
);
insert into public.settings default values;

create table public.readings (
  id        bigint generated always as identity primary key,
  device_id text not null,
  ts        timestamptz not null,
  temp_c    real,                 -- null when the sensor reported a fault
  cj_c      real,                 -- cold-junction (logger box) temperature
  fault     smallint not null default 0,  -- MAX31856 fault flags, 0 = OK
  unique (device_id, ts)
);
create index readings_ts on public.readings (ts);

create table public.firings (
  id           bigint generated always as identity primary key,
  device_id    text not null,
  started_at   timestamptz not null,
  ended_at     timestamptz,
  status       text not null default 'active' check (status in ('active', 'complete')),
  peak_c       real,
  peak_at      timestamptz,
  name         text,
  notes        text,
  cone         text,
  target_c     real,
  alerts_muted boolean not null default false,
  created_at   timestamptz not null default now()
);
create unique index one_active_firing on public.firings (device_id) where status = 'active';
create index firings_started on public.firings (started_at desc);

create table public.device_status (
  device_id       text primary key,
  last_seen       timestamptz,    -- server time of the last upload
  last_reading_at timestamptz,
  last_temp_c     real,
  last_fault      smallint,
  rssi            int,            -- WiFi signal strength (dBm)
  buffered        int,            -- readings waiting on the logger
  fw              text
);

create table public.alerts (
  id         bigint generated always as identity primary key,
  firing_id  bigint references public.firings on delete cascade,
  kind       text not null,       -- started, complete, overshoot, stall, offline, fault
  title      text not null,
  message    text not null,
  created_at timestamptz not null default now()
);
create index alerts_created on public.alerts (created_at desc);

-- ---------------------------------------------------------------------------
-- Access rules: anyone with the link can view; signed-in staff can edit.
-- Turn OFF public sign-ups in Supabase (Authentication → Sign In / Providers)
-- and add staff accounts by hand, because every signed-in user counts as staff.
-- ---------------------------------------------------------------------------

-- Table permissions (needed if "automatically expose new tables" was off when the project was created).
-- The row-level rules below still decide which rows each role can actually see or change.
grant usage on schema public to anon, authenticated;
grant select on public.settings, public.readings, public.firings, public.device_status, public.alerts to anon, authenticated;
grant insert, update, delete on public.firings to authenticated;
grant update on public.settings to authenticated;

alter table public.settings      enable row level security;
alter table public.readings      enable row level security;
alter table public.firings       enable row level security;
alter table public.device_status enable row level security;
alter table public.alerts        enable row level security;
alter table private.config       enable row level security;

create policy "anyone can view" on public.settings      for select using (true);
create policy "anyone can view" on public.readings      for select using (true);
create policy "anyone can view" on public.firings       for select using (true);
create policy "anyone can view" on public.device_status for select using (true);
create policy "anyone can view" on public.alerts        for select using (true);

create policy "staff edit settings" on public.settings for update to authenticated using (true) with check (true);
create policy "staff add firings"    on public.firings for insert to authenticated with check (true);
create policy "staff edit firings"   on public.firings for update to authenticated using (true) with check (true);
create policy "staff delete firings" on public.firings for delete to authenticated using (true);

-- Live updates for the dashboard
alter publication supabase_realtime add table public.readings, public.device_status, public.firings, public.alerts;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function private.fmt_f(c real) returns text
language sql immutable as $$
  select round(c * 9 / 5 + 32)::int || '°F'
$$;

create or replace function private.fmt_dur(d interval) returns text
language sql immutable as $$
  select floor(extract(epoch from d) / 3600)::int || 'h ' || lpad((floor(extract(epoch from d) / 60)::int % 60)::text, 2, '0') || 'm'
$$;

-- MAX31856 fault register bits, in plain words
create or replace function private.fault_text(f int) returns text
language sql immutable as $$
  select coalesce(nullif(concat_ws(', ',
    case when f & 1   <> 0 then 'thermocouple open (unplugged or broken)' end,
    case when f & 2   <> 0 then 'over/under voltage on the thermocouple input' end,
    case when f & 4   <> 0 then 'thermocouple below its low limit' end,
    case when f & 8   <> 0 then 'thermocouple above its high limit' end,
    case when f & 16  <> 0 then 'logger box below its low limit' end,
    case when f & 32  <> 0 then 'logger box above its high limit' end,
    case when f & 64  <> 0 then 'thermocouple out of range' end,
    case when f & 128 <> 0 then 'cold junction out of range' end), ''), 'unknown fault')
$$;

-- Record an alert and push it to phones through ntfy.
-- p_dedupe: skip if the same kind of alert for the same firing was sent this recently.
create or replace function private.send_alert(
  p_firing bigint, p_kind text, p_title text, p_message text,
  p_priority int, p_dedupe interval
) returns void
language plpgsql security definer set search_path = public, private, pg_temp
as $$
declare
  cfg   private.config;
  s     public.settings;
  muted boolean := false;
begin
  if exists (select 1 from public.alerts
             where kind = p_kind and firing_id is not distinct from p_firing
               and created_at > now() - p_dedupe) then
    return;
  end if;

  insert into public.alerts (firing_id, kind, title, message) values (p_firing, p_kind, p_title, p_message);

  select * into cfg from private.config where id = 1;
  select * into s from public.settings where id = 1;
  if p_firing is not null then
    select alerts_muted into muted from public.firings where id = p_firing;
  end if;
  if not s.alerts_enabled or coalesce(muted, false) or coalesce(cfg.ntfy_topic, '') = '' then
    return;
  end if;

  perform net.http_post(
    url  := cfg.ntfy_server,
    body := jsonb_strip_nulls(jsonb_build_object(
      'topic',    cfg.ntfy_topic,
      'title',    p_title,
      'message',  p_message,
      'priority', p_priority,
      'click',    nullif(s.dashboard_url, ''),
      'tags',     jsonb_build_array(case p_kind
                    when 'overshoot' then 'rotating_light'
                    when 'stall'     then 'hourglass'
                    when 'offline'   then 'warning'
                    when 'fault'     then 'warning'
                    when 'complete'  then 'white_check_mark'
                    else 'fire' end)
    ))
  );
end $$;

-- ---------------------------------------------------------------------------
-- ingest(): called by the logger with a batch of readings.
-- Stores them, opens/closes firings automatically, and checks alerts.
--
-- p_readings is a JSON array like:
--   [{"t": 1760371200000, "c": 812.4, "cj": 31.2, "f": 0}, ...]
--   t = time in milliseconds since 1970 (UTC), c = °C (null on fault),
--   cj = cold junction °C, f = MAX31856 fault flags
-- ---------------------------------------------------------------------------
create or replace function public.ingest(
  p_device_key text,
  p_device_id  text,
  p_readings   jsonb,
  p_rssi       int  default null,
  p_buffered   int  default null,
  p_fw         text default null
) returns jsonb
language plpgsql security definer set search_path = public, private, pg_temp
as $$
declare
  cfg        private.config;
  s          public.settings;
  f          public.firings;
  r          record;
  first_row  boolean := true;
  n_inserted int := 0;
  prev_c     real;
  latest_ts  timestamptz;
  latest_c   real;
  any_ts     timestamptz;
  any_c      real;
  any_fault  int;
  fault_bits int;
  fault_ts   timestamptz;
  live       boolean;
  peak_dirty boolean := false;
  v_min      real;
  v_start    timestamptz;
  v_then     real;
  v_limit    real;
  v_goal     real;
begin
  select * into cfg from private.config where id = 1;
  if p_device_key is distinct from cfg.device_key then
    raise exception 'invalid device key' using errcode = '28000';
  end if;
  if p_device_id is null or length(p_device_id) > 64 then
    raise exception 'invalid device id';
  end if;
  if jsonb_typeof(p_readings) is distinct from 'array' then
    raise exception 'p_readings must be a JSON array';
  end if;
  if jsonb_array_length(p_readings) > 2000 then
    raise exception 'too many readings in one upload (max 2000)';
  end if;

  select * into s from public.settings where id = 1;
  select * into f from public.firings where device_id = p_device_id and status = 'active';

  -- Insert new readings (duplicates from retries are skipped) and walk through them in time order.
  for r in
    with b as (
      select to_timestamp((x->>'t')::double precision / 1000) as ts,
             (x->>'c')::real as c, (x->>'cj')::real as cj,
             coalesce((x->>'f')::int, 0) as fault
      from jsonb_array_elements(p_readings) x
    ), ins as (
      insert into public.readings (device_id, ts, temp_c, cj_c, fault)
      select p_device_id, b.ts, case when b.fault = 0 then b.c end, b.cj, b.fault
      from b
      where b.ts > '2024-01-01' and b.ts < now() + interval '5 minutes'   -- ignore unsynced clocks
      on conflict (device_id, ts) do nothing
      returning ts, temp_c as c, fault
    )
    select * from ins order by ts
  loop
    n_inserted := n_inserted + 1;
    if first_row then
      select temp_c into prev_c from public.readings
      where device_id = p_device_id and ts < r.ts and fault = 0 and temp_c is not null
      order by ts desc limit 1;
      first_row := false;
    end if;

    any_ts := r.ts; any_c := r.c; any_fault := r.fault;
    if r.fault <> 0 then
      fault_bits := r.fault; fault_ts := r.ts;
      continue;
    end if;
    continue when r.c is null;

    latest_ts := r.ts; latest_c := r.c;
    live := r.ts > now() - interval '10 minutes';   -- don't push alerts for old buffered data

    if f.id is null then
      -- Start a firing when the kiln climbs past the start temperature.
      -- After a firing ends, the kiln must cool well below the start temperature before
      -- a new firing can begin, so small wobbles while cooling don't count as a new firing.
      if r.c >= s.start_temp_c and (prev_c is null or prev_c < s.start_temp_c)
         and not exists (
           select 1 from public.firings pf
           where pf.device_id = p_device_id and pf.ended_at < r.ts
             and pf.ended_at = (select max(ended_at) from public.firings where device_id = p_device_id and ended_at < r.ts)
             and not exists (select 1 from public.readings rr
                             where rr.device_id = p_device_id and rr.fault = 0
                               and rr.ts > pf.ended_at and rr.ts < r.ts
                               and rr.temp_c < s.start_temp_c - 15)) then
        -- Back-date the start to when the climb began (the coolest point in the last 3 hours).
        select min(temp_c) into v_min from public.readings
        where device_id = p_device_id and fault = 0 and ts between r.ts - interval '3 hours' and r.ts;
        select max(ts) into v_start from public.readings
        where device_id = p_device_id and fault = 0 and ts between r.ts - interval '3 hours' and r.ts
          and temp_c <= v_min + 3;

        insert into public.firings (device_id, started_at, peak_c, peak_at)
        values (p_device_id, coalesce(v_start, r.ts), r.c, r.ts)
        returning * into f;

        if live then
          perform private.send_alert(f.id, 'started', 'Firing started',
            format('The kiln passed %s. A new firing is being logged.', private.fmt_f(s.start_temp_c)),
            3, interval '1 hour');
        end if;
      end if;
    else
      if f.peak_c is null or r.c > f.peak_c then
        f.peak_c := r.c; f.peak_at := r.ts; peak_dirty := true;
      end if;

      -- End the firing once it has cooled down (or if it never really got going).
      if (f.peak_c >= s.min_peak_c and r.c < s.end_temp_c)
         or (f.peak_c < s.min_peak_c and r.c < s.start_temp_c - 15) then
        update public.firings
        set status = 'complete', ended_at = r.ts, peak_c = f.peak_c, peak_at = f.peak_at
        where id = f.id;
        peak_dirty := false;
        if live then
          perform private.send_alert(f.id, 'complete', 'Firing complete',
            format('Peak %s. %s from start to cool-down.', private.fmt_f(f.peak_c), private.fmt_dur(r.ts - f.started_at)),
            3, interval '1 hour');
        end if;
        f := null;
      end if;
    end if;

    prev_c := r.c;
  end loop;

  if peak_dirty and f.id is not null then
    update public.firings set peak_c = f.peak_c, peak_at = f.peak_at where id = f.id;
  end if;

  -- Sensor fault alert
  if fault_ts is not null and fault_ts > now() - interval '10 minutes' then
    perform private.send_alert(f.id, 'fault', 'Thermocouple fault',
      'The logger reports: ' || private.fault_text(fault_bits) || '. Check the thermocouple plug and wiring.',
      4, case when f.id is null then interval '6 hours' else interval '30 minutes' end);
  end if;

  -- Overshoot and stalled-climb alerts, based on the newest good reading
  if f.id is not null and latest_ts > now() - interval '10 minutes' then
    v_goal  := coalesce(f.target_c, s.max_temp_c);
    v_limit := coalesce(f.target_c + s.overshoot_margin_c, s.max_temp_c);

    if latest_c > v_limit then
      perform private.send_alert(f.id, 'overshoot', 'Kiln over temperature',
        format('The kiln is at %s, above the %s limit.', private.fmt_f(latest_c), private.fmt_f(v_limit)),
        5, interval '15 minutes');
    elsif latest_ts - f.started_at > make_interval(mins => s.stall_window_min)
          and latest_c < v_goal - 15            -- still short of the goal
          and latest_c >= f.peak_c - 15 then    -- still climbing, not cooling
      select temp_c into v_then from public.readings
      where device_id = p_device_id and fault = 0 and temp_c is not null
        and ts <= latest_ts - make_interval(mins => s.stall_window_min)
      order by ts desc limit 1;
      if v_then is not null
         and (latest_c - v_then) * 60.0 / s.stall_window_min < s.stall_rate_c_per_hr then
        perform private.send_alert(f.id, 'stall', 'Climb has stalled',
          format('Up only %s°F in the last %s minutes (now %s).',
                 round((latest_c - v_then) * 9 / 5), s.stall_window_min, private.fmt_f(latest_c)),
          4, interval '60 minutes');
      end if;
    end if;
  end if;

  -- Logger status shown on the dashboard
  insert into public.device_status as d
    (device_id, last_seen, last_reading_at, last_temp_c, last_fault, rssi, buffered, fw)
  values (p_device_id, now(), any_ts, any_c, any_fault, p_rssi, p_buffered, p_fw)
  on conflict (device_id) do update set
    last_seen       = excluded.last_seen,
    rssi            = excluded.rssi,
    buffered        = excluded.buffered,
    fw              = excluded.fw,
    last_reading_at = case when excluded.last_reading_at >= coalesce(d.last_reading_at, '-infinity')
                           then excluded.last_reading_at else d.last_reading_at end,
    last_temp_c     = case when excluded.last_reading_at >= coalesce(d.last_reading_at, '-infinity')
                           then excluded.last_temp_c else d.last_temp_c end,
    last_fault      = case when excluded.last_reading_at >= coalesce(d.last_reading_at, '-infinity')
                           then excluded.last_fault else d.last_fault end;

  return jsonb_build_object('ok', true, 'inserted', n_inserted, 'active_firing', f.id);
end $$;

grant execute on function public.ingest(text, text, jsonb, int, int, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- get_curve(): readings between two times, averaged down to at most
-- p_max_points points, as a compact JSON array of [epoch ms, °C].
-- ---------------------------------------------------------------------------
create or replace function public.get_curve(
  p_device_id text, p_from timestamptz, p_to timestamptz, p_max_points int default 1500
) returns jsonb
language sql stable set search_path = public
as $$
  with p as (
    select greatest(1, ceil(extract(epoch from (p_to - p_from)) / least(greatest(p_max_points, 10), 20000)))::int as bucket_s
  ), b as (
    select avg(extract(epoch from r.ts)) as t, avg(r.temp_c) as c
    from public.readings r, p
    where r.device_id = p_device_id and r.ts >= p_from and r.ts <= p_to
      and r.fault = 0 and r.temp_c is not null
    group by date_bin(make_interval(secs => p.bucket_s), r.ts, p_from)
  )
  select coalesce(jsonb_agg(jsonb_build_array((t * 1000)::bigint, round(c::numeric, 1)) order by t), '[]'::jsonb)
  from b
$$;

grant execute on function public.get_curve(text, timestamptz, timestamptz, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Scheduled jobs
-- ---------------------------------------------------------------------------

-- Alert if the logger goes quiet during a firing.
create or replace function private.watchdog() returns void
language plpgsql security definer set search_path = public, private, pg_temp
as $$
declare
  s public.settings;
  f public.firings;
  d public.device_status;
begin
  select * into s from public.settings where id = 1;
  for f in select * from public.firings where status = 'active' loop
    select * into d from public.device_status where device_id = f.device_id;
    if d.last_seen is null or d.last_seen < now() - make_interval(mins => s.offline_minutes) then
      perform private.send_alert(f.id, 'offline', 'Kiln logger offline',
        format('No data for over %s minutes during a firing. Last reading: %s.',
               s.offline_minutes,
               coalesce(private.fmt_f((select temp_c from public.readings
                                       where device_id = f.device_id and temp_c is not null
                                       order by ts desc limit 1)), 'none')),
        4, interval '30 minutes');
    end if;
  end loop;
end $$;

-- Keep the database small: drop idle (between-firing) readings after 90 days.
-- Readings inside a firing are kept forever.
create or replace function private.cleanup() returns void
language sql security definer set search_path = public, private, pg_temp
as $$
  delete from public.readings r
  where r.ts < now() - interval '90 days'
    and not exists (
      select 1 from public.firings f
      where f.device_id = r.device_id
        and r.ts between f.started_at - interval '1 hour' and coalesce(f.ended_at, now()) + interval '1 hour');
  delete from public.alerts where created_at < now() - interval '2 years';
$$;

revoke all on all functions in schema private from public, anon, authenticated;

select cron.schedule('kiln-watchdog', '*/5 * * * *', 'select private.watchdog()');
select cron.schedule('kiln-cleanup',  '15 9 * * *',  'select private.cleanup()');   -- 09:15 UTC = early morning in Texas

-- Show the generated device key and alert topic (you'll need both).
select device_key, ntfy_topic from private.config;
