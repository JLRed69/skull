// skull-app.jsx — React overlay for the Memento BLE skull prototype.
// Hosts the iPhone frame, BLE connection HUD, telemetry, and Tweaks panel.

const { useState, useEffect, useRef, useMemo, useCallback, Fragment } = React;

// ── Fullscreen detection ──────────────────────────────────────
// On real mobile devices, or when ?raw=1 is in the URL, we drop the iPhone
// bezel and the page background and let the screen content fill the viewport.
const RAW_MODE = (() => {
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.has('raw') || qs.has('fullscreen')) return true;
    if (qs.has('frame')) return false; // explicit override to show the frame
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    const isNarrow = window.innerWidth < 700;
    return isStandalone || (isTouch && isNarrow);
  } catch { return false; }
})();

// ── Palettes ──────────────────────────────────────────────────
const PALETTES = {
  aether:  { name: 'Aether',  a: '#7FDBFF', b: '#FF3D6E', dot: '#7FDBFF', label: 'Cold spectre' },
  pyre:    { name: 'Pyre',    a: '#FFB347', b: '#FF2A1E', dot: '#FF7A3D', label: 'Living flame' },
  vesper:  { name: 'Vesper',  a: '#9D7AFF', b: '#33E1ED', dot: '#9D7AFF', label: 'Twilight conjure' },
  bone:    { name: 'Bone',    a: '#F1E6D2', b: '#9A2433', dot: '#F1E6D2', label: 'Ossuary' },
  toxic:   { name: 'Toxic',   a: '#7CFF6B', b: '#11A0B5', dot: '#7CFF6B', label: 'Phosphor cult' },
};

const EFFECTS = [
  { id: 'smoke',   label: 'Smoke',   sub: 'Ambient' },
  { id: 'embers',  label: 'Embers',  sub: 'Combustion' },
  { id: 'mist',    label: 'Mist',    sub: 'Apparition' },
  { id: 'streaks', label: 'Streaks', sub: 'Particulate' },
];

const MOTION_MODES = [
  { id: 'sim',    label: 'BLE Sim' },
  { id: 'touch',  label: 'Touch' },
  { id: 'gyro',   label: 'Gyro' },
];

// ── Web Bluetooth UUIDs (must match ESP32 firmware) ───────────
const BLE_SERVICE_UUID   = '7a0247e7-8e88-409b-a959-ab5092ddb03e';
const BLE_CHAR_TELEM     = '7a0247e8-8e88-409b-a959-ab5092ddb03e'; // notify  ESP32 → phone
const BLE_CHAR_CMD       = '7a0247e9-8e88-409b-a959-ab5092ddb03e'; // write   phone → ESP32

// Telemetry packet (8 bytes, little-endian):
//   int16 rx*1000, int16 ry*1000, int16 rz*1000, uint16 intensity*65535
function parseTelemetry(dv) {
  if (!dv || dv.byteLength < 8) return null;
  return {
    x: dv.getInt16(0, true) / 1000,
    y: dv.getInt16(2, true) / 1000,
    z: dv.getInt16(4, true) / 1000,
    intensity: dv.getUint16(6, true) / 65535,
  };
}

// ── Live ticking digits ───────────────────────────────────────
function Digit({ v, pad = 5 }) {
  const sign = v < 0 ? '−' : ' ';
  const s = Math.abs(v).toFixed(2);
  const padded = sign + s.padStart(pad, '0');
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{padded}</span>;
}

// ── Pulsing connection dot ────────────────────────────────────
function Pulse({ color = '#7FDBFF', size = 8 }) {
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: size, height: size }}>
      <span style={{
        position: 'absolute', inset: 0, borderRadius: '50%',
        background: color, boxShadow: `0 0 8px ${color}`,
      }} />
      <span style={{
        position: 'absolute', inset: -4, borderRadius: '50%',
        border: `1px solid ${color}`, animation: 'pulse-ring 1.8s ease-out infinite', opacity: 0.6,
      }} />
    </span>
  );
}

// ── Signal bars (4 bars; activeCount fills) ───────────────────
function SignalBars({ rssi = -55, color = '#7FDBFF' }) {
  // -30 strong, -90 weak. Clamp to 0..4.
  const norm = Math.max(0, Math.min(1, (rssi + 90) / 60));
  const active = Math.round(norm * 4);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 12 }}>
      {[3, 6, 9, 12].map((h, i) => (
        <div key={i} style={{
          width: 2.5, height: h, borderRadius: 1,
          background: i < active ? color : 'rgba(255,255,255,0.18)',
          boxShadow: i < active ? `0 0 4px ${color}80` : 'none',
        }} />
      ))}
    </div>
  );
}

// ── Connection / Status pill ──────────────────────────────────
function BLEPill({ state, paletteDot, rssi, deviceName, onTap }) {
  const isConn = state === 'connected';
  const isWaiting = state === 'scanning' || state === 'connecting';
  const isError = state === 'error';
  const isSim = state === 'sim';
  const dotColor = isConn ? '#3CE08E'
    : isWaiting ? '#FFD25A'
    : isError ? '#FF5470'
    : '#888';
  const label = isConn ? 'BLE · LIVE'
    : isWaiting ? (state === 'scanning' ? 'BLE · SCAN' : 'BLE · GATT')
    : isError ? 'BLE · ERR'
    : 'BLE · SIM';
  const sub = isConn ? deviceName
    : isWaiting ? 'Connecting…'
    : isError ? 'Tap to retry'
    : 'Tap to connect';
  return (
    <button
      onClick={onTap}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 12,
        padding: '9px 14px 9px 12px', borderRadius: 999,
        background: 'rgba(15,18,26,0.55)',
        backdropFilter: 'blur(18px) saturate(150%)',
        WebkitBackdropFilter: 'blur(18px) saturate(150%)',
        border: `0.5px solid ${isConn ? '#3CE08E55' : 'rgba(255,255,255,0.10)'}`,
        boxShadow: isConn
          ? '0 8px 28px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06), 0 0 22px #3CE08E33'
          : '0 8px 28px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)',
        color: 'rgba(235,240,250,0.92)', fontFamily: 'var(--font-mono)', fontSize: 11,
        letterSpacing: '0.08em', cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}>
      <Pulse color={dotColor} />
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15, textAlign: 'left' }}>
        <span style={{ fontSize: 9, opacity: 0.55, letterSpacing: '0.18em' }}>{label}</span>
        <span style={{ fontSize: 11.5, fontWeight: 500 }}>{sub}</span>
      </div>
      <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.08)' }} />
      <SignalBars rssi={rssi} color={dotColor} />
      <span style={{ fontSize: 10, opacity: 0.65, fontVariantNumeric: 'tabular-nums' }}>
        {isConn ? 'live' : `${rssi.toFixed(0)} dBm`}
      </span>
    </button>
  );
}

// ── Brand mark ────────────────────────────────────────────────
function Brand() {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, color: 'rgba(240,245,255,0.92)' }}>
      <span style={{
        fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 400,
        letterSpacing: '0.02em',
      }}>
        Memento
      </span>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 9, opacity: 0.5,
        letterSpacing: '0.25em', textTransform: 'uppercase',
      }}>// mōri</span>
    </div>
  );
}

// ── Top icon (gear) ───────────────────────────────────────────
function GearIcon({ size = 18, color = 'rgba(240,245,255,0.85)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.4">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>
    </svg>
  );
}

// ── Telemetry HUD ─────────────────────────────────────────────
function HUD({ telem, motionMode, paletteDot, onModeChange, onAmplifyDown, onAmplifyUp, amplifying }) {
  const intensity = telem?.intensity ?? 0;
  const rot = telem?.rotation ?? { x: 0, y: 0, z: 0 };
  return (
    <div style={{
      position: 'absolute', left: 14, right: 14, bottom: RAW_MODE ? 18 : 44,
      borderRadius: 22, overflow: 'hidden',
      background: 'rgba(10,12,18,0.62)',
      backdropFilter: 'blur(22px) saturate(160%)',
      WebkitBackdropFilter: 'blur(22px) saturate(160%)',
      border: '0.5px solid rgba(255,255,255,0.08)',
      boxShadow: '0 18px 50px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05)',
      color: 'rgba(235,240,250,0.94)',
      fontFamily: 'var(--font-mono)',
    }}>
      {/* Header strip */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '11px 14px 9px',
        borderBottom: '0.5px solid rgba(255,255,255,0.06)',
      }}>
        <span style={{ fontSize: 9, letterSpacing: '0.24em', opacity: 0.55 }}>
          MPU6050 · TELEMETRY
        </span>
        <span style={{ fontSize: 9, letterSpacing: '0.18em', opacity: 0.55 }}>
          100 Hz
        </span>
      </div>

      {/* Axis readout grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '14px 14px 12px', gap: 10 }}>
        {[['X', rot.x, '#FF6B6B'], ['Y', rot.y, '#7FDBFF'], ['Z', rot.z, '#B89BFF']].map(([axis, val, col]) => (
          <div key={axis} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 9, letterSpacing: '0.2em', opacity: 0.5 }}>{axis}-AXIS</span>
            <span style={{ fontSize: 22, fontWeight: 300, letterSpacing: '-0.01em' }}>
              <Digit v={val} />
            </span>
            <div style={{ position: 'relative', height: 2, background: 'rgba(255,255,255,0.07)', borderRadius: 2 }}>
              <div style={{
                position: 'absolute', left: '50%', top: 0, bottom: 0,
                width: Math.min(48, Math.abs(val) * 32) + '%',
                transform: val < 0 ? 'translateX(-100%)' : 'none',
                background: col, borderRadius: 2, boxShadow: `0 0 6px ${col}`,
                transition: 'width 80ms linear',
              }} />
              <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: 'rgba(255,255,255,0.18)' }} />
            </div>
          </div>
        ))}
      </div>

      {/* Intensity bar */}
      <div style={{ padding: '4px 14px 12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <span style={{ fontSize: 9, letterSpacing: '0.22em', opacity: 0.55 }}>INTENSITY</span>
          <span style={{ fontSize: 11, letterSpacing: '0.04em', fontVariantNumeric: 'tabular-nums', opacity: 0.85 }}>
            {(intensity * 100).toFixed(0).padStart(3, '0')}%
          </span>
        </div>
        <div style={{ position: 'relative', height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: (intensity * 100) + '%',
            background: `linear-gradient(90deg, ${paletteDot}AA, ${paletteDot})`,
            boxShadow: `0 0 12px ${paletteDot}`,
            transition: 'width 80ms linear',
          }} />
          {/* peak tick markers */}
          {[0.25, 0.5, 0.75].map(p => (
            <div key={p} style={{
              position: 'absolute', left: `${p*100}%`, top: 0, bottom: 0, width: 1,
              background: 'rgba(255,255,255,0.18)',
            }} />
          ))}
        </div>
      </div>

      {/* Bottom row: mode segmented + amplify */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px 12px', borderTop: '0.5px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{
          display: 'flex', flex: 1, background: 'rgba(255,255,255,0.04)',
          borderRadius: 10, padding: 3, gap: 2,
          border: '0.5px solid rgba(255,255,255,0.05)',
        }}>
          {MOTION_MODES.map(m => {
            const active = m.id === motionMode;
            return (
              <button key={m.id} onClick={() => onModeChange(m.id)} style={{
                flex: 1, padding: '6px 0', fontSize: 10, fontWeight: 500,
                letterSpacing: '0.1em', textTransform: 'uppercase',
                color: active ? '#0b0e15' : 'rgba(235,240,250,0.7)',
                background: active ? paletteDot : 'transparent',
                border: 'none', borderRadius: 8, cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
                boxShadow: active ? `0 0 16px ${paletteDot}55` : 'none',
                transition: 'all 180ms ease',
              }}>
                {m.label}
              </button>
            );
          })}
        </div>
        <button
          onPointerDown={onAmplifyDown}
          onPointerUp={onAmplifyUp}
          onPointerLeave={onAmplifyUp}
          style={{
            padding: '7px 14px', borderRadius: 10,
            background: amplifying ? paletteDot : 'rgba(255,255,255,0.05)',
            color: amplifying ? '#0b0e15' : 'rgba(235,240,250,0.9)',
            border: `0.5px solid ${amplifying ? paletteDot : 'rgba(255,255,255,0.12)'}`,
            fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
            fontFamily: 'var(--font-mono)', fontWeight: 600,
            cursor: 'pointer', transition: 'all 120ms ease',
            boxShadow: amplifying ? `0 0 22px ${paletteDot}80` : 'none',
            touchAction: 'none', userSelect: 'none',
          }}
        >
          {amplifying ? '⌁ Amplify' : 'Amplify'}
        </button>
      </div>
    </div>
  );
}

// ── Boot / connecting overlay ─────────────────────────────────
function BootOverlay({ phase, paletteDot }) {
  const [show, setShow] = useState(phase !== 'done');
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (phase === 'done') {
      setFading(true);
      const id = setTimeout(() => setShow(false), 700);
      return () => clearTimeout(id);
    } else {
      setShow(true); setFading(false);
    }
  }, [phase]);
  if (!show) return null;
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 30, display: 'flex',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(5,6,10,0.85)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      color: 'rgba(235,240,250,0.85)', fontFamily: 'var(--font-mono)',
      transition: 'opacity 600ms ease', opacity: fading ? 0 : 1,
      pointerEvents: fading ? 'none' : 'auto',
    }}>
      <div style={{
        fontFamily: 'var(--font-serif)', fontSize: 36, fontWeight: 400,
        marginBottom: 6, letterSpacing: '0.02em',
      }}>Memento</div>
      <div style={{ fontSize: 9, letterSpacing: '0.4em', opacity: 0.5, marginBottom: 56 }}>
        // MŌRI
      </div>
      <div style={{ position: 'relative', width: 36, height: 36, marginBottom: 18 }}>
        <div style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          border: `1.5px solid ${paletteDot}`, borderTopColor: 'transparent',
          animation: 'spin 1.1s linear infinite',
        }} />
        <div style={{
          position: 'absolute', inset: 8, borderRadius: '50%',
          background: paletteDot, opacity: 0.18, filter: `blur(6px)`,
        }} />
      </div>
      <div style={{ fontSize: 11, letterSpacing: '0.22em', textTransform: 'uppercase' }}>
        {phase === 'scan' && 'Scanning for ESP32-SKULL…'}
        {phase === 'pair' && 'Pairing · GATT handshake'}
        {phase === 'sync' && 'Synchronizing MPU6050'}
      </div>
    </div>
  );
}

// ── Tweak defaults ────────────────────────────────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette": "aether",
  "effect": "smoke",
  "particleAmount": 1.0,
  "bloomBase": 0.5,
  "autoSwayStrength": 0.6,
  "backgroundStyle": "void",
  "zoom": 1.0
}/*EDITMODE-END*/;

// ── Main app ──────────────────────────────────────────────────
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const palette = PALETTES[t.palette] || PALETTES.aether;

  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const [telem, setTelem] = useState({ rotation: { x: 0, y: 0, z: 0 }, intensity: 0, peak: 0 });
  const [phase, setPhase] = useState('scan');
  const [rssi, setRssi] = useState(-72);
  const [motionMode, setMotionMode] = useState('sim');
  const [amplifying, setAmplifying] = useState(false);
  const amplifyingRef = useRef(false);
  amplifyingRef.current = amplifying;
  const motionModeRef = useRef(motionMode);
  motionModeRef.current = motionMode;
  const swayStrengthRef = useRef(t.autoSwayStrength);
  swayStrengthRef.current = t.autoSwayStrength;

  // Touch drag state
  const touchState = useRef({ active: false, rx: 0, ry: 0, lx: 0, ly: 0 });

  // ── BLE (Web Bluetooth) ──
  const [bleState, setBleState] = useState('sim'); // sim | scanning | connecting | connected | error
  const [bleDevice, setBleDevice] = useState(null);
  const [bleError, setBleError] = useState(null);
  const bleCharRef = useRef(null);
  const bleDeviceRef = useRef(null);
  const bleDataRef = useRef({ x: 0, y: 0, z: 0, intensity: 0 });
  const bleConnectedRef = useRef(false);

  const onBleNotify = useCallback((e) => {
    const parsed = parseTelemetry(e.target.value);
    if (parsed) bleDataRef.current = parsed;
  }, []);

  const onBleDisconnect = useCallback(() => {
    bleConnectedRef.current = false;
    bleCharRef.current = null;
    bleDeviceRef.current = null;
    setBleDevice(null);
    setBleState(s => s === 'connected' ? 'sim' : s);
  }, []);

  const connectBLE = useCallback(async () => {
    setBleError(null);
    if (!navigator.bluetooth) {
      setBleError('Web Bluetooth no soportado. Usa Bluefy en iOS o Chrome en Android/Desktop.');
      setBleState('error');
      return;
    }
    try {
      setBleState('scanning');
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'ESP32-SKULL' }],
        optionalServices: [BLE_SERVICE_UUID],
      });
      bleDeviceRef.current = device;
      setBleDevice(device);
      device.addEventListener('gattserverdisconnected', onBleDisconnect);
      setBleState('connecting');
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(BLE_SERVICE_UUID);
      const telemChar = await service.getCharacteristic(BLE_CHAR_TELEM);
      await telemChar.startNotifications();
      telemChar.addEventListener('characteristicvaluechanged', onBleNotify);
      bleCharRef.current = telemChar;
      bleConnectedRef.current = true;
      setBleState('connected');
    } catch (err) {
      console.warn('BLE connect failed:', err);
      setBleError(err.message || String(err));
      setBleState('error');
      bleConnectedRef.current = false;
    }
  }, [onBleNotify, onBleDisconnect]);

  const disconnectBLE = useCallback(() => {
    try { bleCharRef.current?.stopNotifications?.(); } catch {}
    try { bleDeviceRef.current?.gatt?.disconnect?.(); } catch {}
    bleConnectedRef.current = false;
    bleCharRef.current = null;
    bleDeviceRef.current = null;
    setBleDevice(null);
    setBleState('sim');
  }, []);

  const onBlePillTap = useCallback(() => {
    if (bleState === 'connected') disconnectBLE();
    else if (bleState === 'scanning' || bleState === 'connecting') {} // ignore
    else connectBLE();
  }, [bleState, connectBLE, disconnectBLE]);


  // ── Initialize engine when ready ──
  useEffect(() => {
    let cancelled = false;
    const start = () => {
      if (cancelled || !canvasRef.current) return;
      const eng = new window.SkullEngine(canvasRef.current);
      engineRef.current = eng;
      eng.onTelemetry = (data) => {
        // throttle React updates
        setTelem(data);
      };
      eng.onReady = () => {
        setPhase('pair');
        setTimeout(() => setPhase('sync'), 700);
        setTimeout(() => setPhase('done'), 1500);
      };
      // Apply initial tweaks
      eng.setColors(palette.a, palette.b);
      eng.setEffect(t.effect);
      eng.setParticleMultiplier(t.particleAmount);
      eng.setBloomStrength(t.bloomBase);
      eng.setZoom?.(t.zoom);
    };
    if (window.SkullEngine) start();
    else window.addEventListener('skull-engine-ready', start, { once: true });
    // expose for debugging
    window.__engineRef = engineRef;
    return () => { cancelled = true; engineRef.current?.dispose?.(); };
  }, []);

  // ── React tweak changes → engine ──
  useEffect(() => {
    const eng = engineRef.current; if (!eng) return;
    eng.setColors(palette.a, palette.b);
  }, [t.palette]);
  useEffect(() => {
    const eng = engineRef.current; if (!eng) return;
    eng.setEffect(t.effect);
  }, [t.effect]);
  useEffect(() => {
    const eng = engineRef.current; if (!eng) return;
    eng.setParticleMultiplier(t.particleAmount * (amplifying ? 2.0 : 1.0));
  }, [t.particleAmount, amplifying]);
  useEffect(() => {
    const eng = engineRef.current; if (!eng) return;
    eng.setBloomStrength(t.bloomBase);
  }, [t.bloomBase]);
  useEffect(() => {
    const eng = engineRef.current; if (!eng) return;
    eng.setZoom?.(t.zoom);
  }, [t.zoom]);

  // ── Motion source: drive engine.setRotation each frame ──
  useEffect(() => {
    let raf;
    let last = performance.now();
    let simT = Math.random() * 100;
    let gyroX = 0, gyroY = 0, gyroZ = 0;

    const onOrient = (e) => {
      // beta: front-back tilt, gamma: left-right, alpha: compass
      gyroX = ((e.beta  || 0) / 180) * Math.PI * 0.55;
      gyroY = ((e.gamma || 0) / 180) * Math.PI * 0.9;
      gyroZ = (((e.alpha || 0) - 180) / 360) * Math.PI * 0.4;
    };

    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const eng = engineRef.current;
      if (eng) {
        const amp = amplifyingRef.current ? 1.8 : 1.0;
        if (motionModeRef.current === 'sim') {
          if (bleConnectedRef.current) {
            // Real telemetry from ESP32 — feed rotation directly.
            const d = bleDataRef.current;
            eng.setRotation(d.x * amp, d.y * amp, d.z * amp);
          } else {
            simT += dt;
            const s = swayStrengthRef.current * amp;
            // Simulated MPU6050 stream — gentle drift on each axis with occasional gusts
            const gust = Math.max(0, Math.sin(simT * 0.35) - 0.6) * 2.5;
            const x = Math.sin(simT * 0.7) * 0.35 * s + Math.sin(simT * 1.9 + 1.3) * 0.12 * s;
            const y = Math.sin(simT * 0.9 + 1.1) * 0.55 * s + Math.cos(simT * 0.4) * 0.1 * s + gust * 0.35;
            const z = Math.sin(simT * 0.55 + 2.1) * 0.18 * s;
            eng.setRotation(x, y, z);
          }
        } else if (motionModeRef.current === 'gyro') {
          eng.setRotation(gyroX * amp, gyroY * amp, gyroZ * amp);
        } else {
          // touch drag — apply gentle return-to-center spring when not active
          const tt = touchState.current;
          if (!tt.active) {
            tt.rx *= 1 - dt * 1.2;
            tt.ry *= 1 - dt * 1.2;
          }
          eng.setRotation(tt.rx * amp, tt.ry * amp, 0);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    if (motionMode === 'gyro') {
      const req = window.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission;
      if (typeof req === 'function') {
        req().then(state => { if (state === 'granted') window.addEventListener('deviceorientation', onOrient); })
            .catch(() => {});
      } else {
        window.addEventListener('deviceorientation', onOrient);
      }
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('deviceorientation', onOrient);
    };
  }, [motionMode]);

  // ── Touch drag + pinch-to-zoom on the canvas ──
  // Tracks active pointers in a map. 1 pointer + 'touch' mode → rotate.
  // 2 pointers (any mode) → pinch-zoom; suppresses rotation while pinching.
  const pointersRef = useRef(new Map());
  const pinchRef = useRef({ baseDist: 0, baseZoom: 1, current: 1 });
  const [zoomHud, setZoomHud] = useState(0); // 0 = hidden, else timestamp
  const zoomHudTimerRef = useRef(null);
  const liveZoomRef = useRef(t.zoom);
  liveZoomRef.current = t.zoom;

  const showZoomHud = useCallback((z) => {
    pinchRef.current.current = z;
    setZoomHud(Date.now());
    clearTimeout(zoomHudTimerRef.current);
    zoomHudTimerRef.current = setTimeout(() => setZoomHud(0), 900);
  }, []);

  const onCanvasPointerDown = useCallback((e) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current.baseDist = Math.hypot(b.x - a.x, b.y - a.y);
      pinchRef.current.baseZoom = liveZoomRef.current;
      // Cancel any in-progress rotation drag
      touchState.current.active = false;
    } else if (motionModeRef.current === 'touch') {
      const tt = touchState.current;
      tt.active = true; tt.lx = e.clientX; tt.ly = e.clientY;
    }
  }, []);

  const onCanvasPointerMove = useCallback((e) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size >= 2 && pinchRef.current.baseDist > 0) {
      const pts = [...pointersRef.current.values()];
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const factor = dist / pinchRef.current.baseDist;
      const z = Math.max(0.5, Math.min(2.2, pinchRef.current.baseZoom * factor));
      const eng = engineRef.current;
      if (eng) eng.setZoom?.(z);
      liveZoomRef.current = z;
      showZoomHud(z);
      return;
    }
    const tt = touchState.current;
    if (!tt.active) return;
    const dx = (e.clientX - tt.lx) / 100;
    const dy = (e.clientY - tt.ly) / 100;
    tt.ry += dx; tt.rx += dy;
    tt.lx = e.clientX; tt.ly = e.clientY;
  }, [showZoomHud]);

  const onCanvasPointerUp = useCallback((e) => {
    const hadPinch = pointersRef.current.size >= 2;
    pointersRef.current.delete(e.pointerId);
    const tt = touchState.current; tt.active = false;
    if (hadPinch && pointersRef.current.size < 2) {
      pinchRef.current.baseDist = 0;
      // Persist the final zoom into the tweak so it survives reload
      const z = Math.round(liveZoomRef.current * 100) / 100;
      if (z !== t.zoom) setTweak('zoom', z);
    }
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  }, [t.zoom, setTweak]);

  // ── Fake RSSI fluctuation ──
  useEffect(() => {
    let id = setInterval(() => {
      setRssi(r => {
        const drift = (Math.random() - 0.5) * 5;
        return Math.max(-86, Math.min(-40, r + drift));
      });
    }, 900);
    return () => clearInterval(id);
  }, []);

  // ── Amplify pulse: temporarily boost rotation envelope and particles ──
  const onAmplifyDown = useCallback(() => setAmplifying(true), []);
  const onAmplifyUp = useCallback(() => setAmplifying(false), []);

  // ── Background style ──
  const bg = useMemo(() => {
    if (t.backgroundStyle === 'nebula') {
      return `radial-gradient(120% 80% at 40% 30%, ${palette.a}18 0%, transparent 55%),
              radial-gradient(80% 90% at 70% 80%, ${palette.b}18 0%, transparent 60%),
              radial-gradient(160% 100% at 50% 110%, #1a0f29 0%, #06070b 70%)`;
    }
    if (t.backgroundStyle === 'grid') {
      return `linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px) 0 0/24px 24px,
              linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px) 0 0/24px 24px,
              radial-gradient(120% 100% at 50% 30%, #0c111c 0%, #04050a 70%)`;
    }
    // void
    return `radial-gradient(120% 90% at 50% 20%, #0b0e18 0%, #04050a 70%)`;
  }, [t.backgroundStyle, palette.a, palette.b]);

  // intensity-driven vignette accent over the iPhone screen
  const accentGlow = telem.intensity > 0.25;

  const screen = (
        <div style={{
          position: 'absolute', inset: 0, background: bg, overflow: 'hidden',
        }}>
            {/* 3D canvas */}
            <canvas
              ref={canvasRef}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%',
                touchAction: 'none',
              }}
            />

            {/* faint scanlines for that ritual-screen feel */}
            <div style={{
              position: 'absolute', inset: 0, pointerEvents: 'none',
              backgroundImage: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 3px)',
              mixBlendMode: 'overlay', opacity: 0.6,
            }} />

            {/* intensity flash ring around the screen edge */}
            <div style={{
              position: 'absolute', inset: 0, pointerEvents: 'none',
              boxShadow: `inset 0 0 ${30 + telem.intensity * 60}px ${palette.dot}${accentGlow ? '55' : '22'}`,
              transition: 'box-shadow 120ms ease',
            }} />

            {/* Top brand row */}
            <div style={{
              position: 'absolute', top: RAW_MODE ? 18 : 64, left: 18, right: 18,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              zIndex: 12,
            }}>
              <Brand />
              <button style={{
                width: 32, height: 32, borderRadius: 16,
                background: 'rgba(15,18,26,0.55)',
                border: '0.5px solid rgba(255,255,255,0.08)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
                cursor: 'pointer',
              }}>
                <GearIcon size={15} />
              </button>
            </div>

            {/* BLE pill */}
            <div style={{
              position: 'absolute', top: RAW_MODE ? 60 : 112, left: 0, right: 0,
              display: 'flex', justifyContent: 'center', zIndex: 12,
            }}>
              <BLEPill
                state={bleState}
                paletteDot={palette.dot}
                rssi={rssi}
                deviceName={bleDevice?.name || 'ESP32-SKULL'}
                onTap={onBlePillTap}
              />
            </div>

            {/* palette label, small */}
            <div style={{
              position: 'absolute', top: RAW_MODE ? 108 : 162, left: 0, right: 0,
              textAlign: 'center', zIndex: 12,
              fontFamily: 'var(--font-mono)', fontSize: 9,
              letterSpacing: '0.32em', textTransform: 'uppercase',
              color: 'rgba(235,240,250,0.42)',
            }}>
              · {palette.label} ·
            </div>

            {/* HUD */}
            <HUD
              telem={telem}
              motionMode={motionMode}
              paletteDot={palette.dot}
              onModeChange={setMotionMode}
              onAmplifyDown={onAmplifyDown}
              onAmplifyUp={onAmplifyUp}
              amplifying={amplifying}
            />

            {/* Boot overlay */}
            <BootOverlay phase={phase} paletteDot={palette.dot} />

            {/* Pinch-zoom indicator */}
            {zoomHud > 0 && (
              <div style={{
                position: 'absolute', top: '50%', left: '50%',
                transform: 'translate(-50%, -50%)',
                padding: '10px 18px', borderRadius: 14,
                background: 'rgba(10,12,18,0.78)',
                border: '0.5px solid rgba(255,255,255,0.1)',
                backdropFilter: 'blur(14px)',
                WebkitBackdropFilter: 'blur(14px)',
                color: palette.dot,
                fontFamily: 'var(--font-mono)',
                fontSize: 16, letterSpacing: '0.08em',
                boxShadow: `0 0 24px ${palette.dot}55`,
                pointerEvents: 'none', zIndex: 25,
                fontVariantNumeric: 'tabular-nums',
              }}>
                ZOOM · {pinchRef.current.current.toFixed(2)}×
              </div>
            )}
        </div>
  );

  return (
    <div>
      {RAW_MODE ? (
        <div style={{
          position: 'fixed',
          top: 'env(safe-area-inset-top)',
          bottom: 'env(safe-area-inset-bottom)',
          left: 'env(safe-area-inset-left)',
          right: 'env(safe-area-inset-right)',
          background: '#04050a',
          overflow: 'hidden',
        }}>
          {screen}
        </div>
      ) : (
        <>
          <PageBackground />
          <div style={{
            position: 'fixed', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <PhoneScaler width={402} height={874}>
              <IOSDevice width={402} height={874} dark={true}>
                {screen}
              </IOSDevice>
            </PhoneScaler>
          </div>
        </>
      )}

      {/* Tweaks panel */}
      <TweaksPanel title="Tweaks">
        <TweakSection label="Palette" />
        <TweakRadio
          label="Vibe"
          value={t.palette}
          options={Object.keys(PALETTES)}
          onChange={v => setTweak('palette', v)}
        />
        <TweakSection label="Particles" />
        <TweakRadio
          label="Effect"
          value={t.effect}
          options={EFFECTS.map(e => e.id)}
          onChange={v => setTweak('effect', v)}
        />
        <TweakSlider label="Density" value={t.particleAmount} min={0.2} max={2.0} step={0.05}
                     onChange={v => setTweak('particleAmount', v)} />
        <TweakSlider label="Bloom" value={t.bloomBase} min={0.2} max={1.6} step={0.05}
                     onChange={v => setTweak('bloomBase', v)} />
        <TweakSlider label="Zoom" value={t.zoom} min={0.5} max={2.2} step={0.05}
                     onChange={v => setTweak('zoom', v)} />
        <TweakSection label="Motion" />
        <TweakSlider label="Sway power" value={t.autoSwayStrength} min={0.0} max={1.5} step={0.05}
                     onChange={v => setTweak('autoSwayStrength', v)} />
        <TweakSection label="Stage" />
        <TweakRadio
          label="Background"
          value={t.backgroundStyle}
          options={['void', 'nebula', 'grid']}
          onChange={v => setTweak('backgroundStyle', v)}
        />
      </TweaksPanel>
    </div>
  );
}

// ── Outer page background (behind iPhone) ─────────────────────
function PhoneScaler({ children, width, height }) {
  const ref = useRef(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const compute = () => {
      const padX = 80, padY = 60;
      const sx = (window.innerWidth - padX) / width;
      const sy = (window.innerHeight - padY) / height;
      setScale(Math.min(1.05, Math.max(0.4, Math.min(sx, sy))));
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [width, height]);
  return (
    <div ref={ref} style={{
      width, height,
      transform: `scale(${scale})`,
      transformOrigin: 'center center',
    }}>
      {children}
    </div>
  );
}

function PageBackground() {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: -1,
      background: `
        radial-gradient(60% 50% at 20% 10%, rgba(60,40,120,0.18) 0%, transparent 60%),
        radial-gradient(50% 50% at 90% 90%, rgba(180,60,90,0.12) 0%, transparent 60%),
        radial-gradient(120% 100% at 50% 50%, #0a0b12 0%, #04040a 70%)
      `,
    }}>
      {/* faint noise */}
      <div style={{
        position: 'absolute', inset: 0, opacity: 0.35, mixBlendMode: 'overlay',
        backgroundImage:
          'radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px)',
        backgroundSize: '3px 3px',
      }} />
      {/* corner labels for that ritual-lab vibe */}
      <div style={{
        position: 'absolute', top: 22, left: 26, color: 'rgba(220,225,240,0.42)',
        fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.3em',
      }}>
        MEMENTO · R&amp;D · 02.16
      </div>
      <div style={{
        position: 'absolute', top: 22, right: 26, color: 'rgba(220,225,240,0.42)',
        fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.3em',
      }}>
        ESP32 / MPU6050 · BLE 5.2
      </div>
      <div style={{
        position: 'absolute', bottom: 22, left: 26, color: 'rgba(220,225,240,0.32)',
        fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.28em',
      }}>
        CRT-IFY DEMO · iOS PROTOTYPE
      </div>
      <div style={{
        position: 'absolute', bottom: 22, right: 26, color: 'rgba(220,225,240,0.32)',
        fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.28em',
      }}>
        100 Hz · 6-DoF
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
