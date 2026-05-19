// skull-engine.js — Three.js scene for the Memento BLE prototype.
// Exposes window.SkullEngine and dispatches `skull-engine-ready` when loaded.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ─── A reactive vignette + chromatic-aberration final pass ───
const ReactiveShader = {
  uniforms: {
    tDiffuse: { value: null },
    uIntensity: { value: 0 },
    uTime: { value: 0 },
    uVignette: { value: 1.1 },
    uTintA: { value: new THREE.Color(0x7fd9ff) },
    uTintB: { value: new THREE.Color(0xff5090) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uIntensity;
    uniform float uTime;
    uniform float uVignette;
    uniform vec3 uTintA;
    uniform vec3 uTintB;
    varying vec2 vUv;

    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r = length(c);
      // Chromatic aberration scales with intensity
      float ca = (0.0025 + uIntensity * 0.012) * r;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ca).b;

      // Subtle reactive tint shift
      vec3 reactive = mix(uTintA, uTintB, uIntensity);
      col = mix(col, col * (0.92 + reactive * 0.12), 0.35);

      // Soft vignette: bright in the centre, darkening to ~0.55 at the corners.
      float v = 1.0 - smoothstep(0.25, uVignette, r);
      col *= mix(0.55, 1.0, v);

      // Faint film grain
      float n = fract(sin(dot(uv * 1024.0 + uTime * 60.0, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * 0.025;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

class SkullEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.rotation = { x: 0, y: 0, z: 0 };
    this.targetRotation = { x: 0, y: 0, z: 0 };
    this.intensity = 0;
    this.smoothedIntensity = 0;
    this.peakIntensity = 0;
    this.onTelemetry = null;
    this.effect = 'smoke'; // smoke | embers | mist | streaks
    this.particleMultiplier = 1.0;
    this._loaded = false;
    this._init();
  }

  _init() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, alpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.setClearColor(0x000000, 0);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05060a, 0.025);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 80);
    camera.position.set(0, 0, 8.5);
    this.camera = camera;

    // ── Lighting: cold key + warm rim + low fill ──
    const key = new THREE.PointLight(0xc8eaff, 25, 22, 0.9);
    key.position.set(-2.5, 2.5, 4.5); scene.add(key);
    const rim = new THREE.PointLight(0xff7090, 18, 18, 1.0);
    rim.position.set(3.2, -0.8, 2.0); scene.add(rim);
    const top = new THREE.PointLight(0xcce4ff, 12, 18, 0.9);
    top.position.set(0, 4.2, 1.5); scene.add(top);
    const front = new THREE.PointLight(0xfff0e0, 8, 14, 0.9);
    front.position.set(0, 0, 6.2); scene.add(front);
    const back = new THREE.DirectionalLight(0x6080c0, 0.6);
    back.position.set(0.5, -1, -4); scene.add(back);
    const fill = new THREE.HemisphereLight(0x6878a8, 0x1a1a24, 0.7);
    scene.add(fill);
    this.keyLight = key; this.rimLight = rim; this.topLight = top; this.frontLight = front;

    // ── Volumetric backdrop (stars + haze) ──
    this._setupBackdrop();

    // ── Skull group ──
    this.skullGroup = new THREE.Group();
    scene.add(this.skullGroup);

    // ── Particles ──
    this._setupParticles();

    // ── Glow halo plane behind the skull ──
    this._setupHalo();

    // ── Post processing ──
    // Explicit RGBA-byte render target so the composer doesn't auto-pick HalfFloat
    // (some browsers / GL drivers won't render to the half-float target correctly here).
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      samples: 0,
    });
    const composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.6, 0.35);
    composer.addPass(bloom);
    this.bloom = bloom;
    const reactive = new ShaderPass(ReactiveShader);
    composer.addPass(reactive);
    this.reactivePass = reactive;
    this.composer = composer;

    // ── Load skull ──
    const loader = new GLTFLoader();
    loader.load('assets/skull.glb', (gltf) => {
      try {
        const skull = gltf.scene;
        // Compute pre-scale bbox & scale first
        const preBox = new THREE.Box3().setFromObject(skull);
        const preSize = preBox.getSize(new THREE.Vector3());
        const targetSize = 2.0;
        const maxDim = Math.max(preSize.x, preSize.y, preSize.z);
        const k = targetSize / maxDim;
        skull.scale.setScalar(k);
        // Now recompute the post-scale bbox and re-center skull around origin
        const postBox = new THREE.Box3().setFromObject(skull);
        const postCenter = postBox.getCenter(new THREE.Vector3());
        skull.position.sub(postCenter);
        // Base orientation — tip the skull so the face looks straight at the camera by default.
        skull.rotation.x = 0;
        skull.rotation.y = -Math.PI / 2;
        // Manual offset to optically center the face in the iPhone viewport
        skull.position.x -= 0.18;
        skull.position.y += 0.35;
        skull.traverse((o) => {
          if (o.isMesh && o.material) {
            const oldMat = o.material;
            // Build a fresh StandardMaterial — avoids any "uniform missing" mismatch.
            const m = new THREE.MeshStandardMaterial({
              map: oldMat.map || null,
              normalMap: oldMat.normalMap || null,
              color: new THREE.Color(0xeadcc2),
              roughness: 0.42,
              metalness: 0.05,
              emissive: new THREE.Color(0x2a3450),
              emissiveIntensity: 0.5,
              envMapIntensity: 1.4,
              side: THREE.DoubleSide,
              flatShading: false,
            });
            // Recompute normals if missing; ensure correct sRGB on baked texture
            if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
            if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
            o.material = m;
            o.castShadow = false;
            o.receiveShadow = false;
          }
        });
        this.skullGroup.add(skull);
        this.skull = skull;
        this._setupEmissionPoints();
        this._loaded = true;
        if (this.onReady) this.onReady();
      } catch (err) {
        console.error('skull setup failed:', err);
      }
    }, undefined, (err) => {
      console.error('skull load failed:', err);
      // Fallback: show a placeholder sphere so the rest of the scene is usable
      const placeholder = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1.4, 1),
        new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.5, metalness: 0.2, emissive: 0x0a1018 })
      );
      this.skullGroup.add(placeholder);
      this.skull = placeholder;
      this._setupEmissionPoints();
      this._loaded = true;
      if (this.onReady) this.onReady();
    });

    this.clock = new THREE.Clock();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.canvas);
    this.resize();
  }

  _setupBackdrop() {
    // Star points far in the background
    const N = 360;
    const positions = new Float32Array(N * 3);
    const sizes = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const r = 18 + Math.random() * 14;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta) - 6;
      sizes[i] = 1 + Math.random() * 3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute float aSize;
        varying float vSize;
        void main(){
          vSize = aSize;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * 80.0 / (-mv.z);
        }
      `,
      fragmentShader: `
        varying float vSize;
        uniform float uTime;
        void main(){
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.0, d);
          float twk = 0.6 + 0.4 * sin(uTime * 2.0 + vSize * 7.0);
          gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * twk, a * 0.6);
        }
      `,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    this.stars = { pts, mat };
  }

  _setupHalo() {
    const haloMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uColorA: { value: new THREE.Color(0x7fd9ff) },
        uColorB: { value: new THREE.Color(0xff5090) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform float uTime;
        uniform float uIntensity;
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        void main(){
          vec2 c = vUv - 0.5;
          float r = length(c);
          float ring = exp(-pow((r - 0.18 - uIntensity * 0.05) * 12.0, 2.0));
          float core = exp(-pow(r * 5.0, 2.0));
          float swirl = 0.5 + 0.5 * sin(atan(c.y, c.x) * 5.0 + uTime * 0.6);
          vec3 col = mix(uColorA, uColorB, uIntensity);
          float a = (core * 0.25 + ring * 0.55 * (0.6 + swirl * 0.4)) * (0.45 + uIntensity * 0.55);
          gl_FragColor = vec4(col, a);
        }
      `,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), haloMat);
    halo.position.set(0, 0, -1.6);
    this.scene.add(halo);
    this.halo = halo;
    this.haloMat = haloMat;
  }

  _setupEmissionPoints() {
    // Approximate local-space emission points around the skull.
    this.emissionPoints = [
      { p: new THREE.Vector3( 0.0,  1.35,  0.1), w: 1.4 }, // crown
      { p: new THREE.Vector3(-0.45, 0.35,  0.85), w: 1.1 }, // left eye
      { p: new THREE.Vector3( 0.45, 0.35,  0.85), w: 1.1 }, // right eye
      { p: new THREE.Vector3( 0.0, -0.55,  0.75), w: 0.9 }, // mouth
      { p: new THREE.Vector3(-1.05, 0.45,  0.0), w: 0.8 }, // left temple
      { p: new THREE.Vector3( 1.05, 0.45,  0.0), w: 0.8 }, // right temple
      { p: new THREE.Vector3( 0.0,  0.10, -1.1), w: 0.6 }, // back
    ];
  }

  _setupParticles() {
    const N = 1400;
    const positions = new Float32Array(N * 3);
    const velocities = new Float32Array(N * 3);
    const lifetimes = new Float32Array(N * 2); // [age, max]
    const seeds = new Float32Array(N);
    const aLife = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      lifetimes[i*2] = 9999;
      lifetimes[i*2+1] = 1;
      seeds[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
    geo.setAttribute('aLife', new THREE.BufferAttribute(aLife, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColorA: { value: new THREE.Color(0x7fd9ff) },
        uColorB: { value: new THREE.Color(0xff6090) },
        uSize: { value: 55.0 },
        uIntensity: { value: 0 },
        uEffect: { value: 0 }, // 0 smoke, 1 embers, 2 mist, 3 streaks
        uDPR: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexShader: `
        attribute float seed;
        attribute float aLife;
        varying float vLife;
        varying float vSeed;
        uniform float uSize;
        uniform float uIntensity;
        uniform float uEffect;
        uniform float uDPR;
        void main() {
          vLife = aLife;
          vSeed = seed;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float life = clamp(aLife, 0.0, 1.0);
          float curve = sin(life * 3.14159);
          float effectSize = mix(1.0, 0.55, step(0.5, uEffect) * step(uEffect, 1.5)); // embers smaller
          effectSize = mix(effectSize, 1.7, step(1.5, uEffect) * step(uEffect, 2.5));  // mist bigger
          effectSize = mix(effectSize, 0.6, step(2.5, uEffect));                       // streaks small
          gl_PointSize = (uSize + uIntensity * 50.0) * curve * (0.5 + seed * 0.8) * effectSize * uDPR / (-mv.z + 0.1);
        }
      `,
      fragmentShader: `
        precision highp float;
        varying float vLife;
        varying float vSeed;
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        uniform float uIntensity;
        uniform float uEffect;
        uniform float uTime;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float life = clamp(vLife, 0.0, 1.0);
          float lifeFade = sin(life * 3.14159);

          float a;
          vec3 col;
          if (uEffect < 0.5) {
            // smoke: soft puff
            a = smoothstep(0.5, 0.05, d);
            float core = smoothstep(0.35, 0.0, d);
            col = mix(uColorA, uColorB, vSeed * 0.4 + uIntensity * 0.5);
            col += core * 0.7;
          } else if (uEffect < 1.5) {
            // embers: tight hot core, more orange
            float core = smoothstep(0.28, 0.0, d);
            a = core + smoothstep(0.5, 0.2, d) * 0.4;
            vec3 hot = mix(uColorA, uColorB * 1.4, 0.7 + 0.3 * vSeed);
            col = hot + core * 1.2;
          } else if (uEffect < 2.5) {
            // mist: very soft halo
            a = smoothstep(0.5, 0.0, d) * 0.5;
            col = mix(uColorA, uColorB, vSeed);
            col *= 0.6;
          } else {
            // streaks: tighter dots that smear via point shape
            float core = smoothstep(0.22, 0.0, d);
            a = core + smoothstep(0.5, 0.3, d) * 0.25;
            col = mix(uColorA, uColorB, vSeed * 0.5 + uIntensity * 0.7);
            col += core * 0.9;
          }
          gl_FragColor = vec4(col, a * lifeFade * 0.6);
        }
      `,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.scene.add(points);

    this.particles = {
      points, geo, mat, N,
      positions, velocities, lifetimes, seeds, aLife,
      spawnAcc: 0,
    };
  }

  _spawnParticle(i) {
    const p = this.particles;
    if (!this.emissionPoints) return;
    // Weighted random emission point
    let totalW = 0;
    for (const e of this.emissionPoints) totalW += e.w;
    let r = Math.random() * totalW;
    let ep = this.emissionPoints[0];
    for (const e of this.emissionPoints) {
      r -= e.w;
      if (r <= 0) { ep = e; break; }
    }
    const local = ep.p.clone();
    const wp = local.clone();
    this.skullGroup.localToWorld(wp);
    const jit = this.effect === 'mist' ? 0.25 : 0.12;
    p.positions[i*3]   = wp.x + (Math.random()-0.5) * jit;
    p.positions[i*3+1] = wp.y + (Math.random()-0.5) * jit;
    p.positions[i*3+2] = wp.z + (Math.random()-0.5) * jit;

    // outward direction roughly from skull center to emission point
    const dir = local.clone().normalize();
    let speed, upBias, life;
    if (this.effect === 'embers') {
      speed = 0.7 + Math.random() * 0.9;
      upBias = 0.55;
      life = 1.6 + Math.random() * 1.8;
    } else if (this.effect === 'mist') {
      speed = 0.18 + Math.random() * 0.25;
      upBias = 0.08;
      life = 4.5 + Math.random() * 3.0;
    } else if (this.effect === 'streaks') {
      speed = 1.6 + Math.random() * 2.0;
      upBias = 0.15;
      life = 0.9 + Math.random() * 0.6;
    } else { // smoke
      speed = 0.35 + Math.random() * 0.5;
      upBias = 0.25;
      life = 2.8 + Math.random() * 2.5;
    }
    p.velocities[i*3]   = dir.x * speed + (Math.random()-0.5) * 0.25;
    p.velocities[i*3+1] = dir.y * speed + upBias + (Math.random()-0.2) * 0.2;
    p.velocities[i*3+2] = dir.z * speed + (Math.random()-0.5) * 0.25;
    p.lifetimes[i*2] = 0;
    p.lifetimes[i*2+1] = life;
  }

  setRotation(x, y, z) {
    this.targetRotation.x = x;
    this.targetRotation.y = y;
    this.targetRotation.z = z;
  }
  setEffect(name) {
    this.effect = name;
    const map = { smoke: 0, embers: 1, mist: 2, streaks: 3 };
    this.particles.mat.uniforms.uEffect.value = map[name] ?? 0;
  }
  setColors(a, b) {
    this.particles.mat.uniforms.uColorA.value.set(a);
    this.particles.mat.uniforms.uColorB.value.set(b);
    this.haloMat.uniforms.uColorA.value.set(a);
    this.haloMat.uniforms.uColorB.value.set(b);
    this.reactivePass.uniforms.uTintA.value.set(a);
    this.reactivePass.uniforms.uTintB.value.set(b);
    // also tilt the lights toward the palette
    this.keyLight.color.set(a);
    this.rimLight.color.set(b);
  }
  setBloomStrength(s) { this._bloomBase = s; }
  setParticleMultiplier(m) { this.particleMultiplier = m; }
  setZoom(z) {
    // z = 1.0 default. Higher = closer (bigger skull).
    const base = 8.5;
    this.camera.position.z = base / Math.max(0.3, z);
    this.camera.updateProjectionMatrix();
  }

  _loop() {
    requestAnimationFrame(this._loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    // Smooth rotation
    const k = 1 - Math.pow(0.0015, dt);
    const prev = { x: this.rotation.x, y: this.rotation.y, z: this.rotation.z };
    this.rotation.x += (this.targetRotation.x - this.rotation.x) * k;
    this.rotation.y += (this.targetRotation.y - this.rotation.y) * k;
    this.rotation.z += (this.targetRotation.z - this.rotation.z) * k;

    const dx = (this.rotation.x - prev.x) / Math.max(dt, 0.001);
    const dy = (this.rotation.y - prev.y) / Math.max(dt, 0.001);
    const dz = (this.rotation.z - prev.z) / Math.max(dt, 0.001);
    const angVel = Math.sqrt(dx*dx + dy*dy + dz*dz);
    const offset = Math.sqrt(this.rotation.x**2 + this.rotation.y**2 + this.rotation.z**2);
    this.intensity = Math.min(1, angVel * 0.25 + offset * 0.55);
    this.smoothedIntensity += (this.intensity - this.smoothedIntensity) * 0.12;
    this.peakIntensity = Math.max(this.peakIntensity * 0.97, this.smoothedIntensity);

    if (this.skullGroup) {
      this.skullGroup.rotation.x = this.rotation.x;
      this.skullGroup.rotation.y = this.rotation.y;
      this.skullGroup.rotation.z = this.rotation.z;
      // slight breathing scale on intensity
      const s = 1 + Math.sin(t * 1.4) * 0.005 + this.smoothedIntensity * 0.03;
      this.skullGroup.scale.setScalar(s);
    }

    // Particles
    const p = this.particles;
    const baseRate = this.effect === 'mist' ? 80 : this.effect === 'streaks' ? 320 : 220;
    const burst = this.smoothedIntensity * (this.effect === 'streaks' ? 900 : 700);
    const rate = (baseRate + burst) * this.particleMultiplier;
    p.spawnAcc += rate * dt;
    let toSpawn = Math.floor(p.spawnAcc);
    p.spawnAcc -= toSpawn;

    const pushScale = 1 + this.smoothedIntensity * 2.4;
    const drag = this.effect === 'streaks' ? 0.2 : 0.4;
    for (let i = 0; i < p.N; i++) {
      p.lifetimes[i*2] += dt;
      const age = p.lifetimes[i*2];
      const max = p.lifetimes[i*2+1];
      if (age < max) {
        const slow = 1 - dt * drag;
        p.velocities[i*3]   *= slow;
        p.velocities[i*3+1] *= slow;
        p.velocities[i*3+2] *= slow;
        p.positions[i*3]   += p.velocities[i*3]   * dt * pushScale;
        p.positions[i*3+1] += p.velocities[i*3+1] * dt * pushScale;
        p.positions[i*3+2] += p.velocities[i*3+2] * dt * pushScale;
        p.aLife[i] = age / max;
      } else if (toSpawn > 0) {
        this._spawnParticle(i);
        p.aLife[i] = 0;
        toSpawn--;
      }
    }
    p.geo.attributes.position.needsUpdate = true;
    p.geo.attributes.aLife.needsUpdate = true;
    p.mat.uniforms.uTime.value = t;
    p.mat.uniforms.uIntensity.value = this.smoothedIntensity;

    // Halo
    this.haloMat.uniforms.uTime.value = t;
    this.haloMat.uniforms.uIntensity.value = this.smoothedIntensity;

    // Bloom + reactive
    this.bloom.strength = (this._bloomBase ?? 0.5) + this.smoothedIntensity * 0.5;
    this.reactivePass.uniforms.uIntensity.value = this.smoothedIntensity;
    this.reactivePass.uniforms.uTime.value = t;

    // Lights breathe with intensity
    this.keyLight.intensity = 25 + this.smoothedIntensity * 22;
    this.rimLight.intensity = 18 + this.smoothedIntensity * 22;
    if (this.topLight) this.topLight.intensity = 12 + this.smoothedIntensity * 10;
    if (this.frontLight) this.frontLight.intensity = 8 + this.smoothedIntensity * 8;

    // Stars
    this.stars.mat.uniforms.uTime.value = t;

    this.composer.render();

    if (this.onTelemetry) {
      this.onTelemetry({
        rotation: { x: this.rotation.x, y: this.rotation.y, z: this.rotation.z },
        intensity: this.smoothedIntensity,
        peak: this.peakIntensity,
        angVel,
      });
    }
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this._ro?.disconnect();
    this.renderer.dispose();
    this.composer?.dispose?.();
  }
}

window.SkullEngine = SkullEngine;
window.dispatchEvent(new CustomEvent('skull-engine-ready'));
