// Who gets which phone alert (people, PIN sign-up, owner settings, access rules).
// Usage: node alert-routing.mjs fresh ../supabase/schema.sql
//    or: node alert-routing.mjs up <old schema.sql> <upgrade.sql>   (tests an upgrade)
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const [mode, file, upgrade] = process.argv.slice(2);
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create publication supabase_realtime;
  create schema net; create table net.sent(id serial, body jsonb);
  create function net.http_post(url text, body jsonb) returns bigint language sql as $$ insert into net.sent(body) values (body) returning id::bigint $$;
  create schema cron; create function cron.schedule(a text, b text, c text) returns int language sql as $$ select 1 $$;
  create schema auth; create table auth.users(email text, created_at timestamptz default now());
  insert into auth.users(email) values ('owner@twu.edu');
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
  grant usage on schema auth to anon, authenticated; grant execute on function auth.jwt() to anon, authenticated;`);
await db.exec(fs.readFileSync(file, 'utf8').replace(/create extension[^;]*;/g, ''));
if (upgrade) { const u = fs.readFileSync(upgrade, 'utf8'); await db.exec(u); await db.exec(u); console.log('upgrade applied twice OK'); }
const q = async (sql, p) => (await db.query(sql, p)).rows;
const key = (await q('select device_key, ntfy_topic from private.config'))[0];
const sent = async () => { const r = await q(`select body->>'topic' t, body->>'title' title from net.sent order by id`); await db.exec('delete from net.sent'); return r.map(x => (x.t === key.ntfy_topic ? 'OWNER' : x.t.startsWith('kiln-') ? (people[x.t] || x.t) : x.t) + ':' + x.title); };
const people = {};
for (const label of ['MG', 'JT']) { const r = (await q(`insert into people(label) values ($1) returning pin, ntfy_topic`, [label]))[0]; people[r.ntfy_topic] = label; people[label] = r.pin; }
const ingest = (c) => q('select public.ingest($1,$2,$3::jsonb) r', [key.device_key, 'gas-kiln', JSON.stringify(c.map((v, i) => ({ t: Date.now() - (c.length - i) * 10000, c: v, cj: 28, f: 0 })))]);
// MG claims before the firing starts
console.log('claim (idle):', (await q(`select public.claim_alerts($1, 'gas-kiln') r`, [people.MG]))[0].r, await sent());
await ingest([25, 30, 60, 95, 120]);
console.log('firing started ->', await sent());
await ingest([1400]);   // overshoot (no target -> max 1330)
console.log('overshoot, owner_alerts=urgent ->', await sent());
await db.exec(`update firings set alerts_muted=false; delete from alerts where kind='overshoot'; update settings set owner_alerts='unclaimed'`);
await ingest([1401]);
console.log('overshoot, owner_alerts=unclaimed ->', await sent());
await db.exec(`delete from alerts where kind='overshoot'; update people set allowed=false where label='MG'`);
await ingest([1402]);
console.log('overshoot, MG switched off ->', await sent());
try { await q(`select public.claim_alerts($1, 'gas-kiln')`, [people.MG]); } catch (e) { console.log('MG claim when off ->', e.message); }
await db.exec(`update people set allowed=true; delete from alerts where kind='overshoot'; update settings set owner_alerts='urgent'`);
console.log('JT claims mid-firing:', (await q(`select public.claim_alerts($1, 'gas-kiln') r`, [people.JT]))[0].r.label, await sent());
console.log('stop MG:', (await q(`select public.claim_alerts($1, 'gas-kiln', true) r`, [people.MG]))[0].r);
await ingest([1403]);
console.log('overshoot after MG stopped ->', await sent());
try { await q(`select public.claim_alerts('000000x', 'gas-kiln')`); } catch (e) { console.log('bad PIN ->', e.message); }
// Access rules
const fid = (await q(`select id from firings where status='active'`))[0].id;
await db.exec(`set role anon`);
console.log('anon alert_recipients:', (await q(`select public.alert_recipients($1, 'gas-kiln') r`, [fid]))[0].r);
try { console.log('anon people rows:', (await q('select * from people')).length); } catch (e) { console.log('anon people ->', e.message); }
await db.exec(`reset role; set test.jwt = '{"email":"other@twu.edu"}'; set role authenticated`);
console.log('other staff people rows:', (await q('select * from people')).length, '| info:', (await q(`select public.alert_recipients($1, 'gas-kiln') r`, [fid]))[0].r);
await db.exec(`reset role; set test.jwt = '{"email":"owner@twu.edu"}'; set role authenticated`);
console.log('owner people rows:', (await q('select label from people')).length, '| info:', JSON.stringify((await q(`select public.alert_recipients($1, 'gas-kiln') r`, [fid]))[0].r));
