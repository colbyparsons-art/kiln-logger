# Kiln Monitor: status and next steps

Last updated 2026-10-13. Work is paused until the hardware arrives (ordered on Amazon, due about late October 2026).
Read this first when picking the project back up. The original plan is in [PROJECT_BRIEF.md](PROJECT_BRIEF.md).

## Where everything is

| What | Where |
|---|---|
| Project folder | `C:\Users\colby\Desktop\kiln-logger` (its own git repo) |
| GitHub | https://github.com/colbyparsons-art/kiln-logger (public; no secrets in it) |
| Live dashboard | https://colbyparsonsart.com/kiln-logger/ (GitHub Pages, rebuilt on every push) |
| Supabase project | ref `ojhgtfrxqzkympprqlsm`, URL https://ojhgtfrxqzkympprqlsm.supabase.co (sign in with GitHub) |
| Secrets (in 1Password) | Supabase database password, **device_key** (the logger's upload password), **ntfy_topic** (the owner's alert channel). To see the last two again: SQL Editor → `select * from private.config;` |
| Local-only secret files | `simulator/config.json` (has the device key). `firmware/src/secrets.h` doesn't exist yet; create it from `secrets.example.h`. Both are ignored by git. |

## What's done

- **Dashboard** (`web/`): live chart with time ranges and zoom, firing history, overlays of past firings,
  CSV download, °F/°C, staff login, staff-only Settings, a privacy note on firing names and notes, and demo mode.
- **Backend** (`supabase/schema.sql`): readings, automatic firing start and end, and alerts through ntfy:
  firing started/complete, kiln is cooling, over temperature, temperature drop (blown pilot), stalled climb,
  thermocouple fault, logger offline.
- **Per-person alerts:** the owner keeps a People list (nicknames or initials only) with PINs. The person firing
  signs up with their PIN. The owner gets urgent alerts on other people's firings and everything on firings nobody signed up for.
- **Firing controls by PIN:** Hold (pauses the stall alert) and "Burners off – mark as cooling".
- **Simulator** (`simulator/`): sends fake firings through the same path the logger will use.
- **Firmware** (`firmware/`): written, but **never compiled or run**. PlatformIO is installed in VS Code.

Verified: the whole path simulator → Supabase → ntfy → phone worked with a live simulated firing on 2026-10-13.
The alert logic was tested on streamed simulated firings (see `tests/`). Not yet verified: real hardware,
the real campus WiFi, and the real kiln's cooling rates and hold swings.

## Database changes

`supabase/schema.sql` is always the complete, current setup for a brand-new project.
Changes to the existing project are applied by pasting these files into the SQL Editor:

| File | Applied? |
|---|---|
| `fix-2026-10-13-degree-sign.sql` | ✅ yes |
| `upgrade-2026-10-13-alerts.sql` (drop alert, people, PIN sign-up) | ✅ yes |
| `upgrade-2026-10-13-cooling-hold.sql` (cooling alert, one alert per drop, Hold, PIN controls) | ✅ yes |

Copy SQL to the clipboard with `Get-Content -Raw -Encoding UTF8 <file> | Set-Clipboard`. Without `-Encoding UTF8`,
the ° sign gets garbled. The upgrade files are plain ASCII to avoid that.

## When the parts arrive

1. **Bench-test the ESP32 alone (no thermocouple):** VS Code → open the `firmware` folder → create `src/secrets.h`
   → choose the `fake` environment → Build. This is the **first compile**, so expect to fix a few errors. Then Upload and open the Serial Monitor at 115200 baud.
   - It prints whether campus WiFi has a login page. If it does, IT must register the MAC address it prints.
   - Fake readings should appear on the dashboard.
2. **Bench-test the MAX31856 board** (Noteflora, quality unknown) with a spare type K thermocouple if one is available.
   Wiring: 3V3→VIN, GND→GND, GPIO18→SCK, GPIO19→SDO, GPIO23→SDI, GPIO5→CS.
3. **Build the pass-through box:** panel female K mini socket → MAX31856 plus a thermocouple-wire pigtail to a male K mini plug for the Easylog.
   Keep polarity correct and all junctions inside the box. Power from the USB wall adapter only.
4. **At the kiln:** check the Bailey controller's temperature display **doesn't shift** when the logger is plugged in.
   If it does, add isolation (deferred; those parts aren't on Amazon). Confirm the thermocouple is type K in the controller settings.
5. **Run both loggers side by side** for a few firings and compare against Easylog. Then retire Easylog.
6. **Firmware TODO:** HTTPS certificate checking (`client.setInsecure()` in `main.cpp`). The connection is encrypted but
   the server isn't verified yet.

## Before real use

- Delete the simulated test data (SQL Editor). This is permanent, so only do it when you're ready to start fresh:
  `delete from public.alerts; delete from public.firings; delete from public.readings; delete from public.device_status;`
- In Settings, set the dashboard link (`https://colbyparsonsart.com/kiln-logger/`).
- Add people (nicknames or initials) and give each their phone setup code and PIN.
- Set a target cone on each firing. That's what lets the system tell a planned shutoff from a blown pilot.

## Still to tune with real data

- **Drop alert** (default 50 °F within 20 minutes): tested only on simulated curves. Export Easylog history as CSV, if possible,
  and run the detector over real firings to check reduction dips and hold swings.
- **Soaks that swing ±30 °F or more** need the Hold button on, or they can trigger "Kiln is cooling" early.
- Type K drifts above about 2300 °F, so check against witness cones now and then.

## Known limitations

- PINs are 6 digits and could be guessed. The worst case is someone signing a person up for, or off, a firing's alerts.
- The logger keeps about 16 hours of readings in memory during WiFi outages, but a power cut loses them.
- The owner is the first staff account created in Supabase. Change it with `update private.config set owner_email = '…';`.
- GitHub shows a Node.js 20 deprecation warning for the Pages deploy. It's harmless for now.
- Supabase free plan: 500 MB of storage, which is plenty at the current rate of one reading every 10 seconds.

## Running the tests

```
cd tests
npm install
npm test
```
The tests run the database code in an in-memory Postgres (PGlite), so they never touch the real project.
`drop-and-hold.mjs` lists exactly which alerts each simulated scenario produces.
