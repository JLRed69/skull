# Memento · ESP32 Skull Prototype

Prototipo interactivo del cráneo (Three.js + React).

## Probar online

Abrir: `https://<TU_USUARIO>.github.io/<NOMBRE_DEL_REPO>/`

## Archivos

- `index.html` — entrada principal (lo que sirve GitHub Pages)
- `skull-app.jsx` — UI React
- `skull-engine.js` — motor 3D (Three.js)
- `ios-frame.jsx` — marco iPhone
- `tweaks-panel.jsx` — panel de tweaks
- `assets/skull.glb` — modelo 3D

## Local

Como usa módulos ES (`<script type="module">`) hay que servirlo por HTTP, no abrir el `.html` directo:

```bash
npx serve .
# o
python3 -m http.server 8000
```
