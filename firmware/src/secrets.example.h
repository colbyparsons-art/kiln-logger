// Copy this file to secrets.h and fill it in. secrets.h is not committed to GitHub.
#pragma once

// Campus WiFi. Leave the password empty ("") for an open network.
#define WIFI_SSID      "TWU-Guest"
#define WIFI_PASSWORD  ""

// Supabase → Project Settings → API Keys
#define SUPABASE_URL      "https://YOUR-PROJECT.supabase.co"
#define SUPABASE_ANON_KEY "YOUR-ANON-OR-PUBLISHABLE-KEY"

// From the last line of output when you ran supabase/schema.sql
#define DEVICE_KEY  "PASTE-DEVICE-KEY-HERE"

// Must match deviceId in web/config.js
#define DEVICE_ID   "gas-kiln"
