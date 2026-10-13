# Kiln Monitor

A self-built replacement for the Easylog Cloud logger on the TWU Visual Arts gas kiln.
An ESP32 reads the kiln's existing type K thermocouple (shared, not a second probe) and uploads
readings over WiFi. A web dashboard shows the live temperature, a history of firings, overlays of
past firings, and sends phone alerts.

**Monitoring only.** The logger never controls the kiln or touches the Bailey controller or its safety shutoff.

```
ESP32 + MAX31856  ──HTTPS──▶  Supabase (database + alert logic)  ──▶  ntfy phone alerts
                                        ▲
                     Dashboard (GitHub Pages) reads live data
```

## What's in here

| Folder | What it is |
|---|---|
| `web/` | The dashboard: plain HTML/CSS/JS, Chart.js. Opens in **demo mode** until Supabase is connected. |
| `supabase/schema.sql` | The whole backend: tables, access rules, firing detection, alerts, scheduled checks. |
| `simulator/` | Sends a fake gas firing to Supabase the same way the logger will. |
| `firmware/` | ESP32 code (PlatformIO). Has a `fake` build that runs without a thermocouple. |
| `docs/PROJECT_BRIEF.md` | The original plan and the decisions made since. |

## Try the dashboard now

Open `web/index.html` in a browser. With no Supabase details in `web/config.js` it runs a simulated
kiln, 30× faster than real time. "Staff sign in" accepts any email in demo mode.

## Setting up Supabase (one time)

1. In Supabase, create a **New project** (any name, e.g. `kiln-monitor`; region: Central US or East US).
   Save the database password somewhere safe.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
   The last result shows two values. Keep them private:
   - `device_key`: the logger's password for uploading data
   - `ntfy_topic`: the name of the phone-alert channel
3. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up".
   Then **Authentication → Users → Add user** for each staff member (email + password).
   Every signed-in user can edit firings and settings; students only need the link.
4. **Project Settings → API Keys**: copy the **Project URL** and the **anon / publishable** key into
   `web/config.js`. (That key is safe to publish; the database only lets it view data and call the upload function.)

## Phone alerts

Install the free **ntfy** app, tap **+**, and subscribe to the `ntfy_topic` value from step 2.
Anyone who knows the topic name can subscribe, so share it only with people who should get alerts.
Set the dashboard link in **Settings** so tapping an alert opens the dashboard.

Alerts: firing started, firing complete, over temperature, stalled climb, thermocouple fault, logger offline.
Thresholds are editable on the dashboard's Settings tab (staff only).

## Testing with the simulator

Needs Node.js (already installed).

```
cd simulator
copy config.example.json config.json      (then fill in URL, key, device_key)
node simulate.js backfill --days-ago 3     one finished past firing
node simulate.js backfill --days-ago 6 --bisque
node simulate.js live --speed 60           a live firing, about 35 minutes long
node simulate.js live --speed 60 --overshoot
```

To test the stalled-climb alert in a sped-up run, temporarily set "Measured over" to 5 minutes in Settings
and use `--stall`.

## Firmware

1. Install the **PlatformIO** extension in VS Code.
2. Copy `firmware/src/secrets.example.h` to `secrets.h` and fill it in.
3. Choose the `fake` environment to test WiFi and uploads with no thermocouple, then `kiln` for the real thing.
4. Upload, then open the Serial Monitor (115200 baud). It reports WiFi signal, the MAC address,
   and whether the network has a login page that would block it.

Wiring, ESP32 → MAX31856: 3V3 → VIN, GND → GND, GPIO18 → SCK, GPIO19 → SDO, GPIO23 → SDI, GPIO5 → CS.

Power it from a USB wall adapter, never from a grounded computer while it's connected to the kiln thermocouple.

## Hosting the dashboard

The dashboard is the `web/` folder. The included workflow (`.github/workflows/pages.yml`) publishes it
to GitHub Pages on every push. One-time setup: repo **Settings → Pages → Source: GitHub Actions**.
The site appears at `https://colbyparsons-art.github.io/kiln-logger/`.
