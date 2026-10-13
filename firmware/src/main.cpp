// Kiln logger: reads the kiln thermocouple through a MAX31856 and uploads readings
// to Supabase over WiFi. Monitoring only; it never controls the kiln.
//
// Readings are kept in memory while WiFi is down and uploaded when it comes back,
// oldest first, so a firing isn't lost to a dropout. (A power cut does lose the buffer.)

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>
#include "secrets.h"
#include "TempSensor.h"

static const char* FW_VERSION = "0.1.0";

// Wiring (ESP32 hardware SPI): SCK 18, MISO/SDO 19, MOSI/SDI 23, CS 5, 3V3 and GND.
const int MAX_CS_PIN = 5;

const uint32_t SAMPLE_MS      = 2000;    // read the sensor this often
const uint32_t STORE_HOT_MS   = 10000;   // keep a reading every 10 s while the kiln is warm
const uint32_t STORE_COLD_MS  = 60000;   // every 60 s while it's cold and steady
const float    HOT_C          = 50;      // "warm" means above this
const uint32_t UPLOAD_MS      = 15000;   // try to upload this often
const int      UPLOAD_BATCH   = 150;     // readings per upload request
const uint32_t WIFI_RETRY_MS  = 30000;

// ------------------------------------------------------------------ reading buffer
// A ring buffer of compact readings. 6000 × 12 bytes = 72 KB, about 16 hours at one reading per 10 s.
struct Reading {
  uint32_t uptimeS;   // seconds since boot (converted to real time at upload)
  int16_t  tempC10;   // °C × 10
  int16_t  cjC10;     // cold junction °C × 10
  uint8_t  fault;
};
const int BUF_SIZE = 6000;
Reading buf[BUF_SIZE];
int bufHead = 0;   // oldest reading
int bufCount = 0;

void pushReading(const Reading& r) {
  int idx = (bufHead + bufCount) % BUF_SIZE;
  if (bufCount == BUF_SIZE) {             // full: drop the oldest
    bufHead = (bufHead + 1) % BUF_SIZE;
    bufCount--;
  }
  buf[idx] = r;
  bufCount++;
}

// ------------------------------------------------------------------ sensor
#ifdef USE_FAKE_SENSOR
FakeSensor sensor;
#else
Max31856Sensor sensor(MAX_CS_PIN);
#endif

uint32_t lastSample = 0, lastStore = 0, lastUpload = 0, lastWifiTry = 0;
float sumC = 0, sumCj = 0;
int nSamples = 0;
uint8_t faultSeen = 0;
float lastStoredC = NAN;

void sampleSensor() {
  TempSample s = sensor.read();
  if (s.fault) {
    faultSeen |= s.fault;
    Serial.printf("Sensor fault 0x%02X\n", s.fault);
  } else {
    sumC += s.tempC;
    sumCj += s.coldJunctionC;
    nSamples++;
  }
}

// Average the samples since the last stored reading and store one reading.
void maybeStore(uint32_t now) {
  float avg = nSamples ? sumC / nSamples : NAN;
  bool warm = !isnan(avg) && (avg > HOT_C || (!isnan(lastStoredC) && fabsf(avg - lastStoredC) > 2));
  uint32_t interval = (warm || faultSeen) ? STORE_HOT_MS : STORE_COLD_MS;
  if (now - lastStore < interval) return;

  Reading r;
  r.uptimeS = now / 1000;
  r.fault = (nSamples == 0) ? (faultSeen ? faultSeen : 0xFF) : 0;
  r.tempC10 = r.fault ? 0 : (int16_t)lroundf(avg * 10);
  r.cjC10 = nSamples ? (int16_t)lroundf(sumCj / nSamples * 10) : 0;
  pushReading(r);
  if (!r.fault) lastStoredC = avg;
  Serial.printf("Stored %.1f C (fault 0x%02X), %d buffered\n", r.fault ? NAN : avg, r.fault, bufCount);

  lastStore = now;
  sumC = sumCj = 0;
  nSamples = 0;
  faultSeen = 0;
}

// ------------------------------------------------------------------ WiFi and time
bool timeSynced() { return time(nullptr) > 1700000000; }   // after Nov 2023 means NTP worked

void connectWifi() {
  Serial.printf("Connecting to WiFi \"%s\"…\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  if (strlen(WIFI_PASSWORD) == 0) WiFi.begin(WIFI_SSID);
  else WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// Open campus networks sometimes need a browser "click to accept" page, which the ESP32 can't do.
// This prints whether the internet is actually reachable.
void checkCaptivePortal() {
  HTTPClient http;
  http.begin("http://connectivitycheck.gstatic.com/generate_204");
  int code = http.GET();
  http.end();
  if (code == 204) Serial.println("Internet reachable (no login page).");
  else Serial.printf("Internet check returned %d. The network may have a login page; IT may need to register MAC %s\n",
                     code, WiFi.macAddress().c_str());
}

// ------------------------------------------------------------------ upload
// Sends up to UPLOAD_BATCH of the oldest readings. Returns true if they were accepted.
bool uploadBatch() {
  int n = min(bufCount, UPLOAD_BATCH);
  uint32_t nowUp = millis() / 1000;
  int64_t bootEpoch = (int64_t)time(nullptr) - nowUp;   // real time when uptime was 0

  String body;
  body.reserve(200 + n * 60);
  body += "{\"p_device_key\":\"" DEVICE_KEY "\",\"p_device_id\":\"" DEVICE_ID "\",";
  body += "\"p_fw\":\"" + String(FW_VERSION) + "\",";
  body += "\"p_rssi\":" + String(WiFi.RSSI()) + ",";
  body += "\"p_buffered\":" + String(bufCount - n) + ",\"p_readings\":[";
  for (int i = 0; i < n; i++) {
    const Reading& r = buf[(bufHead + i) % BUF_SIZE];
    char item[96];
    long long t = (bootEpoch + (int64_t)r.uptimeS) * 1000LL;
    if (r.fault) snprintf(item, sizeof(item), "%s{\"t\":%lld,\"c\":null,\"cj\":%.1f,\"f\":%u}", i ? "," : "", t, r.cjC10 / 10.0, r.fault);
    else snprintf(item, sizeof(item), "%s{\"t\":%lld,\"c\":%.1f,\"cj\":%.1f,\"f\":0}", i ? "," : "", t, r.tempC10 / 10.0, r.cjC10 / 10.0);
    body += item;
  }
  body += "]}";

  WiFiClientSecure client;
  // TODO: verify the server certificate. For now the connection is encrypted but the server's
  // identity isn't checked. Add the CA certificate once we've tested against the real project.
  client.setInsecure();
  HTTPClient http;
  http.setTimeout(15000);
  http.begin(client, String(SUPABASE_URL) + "/rest/v1/rpc/ingest");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  int code = http.POST(body);
  String resp = http.getString();
  http.end();

  if (code == 200) {
    bufHead = (bufHead + n) % BUF_SIZE;
    bufCount -= n;
    Serial.printf("Uploaded %d readings: %s\n", n, resp.c_str());
    return true;
  }
  Serial.printf("Upload failed (%d): %s\n", code, resp.c_str());
  return false;
}

// ------------------------------------------------------------------ main
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.printf("\nKiln logger %s, device %s\n", FW_VERSION, DEVICE_ID);

  if (!sensor.begin()) Serial.println("MAX31856 not found. Check wiring (SCK 18, SDO 19, SDI 23, CS 5, 3V3, GND).");

  connectWifi();
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");   // UTC; the dashboard shows local time

  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) delay(250);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("WiFi connected, IP %s, signal %d dBm, MAC %s\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI(), WiFi.macAddress().c_str());
    checkCaptivePortal();
  } else {
    Serial.println("WiFi not connected yet; logging locally and retrying.");
  }
}

void loop() {
  uint32_t now = millis();

  if (now - lastSample >= SAMPLE_MS) {
    lastSample = now;
    sampleSensor();
    maybeStore(now);
  }

  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiTry >= WIFI_RETRY_MS) {
      lastWifiTry = now;
      Serial.println("WiFi down, reconnecting…");
      WiFi.disconnect();
      connectWifi();
    }
  } else if (bufCount > 0 && timeSynced() && now - lastUpload >= UPLOAD_MS) {
    lastUpload = now;
    // Catch up after an outage: keep sending batches while they succeed (a few per pass).
    for (int i = 0; i < 5 && bufCount > 0; i++) {
      if (!uploadBatch()) break;
    }
  }

  delay(10);
}
