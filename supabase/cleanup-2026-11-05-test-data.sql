-- One-time cleanup before real use (2026-11-05).
-- Permanently deletes ALL firings, readings, alerts and sign-ups so far
-- (simulated firings and the bench tests), and numbers new firings from 1 again.
-- Keeps: settings, the People list, staff logins, device key, ntfy topic.

truncate public.readings, public.alerts, public.firing_recipients, public.firings
  restart identity;
delete from public.alert_claims;
delete from public.device_status;

update public.settings
   set dashboard_url = 'https://colbyparsonsart.com/kiln-logger/'
 where id = 1;

select (select count(*) from public.firings)  as firings_left,
       (select count(*) from public.readings) as readings_left,
       (select dashboard_url from public.settings where id = 1) as dashboard_link;
