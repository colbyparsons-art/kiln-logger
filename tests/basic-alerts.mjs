// Firing detection and basic alerts (overshoot, stall, fault, offline). Usage: node basic-alerts.mjs <kiln-logger folder>
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const KilnSim = require(process.argv[2] + '/web/sim.js');
let schema = fs.readFileSync(process.argv[2] + '/supabase/schema.sql', 'utf8')
  .replace(/create extension[^;]*;/g, '');

async function fresh() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create publication supabase_realtime;
    create schema net; create table net.sent(id serial, url text, body jsonb);
    create function net.http_post(url text, body jsonb) returns bigint language sql as $$ insert into net.sent(url, body) values (url, body) returning id::bigint $$;
    create schema cron; create function cron.schedule(a text, b text, c text) returns int language sql as $$ select 1 $$; create schema auth; create table auth.users(email text, created_at timestamptz default now()); create function auth.jwt() returns jsonb language sql as $$ select ('{}')::jsonb $$;
  `);
  await db.exec(schema);
  return db;
}
async function ingest(db, readings) {
  const key = (await db.query('select device_key from private.config')).rows[0].device_key;
  let last;
  for (let i = 0; i < readings.length; i += 500) {
    const batch = readings.slice(i, i + 500).map(([t, c]) => ({ t, c, cj: 28, f: 0 }));
    last = (await db.query('select public.ingest($1,$2,$3::jsonb,$4,$5,$6) as r', [key, 'gas-kiln', JSON.stringify(batch), -60, 0, 'test'])).rows[0].r;
  }
  return last;
}
const show = async (db, label) => {
  console.log('==', label);
  console.log((await db.query(`select id,status,started_at,ended_at,round(peak_c) peak from firings order by id`)).rows);
  console.log((await db.query(`select kind,title,message from alerts order by id`)).rows);
  console.log('pushes:', (await db.query(`select body->>'title' t from net.sent`)).rows.map(r => r.t));
};

// 1. Past firing backfilled -> one complete firing, no pushes
let db = await fresh();
let f = KilnSim.createFiring({ seed: 3 });
let start = Date.now() - 3 * 86400000;
console.log('sim totalHours', f.totalHours.toFixed(1), 'peak', f.peakC);
await ingest(db, KilnSim.generate(f, start, 30, 2));
await show(db, 'backfill');
console.log('start offset (min)', (await db.query(`select extract(epoch from started_at)*1000 - ${start} as d from firings`)).rows[0].d / 60000);
// retry same data -> no duplicates
await ingest(db, KilnSim.generate(f, start, 30, 2));
console.log('firings after retry', (await db.query('select count(*) from firings')).rows[0].count);
console.log('curve pts', (await db.query(`select jsonb_array_length(public.get_curve('gas-kiln', now()-interval '4 days', now(), 800)) n`)).rows[0].n);

// 2. Overshoot firing in progress right now (reach peak at now)
db = await fresh();
f = KilnSim.createFiring({ seed: 5, overshoot: true });
start = Date.now() - f.heatHours * 3600000;
await ingest(db, KilnSim.generate(f, start, 30, 1).filter(([t]) => t <= Date.now()));
await show(db, 'overshoot live');
console.log((await db.query('select * from device_status')).rows);

// 3. Stall firing, now inside the stall
db = await fresh();
f = KilnSim.createFiring({ seed: 9, stall: true });
let stallH = 0; for (let h = 0; h < f.heatHours; h += 0.01) if (f.tempAt(h) > 1098) { stallH = h; break; }
start = Date.now() - (stallH + 1.5) * 3600000;
await ingest(db, KilnSim.generate(f, start, 30, 1).filter(([t]) => t <= Date.now()));
await show(db, 'stall live');

// 4. Live start then fault then watchdog
db = await fresh();
f = KilnSim.createFiring({ seed: 2 });
start = Date.now() - 2 * 3600000;
await ingest(db, KilnSim.generate(f, start, 30, 2).filter(([t]) => t <= Date.now() - 60000));
const key = (await db.query('select device_key from private.config')).rows[0].device_key;
await db.query('select public.ingest($1,$2,$3::jsonb)', [key, 'gas-kiln', JSON.stringify([{ t: Date.now(), c: null, cj: 28, f: 1 }])]);
await db.query(`update device_status set last_seen = now() - interval '20 minutes'`);
await db.query('select private.watchdog()');
await show(db, 'start/fault/offline');
// bad key
try { await db.query('select public.ingest($1,$2,$3::jsonb)', ['nope', 'gas-kiln', '[]']); } catch (e) { console.log('bad key ->', e.message); }
