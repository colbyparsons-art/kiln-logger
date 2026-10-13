# Kiln Datalogger Project: brief and decisions

Started 2026-10-13. Based on a planning brief written in Claude chat.

## Decisions (2026-10-13)

| Question | Decision |
|---|---|
| Backend | **Supabase**. All logic is in `supabase/schema.sql` (Postgres functions, pg_cron, pg_net), so there are no server functions to deploy |
| Alerts | **ntfy** push notifications (free app, no account) |
| Access | Anyone with the link can view. Signed-in staff can edit firings and settings. Public sign-up is turned off |
| Units | Stored in °C. The dashboard shows °F by default, with a °C toggle |
| Dashboard hosting | GitHub Pages, from the `web/` folder via GitHub Actions |
| Project location | `Desktop\kiln-logger`, its own repo, separate from art-dept-scheduler |

## Goal

Replace the Easylog Cloud datalogger on the school's gas kiln with a self-built logger that sends
temperature data over WiFi to a web app. The app needs a live chart (usable on a phone), each firing
saved as a record, overlays of past firings, and alerts (overshoot, stalled climb, lost connection).

## Hard constraints

- **Monitoring only.** The logger never controls the kiln or interferes with the controller or any safety shutoff.
- **No second thermocouple and no drilling.** It shares the existing thermocouple.
- **Prefer Amazon** for purchases.

## Kiln setup

- Gas kiln, **Bailey Advanced Logic** controller.
- One thermocouple, believed to be **type K** (green plug). Confirm this in the controller settings.
- The Easylog sits on the outside of the control panel and connects with a standard **mini thermocouple plug**.
  It runs on a USB wall adapter and uses campus WiFi, probably an open network.
- Type K is rated to about 1260 °C (cone 10 is about 1305 °C), so expect drift at high fire. Check it occasionally against witness cones.

## Hardware

Pass-through wiring: the kiln's thermocouple plug goes into a panel-mount female K mini socket on the
logger box. Inside the box, that socket feeds the MAX31856 and a short thermocouple-wire pigtail ending in a male
K mini plug that goes to the Easylog, so both loggers run side by side for a few firings.

- Use thermocouple-grade wire for all thermocouple runs, and keep the polarity correct.
- Keep all junctions inside the enclosure.
- Power from a USB wall adapter only; never from a grounded computer while it's connected to the kiln.
- Isolation (a digital isolator plus an isolated DC-DC converter) is deferred. Check that the controller's display doesn't
  shift when the logger is connected; add isolation if offsets or noise appear.

Parts ordered from Amazon (about $98): ESP32-DevKitC-32E, Noteflora MAX31856 module (bench-test it first),
SeaISee K mini socket/plug set, K-type thermocouple wire (AWG 24), LeMotech IP65 box (158×90×60 mm),
a 5 V 2 A USB adapter, and Dupont jumpers.

## Still open

- Whether campus WiFi has a login page or needs IT to register the device. The firmware prints this on boot.
- Easylog history export (CSV) for seed data and comparison.
- Thermocouple type confirmation.
- Certificate checking for HTTPS uploads (currently encrypted but not verified; see `firmware/src/main.cpp`).
