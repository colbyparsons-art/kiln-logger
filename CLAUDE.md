# Kiln Monitor: notes for Claude

A self-built replacement for the Easylog Cloud temperature logger on the TWU Visual Arts gas kiln.
An ESP32 with a MAX31856 reads the kiln's type K thermocouple and uploads to Supabase. A web dashboard
(GitHub Pages) shows live and past firings, and phone alerts go out through ntfy.

This project is separate from Colby's art-dept-scheduler. Don't mix the two.

## Start here

Read `docs/STATUS.md` first. It records what's done, which database upgrades have been applied, the
hardware bring-up steps, what still needs tuning, and where the secrets live. `docs/PROJECT_BRIEF.md` has the
original plan and decisions. Update STATUS.md whenever something changes.

## Hard rules

- **Monitoring only.** Nothing may control the kiln or touch the Bailey controller or its safety shutoff.
- **No student names.** In the People list, use nicknames or initials. Firing names and notes are publicly readable.
- Never commit secrets: `firmware/src/secrets.h` and `simulator/config.json` are ignored by git. The Supabase
  anon key in `web/config.js` is public by design.

## How changes ship

- **Dashboard (`web/`):** commit and push to `main`; GitHub Pages redeploys. Live at https://colbyparsonsart.com/kiln-logger/.
- **Database:** `supabase/schema.sql` is always the full setup for a new project. Changes to the live project go in a
  new `supabase/upgrade-YYYY-MM-DD-*.sql` that is safe to run twice and ASCII-only. Colby pastes it into the Supabase SQL Editor.
  Put it on the clipboard with `Get-Content -Raw -Encoding UTF8 <file> | Set-Clipboard`; without `-Encoding UTF8` the ° sign
  gets garbled. Afterward, confirm it was applied by querying the REST API with the anon key, then mark it applied in STATUS.md.
- **Test database changes before shipping:** `cd tests && npm install && npm test` (in-memory Postgres via PGlite).
  To test an upgrade, run `node alert-routing.mjs up <schema from git HEAD> <upgrade file>`.
- **Firmware:** PlatformIO in VS Code. Open the `firmware` folder. The `fake` environment needs no thermocouple.

## Working with Colby

- Head of Visual Arts at TWU and a ceramicist. Basic coding knowledge, so give plain-language steps for tools
  (Supabase dashboard, VS Code, PlatformIO). Gas-kiln realities matter: holds swing up and down, cooldowns are slowed by
  firing down (e.g. through quartz inversion), and pilots sometimes blow out.
- Ask where to save new files outside this repo (default: Desktop). Don't change things outside the current task.
