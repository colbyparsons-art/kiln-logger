-- Upgrade 2026-11-05: blocked-person message says "moderator" instead of "department head".
-- Safe to run more than once.

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
    raise exception 'Alerts are switched off for %. Ask the moderator.', p.label using errcode = '42501';
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
