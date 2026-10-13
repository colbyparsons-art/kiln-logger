// Kiln Monitor dashboard
(function () {
  'use strict';

  const cfg = window.KILN_CONFIG;
  const api = window.KilnApi.create(cfg);
  const H = 3600000;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  // Orton self-supporting cones, 108 °F/hr final rate
  const CONES = [['010', 1657], ['08', 1728], ['07', 1789], ['06', 1828], ['05', 1888], ['04', 1945],
    ['03', 1987], ['02', 2016], ['01', 2046], ['1', 2079], ['2', 2088], ['3', 2106], ['4', 2124],
    ['5', 2167], ['6', 2232], ['7', 2262], ['8', 2280], ['9', 2300], ['10', 2345], ['11', 2361], ['12', 2383]];

  const FAULTS = ['thermocouple open (unplugged or broken)', 'over/under voltage', 'thermocouple low',
    'thermocouple high', 'logger box cold', 'logger box hot', 'thermocouple out of range', 'cold junction out of range'];

  const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'];

  // ------------------------------------------------------------------ storage (per-viewer only)
  function load(key, def) { try { return localStorage.getItem(key) || def; } catch (e) { return def; } }
  function save(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* ignore */ } }

  // ------------------------------------------------------------------ state
  let unit = load('kiln-unit', 'F');
  const state = {
    status: null, active: null, firings: [], alerts: [], settings: null, session: null,
    live: [], liveRange: 'all', cmp: new Map(), curves: new Map(), view: 'live', firingId: null,
  };
  const charts = {};

  // ------------------------------------------------------------------ formatting
  const toU = c => unit === 'F' ? c * 9 / 5 + 32 : c;
  const fromU = v => unit === 'F' ? (v - 32) * 5 / 9 : v;
  const dToU = c => unit === 'F' ? c * 9 / 5 : c;      // temperature differences
  const dFromU = v => unit === 'F' ? v * 5 / 9 : v;
  const fmtT = c => (c == null || isNaN(c)) ? '—' : Math.round(toU(c)).toLocaleString() + '°' + unit;
  const fmtRate = c => (c >= 0 ? '+' : '−') + Math.round(Math.abs(dToU(c))).toLocaleString() + '°' + unit + '/hr';
  const fmtDur = ms => { const m = Math.max(0, Math.round(ms / 60000)); return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
  const fmtDate = t => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const fmtTime = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtDT = t => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const ms = iso => iso ? Date.parse(iso) : null;
  function ago(t) {
    const s = Math.max(0, Math.round((api.now() - t) / 1000));
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
  }
  function faultText(f) {
    return FAULTS.filter((_, i) => f & (1 << i)).join(', ') || 'unknown fault';
  }
  function firingName(f) { return f.name || 'Firing ' + new Date(f.started_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  function coneLabel(f) {
    if (f.cone) return 'Cone ' + f.cone + (f.target_c ? ' (' + fmtT(f.target_c) + ')' : '');
    return f.target_c ? fmtT(f.target_c) : '—';
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, 3500);
  }
  function fail(e) { console.error(e); toast(e.message || String(e)); }

  // ------------------------------------------------------------------ charts
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Vertical guide line under the tooltip
  const crosshair = {
    id: 'crosshair',
    afterDatasetsDraw(chart) {
      const act = chart.tooltip && chart.tooltip.getActiveElements();
      if (!act || !act.length) return;
      const x = act[0].element.x, a = chart.chartArea, c = chart.ctx;
      c.save(); c.strokeStyle = css('--baseline'); c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, a.top); c.lineTo(x, a.bottom); c.stroke(); c.restore();
    },
  };
  // Dashed horizontal reference lines (target temperature)
  const refLines = {
    id: 'refLines',
    beforeDatasetsDraw(chart, _args, opts) {
      const a = chart.chartArea, c = chart.ctx, y = chart.scales.y;
      (opts.lines || []).forEach(l => {
        const py = y.getPixelForValue(l.y);
        if (py < a.top || py > a.bottom) return;
        c.save();
        c.strokeStyle = css('--ref'); c.lineWidth = 1; c.setLineDash([4, 4]);
        c.beginPath(); c.moveTo(a.left, py); c.lineTo(a.right, py); c.stroke();
        c.setLineDash([]); c.fillStyle = css('--ink-2');
        c.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
        c.textAlign = 'left'; c.textBaseline = 'bottom';
        c.fillText(l.label, a.left + 6, py - 3);
        c.restore();
      });
    },
  };
  Chart.register(crosshair, refLines);

  function niceStep(span, target, steps) {
    const raw = span / target;
    return steps.find(s => s >= raw) || steps[steps.length - 1];
  }
  const TIME_STEPS = [5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440].map(m => m * 60000);
  const HOUR_STEPS = [0.25, 0.5, 1, 2, 3, 4, 6, 12];

  // points: [[x, °C], ...] → [{x, y in display unit}], with breaks across data gaps
  function toXY(points, gap) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      if (i && gap && points[i][0] - points[i - 1][0] > gap) out.push({ x: (points[i][0] + points[i - 1][0]) / 2, y: null });
      out.push({ x: points[i][0], y: points[i][1] == null ? null : toU(points[i][1]) });
    }
    return out;
  }

  function lineChart(canvas, o) {
    const multi = o.datasets.length > 1;
    const span = o.xMax - o.xMin;
    const time = o.x === 'time';
    return new Chart(canvas, {
      type: 'line',
      data: {
        datasets: o.datasets.map(d => ({
          label: d.label, data: d.data, borderColor: d.color, backgroundColor: d.color,
          borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBorderWidth: 2,
          pointHoverBorderColor: css('--surface'), spanGaps: false, tension: 0,
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: false, normalized: true,
        interaction: multi ? { mode: 'index', intersect: false } : { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: {
            type: 'linear', min: o.xMin, max: o.xMax,
            grid: { display: false }, border: { color: css('--baseline') },
            ticks: {
              color: css('--axis'), maxRotation: 0, autoSkip: true, autoSkipPadding: 16,
              stepSize: time ? niceStep(span, 6, TIME_STEPS) : niceStep(span, 7, HOUR_STEPS),
              callback: v => time ? timeTick(v) : v + ' h',
            },
            // Put time labels on whole local clock steps (6:00, 8:00…) rather than the first reading
            afterBuildTicks: time ? axis => {
              const step = niceStep(span, 6, TIME_STEPS);
              const off = new Date(o.xMin).getTimezoneOffset() * 60000;
              const ticks = [];
              for (let t = Math.ceil((o.xMin - off) / step) * step + off; t <= o.xMax; t += step) ticks.push({ value: t });
              axis.ticks = ticks;
            } : undefined,
          },
          y: {
            min: unit === 'F' ? 0 : -20,
            suggestedMax: unit === 'F' ? 300 : 150,   // keeps a sensible scale when the kiln is cold or there's no data
            grid: { color: css('--grid') }, border: { display: false },
            ticks: { color: css('--axis'), callback: v => Math.round(v).toLocaleString() + '°' },
          },
        },
        plugins: {
          legend: { display: false },
          refLines: { lines: o.refs || [] },
          tooltip: {
            backgroundColor: css('--surface'), titleColor: css('--ink'), bodyColor: css('--ink-2'),
            borderColor: css('--border'), borderWidth: 1, padding: 10, displayColors: multi,
            boxWidth: 10, boxHeight: 3, usePointStyle: false,
            filter: it => it.parsed.y != null,
            callbacks: {
              title: items => items.length ? (time ? fmtDT(items[0].parsed.x) : hoursLabel(items[0].parsed.x)) : '',
              label: it => (multi ? it.dataset.label + ': ' : '') + Math.round(it.parsed.y).toLocaleString() + '°' + unit,
            },
          },
        },
      },
    });
  }
  function timeTick(v) {
    const d = new Date(v);
    return d.getHours() === 0 && d.getMinutes() === 0 ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : fmtTime(v);
  }
  function hoursLabel(h) { return fmtDur(h * H) + ' in'; }
  function destroy(name) { if (charts[name]) { charts[name].destroy(); charts[name] = null; } }

  // ------------------------------------------------------------------ data loading
  async function loadCore() {
    const [status, active, firings, alerts, settings] = await Promise.all([
      api.status(), api.activeFiring(), api.listFirings(), api.recentAlerts(8), api.settings(),
    ]);
    const activeChanged = (state.active && state.active.id) !== (active && active.id);
    Object.assign(state, { status, active, firings, alerts, settings });
    return activeChanged;
  }

  function liveWindow() {
    const now = api.now();
    if (state.liveRange === '2') return [now - 2 * H, now];
    if (state.active) return [ms(state.active.started_at), now];
    return [now - 12 * H, now];
  }

  async function loadLive() {
    const [from, to] = liveWindow();
    state.live = await api.curve(from, to, 1500);
    renderLiveChart(true);
  }

  // ------------------------------------------------------------------ header
  function renderHeader() {
    $('#kiln-name').textContent = cfg.kilnName || 'Kiln Monitor';
    $('#unit-toggle').textContent = '°' + unit;
    const el = $('#conn'), s = state.status;
    const offlineMs = ((state.settings && state.settings.offline_minutes) || 10) * 60000;
    el.classList.remove('ok', 'bad');
    if (!s || !s.last_seen) {
      $('#conn-text').textContent = 'Logger has not connected yet';
    } else if (api.now() - ms(s.last_seen) < offlineMs) {
      el.classList.add('ok');
      $('#conn-text').textContent = 'Online · ' + ago(ms(s.last_seen));
    } else {
      el.classList.add('bad');
      $('#conn-text').textContent = 'Offline · last seen ' + ago(ms(s.last_seen));
    }
    $('#auth-btn').textContent = state.session ? 'Sign out' : 'Staff sign in';
    document.body.classList.toggle('staff', !!state.session);
  }

  // ------------------------------------------------------------------ live view
  function currentRate() {
    const pts = state.live.filter(p => p[1] != null);
    if (pts.length < 2) return null;
    const last = pts[pts.length - 1];
    let i = pts.length - 2;
    while (i > 0 && last[0] - pts[i][0] < 15 * 60000) i--;
    const dt = (last[0] - pts[i][0]) / H;
    return dt > 0.05 ? (last[1] - pts[i][1]) / dt : null;
  }

  function renderHero() {
    const s = state.status, f = state.active;
    const lastPt = state.live.length ? state.live[state.live.length - 1] : null;
    const temp = s && s.last_temp_c != null ? s.last_temp_c : (lastPt ? lastPt[1] : null);
    const faulted = s && s.last_fault;
    $('#live-temp').textContent = faulted ? 'Sensor fault' : fmtT(temp);
    const rate = currentRate();
    $('#live-rate').textContent = !faulted && rate != null && f ? fmtRate(rate) : '';

    let sub;
    if (faulted) sub = 'The logger reports: ' + faultText(s.last_fault) + '.';
    else if (f) sub = 'Firing in progress · started ' + fmtDT(f.started_at) + ' · ' + fmtDur(api.now() - ms(f.started_at));
    else sub = 'No firing in progress';
    $('#live-sub').textContent = sub;

    const stats = [];
    if (f) {
      stats.push(['Name', esc(firingName(f))]);
      stats.push(['Peak so far', fmtT(f.peak_c)]);
      stats.push(['Target', esc(coneLabel(f))]);
      if (f.target_c && temp != null && rate > 1 && temp < f.target_c) {
        stats.push(['At this rate, target in', fmtDur((f.target_c - temp) / rate * H)]);
      }
    }
    if (s && s.rssi != null) stats.push(['WiFi signal', s.rssi + ' dBm']);
    if (s && s.buffered) stats.push(['Waiting to upload', s.buffered + ' readings']);
    $('#live-stats').innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  }

  function renderLiveChart(rebuild) {
    const [from, to] = liveWindow();
    $('#live-chart-title').textContent = state.active ? 'Current firing' : 'Last 12 hours';
    $$('#view-live .seg button')[0].textContent = state.active ? 'Whole firing' : '12 h';
    const data = toXY(state.live.filter(p => p[0] >= from), 10 * 60000);
    const refs = state.active && state.active.target_c ? [{ y: toU(state.active.target_c), label: 'Target ' + coneLabel(state.active) }] : [];
    if (!rebuild && charts.live) {
      const c = charts.live;
      c.data.datasets[0].data = data;
      c.options.scales.x.min = from; c.options.scales.x.max = Math.max(to, from + 10 * 60000);
      c.update('none');
      return;
    }
    destroy('live');
    charts.live = lineChart($('#live-chart'), {
      x: 'time', xMin: from, xMax: Math.max(to, from + 10 * 60000), refs,
      datasets: [{ label: 'Temperature', data, color: css('--series-1') }],
    });
  }

  function renderAlerts() {
    const sev = { overshoot: 'critical', fault: 'serious', offline: 'serious', stall: 'warning', complete: 'good', started: '' };
    const label = { overshoot: 'Over temp', fault: 'Fault', offline: 'Offline', stall: 'Stall', complete: 'Done', started: 'Started' };
    const items = state.alerts.map(a => `
      <li>
        <span class="badge ${sev[a.kind] || ''}"><span class="ic"></span>${esc(label[a.kind] || a.kind)}</span>
        <span class="title">${esc(a.title)}</span>
        <span class="meta">${esc(a.message)} · ${fmtDT(a.created_at)}</span>
      </li>`);
    $('#live-alerts').innerHTML = items.join('') || '<li class="meta">No alerts yet.</li>';
  }

  function renderLiveStaff() {
    const body = $('#live-staff-body');
    if (!state.session) { body.innerHTML = ''; return; }
    if (!state.active) {
      body.innerHTML = `<p class="muted">Firings start automatically when the kiln passes ${fmtT(state.settings && state.settings.start_temp_c)}.
        Use this only if the automatic start missed one.</p>
        <button class="btn" id="start-firing">Start a firing now</button>`;
      $('#start-firing').onclick = () => api.startFiring().then(refresh).catch(fail);
      return;
    }
    body.innerHTML = '<form class="form" id="live-form"></form>';
    firingForm($('#live-form'), state.active, true);
  }

  function renderLive() {
    renderHero();
    renderAlerts();
    renderLiveStaff();
    renderLiveChart(true);
  }

  // ------------------------------------------------------------------ firing edit form (shared)
  function firingForm(form, f, isLive) {
    const coneOpts = ['<option value="">— none —</option>']
      .concat(CONES.map(([c, tf]) => `<option value="${c}" ${f.cone === c ? 'selected' : ''}>Cone ${c} (${unit === 'F' ? tf : Math.round((tf - 32) * 5 / 9)}°${unit})</option>`));
    form.innerHTML = `
      <div class="grid">
        <label>Name <input name="name" value="${esc(f.name || '')}" placeholder="e.g. Glaze – cone 10 reduction"></label>
        <label>Target cone <select name="cone">${coneOpts.join('')}</select></label>
        <label>Target temperature (°${unit})
          <input name="target" type="number" step="1" value="${f.target_c != null ? Math.round(toU(f.target_c)) : ''}">
          <span class="hint">Filled in from the cone. Used for the over-temperature alert.</span></label>
      </div>
      ${isLive ? '' : `<label>Notes <textarea name="notes">${esc(f.notes || '')}</textarea></label>`}
      <p class="privacy">For privacy, don't include student names in firing names or notes. Anyone with the dashboard link can read them.</p>
      <label class="check"><input type="checkbox" name="muted" ${f.alerts_muted ? 'checked' : ''}> Mute phone alerts for this firing</label>
      <div class="row">
        <button class="btn primary" type="submit">Save</button>
        ${isLive ? '<button class="btn" type="button" data-act="end">End firing now</button>' : '<button class="btn danger" type="button" data-act="delete">Delete firing</button>'}
      </div>`;
    form.cone.onchange = () => {
      const c = CONES.find(x => x[0] === form.cone.value);
      if (c) form.target.value = unit === 'F' ? c[1] : Math.round((c[1] - 32) * 5 / 9);
    };
    form.onsubmit = e => {
      e.preventDefault();
      const t = form.target.value === '' ? null : fromU(Number(form.target.value));
      const patch = { name: form.name.value.trim() || null, cone: form.cone.value || null, target_c: t, alerts_muted: form.muted.checked };
      if (!isLive) patch.notes = form.notes.value;
      api.updateFiring(f.id, patch).then(() => { toast('Saved'); return refresh(); }).catch(fail);
    };
    const act = form.querySelector('[data-act]');
    act.onclick = () => {
      if (act.dataset.act === 'end') {
        if (confirm('Mark this firing as finished now? Logging continues; this just closes the record.')) {
          api.endFiring(f.id).then(refresh).catch(fail);
        }
      } else if (confirm('Delete this firing record? The temperature readings stay in the database.')) {
        api.deleteFiring(f.id).then(() => { location.hash = '#firings'; return refresh(); }).catch(fail);
      }
    };
  }

  // ------------------------------------------------------------------ firings list
  function renderFirings() {
    const items = state.firings.map(f => {
      const end = f.ended_at ? ms(f.ended_at) : api.now();
      return `<li><a href="#firing/${f.id}">
        <span class="name">${esc(firingName(f))}</span>
        <span class="peak">${fmtT(f.peak_c)}</span>
        <span class="when">${fmtDate(f.started_at)}${f.cone ? ' · cone ' + esc(f.cone) : ''}</span>
        <span class="dur">${f.status === 'active' ? 'In progress · ' : ''}${fmtDur(end - ms(f.started_at))}</span>
      </a></li>`;
    });
    $('#firing-list').innerHTML = items.join('') || '<li class="muted" style="padding:12px 4px">No firings recorded yet.</li>';
  }

  async function renderFiring() {
    const f = state.firings.find(x => x.id === state.firingId);
    if (!f) { $('#fd-title').textContent = 'Firing not found'; return; }
    const start = ms(f.started_at), end = f.ended_at ? ms(f.ended_at) : api.now();
    $('#fd-title').textContent = firingName(f);
    const stats = [
      ['Started', fmtDT(start)],
      ['Ended', f.ended_at ? fmtDT(end) : 'In progress'],
      ['Duration', fmtDur(end - start)],
      ['Peak', fmtT(f.peak_c)],
      ['Time to peak', f.peak_at ? fmtDur(ms(f.peak_at) - start) : '—'],
      ['Target', coneLabel(f)],
    ];
    $('#fd-stats').innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
    $('#fd-notes').textContent = f.notes || '';
    if (state.session) firingForm($('#fd-form'), f, false);

    const pts = await api.curve(start, end, 1500);
    if (state.view !== 'firing' || state.firingId !== f.id) return;
    destroy('fd');
    charts.fd = lineChart($('#fd-chart'), {
      x: 'time', xMin: start, xMax: end,
      refs: f.target_c ? [{ y: toU(f.target_c), label: 'Target ' + coneLabel(f) }] : [],
      datasets: [{ label: 'Temperature', data: toXY(pts, 10 * 60000), color: css('--series-1') }],
    });
    $('#fd-csv').onclick = () => downloadCsv(f, start, end);
  }

  async function downloadCsv(f, start, end) {
    try {
      const pts = await api.curve(start, end, 20000);
      const rows = ['time,temp_c,temp_f'].concat(pts.map(([t, c]) =>
        `${new Date(t).toISOString()},${c.toFixed(1)},${(c * 9 / 5 + 32).toFixed(1)}`));
      const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `kiln-firing-${new Date(start).toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { fail(e); }
  }

  // ------------------------------------------------------------------ compare
  function renderComparePicker() {
    const full = state.cmp.size >= 6;
    $('#cmp-pick').innerHTML = state.firings.map(f => {
      const slot = state.cmp.get(f.id);
      const on = slot !== undefined;
      return `<li><label>
        <input type="checkbox" data-id="${f.id}" ${on ? 'checked' : ''} ${!on && full ? 'disabled' : ''}>
        <span class="sw" style="background:${on ? `var(${SERIES[slot]})` : 'transparent'}"></span>
        <span>${esc(firingName(f))}</span>
        <span class="when">${fmtDate(f.started_at)}<br>${fmtT(f.peak_c)}</span>
      </label></li>`;
    }).join('') || '<li class="muted">No firings yet.</li>';
    $$('#cmp-pick input').forEach(cb => {
      cb.onchange = () => {
        const id = Number(cb.dataset.id);
        if (cb.checked) {
          const used = new Set(state.cmp.values());
          state.cmp.set(id, [0, 1, 2, 3, 4, 5].find(i => !used.has(i)));
        } else state.cmp.delete(id);
        save('kiln-compare', JSON.stringify(Array.from(state.cmp.entries())));
        renderCompare();
      };
    });
  }

  async function curveFor(f) {
    const key = f.id + ':' + (f.ended_at || '');
    if (f.status !== 'active' && state.curves.has(key)) return state.curves.get(key);
    const start = ms(f.started_at), end = f.ended_at ? ms(f.ended_at) : api.now();
    const pts = await api.curve(start, end, 1500);
    if (f.status !== 'active') state.curves.set(key, pts);
    return pts;
  }

  async function renderCompare() {
    renderComparePicker();
    const picked = state.firings.filter(f => state.cmp.has(f.id));
    $('#cmp-legend').innerHTML = picked.map(f =>
      `<span><i style="background:var(${SERIES[state.cmp.get(f.id)]})"></i>${esc(firingName(f))} · ${new Date(f.started_at).toLocaleDateString()}</span>`).join('');
    destroy('cmp');
    if (!picked.length) {
      $('#cmp-table').innerHTML = '';
      $('#cmp-legend').innerHTML = '<span>Pick firings above to overlay them.</span>';
      return;
    }
    const curves = await Promise.all(picked.map(curveFor));
    if (state.view !== 'compare') return;

    // Put every firing on the same hours-since-start grid so the tooltip can show them side by side.
    const spans = curves.map((pts, i) => pts.length ? (pts[pts.length - 1][0] - ms(picked[i].started_at)) / H : 0);
    const maxH = Math.max(1, ...spans);
    const step = Math.max(maxH / 600, 1 / 60);
    const datasets = picked.map((f, i) => {
      const start = ms(f.started_at), pts = curves[i], data = [];
      let j = 0;
      for (let h = 0; h <= maxH + 1e-9; h += step) {
        const t = start + h * H;
        while (j < pts.length - 2 && pts[j + 1][0] < t) j++;
        let y = null;
        if (pts.length > 1 && t >= pts[0][0] && t <= pts[pts.length - 1][0]) {
          const [t0, c0] = pts[j], [t1, c1] = pts[j + 1];
          y = toU(t1 === t0 ? c0 : c0 + (c1 - c0) * (t - t0) / (t1 - t0));
        }
        data.push({ x: Math.round(h * 1000) / 1000, y });
      }
      return { label: firingName(f), data, color: css(SERIES[state.cmp.get(f.id)]) };
    });
    charts.cmp = lineChart($('#cmp-chart'), { x: 'hours', xMin: 0, xMax: Math.ceil(maxH), datasets });

    // Table view of the same firings
    const rows = picked.map((f, i) => {
      const start = ms(f.started_at), end = f.ended_at ? ms(f.ended_at) : api.now();
      return `<tr>
        <td><span class="legend"><span><i style="background:var(${SERIES[state.cmp.get(f.id)]})"></i>${esc(firingName(f))}</span></span></td>
        <td>${fmtDate(start)}</td>
        <td>${esc(f.cone || '—')}</td>
        <td class="num">${fmtT(f.peak_c)}</td>
        <td class="num">${f.peak_at ? fmtDur(ms(f.peak_at) - start) : '—'}</td>
        <td class="num">${fmtDur(end - start)}</td>
      </tr>`;
    });
    $('#cmp-table').innerHTML = `<thead><tr><th>Firing</th><th>Date</th><th>Cone</th>
      <th style="text-align:right">Peak</th><th style="text-align:right">Time to peak</th><th style="text-align:right">Duration</th></tr></thead>
      <tbody>${rows.join('')}</tbody>`;
  }

  // ------------------------------------------------------------------ settings
  const SETTING_FIELDS = [
    ['start_temp_c', 'A firing starts when the kiln climbs past', 'temp'],
    ['end_temp_c', 'A firing ends when it cools below', 'temp'],
    ['min_peak_c', '…but only after it has reached', 'temp'],
    ['max_temp_c', 'Over-temperature alert above (if no target is set)', 'temp'],
    ['overshoot_margin_c', 'Over-temperature alert this far above a firing\'s target', 'delta'],
    ['stall_rate_c_per_hr', 'Stalled-climb alert if rising slower than (per hour)', 'delta'],
    ['stall_window_min', 'Measured over (minutes)', 'int'],
    ['offline_minutes', 'Logger-offline alert after (minutes without data)', 'int'],
  ];

  function renderSettings() {
    const s = state.settings;
    if (!s) return;
    const form = $('#settings-form');
    const val = (k, kind) => kind === 'temp' ? Math.round(toU(s[k])) : kind === 'delta' ? Math.round(dToU(s[k])) : s[k];
    form.innerHTML = `
      <div class="grid">
        ${SETTING_FIELDS.map(([k, label, kind]) => `<label>${label}${kind === 'int' ? '' : ` (°${unit})`}
          <input type="number" name="${k}" step="1" value="${val(k, kind)}" required></label>`).join('')}
      </div>
      <label>Dashboard link (opened when someone taps a phone alert)
        <input type="url" name="dashboard_url" value="${esc(s.dashboard_url || '')}" placeholder="https://…"></label>
      <label class="check"><input type="checkbox" name="alerts_enabled" ${s.alerts_enabled ? 'checked' : ''}> Send phone alerts</label>
      <div class="row"><button class="btn primary" type="submit">Save settings</button></div>`;
    form.onsubmit = e => {
      e.preventDefault();
      const patch = { alerts_enabled: form.alerts_enabled.checked, dashboard_url: form.dashboard_url.value.trim() || null };
      SETTING_FIELDS.forEach(([k, , kind]) => {
        const v = Number(form[k].value);
        patch[k] = kind === 'temp' ? fromU(v) : kind === 'delta' ? dFromU(v) : Math.round(v);
      });
      api.saveSettings(patch).then(() => { toast('Settings saved'); return refresh(); }).catch(fail);
    };
  }

  // ------------------------------------------------------------------ routing
  function route() {
    const h = location.hash.replace('#', '') || 'live';
    const m = h.match(/^firing\/(\d+)$/);
    let view = m ? 'firing' : h;
    if (!['live', 'firings', 'firing', 'compare', 'settings'].includes(view)) view = 'live';
    if (view === 'settings' && !state.session) view = 'live';
    state.view = view;
    state.firingId = m ? Number(m[1]) : null;
    $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + view; });
    $$('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === (view === 'firing' ? 'firings' : view)));
    renderView();
  }

  function renderView() {
    renderHeader();
    const v = state.view;
    if (v === 'live') renderLive();
    else if (v === 'firings') renderFirings();
    else if (v === 'firing') renderFiring().catch(fail);
    else if (v === 'compare') renderCompare().catch(fail);
    else if (v === 'settings') renderSettings();
  }

  async function refresh() {
    const activeChanged = await loadCore();
    if (activeChanged || state.view === 'live') await loadLive();
    renderView();
  }

  // ------------------------------------------------------------------ events
  function bind() {
    window.addEventListener('hashchange', route);
    $('#unit-toggle').onclick = () => {
      unit = unit === 'F' ? 'C' : 'F';
      save('kiln-unit', unit);
      renderView();
    };
    $$('#view-live .seg button').forEach(b => {
      b.onclick = () => {
        $$('#view-live .seg button').forEach(x => x.classList.toggle('on', x === b));
        state.liveRange = b.dataset.range;
        loadLive().catch(fail);
      };
    });
    const dlg = $('#login-dialog');
    $('#auth-btn').onclick = () => {
      if (state.session) { api.signOut().catch(fail); return; }
      $('#login-error').textContent = api.demo ? 'Demo mode: any email works.' : '';
      dlg.showModal();
    };
    $('#login-cancel').onclick = () => dlg.close();
    $('#login-form').onsubmit = e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      api.signIn(fd.get('email'), fd.get('password'))
        .then(() => { dlg.close(); toast('Signed in'); })
        .catch(err => { $('#login-error').textContent = err.message; });
    };
    api.onAuth(session => { state.session = session; route(); });

    // Redraw charts when the light/dark theme changes
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderView);
    }

    api.subscribe({
      onReading(r) {
        const t = ms(r.ts);
        const last = state.live[state.live.length - 1];
        if (!last || t > last[0]) state.live.push([t, r.fault ? null : r.temp_c]);
        if (state.view === 'live') { renderHero(); renderLiveChart(false); }
      },
      onStatus(s) {
        if (s && s.device_id === cfg.deviceId) state.status = s;
        renderHeader();
        if (state.view === 'live') renderHero();
      },
      onFiring() { clearTimeout(bind.ft); bind.ft = setTimeout(() => refresh().catch(fail), 500); },
      onAlert() { api.recentAlerts(8).then(a => { state.alerts = a; if (state.view === 'live') renderAlerts(); }).catch(fail); },
    });

    // Keep the "updated x ago" text fresh, and re-sync now and then in case live updates drop.
    setInterval(renderHeader, 5000);
    if (!api.demo) setInterval(() => { if (!document.hidden) refresh().catch(fail); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(fail); });
  }

  async function init() {
    $('#demo-banner').hidden = !api.demo;
    try {
      const saved = JSON.parse(load('kiln-compare', '[]'));
      if (Array.isArray(saved)) saved.forEach(([id, slot]) => state.cmp.set(id, slot));
    } catch (e) { /* ignore */ }
    state.session = await api.session();
    bind();
    await loadCore();
    // Drop saved comparisons for firings that no longer exist
    state.cmp.forEach((_, id) => { if (!state.firings.some(f => f.id === id)) state.cmp.delete(id); });
    if (!state.cmp.size) state.firings.filter(f => f.status === 'complete').slice(0, 2).forEach((f, i) => state.cmp.set(f.id, i));
    await loadLive();
    route();
  }

  init().catch(fail);
})();
