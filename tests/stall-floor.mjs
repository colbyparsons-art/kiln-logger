// The stalled-climb alert only applies above settings.stall_min_c (default 350 F).
// Usage: node stall-floor.mjs <schema.sql> [<upgrade.sql>]   (with an upgrade: tests old schema + upgrade)
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const [file, upgrade] = process.argv.slice(2);

async function fresh() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create publication supabase_realtime;
    create schema net; create table net.sent(id serial, body jsonb);
    create function net.http_post(url text, body jsonb) returns bigint language sql as $$ insert into net.sent(body) values (body) returning id::bigint $$;
    create schema cron; create function cron.schedule(a text, b text, c text) returns int language sql as $$ select 1 $$;
    create schema auth; create table auth.users(email text, created_at timestamptz default now());
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;`);
  await db.exec(fs.readFileSync(file, 'utf8').replace(/create extension[^;]*;/g, ''));
  if (upgrade) { const u = fs.readFileSync(upgrade, 'utf8'); await db.exec(u); await db.exec(u); }
  return db;
}

// One reading a minute, ending now: 10 min cold, a 20-min ramp to holdC, then flat at holdC for holdMin.
async function run(holdC, holdMin) {
  const db = await fresh();
  const key = (await db.query('select device_key from private.config')).rows[0].device_key;
  const temps = [];
  for (let i = 0; i < 10; i++) temps.push(25);
  for (let i = 1; i <= 20; i++) temps.push(25 + (holdC - 25) * i / 20);
  for (let i = 0; i < holdMin; i++) temps.push(holdC + (i % 2 ? 0.5 : -0.5));
  const now = Date.now();
  const rows = temps.map((c, i) => ({ t: now - (temps.length - 1 - i) * 60000, c, cj: 28, f: 0 }));
  // Upload in 5-minute batches, like a live logger catching up
  for (let i = 0; i < rows.length; i += 5) {
    await db.query('select public.ingest($1,$2,$3::jsonb)', [key, 'gas-kiln', JSON.stringify(rows.slice(i, i + 5))]);
  }
  return (await db.query(`select kind from alerts order by id`)).rows.map(r => r.kind);
}

let ok = true;
const check = (label, kinds, wantStall) => {
  const got = kinds.includes('stall');
  const pass = got === wantStall;
  ok = ok && pass;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}: alerts = ${kinds.join(', ') || 'none'}`);
};
check('flat at 250 F for 90 min (below 350 F floor)', await run(121, 90), false);
check('flat at 340 F for 90 min (just below the floor)', await run(171, 90), false);
check('flat at 410 F for 90 min (above the floor)', await run(210, 90), true);
if (!ok) process.exit(1);
