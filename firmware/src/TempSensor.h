// Temperature sensor interface, so the rest of the firmware doesn't care whether
// it's talking to the real MAX31856 or a fake one.
#pragma once
#include <Arduino.h>

struct TempSample {
  float tempC;          // thermocouple temperature (NAN on fault)
  float coldJunctionC;  // temperature of the board itself
  uint8_t fault;        // MAX31856 fault register, 0 = OK
};

class TempSensor {
 public:
  virtual ~TempSensor() {}
  virtual bool begin() = 0;
  virtual TempSample read() = 0;
};

#ifndef USE_FAKE_SENSOR
// ------------------------------------------------------------------ real sensor
#include <Adafruit_MAX31856.h>

class Max31856Sensor : public TempSensor {
 public:
  explicit Max31856Sensor(int csPin) : chip_(csPin) {}

  bool begin() override {
    if (!chip_.begin()) return false;            // hardware SPI: SCK 18, MISO 19, MOSI 23
    chip_.setThermocoupleType(MAX31856_TCTYPE_K);
    chip_.setNoiseFilter(MAX31856_NOISE_FILTER_60HZ);  // US mains
    chip_.setConversionMode(MAX31856_CONTINUOUS);
    return true;
  }

  TempSample read() override {
    TempSample s;
    s.fault = chip_.readFault();
    s.coldJunctionC = chip_.readCJTemperature();
    s.tempC = s.fault ? NAN : chip_.readThermocoupleTemperature();
    return s;
  }

 private:
  Adafruit_MAX31856 chip_;
};

#else
// ------------------------------------------------------------------ fake sensor
// A cone 10 firing compressed to about 35 minutes, then it starts over.
class FakeSensor : public TempSensor {
 public:
  bool begin() override { start_ = millis(); return true; }

  TempSample read() override {
    static const float pts[][2] = {  // hours, °C
      {0, 24}, {1, 90}, {2, 190}, {4, 470}, {6, 760}, {7, 890}, {7.25f, 880},
      {8.25f, 950}, {9, 1010}, {10.5f, 1170}, {11.5f, 1260}, {12, 1285}, {12.5f, 1290}};
    const int n = sizeof(pts) / sizeof(pts[0]);
    const float speed = 60;  // 1 real minute = 1 simulated hour
    float h = fmodf((millis() - start_) / 3600000.0f * speed, 35.0f);
    float c;
    if (h <= pts[n - 1][0]) {
      int i = 1;
      while (pts[i][0] < h) i++;
      float t = (h - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
      c = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
    } else {
      c = 24 + (pts[n - 1][1] - 24) * expf(-(h - pts[n - 1][0]) / 7.0f);
    }
    return TempSample{c + random(-50, 50) / 100.0f, 28.0f, 0};
  }

 private:
  uint32_t start_ = 0;
};
#endif
