# BLE — ESP32 ⇄ Memento App

## Bridge summary

```
┌──────────────┐    BLE GATT     ┌─────────────────────┐
│  ESP32       │  ─── notify ──▶ │  Memento (Bluefy /  │
│  + MPU6050   │  ◀── write ──── │  Chrome)            │
└──────────────┘                 └─────────────────────┘
```

## UUIDs (compartidos entre firmware y app)

| Rol | UUID |
|---|---|
| Service          | `7a0247e7-8e88-409b-a959-ab5092ddb03e` |
| Telemetría (notify, ESP32 → phone) | `7a0247e8-8e88-409b-a959-ab5092ddb03e` |
| Comandos (write, phone → ESP32)    | `7a0247e9-8e88-409b-a959-ab5092ddb03e` |

## Paquete de telemetría (8 bytes, little-endian)

| Offset | Tipo | Valor |
|---|---|---|
| 0–1 | `int16` | rotación X · 1000 (radianes) |
| 2–3 | `int16` | rotación Y · 1000 |
| 4–5 | `int16` | rotación Z · 1000 |
| 6–7 | `uint16` | intensidad · 65535 (0..1) |

100 Hz típicamente.

## Comandos opcionales (phone → ESP32, no implementados en la app aún)

Primer byte = código, siguientes = payload.

| Cmd | Nombre | Payload |
|---|---|---|
| `0x01` | setEffect  | 1 byte (`0`=smoke `1`=embers `2`=mist `3`=streaks) |
| `0x02` | setPalette | 1 byte (`0`..`4`) |
| `0x03` | amplify    | — |

## Probar paso a paso

### 1. Flashear el ESP32
1. Conecta MPU6050: `SDA→GPIO21`, `SCL→GPIO22`, `VCC→3.3V`, `GND→GND`.
2. Arduino IDE → Library Manager → instala **Adafruit MPU6050** (lleva Adafruit Unified Sensor).
3. Tools → Board → `ESP32 Dev Module` (o tu placa).
4. Abre `firmware/skull_ble.ino`, súbelo.
5. Serial Monitor a 115200 → debe decir: `BLE advertising as ESP32-SKULL`.

### 2. App en el iPhone
1. Instala **Bluefy – Web BLE Browser** desde App Store (Safari NO soporta Web Bluetooth en iOS).
2. Abre tu URL: `https://jlred69.github.io/skull/`
3. Toca la pill **BLE · SIM** → "Tap to connect".
4. Aparece el picker nativo de BLE → elige `ESP32-SKULL`.
5. La pill se pone verde **BLE · LIVE**, mueve la placa → el cráneo se mueve.
6. Toca otra vez la pill para desconectar.

### 3. En Android / Desktop
Igual pero con **Chrome** (Web Bluetooth ya viene).

## Estados de la pill BLE

| Estado | Dot | Texto |
|---|---|---|
| `sim`        | gris    | "BLE · SIM"  · *Tap to connect* |
| `scanning`   | amarillo | "BLE · SCAN" |
| `connecting` | amarillo | "BLE · GATT" |
| `connected`  | verde   | "BLE · LIVE" · *nombre del device* |
| `error`      | rojo    | "BLE · ERR"  · *Tap to retry* |

## Troubleshooting

| Síntoma | Causa probable |
|---|---|
| No aparece el device en el picker | El ESP32 no está advertising, o estás en Safari (usa Bluefy). |
| Picker vacío en Bluefy            | Refresca la página, asegúrate que Bluetooth del iPhone está ON. |
| "GATT operation failed"           | Reinicia el ESP32 y vuelve a conectar; a veces se queda con la sesión vieja. |
| Cráneo no se mueve aunque está conectado | Comprueba en Serial Monitor que MPU6050 fue detectado; revisa cableado I²C. |
| Drift en yaw (Z)                  | Es normal con MPU6050 sin magnetómetro; el firmware ya aplica una pequeña fuga. |
