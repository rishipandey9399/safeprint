"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Post-print "document destroyed" moment: the page feeds into a 3D shredder
 * (public/models/shredder.glb, built by assets/3d/build_shredder.py), the
 * cutters spin and cross-cut shreds drop onto the pile behind the bin window.
 *
 * Purely visual — the file is already deleted on the server before this
 * plays. Three.js is imported only here, when the scene starts. Reduced
 * motion, no WebGL or a failed load skip straight to onDone().
 */

type Three = typeof import("three");

interface Props {
  /** Small, blurred picture of the printed page (shop side). Phone side
   * passes nothing and gets a generic document. Only ever kept in memory. */
  thumbnail?: HTMLCanvasElement | null;
  onDone: () => void;
}

const MODEL_URL = "/models/shredder.glb";
const DURATION = 6.6; // seconds, including the stamp

// Model geometry (metres, Y-up) — see assets/3d/build_shredder.py.
const SLOT_Y = 0.447;
const BIN_TOP = 0.335;
const PILE_Y = 0.15;
const BIN_HALF_X = 0.155;
const BIN_HALF_Z = 0.105;

export default function ShredderScene({ thumbnail, onDone }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const [phase, setPhase] = useState<"loading" | "shredding" | "stamp">("loading");
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  mutedRef.current = muted;

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDoneRef.current();
  };

  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !hasWebGL()) {
      finish();
      return;
    }
    let disposed = false;
    let cleanup = () => {};
    run(mountRef.current!, thumbnail ?? null, {
      isDisposed: () => disposed,
      isMuted: () => mutedRef.current,
      onPhase: setPhase,
      onFinish: finish,
    })
      .then((c) => {
        if (disposed) c();
        else cleanup = c;
      })
      .catch((err) => {
        console.warn("[SafePrint] shredder animation unavailable:", err);
        finish();
      });
    return () => {
      disposed = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="shredder-overlay" role="dialog" aria-label="Your document is being destroyed">
      <div className="shredder-stage" ref={mountRef} />
      <div className="shredder-caption" aria-live="polite">
        {phase === "stamp" ? (
          <div className="shredder-stamp">
            <span className="shredder-stamp-mark">✓</span>
            <span>
              <strong>Document destroyed</strong>
              <small>Encryption key erased · file deleted from the server</small>
            </span>
          </div>
        ) : (
          <p>{phase === "loading" ? "Destroying your document…" : "Shredding — nothing is kept on this device or the server."}</p>
        )}
      </div>
      <div className="shredder-controls">
        <button type="button" className="shredder-btn" onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
          {muted ? "Sound off" : "Sound on"}
        </button>
        <button type="button" className="shredder-btn" onClick={finish}>
          Skip
        </button>
      </div>
    </div>
  );
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

interface Hooks {
  isDisposed: () => boolean;
  isMuted: () => boolean;
  onPhase: (p: "loading" | "shredding" | "stamp") => void;
  onFinish: () => void;
}

async function run(mount: HTMLDivElement, thumbnail: HTMLCanvasElement | null, hooks: Hooks): Promise<() => void> {
  const [THREE, { GLTFLoader }, { RoomEnvironment }] = await Promise.all([
    import("three"),
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/environments/RoomEnvironment.js"),
  ]);
  if (hooks.isDisposed()) return () => {};

  const nav = navigator as Navigator & { deviceMemory?: number };
  // Budget phones (≤3 GB, <6 cores): no shadows, fewer shreds, lighter AA.
  const lowEnd = (nav.deviceMemory ?? 8) <= 3 || (navigator.hardwareConcurrency ?? 8) < 6;

  // --- renderer / scene ----------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: !lowEnd, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, lowEnd ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = !lowEnd;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.75;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 20);

  const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
  key.position.set(0.9, 1.6, 1.1);
  key.castShadow = !lowEnd;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = key.shadow.camera.bottom = -0.5;
  key.shadow.camera.right = key.shadow.camera.top = 0.5;
  key.shadow.radius = 4;
  key.shadow.bias = -0.0005;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xdfe8ff, 1.1);
  rim.position.set(-1, 0.9, -0.8);
  scene.add(rim);
  // Soft light inside the bin so the pile reads through the smoked window.
  const binLight = new THREE.PointLight(0xfff1dd, 0.35, 0.5, 2);
  binLight.position.set(0, 0.27, 0.02);
  scene.add(binLight);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.ShadowMaterial({ opacity: 0.22 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.008;
  floor.receiveShadow = true;
  scene.add(floor);

  // --- shredder model --------------------------------------------------------
  // GLTFLoader decodes embedded textures by fetch()ing a blob: URL, which our
  // CSP (connect-src 'self') refuses. Decode through <img> instead, which
  // img-src blob: already allows — no CSP loosening.
  const loader = new GLTFLoader().register((parser) => {
    parser.textureLoader = new THREE.TextureLoader(parser.options.manager);
    return { name: "safeprint_img_textures" };
  });
  const gltf = await loader.loadAsync(MODEL_URL);
  if (hooks.isDisposed()) {
    disposeAll(THREE, scene, renderer, pmrem);
    return () => {};
  }
  const machine = gltf.scene;
  let led: import("three").MeshStandardMaterial | null = null;
  const blades: import("three").Object3D[] = [];
  machine.traverse((o) => {
    const mesh = o as import("three").Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const mat = mesh.material as import("three").MeshStandardMaterial;
    if (mat.name === "SmokedGlass") {
      mat.transparent = true;
      mat.opacity = 0.2;
      mat.depthWrite = false;
      mesh.castShadow = false;
    }
    if (mat.name === "BrushedAluminium") {
      // Satin, not mirror: keep the studio reflections from blowing it out.
      mat.color.setRGB(0.62, 0.63, 0.65);
      mat.envMapIntensity = 0.55;
    }
    if (mat.name === "LED") {
      led = mat.clone();
      mesh.material = led;
    }
  });
  for (const n of ["BladeL", "BladeR"]) {
    const b = machine.getObjectByName(n);
    if (b) blades.push(b);
  }
  scene.add(machine);

  // --- the page ------------------------------------------------------------
  const pageTex = new THREE.CanvasTexture(thumbnail ?? genericPage());
  pageTex.colorSpace = THREE.SRGBColorSpace;
  pageTex.anisotropy = 4;
  const aspect = thumbnail ? thumbnail.height / thumbnail.width : 297 / 210;
  const PW = 0.2;
  const PH = Math.min(0.32, PW * aspect);
  const pageGeo = new THREE.PlaneGeometry(PW, PH, 16, 24);
  const basePos = Float32Array.from(pageGeo.attributes.position.array as Float32Array);
  const pageMat = new THREE.MeshStandardMaterial({
    map: pageTex,
    roughness: 0.92,
    side: THREE.DoubleSide,
    // Everything below the slot lips is inside the machine.
    clippingPlanes: [new THREE.Plane(new THREE.Vector3(0, 1, 0), -SLOT_Y + 0.002)],
  });
  const page = new THREE.Mesh(pageGeo, pageMat);
  page.castShadow = true;
  scene.add(page);
  const pageColors = samplePalette(thumbnail);

  // --- shreds ---------------------------------------------------------------
  const pieceGeo = new THREE.PlaneGeometry(0.0045, 0.026);
  const pieceMat = new THREE.MeshStandardMaterial({ roughness: 0.95, side: THREE.DoubleSide });
  const OLD = lowEnd ? 220 : 420; // shreds already in the bin
  const NEW = lowEnd ? 110 : 220; // this document's shreds
  const pieces = new THREE.InstancedMesh(pieceGeo, pieceMat, OLD + NEW);
  pieces.castShadow = false;
  pieces.receiveShadow = !lowEnd;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const color = new THREE.Color();
  const old = ["#f4f1ea", "#ebe7de", "#dfe4ea", "#f7f4ee", "#d9d3c7"];
  for (let i = 0; i < OLD; i++) {
    v.set(rand(-BIN_HALF_X, BIN_HALF_X), PILE_Y - 0.03 + Math.random() * 0.03, rand(-BIN_HALF_Z, BIN_HALF_Z));
    e.set(Math.PI / 2 + rand(-0.6, 0.6), rand(-Math.PI, Math.PI), rand(-0.4, 0.4));
    m4.compose(v, q.setFromEuler(e), one);
    pieces.setMatrixAt(i, m4);
    pieces.setColorAt(i, color.set(old[i % old.length]));
  }
  type Shred = { p: import("three").Vector3; vel: import("three").Vector3; rot: import("three").Euler; spin: import("three").Vector3; t0: number; landed: boolean };
  const shreds: Shred[] = [];
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < NEW; i++) {
    pieces.setMatrixAt(OLD + i, hidden);
    pieces.setColorAt(OLD + i, color.set(pageColors[i % pageColors.length]));
    shreds.push({
      p: new THREE.Vector3(rand(-PW / 2, PW / 2), BIN_TOP - 0.03, rand(-0.006, 0.006)),
      vel: new THREE.Vector3(rand(-0.05, 0.05), rand(-0.08, -0.02), rand(-0.04, 0.07)),
      rot: new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)),
      spin: new THREE.Vector3(rand(-14, 14), rand(-14, 14), rand(-14, 14)),
      t0: 0,
      landed: false,
    });
  }
  pieces.instanceMatrix.needsUpdate = true;
  if (pieces.instanceColor) pieces.instanceColor.needsUpdate = true;
  scene.add(pieces);

  // --- sound ----------------------------------------------------------------
  const sound = makeSound();

  // --- animation --------------------------------------------------------------
  const resize = () => {
    const w = mount.clientWidth || 1;
    const h = mount.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Keep the machine framed on tall phone screens.
    camera.fov = w / h < 0.8 ? 42 : 32;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(mount);

  // Camera keyframes: [time, position, target]
  const shots: [number, number[], number[]][] = [
    [0.0, [0.95, 0.78, 1.25], [0, 0.34, 0]],
    [1.3, [0.62, 0.78, 0.95], [0, 0.42, 0]],
    [3.0, [0.26, 0.7, 0.58], [0, 0.44, 0]],
    [4.6, [0.42, 0.42, 0.9], [0, 0.22, 0]],
    [DURATION, [0.7, 0.62, 1.15], [0, 0.3, 0]],
  ];
  const camPos = new THREE.Vector3();
  const camTarget = new THREE.Vector3();
  const FEED_START = 1.1;
  const FEED_END = 3.9;
  const ledRed = new THREE.Color(1, 0.12, 0.05);
  const ledGreen = new THREE.Color(0.2, 1, 0.4);
  const ledAmber = new THREE.Color(1, 0.65, 0.1);

  hooks.onPhase("shredding");
  const start = performance.now();
  let last = 0;
  let stampShown = false;
  let raf = 0;
  const machineBase = machine.position.clone();

  const frame = () => {
    raf = requestAnimationFrame(frame);
    const t = (performance.now() - start) / 1000;
    const dt = Math.min(0.05, t - last);
    last = t;

    // Camera
    let k = 0;
    while (k < shots.length - 2 && t > shots[k + 1][0]) k++;
    const [ta, pa, ga] = shots[k];
    const [tb, pb, gb] = shots[k + 1];
    const u = smooth(clamp01((t - ta) / (tb - ta)));
    camPos.set(lerp(pa[0], pb[0], u), lerp(pa[1], pb[1], u), lerp(pa[2], pb[2], u));
    camTarget.set(lerp(ga[0], gb[0], u), lerp(ga[1], gb[1], u), lerp(ga[2], gb[2], u));
    camera.position.copy(camPos);
    camera.lookAt(camTarget);

    // Feed progress 0..1, eased so the rollers "grab" the sheet.
    const feed = smooth(clamp01((t - FEED_START) / (FEED_END - FEED_START)));
    const running = t > FEED_START - 0.25 && t < FEED_END + 0.35;
    sound.set(running && !hooks.isMuted(), running ? 0.5 + 0.5 * Math.sin(t * 9) : 0);

    // Page: hovers in, then is pulled down through the slot.
    const settle = smooth(clamp01(t / FEED_START));
    const bottomY = SLOT_Y + (1 - settle) * 0.12 - feed * (PH + 0.01);
    page.position.set(0, bottomY + PH / 2, 0);
    page.visible = feed < 0.999;
    const pos = pageGeo.attributes.position as import("three").BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = basePos[i * 3];
      const y = basePos[i * 3 + 1];
      const above = y + PH / 2 + bottomY - SLOT_Y; // height above the slot
      // Taut near the rollers, a gentle wave and corner curl further up.
      const free = clamp01(above / 0.12);
      const wave = Math.sin(y * 18 + t * 5) * 0.004 * free * (running ? 1.4 : 0.6);
      const curl = Math.pow(Math.abs(x) / (PW / 2), 3) * 0.012 * free;
      const lean = free * free * 0.025;
      pos.setXYZ(i, x, y, wave + curl - lean * 0.4);
    }
    pos.needsUpdate = true;
    pageGeo.computeVertexNormals();

    // Cutters + vibration
    for (const [i, b] of blades.entries()) b.rotation.x += (i ? -1 : 1) * (running ? 26 : 0) * dt;
    if (running) {
      machine.position.set(machineBase.x + rand(-1, 1) * 0.0007, machineBase.y + rand(-1, 1) * 0.0004, machineBase.z + rand(-1, 1) * 0.0006);
    } else {
      machine.position.copy(machineBase);
    }
    if (led) {
      const c = t < FEED_START - 0.25 ? ledAmber : running ? ledRed : ledGreen;
      led.emissive.copy(c);
      led.color.copy(c);
      led.emissiveIntensity = running ? 3 + Math.sin(t * 30) : 3.5;
    }

    // Shreds fall from the cutters onto the pile as the sheet goes in.
    const released = Math.floor(feed * NEW);
    for (let i = 0; i < NEW; i++) {
      const s = shreds[i];
      if (i >= released) continue;
      if (!s.t0) s.t0 = t;
      if (!s.landed) {
        s.vel.y -= 9.8 * dt * 0.55; // air drag on paper
        s.vel.multiplyScalar(0.985);
        s.p.addScaledVector(s.vel, dt);
        s.rot.x += s.spin.x * dt;
        s.rot.y += s.spin.y * dt;
        s.rot.z += s.spin.z * dt;
        s.p.x = Math.max(-BIN_HALF_X, Math.min(BIN_HALF_X, s.p.x));
        s.p.z = Math.max(-BIN_HALF_Z, Math.min(BIN_HALF_Z, s.p.z));
        const floorY = PILE_Y + 0.002 + (i / NEW) * 0.02 + Math.sin(s.p.x * 60) * 0.003;
        if (s.p.y <= floorY) {
          s.p.y = floorY;
          s.landed = true;
          s.rot.x = Math.PI / 2 + rand(-0.5, 0.5);
        }
      }
      m4.compose(s.p, q.setFromEuler(s.rot), one);
      pieces.setMatrixAt(OLD + i, m4);
    }
    pieces.instanceMatrix.needsUpdate = true;

    if (!stampShown && t > FEED_END + 0.6) {
      stampShown = true;
      hooks.onPhase("stamp");
    }
    renderer.render(scene, camera);
    if (t > DURATION) {
      cancelAnimationFrame(raf);
      hooks.onFinish();
    }
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    sound.close();
    pageTex.dispose();
    disposeAll(THREE, scene, renderer, pmrem);
    envTex.dispose();
    renderer.domElement.remove();
  };
}

function disposeAll(THREE: Three, scene: import("three").Scene, renderer: import("three").WebGLRenderer, pmrem: import("three").PMREMGenerator) {
  scene.traverse((o) => {
    const mesh = o as import("three").Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    for (const m of mats) {
      for (const val of Object.values(m)) if (val instanceof THREE.Texture) val.dispose();
      m.dispose();
    }
  });
  pmrem.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => x * x * (3 - 2 * x);

/** A plain document look for the customer's phone (it never renders the page). */
function genericPage(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 210;
  c.height = 297;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fbfaf6";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#c9c4b8";
  g.fillRect(18, 20, 90, 9);
  g.fillStyle = "#dcd7cc";
  for (let y = 48; y < 270; y += 11) {
    const w = y % 66 === 4 ? 110 : 150 + ((y * 37) % 24);
    g.fillRect(18, y, w, 4);
  }
  g.strokeStyle = "#b8b2a4";
  g.strokeRect(140, 228, 50, 34);
  return c;
}

/** Shred colours: the page's own tones (paper white + ink), so the shreds
 * look like they came from this sheet. */
function samplePalette(thumb: HTMLCanvasElement | null): string[] {
  const out = ["#f6f4ee", "#f2efe8", "#efece4"];
  if (!thumb) return [...out, "#d9d4c8", "#e6e2d8"];
  try {
    const g = thumb.getContext("2d");
    if (!g) return out;
    const { data } = g.getImageData(0, 0, thumb.width, thumb.height);
    const step = Math.max(4, Math.floor(data.length / 4 / 40)) * 4;
    for (let i = 0; i < data.length; i += step) {
      out.push(`rgb(${data[i]},${data[i + 1]},${data[i + 2]})`);
    }
  } catch {
    /* tainted or unavailable: plain paper */
  }
  return out;
}

/** Motor hum + paper grind, synthesised (no audio file). */
function makeSound() {
  type Ctx = typeof AudioContext;
  const AC = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctx }).webkitAudioContext) as Ctx | undefined;
  const activated = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true;
  if (!AC || !activated) return { set: () => {}, close: () => {} };
  let ctx: AudioContext;
  try {
    ctx = new AC();
  } catch {
    return { set: () => {}, close: () => {} };
  }
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  const motor = ctx.createOscillator();
  motor.type = "sawtooth";
  motor.frequency.value = 92;
  const motorLp = ctx.createBiquadFilter();
  motorLp.type = "lowpass";
  motorLp.frequency.value = 420;
  const motorGain = ctx.createGain();
  motorGain.gain.value = 0.18;
  motor.connect(motorLp).connect(motorGain).connect(master);

  const len = ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  noise.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1900;
  bp.Q.value = 0.7;
  const grind = ctx.createGain();
  grind.gain.value = 0;
  noise.connect(bp).connect(grind).connect(master);
  motor.start();
  noise.start();

  return {
    set(on: boolean, crunch: number) {
      const now = ctx.currentTime;
      master.gain.setTargetAtTime(on ? 0.35 : 0, now, 0.08);
      grind.gain.setTargetAtTime(on ? 0.25 + crunch * 0.35 : 0, now, 0.03);
    },
    close() {
      try {
        motor.stop();
        noise.stop();
      } catch {
        /* already stopped */
      }
      void ctx.close();
    },
  };
}
