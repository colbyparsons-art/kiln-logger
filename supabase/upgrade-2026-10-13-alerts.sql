-- Upgrade 2026-10-13: temperature-drop alert, "cooling" marker, and per-person phone alerts.
-- Run once in the SQL Editor. Safe to run again.

alter table public.settings
  add column if not exists drop_alert_c    real not null default 27.8,  -- 50 F
  add column if not exists drop_window_min int  not null default 20,
  add column if not exists owner_alerts    text not null default 'urgent' check (owner_alerts in ('all', 'urgent', 'unclaimed'));
alter table public.firings add column if not exists cooling_at timestamptz;
alter table private.config add column if not exists owner_email text;

-- ---------------------------------------------------------------------------
-- Who gets phone alerts
--
-- The owner manages a list of people (nicknames or initials only, for privacy).
-- Each person has a private ntfy channel and a PIN. Whoever is firing enters their
-- PIN on the dashboard to get that firing's alerts; nobody else is pinged.
-- The owner gets everything on unclaimed firings, plus (by default) only urgent
-- alerts on firings someone else has claimed. See settings.owner_alerts.
-- ---------------------------------------------------------------------------

create table if not exists public.people (
  id         bigint generated always as identity primary key,
  label      text not null,                 -- nickname or initials, never a full student name
  allowed    boolean not null default true, -- the owner can switch someone's alerts off
  pin        text not null unique default lpad(floor(random() * 1000000)::int::text, 6, '0'),
  ntfy_topic text not null unique default 'kiln-' || left(replace(gen_random_uuid()::text, '-', ''), 16),
  created_at timestamptz not null default now()
);

-- People who get alerts for a firing
create table if not exists public.firing_recipients (
  firing_id  bigint not null references public.firings on delete cascade,
  person_id  bigint not null references public.people on delete cascade,
  created_at timestamptz not null default now(),
  primary key (firing_id, person_id)
);

-- "Send me the next firing's alerts", made while nothing is firing (kept 12 hours)
create table if not exists public.alert_claims (
  person_id  bigint primary key references public.people on delete cascade,
  device_id  text not null,
  created_at timestamptz not null default now()
);

-- True when the signed-in user is the owner
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public, private, auth, pg_temp
as $$
  select coalesce((auth.jwt() ->> 'email') = coalesce(
    (select owner_email from private.config where id = 1),
    (select email from auth.users order by created_at limit 1)), false)
$$;
grant execute on function public.is_owner() to anon, authenticated;

alter table public.people            enable row level security;
alter table public.firing_recipients enable row level security;
alter table public.alert_claims      enable row level security;
grant select, insert, update, delete on public.people, public.firing_recipients, public.alert_claims to authenticated;
drop policy if exists "owner only" on public.people;
drop policy if exists "owner only" on public.firing_recipients;
drop policy if exists "owner only" on public.alert_claims;
create policy "owner only" on public.people            for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy "owner only" on public.firing_recipients for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy "owner only" on public.alert_claims      for all to authenticated using (public.is_owner()) with check (public.is_owner());

-- Send one ntfy notification
create or replace function private.push(p_topic text, p_title text, p_message text, p_priority int, p_tag text)
returns void
language plpgsql security definer set search_path = public, private, pg_temp
as $$
declare
  cfg private.config;
  s   public.settings;
begin
  select * into cfg from private.config where id = 1;
  select * into s from public.settings where id = 1;
  perform net.http_post(
    url  := cfg.ntfy_server,
    body := jsonb_strip_nulls(jsonb_build_object(
      'topic', p_topic, 'title', p_title, 'message', p_message, 'priority', p_priority,
      'click', nullif(s.dashboard_url, ''), 'tags', jsonb_build_array(p_tag)))
  );
end $$;

-- Record an alert and push it to the right phones.
-- p_dedupe: skip if the same kind of alert for the same firing was sent this recently.
create or replace function private.send_alert(
  p_firing bigint, p_kind text, p_title text, p_message text,
  p_priority int, p_dedupe interval
) returns void
language plpgsql security definer set search_path = public, private, pg_temp
as $$
declare
  cfg     private.config;
  s       public.settings;
  muted   boolean := false;
  topics  text[] := '{}';
  claimed int := 0;
  t       text;
  tag     text;
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
  if not s.alerts_enabled or coalesce(muted, false) then
    return;
  end if;

  -- People who claimed this firing
  if p_firing is not null then
    select coalesce(array_agg(p.ntfy_topic), '{}'), count(*) into topics, claimed
    from public.firing_recipients r join public.people p on p.id = r.person_id
    where r.firing_id = p_firing and p.allowed;
  end if;

  -- The owner
  if coalesce(cfg.ntfy_topic, '') <> '' and (
       claimed = 0
       or s.owner_alerts = 'all'
       or (s.owner_alerts = 'urgent' and p_kind in ('overshoot', 'drop', 'offline', 'fault'))) then
    topics := topics || cfg.ntfy_topic;
  end if;

  tag := case p_kind
           when 'overshoot' then 'rotating_light'
           when 'drop'      then 'rotating_light'
           when 'stall'     then 'hourglass'
           when 'offline'   then 'warning'
           when 'fault'     then 'warning'
           when 'complete'  then 'white_check_mark'
           else 'fire' end;
  foreach t in array topics loop
    perform private.push(t, p_title, p_message, p_priority, tag);
  end loop;
end $$;

-- claim_alerts(): called from the dashboard (no login) with a person's PIN.
-- Adds them to the current firing, or to the next one if nothing is firing.
-- p_stop = true removes them instead.
create or replace function public.claim_alerts(p_pin text, p_device_id text, p_stop boolean default false)
returns jsonb
language plpgsql security definer set search_path = public, private, pg_temp
as $$
declare
  p public.people;
  f public.firings;
begin
  select * into p from public.people where pin = trim(p_pin);
  if p.id is null then
    raise exception 'That PIN was not recognized.' using errcode = '28000';
  end if;
  select * into f from public.firings where device_id = p_device_id and status = 'active';

  if p_stop then
    delete from public.firing_recipients where person_id = p.id and firing_id = f.id;
    delete from public.alert_claims where person_id = p.id;
    return jsonb_build_object('label', p.label, 'stopped', true);
  end if;

  if not p.allowed then
    raise exception 'Alerts are switched off for %. Ask the department head.', p.label using errcode = '42501';
  end if;

  if f.id is not null then
    insert into public.firing_recipients (firing_id, person_id) values (f.id, p.id) on conflict do nothing;
  else
    insert into public.alert_claims (person_id, device_id) values (p.id, p_device_id)
    on conflict (person_id) do update set device_id = excluded.device_id, created_at = now();
  end if;

  perform private.push(p.ntfy_topic, 'Kiln alerts on',
    case when f.id is null
         then 'You will get alerts for the next firing, if it starts within 12 hours.'
         else 'You will get alerts for the firing in progress.' end,
    3, 'bell');
  return jsonb_build_object('label', p.label, 'firing_id', f.id, 'pending', f.id is null);
end $$;
grant execute on function public.claim_alerts(text, text, boolean) to anon, authenticated;

-- What the dashboard shows about a firing's alert recipients.
-- Everyone sees counts; only the owner sees who.
create or replace function public.alert_recipients(p_firing bigint, p_device_id text)
returns jsonb
language plpgsql stable security definer set search_path = public, private, pg_temp
as $$
declare
  is_own boolean := public.is_owner();
begin
  return jsonb_build_object(
    'count', (select count(*) from public.firing_recipients r join public.people p on p.id = r.person_id
              where r.firing_id = p_firing and p.allowed),
    'pending', (select count(*) from public.alert_claims c
                where c.device_id = p_device_id and c.created_at > now() - interval '12 hours'),
    'people', case when is_own then (
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'label', p.label) order by p.label), '[]')
      from public.firing_recipients r join public.people p on p.id = r.person_id
      where r.firing_id = p_firing) end,
    'pending_people', case when is_own then (
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'label', p.label) order by p.label), '[]')
      from public.alert_claims c join public.people p on p.id = c.person_id
      where c.device_id = p_device_id and c.created_at > now() - interval '12 hours') end
  );
end $$;
grant execute on function public.alert_recipients(bigint, text) to anon, authenticated;

-- When a firing starts (automatically or by hand), give it the "next firing" claims.
create or replace function private.attach_claims() returns trigger
language plpgsql security definer set search_path = public, private, pg_temp
as $$
begin
  if new.status = 'active' then
    insert into public.firing_recipients (firing_id, person_id)
    select new.id, c.person_id from public.alert_claims c
    where c.device_id = new.device_id and c.created_at > now() - interval '12 hours'
    on conflict do nothing;
    delete from public.alert_claims where device_id = new.device_id;
  end if;
  return new;
end $$;

drop trigger if exists firings_attach_claims on public.firings;
create trigger firings_attach_claims after insert on public.firings
  for each row execute function private.attach_claims();

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
  v_high     real;
  v_now      real;
  v_before   real;
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
          format('Up only %s' || chr(176) || 'F in the last %s minutes (now %s).',
                 round((latest_c - v_then) * 9 / 5), s.stall_window_min, private.fmt_f(latest_c)),
          4, interval '60 minutes');
      end if;
    end if;

    -- Temperature drop (e.g. a pilot or burner blew out). To avoid false alarms:
    --  * compare 2-minute averages, not single readings, so burner wobble is smoothed out
    --  * the fall must be large: drop_alert_c below the high of the last drop_window_min minutes.
    --    A cooler kiln loses heat more slowly, so below about 900  degF the threshold shrinks
    --    to 6% of the kiln's rise above room temperature (never less than about 15  degF).
    --  * and still going (the last 2 minutes are lower than 3-5 minutes ago), so a brief
    --    reduction dip that has already recovered doesn't count
    --  * skip it once the kiln has been marked as cooling, or once it reached its target
    --    (within 50  degF), since that drop is the planned shutoff
    if f.cooling_at is null
       and (f.target_c is null or f.peak_c < f.target_c - 28) then
      select max(temp_c) into v_high from public.readings
      where device_id = p_device_id and fault = 0
        and ts between latest_ts - make_interval(mins => s.drop_window_min) and latest_ts;
      select avg(temp_c) into v_now from public.readings
      where device_id = p_device_id and fault = 0 and ts > latest_ts - interval '2 minutes' and ts <= latest_ts;
      select avg(temp_c) into v_before from public.readings
      where device_id = p_device_id and fault = 0
        and ts between latest_ts - interval '5 minutes' and latest_ts - interval '3 minutes';
      if v_high - v_now >= least(s.drop_alert_c, greatest(8, (v_high - 24) * 0.06))
         and v_now < v_before - 0.5 then
        perform private.send_alert(f.id, 'drop', 'Kiln temperature dropping',
          format('Down %s' || chr(176) || 'F from %s in the last %s minutes (now %s). Check the burners and pilots. '
                 || 'If the kiln was turned off on purpose, mark it as cooling on the dashboard.',
                 round((v_high - v_now) * 9 / 5), private.fmt_f(v_high), s.drop_window_min, private.fmt_f(v_now)),
          5, interval '20 minutes');
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

revoke all on all functions in schema private from public, anon, authenticated;

select 'upgrade done' as status;
