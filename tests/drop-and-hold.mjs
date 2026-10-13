// Streams whole simulated firings (10-second readings) and lists every drop / cooling alert:
// normal firings, holds that swing, pilot blowouts at different temperatures.
// Usage: node drop-and-hold.mjs <kiln-logger folder>
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dir = process.argv[2];
const KilnSim = require(dir + '/web/sim.js');
// Test copy: treat every reading as "live" so alerts are evaluated while streaming old timestamps.
let schema = fs.readFileSync(dir + '/supabase/schema.sql', 'utf8').replace(/create extension[^;]*;/g, '')
  .replace("live := r.ts > now() - interval '10 minutes';", 'live := true;')
  .replace("latest_ts > now() - interval '10 minutes' then", 'latest_ts is not null then')
  .replace(/and created_at > now\(\) - p_dedupe\)/, "and created_at > now() - interval '1 microsecond')"); // no dedupe: log every hit
async function run(label, firingOpts, { target, noise = 0, hours, transform } = {}) {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create publication supabase_realtime;
    create schema net; create function net.http_post(url text, body jsonb) returns bigint language sql as $$ select 1::bigint $$;
    create schema cron; create function cron.schedule(a text, b text, c text) returns int language sql as $$ select 1 $$; create schema auth; create table auth.users(email text, created_at timestamptz default now()); create function auth.jwt() returns jsonb language sql as $$ select ('{}')::jsonb $$;`);
  await db.exec(schema);
  const key = (await db.query('select device_key from private.config')).rows[0].device_key;
  const f = KilnSim.createFiring(firingOpts);
  const start = Date.now() - 40 * 3600000;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const all = KilnSim.generate(f, start, 10, 1).map(([t, c]) => [t, (transform ? transform((t - start) / 3600000, c, f) : c) + (rnd() - 0.5) * 2 * noise]);
  const end = hours ? start + hours * 3600000 : Infinity;
  const hits = [];
  let targetSet = false;
  for (let i = 0; i < all.length && all[i][0] <= end; i += 6) {
    const batch = all.slice(i, i + 6).map(([t, c]) => ({ t, c, cj: 28, f: 0 }));
    await db.query('select public.ingest($1,$2,$3::jsonb)', [key, 'k', JSON.stringify(batch)]);
    if (target && !targetSet) { const r = await db.query(`update firings set target_c = $1 where status='active' returning id`, [target]); targetSet = r.rows.length > 0; }
    const n = (await db.query(`select count(*)::int n from alerts where kind in ('drop','cooling')`)).rows[0].n;
    if (n > hits.length) hits.push((await db.query(`select kind from alerts where kind in ('drop','cooling') order by id desc limit 1`)).rows[0].kind + ' ' + ((all[i][0] - start) / 3600000).toFixed(2) + 'h@' + Math.round(all[i][1] * 9 / 5 + 32) + 'F');
  }
  const peak = (await db.query('select round(max(peak_c)) p from firings')).rows[0].p;
  console.log(label.padEnd(44), 'heatEnd', f.heatHours.toFixed(2) + 'h', 'peak', peak, '| alerts:', hits.length ? hits.slice(0, 4).join(', ') + (hits.length > 4 ? ` (+${hits.length - 4} more)` : '') : 'none');
}
// await run('normal, cone 10 target, whole firing', { seed: 11 }, { target: 1285 });
// await run('normal, NO target', { seed: 11 });
// await run('pilot out at 8h, no target', { seed: 11, blowout: 8 });
// await run('pilot out at 11h, target set', { seed: 11, blowout: 11 }, { target: 1285 });
// A hold: the kiln swings +/-amp (C) around the hold temperature with the given period, then resumes.
const hold = (h0, dur, amp, periodMin, blowAt) => (h, c, f) => {
  if (h < h0) return c;
  const T = f.tempAt(h0);
  if (blowAt && h >= blowAt) { const Tb = T + amp * Math.sin(2 * Math.PI * (blowAt - h0) * 60 / periodMin); return 24 + (Tb - 24) * Math.exp(-(h - blowAt) / 4); }
  if (h < h0 + dur) return T + amp * Math.sin(2 * Math.PI * (h - h0) * 60 / periodMin);
  return f.tempAt(h - dur);
};
const F = 1.8;
await run('candling hold 2h @~210F, +/-5F, 15-min cycle', { seed: 11 }, { target: 1285, transform: hold(1.15, 2, 5 / F, 15), hours: 4 });
await run('candling hold 2h @~210F, +/-12F, 15-min cycle', { seed: 11 }, { target: 1285, transform: hold(1.15, 2, 12 / F, 15), hours: 4 });
await run('hold 1.5h @~1630F, +/-15F, 20-min cycle', { seed: 11 }, { target: 1285, transform: hold(7, 1.5, 15 / F, 20), hours: 9 });
await run('hold 1.5h @~1630F, +/-25F, 20-min cycle', { seed: 11 }, { target: 1285, transform: hold(7, 1.5, 25 / F, 20), hours: 9 });
await run('soak 1h at peak, +/-20F, 20-min cycle', { seed: 11 }, { target: 1285, transform: hold(12.41, 1, 20 / F, 20), hours: 14 });
await run('soak 1h at peak, +/-30F, 20-min cycle', { seed: 11 }, { target: 1285, transform: hold(12.41, 1, 30 / F, 20), hours: 14 });
await run('soak 1h at peak, +/-30F, 30-min cycle', { seed: 11 }, { target: 1285, transform: hold(12.41, 1, 30 / F, 30), hours: 14 });
await run('hold 1.5h @~1630F, +/-25F, 30-min cycle', { seed: 11 }, { target: 1285, transform: hold(7, 1.5, 25 / F, 30), hours: 9 });
await run('candling hold 2h, +/-12F, 30-min cycle', { seed: 11 }, { target: 1285, transform: hold(1.15, 2, 12 / F, 30), hours: 4 });
await run('pilot out DURING hold @1630F (+/-15F)', { seed: 11 }, { target: 1285, transform: hold(7, 1.5, 15 / F, 20, 7.8), hours: 9 });
await run('pilot out at 1.5h (~250F)', { seed: 11, blowout: 1.5 }, { target: 1285, hours: 3 });
await run('pilot out at 2h (~400F)', { seed: 11, blowout: 2 }, { target: 1285, hours: 4 });
await run('pilot out at 3h (~600F)', { seed: 11, blowout: 3 }, { target: 1285, hours: 5 });
await run('pilot out at 5h (~1100F)', { seed: 11, blowout: 5 }, { target: 1285, hours: 7 });
await run('pilot out at 8h (~1650F)', { seed: 11, blowout: 8 }, { target: 1285, hours: 10 });
await run('pilot out at 11h (~2250F)', { seed: 11, blowout: 11 }, { target: 1285, hours: 13 });
await run('normal, target, +/-8C noise', { seed: 4 }, { target: 1285, noise: 8 });
await run('normal, target, whole firing', { seed: 11 }, { target: 1285 });
