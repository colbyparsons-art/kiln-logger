#!/usr/bin/env node
// Kiln firing simulator. Sends fake readings to Supabase exactly the way the ESP32 logger will.
//
// Setup: copy config.example.json to config.json and fill in your Supabase details.
//
// Usage:
//   node simulate.js backfill [--days-ago 3] [--seed 7] [--bisque] [--stall] [--overshoot]
//       Uploads one complete past firing (good for filling the history and testing overlays).
//   node simulate.js live [--speed 60] [--seed 7] [--stall] [--overshoot]
//       Runs a firing in real time, sped up. At --speed 60 a 33-hour firing takes about 33 minutes.
//   node simulate.js csv [--seed 7] > firing.csv
//       Prints a firing as CSV without sending anything.

const fs = require('fs');
const path = require('path');
const KilnSim = require('../web/sim.js');

const args = process.argv.slice(2);
const mode = args[0];
const flag = name => args.includes('--' + name);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : def;
};

const firing = KilnSim.createFiring({
  seed: opt('seed', Math.floor(Math.random() * 1e6)),
  kind: flag('bisque') ? 'bisque' : 'glaze',
  stall: flag('stall'),
  overshoot: flag('overshoot'),
});

function loadConfig() {
  const file = path.join(__dirname, 'config.json');
  if (!fs.existsSync(file)) {
    console.error('Missing simulator/config.json. Copy config.example.json and fill it in.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function send(cfg, readings) {
  const res = await fetch(cfg.supabaseUrl.replace(/\/$/, '') + '/rest/v1/rpc/ingest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.supabaseAnonKey,
      Authorization: 'Bearer ' + cfg.supabaseAnonKey,
    },
    body: JSON.stringify({
      p_device_key: cfg.deviceKey,
      p_device_id: cfg.deviceId,
      p_fw: 'simulator',
      p_rssi: -60,
      p_buffered: 0,
      p_readings: readings.map(([t, c]) => ({ t, c, cj: 28, f: 0 })),
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

const fmtF = c => Math.round(c * 9 / 5 + 32) + '°F';

async function backfill() {
  const cfg = loadConfig();
  const daysAgo = opt('days-ago', 3);
  const start = Date.now() - daysAgo * 86400000;
  if (start + firing.totalHours * 3600000 > Date.now()) {
    console.error(`A firing lasts ${firing.totalHours.toFixed(0)} hours, so --days-ago must be at least ${Math.ceil(firing.totalHours / 24)}.`);
    process.exit(1);
  }
  const readings = KilnSim.generate(firing, start, 30, 2);
  console.log(`Uploading ${readings.length} readings (peak ${fmtF(firing.peakC)}, ${firing.totalHours.toFixed(1)} h)…`);
  for (let i = 0; i < readings.length; i += 1000) {
    const out = await send(cfg, readings.slice(i, i + 1000));
    process.stdout.write(`  ${Math.min(i + 1000, readings.length)}/${readings.length}  firing: ${out.active_firing ?? '-'}\n`);
  }
  console.log('Done.');
}

async function live() {
  const cfg = loadConfig();
  const speed = opt('speed', 60);
  const t0 = Date.now();
  const preHours = 0.25;
  let batch = [];
  console.log(`Live firing at ${speed}x. Press Ctrl+C to stop.`);

  while (true) {
    const simH = (Date.now() - t0) / 3600000 * speed - preHours;
    if (simH > firing.totalHours) break;
    batch.push([Date.now(), Math.round(firing.tempAt(simH) * 100) / 100]);
    if (batch.length >= 5) {
      try {
        const out = await send(cfg, batch);
        const c = batch[batch.length - 1][1];
        console.log(`${simH.toFixed(2).padStart(6)} h  ${fmtF(c).padStart(7)}  firing: ${out.active_firing ?? '-'}`);
        batch = [];
      } catch (e) {
        console.log('  (upload failed, will retry) ' + e.message);
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (batch.length) await send(cfg, batch);
  console.log('Firing finished.');
}

function csv() {
  const readings = KilnSim.generate(firing, Date.now(), 60, 1);
  console.log('time_iso,temp_c,temp_f');
  for (const [t, c] of readings) console.log(`${new Date(t).toISOString()},${c.toFixed(1)},${(c * 9 / 5 + 32).toFixed(1)}`);
}

const modes = { backfill, live, csv };
if (!modes[mode]) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 14).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(1);
}
Promise.resolve(modes[mode]()).catch(e => { console.error(e.message); process.exit(1); });
