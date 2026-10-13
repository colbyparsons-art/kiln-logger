// Data layer for the dashboard. Two versions with the same methods:
//   SupabaseApi – the real database
//   DemoApi     – a simulated kiln in the browser (used when config.js has no Supabase URL)
// All temperatures are °C; times are ISO strings in records and epoch ms in curves.
(function (root) {
  'use strict';

  const DEFAULT_SETTINGS = {
    id: 1, start_temp_c: 93.3, end_temp_c: 121.1, min_peak_c: 537.8, max_temp_c: 1330,
    overshoot_margin_c: 13.9, stall_rate_c_per_hr: 5.6, stall_window_min: 60,
    offline_minutes: 10, drop_alert_c: 27.8, drop_window_min: 20, owner_alerts: 'urgent', alerts_enabled: true, dashboard_url: '',
  };

  // ---------------------------------------------------------------- Supabase
  class SupabaseApi {
    constructor(cfg) {
      this.demo = false;
      this.dev = cfg.deviceId;
      this.sb = root.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    }
    now() { return Date.now(); }

    async _q(promise) {
      const { data, error } = await promise;
      if (error) throw error;
      return data;
    }
    status() {
      return this._q(this.sb.from('device_status').select('*').eq('device_id', this.dev).maybeSingle());
    }
    activeFiring() {
      return this._q(this.sb.from('firings').select('*').eq('device_id', this.dev).eq('status', 'active').maybeSingle());
    }
    listFirings() {
      return this._q(this.sb.from('firings').select('*').eq('device_id', this.dev)
        .order('started_at', { ascending: false }).limit(300));
    }
    curve(fromMs, toMs, maxPoints) {
      return this._q(this.sb.rpc('get_curve', {
        p_device_id: this.dev, p_from: new Date(fromMs).toISOString(),
        p_to: new Date(toMs).toISOString(), p_max_points: maxPoints || 1500,
      }));
    }
    recentAlerts(limit) {
      return this._q(this.sb.from('alerts').select('*').order('created_at', { ascending: false }).limit(limit || 10));
    }
    settings() { return this._q(this.sb.from('settings').select('*').eq('id', 1).single()); }
    saveSettings(patch) { return this._q(this.sb.from('settings').update(patch).eq('id', 1)); }
    updateFiring(id, patch) { return this._q(this.sb.from('firings').update(patch).eq('id', id)); }
    deleteFiring(id) { return this._q(this.sb.from('firings').delete().eq('id', id)); }
    startFiring() {
      const now = new Date().toISOString();
      return this._q(this.sb.from('firings').insert({ device_id: this.dev, started_at: now, status: 'active' }));
    }
    endFiring(id) {
      return this._q(this.sb.from('firings').update({ status: 'complete', ended_at: new Date().toISOString() }).eq('id', id));
    }

    // Phone-alert recipients
    async isOwner() { return !!(await this._q(this.sb.rpc('is_owner'))); }
    listPeople() { return this._q(this.sb.from('people').select('*').order('label')); }
    addPerson(label) { return this._q(this.sb.from('people').insert({ label }).select().single()); }
    updatePerson(id, patch) { return this._q(this.sb.from('people').update(patch).eq('id', id)); }
    deletePerson(id) { return this._q(this.sb.from('people').delete().eq('id', id)); }
    alertInfo(firingId) { return this._q(this.sb.rpc('alert_recipients', { p_firing: firingId, p_device_id: this.dev })); }
    claim(pin, stop) { return this._q(this.sb.rpc('claim_alerts', { p_pin: pin, p_device_id: this.dev, p_stop: !!stop })); }
    firingAction(pin, action, minutes) {
      return this._q(this.sb.rpc('firing_action', { p_pin: pin, p_device_id: this.dev, p_action: action, p_minutes: minutes || null }));
    }
    addRecipient(firingId, personId) {
      return firingId
        ? this._q(this.sb.from('firing_recipients').insert({ firing_id: firingId, person_id: personId }))
        : this._q(this.sb.from('alert_claims').upsert({ person_id: personId, device_id: this.dev, created_at: new Date().toISOString() }));
    }
    removeRecipient(firingId, personId) {
      return firingId
        ? this._q(this.sb.from('firing_recipients').delete().eq('firing_id', firingId).eq('person_id', personId))
        : this._q(this.sb.from('alert_claims').delete().eq('person_id', personId));
    }

    subscribe(h) {
      this.sb.channel('kiln')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'readings', filter: 'device_id=eq.' + this.dev },
          p => h.onReading(p.new))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'device_status' }, p => h.onStatus(p.new))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'firings' }, () => h.onFiring())
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts' }, () => h.onAlert())
        .subscribe();
    }

    async session() { return (await this.sb.auth.getSession()).data.session; }
    async signIn(email, password) {
      const { error } = await this.sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
    async signOut() { await this.sb.auth.signOut(); }
    onAuth(cb) { this.sb.auth.onAuthStateChange((_e, session) => cb(session)); }
  }

  // ---------------------------------------------------------------- Demo
  // A pretend kiln: three past firings plus one in progress that runs 30× faster than real time.
  class DemoApi {
    constructor(cfg) {
      this.demo = true;
      this.speed = 30;
      this.dev = cfg.deviceId;
      this.loadedAt = Date.now();
      this._session = null;
      this._authCb = () => {};
      this._settings = Object.assign({}, DEFAULT_SETTINGS);
      const H = 3600000, D = 86400000;
      const morning = d => { const t = new Date(this.loadedAt - d * D); t.setHours(7, 30, 0, 0); return t.getTime(); };
      const specs = [
        { id: 1, seed: 21, kind: 'glaze', start: morning(16), name: 'Glaze – cone 10 reduction', cone: '10', notes: 'Shino test tiles on top shelf. Cone 10 down at 2 o\'clock, 11 soft.' },
        { id: 2, seed: 8, kind: 'bisque', start: morning(9), name: 'Bisque – student work', cone: '06', notes: '' },
        { id: 3, seed: 3, kind: 'glaze', start: morning(4), name: 'Glaze – cone 10, slow cool', cone: '10', notes: 'Closed damper at shutoff.', coolTau: 9 },
        { id: 4, seed: 11, kind: 'glaze', start: this.loadedAt - 7.5 * H, name: 'Glaze – cone 10 reduction', cone: '10', notes: '' },
      ];
      this._firings = specs.map(s => this._makeFiring(s));
      this._firings[3].status = 'active';
      this._firings[3].ended_at = null;
      this._alerts = [
        { id: 2, firing_id: 4, kind: 'started', title: 'Firing started', message: 'The kiln passed 200°F. A new firing is being logged.', created_at: new Date(specs[3].start + 1.05 * H).toISOString() },
        { id: 1, firing_id: 3, kind: 'complete', title: 'Firing complete', message: 'Peak 2354°F. 33h 10m from start to cool-down.', created_at: new Date(this._firings[2]._endMs).toISOString() },
      ];
    }

    _makeFiring(s) {
      const sim = root.KilnSim.createFiring({ seed: s.seed, kind: s.kind, coolTau: s.coolTau });
      let endH = sim.heatHours;
      while (sim.tempAt(endH) > 121 && endH < 80) endH += 0.02;
      return {
        id: s.id, device_id: this.dev, status: 'complete', name: s.name, notes: s.notes, cone: s.cone,
        target_c: s.cone === '06' ? 999 : 1285, alerts_muted: false,
        started_at: new Date(s.start).toISOString(),
        ended_at: new Date(s.start + endH * 3600000).toISOString(),
        peak_c: sim.peakC, peak_at: new Date(s.start + sim.heatHours * 3600000).toISOString(),
        _sim: sim, _startMs: s.start, _endMs: s.start + endH * 3600000,
      };
    }

    now() { return this.loadedAt + (Date.now() - this.loadedAt) * this.speed; }

    _tempAt(ms) {
      for (const f of this._firings) {
        if (f._sim && ms >= f._startMs && ms <= f._startMs + f._sim.totalHours * 3600000) {
          return f._sim.tempAt((ms - f._startMs) / 3600000);
        }
      }
      return root.KilnSim.AMBIENT_C + Math.sin(ms / 7e5) * 0.4;
    }
    _strip(f) {
      const out = Object.assign({}, f);
      delete out._sim; delete out._startMs; delete out._endMs;
      if (f.status === 'active' && f._sim) {
        const h = Math.min((this.now() - f._startMs) / 3600000, f._sim.heatHours);
        out.peak_c = f._sim.tempAt(h);
        out.peak_at = new Date(f._startMs + h * 3600000).toISOString();
      }
      return out;
    }
    _tick() {
      const f = this._firings.find(x => x.status === 'active');
      if (f && f._endMs && this.now() > f._endMs) {
        f.status = 'complete';
        f.ended_at = new Date(f._endMs).toISOString();
        return true;
      }
      return false;
    }

    async status() {
      const t = this.now();
      return { device_id: this.dev, last_seen: new Date(t).toISOString(), last_reading_at: new Date(t).toISOString(),
        last_temp_c: this._tempAt(t), last_fault: 0, rssi: -58, buffered: 0, fw: 'demo' };
    }
    async activeFiring() {
      this._tick();
      const f = this._firings.find(x => x.status === 'active');
      return f ? this._strip(f) : null;
    }
    async listFirings() {
      this._tick();
      return this._firings.slice().sort((a, b) => b._startMs - a._startMs).map(f => this._strip(f));
    }
    async curve(fromMs, toMs, maxPoints) {
      toMs = Math.min(toMs, this.now());
      const step = Math.max((toMs - fromMs) / (maxPoints || 1500), 10000);
      const out = [];
      for (let t = fromMs; t <= toMs; t += step) out.push([Math.round(t), Math.round(this._tempAt(t) * 10) / 10]);
      return out;
    }
    async recentAlerts(limit) { return this._alerts.slice(0, limit || 10); }
    async settings() { return Object.assign({}, this._settings); }
    async saveSettings(patch) { Object.assign(this._settings, patch); }
    async updateFiring(id, patch) { Object.assign(this._firings.find(f => f.id === id), patch); }
    async deleteFiring(id) { this._firings = this._firings.filter(f => f.id !== id); }
    async startFiring() {
      if (this._firings.some(f => f.status === 'active')) throw new Error('A firing is already in progress.');
      const id = Math.max(0, ...this._firings.map(f => f.id)) + 1;
      this._firings.push({ id, device_id: this.dev, status: 'active', started_at: new Date(this.now()).toISOString(),
        ended_at: null, peak_c: null, name: null, notes: '', cone: null, target_c: null, alerts_muted: false,
        _startMs: this.now() });
    }
    async endFiring(id) {
      const f = this._firings.find(x => x.id === id);
      f.status = 'complete';
      f.ended_at = new Date(this.now()).toISOString();
      f._endMs = this.now();
    }

    // Phone-alert recipients (demo: two sample people, PINs 111111 and 222222)
    _peopleInit() {
      if (this._people) return;
      this._people = [
        { id: 1, label: 'MG', allowed: true, pin: '111111', ntfy_topic: 'kiln-demo-mg' },
        { id: 2, label: 'JT', allowed: true, pin: '222222', ntfy_topic: 'kiln-demo-jt' },
      ];
      this._recips = new Map([[4, new Set([1])]]);   // MG claimed the demo firing
      this._pending = new Set();
    }
    _set(firingId) {
      if (!firingId) return this._pending;
      if (!this._recips.has(firingId)) this._recips.set(firingId, new Set());
      return this._recips.get(firingId);
    }
    async isOwner() { return !!this._session; }
    async listPeople() { this._peopleInit(); return this._people.map(p => Object.assign({}, p)); }
    async addPerson(label) {
      this._peopleInit();
      const p = { id: Math.max(0, ...this._people.map(x => x.id)) + 1, label, allowed: true,
        pin: String(Math.floor(Math.random() * 1e6)).padStart(6, '0'), ntfy_topic: 'kiln-demo-' + Math.random().toString(16).slice(2, 10) };
      this._people.push(p);
      return p;
    }
    async updatePerson(id, patch) { this._peopleInit(); Object.assign(this._people.find(p => p.id === id), patch); }
    async deletePerson(id) {
      this._peopleInit();
      this._people = this._people.filter(p => p.id !== id);
      this._recips.forEach(s => s.delete(id)); this._pending.delete(id);
    }
    async alertInfo(firingId) {
      this._peopleInit();
      const lab = ids => this._people.filter(p => ids.has(p.id)).map(p => ({ id: p.id, label: p.label }));
      const cur = this._set(firingId);
      return { count: lab(cur).length, pending: this._pending.size,
        people: this._session ? lab(cur) : null, pending_people: this._session ? lab(this._pending) : null };
    }
    async claim(pin, stop) {
      this._peopleInit();
      const p = this._people.find(x => x.pin === String(pin).trim());
      if (!p) throw new Error('That PIN was not recognized.');
      const f = this._firings.find(x => x.status === 'active');
      if (stop) { this._set(f && f.id).delete(p.id); this._pending.delete(p.id); return { label: p.label, stopped: true }; }
      if (!p.allowed) throw new Error(`Alerts are switched off for ${p.label}. Ask the department head.`);
      this._set(f && f.id).add(p.id);
      return { label: p.label, firing_id: f ? f.id : null, pending: !f };
    }
    async firingAction(pin, action, minutes) {
      this._peopleInit();
      const f = this._firings.find(x => x.status === 'active');
      if (!f) throw new Error('No firing is in progress.');
      const p = this._people.find(x => x.pin === String(pin).trim() && x.allowed);
      if (!p || !this._set(f.id).has(p.id)) throw new Error('That PIN is not signed up for this firing. Sign up for its alerts first.');
      const now = this.now();
      if (action === 'hold') f.hold_until = new Date(now + (minutes || 60) * 60000).toISOString();
      else if (action === 'resume') f.hold_until = null;
      else if (action === 'cool') f.cooling_at = new Date(now).toISOString();
      else if (action === 'uncool') f.cooling_at = null;
      return { ok: true, label: p.label };
    }
    async addRecipient(firingId, personId) { this._peopleInit(); this._set(firingId).add(personId); }
    async removeRecipient(firingId, personId) { this._peopleInit(); this._set(firingId).delete(personId); }

    subscribe(h) {
      setInterval(() => {
        const t = this.now();
        h.onReading({ device_id: this.dev, ts: new Date(t).toISOString(), temp_c: this._tempAt(t), fault: 0 });
        this.status().then(h.onStatus);
        if (this._tick()) h.onFiring();
      }, 2000);
    }

    async session() { return this._session; }
    async signIn(email) {
      this._session = { user: { email: email || 'demo@example.edu' } };
      this._authCb(this._session);
    }
    async signOut() { this._session = null; this._authCb(null); }
    onAuth(cb) { this._authCb = cb; }
  }

  root.KilnApi = {
    create(cfg) {
      return cfg.supabaseUrl ? new SupabaseApi(cfg) : new DemoApi(cfg);
    },
  };
})(this);
