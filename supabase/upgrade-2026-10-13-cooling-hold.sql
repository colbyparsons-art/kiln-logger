-- Upgrade 2026-10-13 (2): "Kiln is cooling" alert, one drop alert per drop, Hold, and
-- firing controls by PIN. Run once in the SQL Editor. Safe to run again.

alter table public.firings
  add column if not exists drop_armed  boolean not null default true,
  add column if not exists drop_from_c real,
  add column if not exists hold_until  timestamptz;

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
           when 'cooling'   then 'snowflake'
           else 'fire' end;
  foreach t in array topics loop
    perform private.push(t, p_title, p_message, p_priority, tag);
  end loop;
end $$;

create or replace function public.firing_action(p_pin text, p_device_id text, p_action text, p_minutes int default null)
returns jsonb
language plpgsql security definer set search_path = public, private, pg_temp
as $$
declare
  p public.people;
  f public.firings;
begin
  select * into f from public.firings where device_id = p_device_id and status = 'active';
  if f.id is null then
    raise exception 'No firing is in progress.';
  end if;
  select * into p from public.people where pin = trim(p_pin) and allowed;
  if p.id is null or not exists (select 1 from public.firing_recipients where firing_id = f.id and person_id = p.id) then
    raise exception 'That PIN is not signed up for this firing. Sign up for its alerts first.' using errcode = '28000';
  end if;

  if p_action = 'hold' then
    update public.firings set hold_until = now() + make_interval(mins => least(greatest(coalesce(p_minutes, 60), 5), 24 * 60))
    where id = f.id;
  elsif p_action = 'resume' then
    update public.firings set hold_until = null where id = f.id;
  elsif p_action = 'cool' then
    update public.firings set cooling_at = now() where id = f.id;
  elsif p_action = 'uncool' then
    update public.firings set cooling_at = null, drop_armed = true, drop_from_c = null where id = f.id;
  else
    raise exception 'Unknown action %', p_action;
  end if;
  return jsonb_build_object('ok', true, 'label', p.label);
end $$;
grant execute on function public.firing_action(text, text, text, int) to anon, authenticated;

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
  v_mid      real;
  v_early    real;
  v_thresh   real;
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
          and (f.hold_until is null or f.hold_until < latest_ts)   -- not holding on purpose
          and f.cooling_at is null
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

    -- Falling temperature. Two different alerts:
    --  * "Kiln is cooling" (once per firing): the firing reached its target (within 50  degF)
    --    and the kiln is now falling, i.e. the planned shutoff. The firing is marked as
    --    cooling, so nothing else fires until "Firing complete".
    --  * "Kiln temperature dropping" (a pilot or burner may have gone out): before the
    --    target. Sent once per drop; it re-arms only after the kiln climbs back to within
    --    20  degF of where the drop started (it was relit). Slowing the cooldown by firing
    --    down doesn't get it that high, so it doesn't cause repeat alerts.
    -- To avoid false alarms from burner wobble, reduction, and holds that swing up and down:
    --  * compare 2-minute averages, not single readings
    --  * the fall must be large: drop_alert_c below the high of the last drop_window_min minutes.
    --    A cooler kiln loses heat more slowly, so below about 900  degF the threshold shrinks
    --    to 6% of the kiln's rise above room temperature (never less than 25  degF), and the
    --    fall may take up to 45 minutes.
    --  * while a hold is on (Hold button), the fall must be twice as large
    --  * and steady: each of the last four 2-minute averages, about 3 minutes apart, is lower
    --    than the one before (about 10 minutes of continuous fall). A hold that swings turns
    --    around before that.
    -- Marking the firing as cooling by hand on the dashboard turns both off.
    if f.cooling_at is null then
      select max(temp_c) into v_high from public.readings
      where device_id = p_device_id and fault = 0
        and ts between latest_ts - make_interval(mins => s.drop_window_min) and latest_ts;
      if v_high < 480 then   -- below about 900  degF, allow a slower fall
        select max(temp_c) into v_high from public.readings
        where device_id = p_device_id and fault = 0
          and ts between latest_ts - make_interval(mins => greatest(s.drop_window_min, 45)) and latest_ts;
      end if;
      select avg(temp_c) into v_now from public.readings
      where device_id = p_device_id and fault = 0 and ts > latest_ts - interval '2 minutes' and ts <= latest_ts;
      select avg(temp_c) into v_before from public.readings
      where device_id = p_device_id and fault = 0
        and ts between latest_ts - interval '5 minutes' and latest_ts - interval '3 minutes';
      select avg(temp_c) into v_mid from public.readings
      where device_id = p_device_id and fault = 0
        and ts between latest_ts - interval '8 minutes' and latest_ts - interval '6 minutes';
      select avg(temp_c) into v_early from public.readings
      where device_id = p_device_id and fault = 0
        and ts between latest_ts - interval '11 minutes' and latest_ts - interval '9 minutes';

      -- After a drop alert, re-arm once the kiln is back near where the drop started.
      if not f.drop_armed and v_now is not null and v_now >= coalesce(f.drop_from_c, 0) - 11 then
        update public.firings set drop_armed = true, drop_from_c = null where id = f.id;
        f.drop_armed := true;
      end if;

      -- During a planned hold (which can swing up and down), the fall must be twice as large.
      v_thresh := least(s.drop_alert_c, greatest(14, (v_high - 24) * 0.06))
                  * case when f.hold_until > latest_ts then 2 else 1 end;
      if v_high - v_now >= v_thresh
         and v_now < v_before - 0.5 and v_before < v_mid - 0.5 and v_mid < v_early - 0.5 then
        if f.target_c is not null and f.peak_c >= f.target_c - 28 then
          update public.firings set cooling_at = latest_ts where id = f.id;
          perform private.send_alert(f.id, 'cooling', 'Kiln is cooling',
            format('Down %s' || chr(176) || 'F from the peak of %s, so the burners appear to be off. '
                   || 'No more alerts until the firing is complete. If this wasn''t planned, check the burners.',
                   round((f.peak_c - v_now) * 9 / 5), private.fmt_f(f.peak_c)),
            3, interval '100 years');
        elsif f.drop_armed then
          update public.firings set drop_armed = false, drop_from_c = v_high where id = f.id;
          perform private.send_alert(f.id, 'drop', 'Kiln temperature dropping',
            format('Down %s' || chr(176) || 'F from %s in the last %s minutes (now %s). Check the burners and pilots. '
                   || 'If the kiln was turned off on purpose, mark it as cooling on the dashboard. '
                   || 'No more drop alerts unless the kiln climbs again and then drops.',
                   round((v_high - v_now) * 9 / 5), private.fmt_f(v_high), s.drop_window_min, private.fmt_f(v_now)),
            5, interval '1 minute');
        end if;
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
