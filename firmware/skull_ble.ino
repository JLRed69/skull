// ─────────────────────────────────────────────────────────────────────────────
// skull_ble.ino  ·  Memento · ESP32 + MPU6050 → BLE telemetry
// ─────────────────────────────────────────────────────────────────────────────
//
// Streams 6-DoF motion from an MPU6050 over BLE (GATT notify) to the Memento
// web app (Bluefy on iOS, Chrome on Android/desktop).
//
// HARDWARE
//   - Any ESP32 dev board with BLE (WROOM, S3, C3, C6, etc.)
//   - MPU6050 IMU on I²C
//
// PIN CONFIG  ────────────────────────────────────────────────────────────────
//   The default Wire pins differ per chip family. Edit MPU_SDA / MPU_SCL below
//   to match your board:
//
//     ┌───────────────────────────────────┬─────┬─────┐
//     │ Board                             │ SDA │ SCL │
//     ├───────────────────────────────────┼─────┼─────┤
//     │ ESP32 (classic, WROOM/WROVER)     │  21 │  22 │
//     │ ESP32-S3                          │   8 │   9 │
//     │ XIAO ESP32-C3 (Seeed)             │   6 │   7 │
//     │ ESP32-C3-DevKitM-1 (Espressif)    │   4 │   5 │
//     │ ESP32-C3 SuperMini                │   8 │   9 │
//     │ LOLIN C3 mini                     │   8 │  10 │
//     └───────────────────────────────────┴─────┴─────┘
//
//   For ESP32-C3 boards: in Arduino IDE, also check Tools menu →
//     - "USB CDC On Boot" : Enabled    (so Serial works over USB)
//     - "Partition Scheme": Default 4MB with spiffs   (BLE needs room)
//
//   Wiring:
//     SDA  → MPU SDA
//     SCL  → MPU SCL
//     3.3V → MPU VCC   (do NOT use 5 V on the C3)
//     GND  → MPU GND
//
// LIBRARIES (install from Arduino Library Manager)
//   - "Adafruit MPU6050"   by Adafruit
//   - "Adafruit Unified Sensor"   (dependency, auto-installs)
//   - ESP32 BLE libs ship with the "esp32 by Espressif Systems" board package
//     (v2.0.4 or newer for ESP32-C3 support — v3.x recommended).
//
// FLASHING
//   1.  Arduino IDE → Boards Manager → install "esp32 by Espressif Systems".
//   2.  Tools → Board → "ESP32 Dev Module" (or your specific board).
//   3.  Tools → Partition Scheme → "Minimal SPIFFS" or "Default" — BLE is big,
//       the default sketch partition is fine on most boards.
//   4.  Plug in the board, pick the port, hit Upload.
//   5.  Open the Serial Monitor at 115200 baud — you should see:
//         BLE advertising as ESP32-SKULL
//
// CONNECT FROM THE APP
//   • Open the Memento app in Bluefy (iOS) or Chrome (Android/desktop).
//   • Tap the BLE pill at the top.
//   • Pick "ESP32-SKULL" from the picker.
//   • Move the board — the on-screen skull should follow in real time.
//
// ─────────────────────────────────────────────────────────────────────────────

#include <Wire.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

// ── Pin config (see table at top — change to match your board) ──────────────
#if defined(CONFIG_IDF_TARGET_ESP32C3)
  // ESP32-C3 default — works for XIAO ESP32-C3 out of the box. Edit if your
  // C3 board uses different pins (e.g. SuperMini = 8/9, DevKitM-1 = 4/5).
  #define MPU_SDA 6
  #define MPU_SCL 7
#elif defined(CONFIG_IDF_TARGET_ESP32S3)
  #define MPU_SDA 8
  #define MPU_SCL 9
#else
  // Classic ESP32 (WROOM/WROVER)
  #define MPU_SDA 21
  #define MPU_SCL 22
#endif

// ── UUIDs ───────────────────────────────────────────────────────────────────
// These MUST match the constants in skull-app.jsx (BLE_SERVICE_UUID, etc).
#define SERVICE_UUID     "7a0247e7-8e88-409b-a959-ab5092ddb03e"
#define CHAR_TELEM_UUID  "7a0247e8-8e88-409b-a959-ab5092ddb03e"  // notify, ESP32 → phone
#define CHAR_CMD_UUID    "7a0247e9-8e88-409b-a959-ab5092ddb03e"  // write,  phone → ESP32

// ── State ───────────────────────────────────────────────────────────────────
Adafruit_MPU6050     mpu;
BLECharacteristic*   telemChar     = nullptr;
bool                 clientConnected = false;

// Live orientation estimate (radians)
float rx = 0, ry = 0, rz = 0;
// Smoothed motion intensity (0..1)
float intensity = 0;
unsigned long lastTickMs = 0;

// ── BLE callbacks ───────────────────────────────────────────────────────────
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) override {
    clientConnected = true;
    Serial.println("[BLE] client connected");
  }
  void onDisconnect(BLEServer* s) override {
    clientConnected = false;
    Serial.println("[BLE] client disconnected — restart advertising");
    BLEDevice::startAdvertising();
  }
};

// Commands phone → ESP32 (optional — extend as needed).
// Packet layout: [cmd_byte][payload...]
//   0x01 setEffect   payload: 1 byte  (0=smoke 1=embers 2=mist 3=streaks)
//   0x02 setPalette  payload: 1 byte  (0..4)
//   0x03 amplify     payload: none    (pulse)
class CmdCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    std::string v = c->getValue();
    if (v.empty()) return;
    uint8_t cmd = (uint8_t) v[0];
    Serial.printf("[BLE] cmd 0x%02X len=%u\n", cmd, (unsigned) v.size());
    // Extend here: drive LEDs, change animation modes on the skull rig, etc.
  }
};

// ── Setup ───────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\nMemento · ESP32 Skull BLE\n");

  // ── I²C + MPU6050 ─────────────────────────────────────────────────────────
  Wire.begin(MPU_SDA, MPU_SCL);
  Serial.printf("I2C pins: SDA=%d SCL=%d\n", MPU_SDA, MPU_SCL);
  if (!mpu.begin()) {
    Serial.println("!! MPU6050 not found — check wiring and pin defines");
    // Continue anyway so BLE still advertises; telemetry will be zeros.
  } else {
    mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    Serial.println("MPU6050 ready");
  }

  // ── BLE ───────────────────────────────────────────────────────────────────
  BLEDevice::init("ESP32-SKULL");
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService* service = server->createService(SERVICE_UUID);

  telemChar = service->createCharacteristic(
    CHAR_TELEM_UUID,
    BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ
  );
  telemChar->addDescriptor(new BLE2902());

  BLECharacteristic* cmdChar = service->createCharacteristic(
    CHAR_CMD_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  cmdChar->setCallbacks(new CmdCallbacks());

  service->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  adv->setMinPreferred(0x06);  // helps with iPhone connection issues
  adv->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("BLE advertising as ESP32-SKULL");
}

// ── Pack 8-byte telemetry packet (must match parseTelemetry in app) ────────
//   int16  rx * 1000   (radians ×1000, range ±32 rad — way more than needed)
//   int16  ry * 1000
//   int16  rz * 1000
//   uint16 intensity * 65535
inline int16_t clamp16(long v) {
  if (v >  32000) return  32000;
  if (v < -32000) return -32000;
  return (int16_t) v;
}

void sendTelemetry() {
  uint8_t buf[8];
  int16_t  i16x = clamp16((long)(rx * 1000.0f));
  int16_t  i16y = clamp16((long)(ry * 1000.0f));
  int16_t  i16z = clamp16((long)(rz * 1000.0f));
  uint16_t u16i = (uint16_t)(intensity * 65535.0f);
  buf[0] = i16x       & 0xff;  buf[1] = (i16x >> 8) & 0xff;
  buf[2] = i16y       & 0xff;  buf[3] = (i16y >> 8) & 0xff;
  buf[4] = i16z       & 0xff;  buf[5] = (i16z >> 8) & 0xff;
  buf[6] = u16i       & 0xff;  buf[7] = (u16i >> 8) & 0xff;
  telemChar->setValue(buf, 8);
  telemChar->notify();
}

// ── Loop ────────────────────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();
  unsigned long dtMs = now - lastTickMs;
  if (dtMs < 10) { delay(1); return; }  // throttle to ~100 Hz
  lastTickMs = now;
  float dt = dtMs / 1000.0f;

  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);

  // Complementary filter — blend gyro integration with accel-tilt estimate.
  // For a more accurate solution swap in Madgwick/Mahony fusion.
  float pitch = atan2(a.acceleration.y,
                      sqrt(a.acceleration.x * a.acceleration.x +
                           a.acceleration.z * a.acceleration.z));
  float roll  = atan2(-a.acceleration.x, a.acceleration.z);

  const float K = 0.05f;  // accel weight; gyro carries the rest
  rx = (1.0f - K) * (rx + g.gyro.x * dt) + K * pitch;
  ry = (1.0f - K) * (ry + g.gyro.y * dt) + K * roll;
  rz = rz + g.gyro.z * dt;
  rz *= 0.9985f;          // slow yaw bleed so drift doesn't run away

  // Motion intensity → particle bloom on the app side
  float gMag = sqrt(g.gyro.x * g.gyro.x +
                    g.gyro.y * g.gyro.y +
                    g.gyro.z * g.gyro.z);
  float aMag = sqrt(a.acceleration.x * a.acceleration.x +
                    a.acceleration.y * a.acceleration.y +
                    a.acceleration.z * a.acceleration.z);
  float jerk = fabs(aMag - 9.81f);
  float target = gMag * 0.15f + jerk * 0.05f;
  if (target < 0.0f) target = 0.0f;
  if (target > 1.0f) target = 1.0f;
  intensity = intensity * 0.85f + target * 0.15f;

  if (clientConnected && telemChar) {
    sendTelemetry();
  }
}
