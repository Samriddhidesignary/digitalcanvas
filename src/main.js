/* =============================================================
   main.js — Gesture Canvas
   Free Draw (unchanged) + new Practice Mode.

   ARCHITECTURE NOTE ON PRACTICE MODE
   ------------------------------------------------------------
   Practice Mode intentionally does NOT introduce a new drawing
   pipeline. It reuses DrawEngine/EraserEngine/ParticlePool
   exactly as Free Draw does — the user's ink lands on the same
   drawCanvas/bloomCanvas via the same processHand() function.
   The only additions are:
     1. PracticeReference — draws a static, thin, dotted outline
        of the selected shape on its own layer BELOW the drawing
        canvas (purely visual, never touched by drawing logic).
     2. PracticeMode — records the raw fingertip points traced
        while in 'practice' mode (for evaluation only) and owns
        shape switching / clearing.
     3. ShapeEvaluator — a standalone, reusable scoring module.
        It knows nothing about hands, canvases, or MediaPipe; it
        only compares two point sets (user vs. reference) and
        returns an encouraging score + message. Future modes
        (Letter Practice, Number Practice, Connect the Dots) can
        call ShapeEvaluator.evaluate() directly with their own
        reference point sets.
   ============================================================= */

   import {
    HandLandmarker,
    FilesetResolver,
  } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
  
  /* =============================================================
     SECTION 1: DOM REFERENCES
     ============================================================= */
  const videoElement = document.getElementById('webcam');
  const appEl = document.getElementById('app');
  
  const overlayCanvas = document.getElementById('overlay');
  const overlayCtx = overlayCanvas.getContext('2d');
  
  const practiceStage = document.getElementById('practiceStage');
  const practiceCanvas = document.getElementById('practiceCanvas');
  const practiceCtx = practiceCanvas.getContext('2d');
  
  const bloomCanvas = document.getElementById('bloomCanvas');
  const bloomCtx = bloomCanvas.getContext('2d');
  
  const drawCanvas = document.getElementById('drawCanvas');
  const drawCtx = drawCanvas.getContext('2d');
  
  const particleCanvas = document.getElementById('particleCanvas');
  const particleCtx = particleCanvas.getContext('2d');
  
  const handCursorCanvas = document.getElementById('handCursorCanvas');
  const handCursorCtx = handCursorCanvas.getContext('2d');
  
  const clearBtn = document.getElementById('clearBtn');
  const saveBtn = document.getElementById('saveBtn');
  const brushSizeSlider = document.getElementById('brushSize');
  const colorPicker = document.getElementById('colorPicker');
  const colorGroup = document.getElementById('colorGroup');
  const glowToggle = document.getElementById('glowToggle');
  const rainbowToggle = document.getElementById('rainbowToggle');
  const particleToggle = document.getElementById('particleToggle');
  const colorSwatches = Array.from(document.querySelectorAll('.color-swatch'));
  
  const modeFreeBtn = document.getElementById('modeFreeBtn');
  const modePracticeBtn = document.getElementById('modePracticeBtn');
  const practiceNavGroup = document.getElementById('practiceNavGroup');
  const shapeNameLabel = document.getElementById('shapeNameLabel');
  const shapePrevBtn = document.getElementById('shapePrevBtn');
  const shapeNextBtn = document.getElementById('shapeNextBtn');
  const checkDrawingBtn = document.getElementById('checkDrawingBtn');
  
  const onboardingCard = document.getElementById('onboardingCard');
  const onboardingGotIt = document.getElementById('onboardingGotIt');
  const miniReminder = document.getElementById('miniReminder');
  
  const practiceFeedbackCard = document.getElementById('practiceFeedbackCard');
  const feedbackPercent = document.getElementById('feedbackPercent');
  const feedbackMessage = document.getElementById('feedbackMessage');
  const practiceTryAgainBtn = document.getElementById('practiceTryAgainBtn');
  const practiceNextShapeBtn = document.getElementById('practiceNextShapeBtn');
  
  const ONBOARDING_SESSION_KEY = 'gestureCanvasOnboardingShown';
  
  /* =============================================================
     SECTION 2: GLOBAL APP STATE
     ============================================================= */
  const appState = {
    mode: 'free', // 'free' | 'practice'
    brushColor: '#00ffff',
    brushSize: 4,
    glowEnabled: false,
    rainbowEnabled: false,
    particlesEnabled: false,
    rainbowHue: 0,
  };
  
  let stageWidth = 0;
  let stageHeight = 0;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  
  function currentBrushColor() {
    return appState.rainbowEnabled
      ? `hsl(${appState.rainbowHue}, 100%, 60%)`
      : appState.brushColor;
  }
  
  function advanceRainbowHue(dt) {
    if (appState.rainbowEnabled) {
      appState.rainbowHue = (appState.rainbowHue + dt * 0.06) % 360;
    }
  }
  
  function getEraserSize() {
    return appState.brushSize * 2.2;
  }
  
  /* =============================================================
     SECTION 3: ONBOARDING CARD
     ============================================================= */
  const OnboardingController = (() => {
    let autoHideTimer = null;
  
    function show() {
      const alreadyShown = sessionStorage.getItem(ONBOARDING_SESSION_KEY);
      if (alreadyShown) {
        MiniReminder.show();
        return;
      }
  
      sessionStorage.setItem(ONBOARDING_SESSION_KEY, '1');
      onboardingCard.classList.remove('hidden');
  
      autoHideTimer = setTimeout(hide, 6000);
    }
  
    function hide() {
      if (autoHideTimer) {
        clearTimeout(autoHideTimer);
        autoHideTimer = null;
      }
      onboardingCard.classList.add('fade-out');
      setTimeout(() => {
        onboardingCard.classList.add('hidden');
        onboardingCard.classList.remove('fade-out');
        MiniReminder.show();
      }, 550);
    }
  
    onboardingGotIt.addEventListener('click', hide);
  
    return { show };
  })();
  
  /* =============================================================
     SECTION 4: FLOATING MINIMAL REMINDER
     ============================================================= */
  const MiniReminder = (() => {
    let visible = false;
  
    function show() {
      if (visible) return;
      visible = true;
      miniReminder.classList.remove('hidden');
      requestAnimationFrame(() => miniReminder.classList.add('visible'));
    }
  
    function setDrawingActive(isDrawing) {
      if (!visible) return;
      miniReminder.classList.toggle('drawing-active', isDrawing);
    }
  
    return { show, setDrawingActive };
  })();
  
  /* =============================================================
     SECTION 5: HAND SKELETON CONNECTIONS (overlay rendering)
     ============================================================= */
  const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ];
  
  /* =============================================================
     SECTION 6: HAND INPUT STORE
     ============================================================= */
  const HandInputStore = (() => {
    const MAX_MISSED_FRAMES = 3;
    const MAX_PREDICTED_STEP_PX = 40;
    const GESTURE_STABILITY_FRAMES = 2;
    const FINGER_MARGIN = 0.035;
  
    function createSlot() {
      return {
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        gesture: 'idle',
        pendingGesture: 'idle',
        pendingCount: 0,
        t: 0,
        lastRealT: 0,
        missedFrames: 0,
        valid: false,
        predicted: false,
        landmarks: null,
      };
    }
  
    const slots = { Left: createSlot(), Right: createSlot() };
  
    function classifyGesture(landmarks) {
      const isUp = (tip, pip) => landmarks[tip].y < landmarks[pip].y - FINGER_MARGIN;
      const index = isUp(8, 6);
      const middle = isUp(12, 10);
      const ring = isUp(16, 14);
      const pinky = isUp(20, 18);
  
      if (index && middle && ring && pinky) return 'open';
      if (index && middle && !ring && !pinky) return 'erase';
      if (index && !middle && !ring && !pinky) return 'draw';
      return 'idle';
    }
  
    function updateGestureStability(slot, rawGesture) {
      if (rawGesture === slot.pendingGesture) {
        slot.pendingCount += 1;
      } else {
        slot.pendingGesture = rawGesture;
        slot.pendingCount = 1;
      }
      if (slot.pendingCount >= GESTURE_STABILITY_FRAMES) {
        slot.gesture = rawGesture;
      }
    }
  
    function ingest(result, width, height, now) {
      const seenLabels = new Set();
  
      if (result.landmarks && result.handedness) {
        result.landmarks.forEach((landmarks, i) => {
          const handedness = result.handedness[i]?.[0]?.categoryName;
          const label = handedness === 'Left' ? 'Left' : 'Right';
          seenLabels.add(label);
  
          const slot = slots[label];
          const newX = width - landmarks[8].x * width;
          const newY = landmarks[8].y * height;
  
          const dt = Math.max(now - slot.lastRealT, 1);
          if (slot.lastRealT > 0) {
            slot.vx = (newX - slot.x) / dt;
            slot.vy = (newY - slot.y) / dt;
          }
  
          slot.x = newX;
          slot.y = newY;
          updateGestureStability(slot, classifyGesture(landmarks));
          slot.landmarks = landmarks;
          slot.t = now;
          slot.lastRealT = now;
          slot.missedFrames = 0;
          slot.valid = true;
          slot.predicted = false;
        });
      }
  
      for (const label of ['Left', 'Right']) {
        if (seenLabels.has(label)) continue;
        const slot = slots[label];
        if (!slot.valid) continue;
  
        slot.missedFrames += 1;
  
        if (slot.missedFrames <= MAX_MISSED_FRAMES) {
          const dt = Math.max(now - slot.t, 1);
          let dx = slot.vx * dt;
          let dy = slot.vy * dt;
  
          const stepDist = Math.hypot(dx, dy);
          if (stepDist > MAX_PREDICTED_STEP_PX) {
            const scale = MAX_PREDICTED_STEP_PX / stepDist;
            dx *= scale;
            dy *= scale;
          }
  
          slot.x += dx;
          slot.y += dy;
          slot.t = now;
          slot.predicted = true;
          slot.valid = true;
          slot.landmarks = null;
        } else {
          slot.valid = false;
          slot.predicted = false;
          slot.gesture = 'idle';
          slot.pendingGesture = 'idle';
          slot.pendingCount = 0;
          slot.landmarks = null;
        }
      }
    }
  
    function getSlot(label) {
      return slots[label];
    }
  
    return { ingest, getSlot };
  })();
  
  /* =============================================================
     SECTION 7: CATMULL-ROM STROKE INTERPOLATOR (Free Draw + Practice)
     ============================================================= */
  function catmullRom(p0, p1, p2, p3, t, out) {
    const t2 = t * t;
    const t3 = t2 * t;
  
    out.x =
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  
    out.y =
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
  
    return out;
  }
  
  function adaptiveSteps(dist, minStep, maxSteps) {
    const steps = Math.ceil(dist / minStep);
    return Math.max(1, Math.min(steps, maxSteps));
  }
  
  /* =============================================================
     SECTION 8: PER-HAND RENDER STATE
     ============================================================= */
  function createHandRenderState() {
    return {
      history: [],
      lastProcessed: null,
      mode: 'idle',
      strokeActive: false,
      lastSampleT: 0,
      scratchPoint: { x: 0, y: 0 },
    };
  }
  
  const handRenderStates = {
    Left: createHandRenderState(),
    Right: createHandRenderState(),
  };
  
  function resetHandRenderState(hs) {
    hs.history.length = 0;
    hs.lastProcessed = null;
    hs.mode = 'idle';
    hs.strokeActive = false;
    hs.lastSampleT = 0;
  }
  
  /* =============================================================
     SECTION 9: DRAWING ENGINE — used by BOTH Free Draw and
     Practice Mode, completely unchanged from Free Draw's version.
     ============================================================= */
  const DrawEngine = (() => {
    const MIN_STEP_PX = 2;
    const MAX_STEPS = 28;
  
    function configureStyle(ctx, speedPxMs, isBloom) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = currentBrushColor();
  
      if (isBloom) {
        ctx.lineWidth = appState.brushSize * 2.4;
        ctx.shadowBlur = 0;
      } else {
        ctx.lineWidth = appState.brushSize;
        if (appState.glowEnabled) {
          ctx.shadowColor = currentBrushColor();
          ctx.shadowBlur = 15 + Math.min(speedPxMs * 10, 20);
        } else {
          ctx.shadowBlur = 0;
        }
      }
    }
  
    function strokeLinear(a, b, speed) {
      configureStyle(drawCtx, speed, false);
      drawCtx.beginPath();
      drawCtx.moveTo(a.x, a.y);
      drawCtx.lineTo(b.x, b.y);
      drawCtx.stroke();
  
      if (appState.glowEnabled) {
        configureStyle(bloomCtx, speed, true);
        bloomCtx.beginPath();
        bloomCtx.moveTo(a.x, a.y);
        bloomCtx.lineTo(b.x, b.y);
        bloomCtx.stroke();
      }
    }
  
    function strokeCurve(p0, p1, p2, p3, speed, scratch) {
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const steps = adaptiveSteps(dist, MIN_STEP_PX, MAX_STEPS);
  
      configureStyle(drawCtx, speed, false);
      drawCtx.beginPath();
      drawCtx.moveTo(p1.x, p1.y);
  
      if (appState.glowEnabled) {
        configureStyle(bloomCtx, speed, true);
        bloomCtx.beginPath();
        bloomCtx.moveTo(p1.x, p1.y);
      }
  
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        catmullRom(p0, p1, p2, p3, t, scratch);
        drawCtx.lineTo(scratch.x, scratch.y);
        if (appState.glowEnabled) bloomCtx.lineTo(scratch.x, scratch.y);
      }
  
      drawCtx.stroke();
      if (appState.glowEnabled) bloomCtx.stroke();
    }
  
    function processDraw(hs, target, speed) {
      if (!hs.strokeActive || !hs.lastProcessed) {
        hs.strokeActive = true;
        hs.history.length = 0;
        hs.history.push({ x: target.x, y: target.y });
        hs.lastProcessed = { x: target.x, y: target.y };
        return;
      }
  
      const p1 = hs.lastProcessed;
  
      if (hs.history.length < 2) {
        strokeLinear(p1, target, speed);
      } else {
        const p0 = hs.history[hs.history.length - 2];
        const p3 = {
          x: target.x + (target.x - p1.x),
          y: target.y + (target.y - p1.y),
        };
        strokeCurve(p0, p1, target, p3, speed, hs.scratchPoint);
      }
  
      hs.history.push({ x: target.x, y: target.y });
      if (hs.history.length > 4) hs.history.shift();
      hs.lastProcessed = { x: target.x, y: target.y };
    }
  
    function endStroke(hs) {
      hs.strokeActive = false;
      hs.history.length = 0;
      hs.lastProcessed = null;
    }
  
    return { processDraw, endStroke };
  })();
  
  /* =============================================================
     SECTION 10: ERASER ENGINE — used by BOTH Free Draw and
     Practice Mode, unchanged.
     ============================================================= */
  const EraserEngine = (() => {
    let stampCanvas = null;
    let stampSize = 0;
  
    function buildStamp(diameter) {
      const size = Math.ceil(diameter);
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const ctx = c.getContext('2d');
      const radius = size / 2;
  
      const gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
      gradient.addColorStop(0, 'rgba(0,0,0,1)');
      gradient.addColorStop(0.7, 'rgba(0,0,0,0.85)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
  
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(radius, radius, radius, 0, Math.PI * 2);
      ctx.fill();
  
      stampCanvas = c;
      stampSize = size;
    }
  
    function getStamp() {
      const diameter = getEraserSize();
      if (!stampCanvas || Math.abs(stampSize - diameter) > 0.5) {
        buildStamp(diameter);
      }
      return stampCanvas;
    }
  
    function stampAt(ctx, x, y) {
      const stamp = getStamp();
      const half = stampSize / 2;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.shadowBlur = 0;
      ctx.drawImage(stamp, x - half, y - half, stampSize, stampSize);
      ctx.restore();
    }
  
    function eraseSegment(x0, y0, x1, y1) {
      const dist = Math.hypot(x1 - x0, y1 - y0);
      const radius = getEraserSize() / 2;
      const step = Math.max(radius * 0.35, 2);
      const steps = dist < 0.5 ? 1 : Math.ceil(dist / step);
  
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = x0 + (x1 - x0) * t;
        const y = y0 + (y1 - y0) * t;
        stampAt(drawCtx, x, y);
        stampAt(bloomCtx, x, y);
      }
    }
  
    function eraseSingle(x, y) {
      stampAt(drawCtx, x, y);
      stampAt(bloomCtx, x, y);
    }
  
    return { eraseSegment, eraseSingle, getSize: getEraserSize };
  })();
  
  /* =============================================================
     SECTION 11: PARTICLE POOL — used by both modes, unchanged.
     ============================================================= */
  const ParticlePool = (() => {
    const CAPACITY = 500;
    const pool = new Array(CAPACITY);
    for (let i = 0; i < CAPACITY; i++) {
      pool[i] = { x: 0, y: 0, vx: 0, vy: 0, size: 0, life: 0, decay: 0, color: '#000' };
    }
    let activeCount = 0;
  
    function spawn(x, y, opts) {
      if (activeCount >= CAPACITY) return;
      const p = pool[activeCount++];
  
      const angle = opts.angle ?? Math.random() * Math.PI * 2;
      const speed = opts.speed ?? Math.random() * 1.5 + 0.5;
  
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.size = opts.size ?? Math.random() * 3 + 1;
      p.life = opts.life ?? 1;
      p.decay = opts.decay ?? Math.random() * 0.02 + 0.015;
      p.color = opts.color ?? currentBrushColor();
    }
  
    function spawnSparkles(x, y, color) {
      spawn(x, y, { speed: Math.random() * 0.6, size: Math.random() * 2 + 0.5, decay: 0.03, color });
      spawn(x, y, { speed: Math.random() * 0.6, size: Math.random() * 2 + 0.5, decay: 0.03, color });
    }
  
    function spawnExplosion(x, y, intensity, color) {
      const count = Math.min(18, Math.floor(intensity * 2));
      for (let i = 0; i < count; i++) {
        spawn(x, y, { speed: Math.random() * 4 + 2, size: Math.random() * 4 + 2, decay: 0.025, color });
      }
    }
  
    function updateAndDraw(ctx, dtScale) {
      ctx.save();
      for (let i = activeCount - 1; i >= 0; i--) {
        const p = pool[i];
  
        p.x += p.vx * dtScale;
        p.y += p.vy * dtScale;
        p.life -= p.decay * dtScale;
        p.vx *= 0.96;
        p.vy *= 0.96;
  
        if (p.life <= 0) {
          activeCount--;
          if (i !== activeCount) {
            const tmp = pool[i];
            pool[i] = pool[activeCount];
            pool[activeCount] = tmp;
          }
          continue;
        }
  
        ctx.globalAlpha = Math.max(p.life, 0);
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  
    function clear() {
      activeCount = 0;
    }
  
    return { spawnSparkles, spawnExplosion, updateAndDraw, clear };
  })();
  
  /* =============================================================
     SECTION 12: SIMPLE FINGERTIP CURSOR
     ============================================================= */
  const CursorFX = (() => {
    const FOLLOW_RATE = 0.35;
    const SCALE_RATE = 0.2;
    const BASE_RADIUS = 9;
  
    function createState() {
      return {
        x: 0,
        y: 0,
        initialized: false,
        displayScale: 1,
        color: 'rgba(255,255,255,0.5)',
        visible: false,
      };
    }
  
    const states = { Left: createState(), Right: createState() };
  
    function update(label, target, mode) {
      const st = states[label];
  
      if (!target.valid) {
        st.initialized = false;
        st.visible = false;
        return st;
      }
  
      if (!st.initialized) {
        st.x = target.x;
        st.y = target.y;
        st.initialized = true;
      }
  
      st.x += (target.x - st.x) * FOLLOW_RATE;
      st.y += (target.y - st.y) * FOLLOW_RATE;
      st.visible = true;
  
      let targetScale = 1;
      let targetColor = 'rgba(255,255,255,0.5)';
  
      if (mode === 'erase') {
        targetScale = 1.7;
        targetColor = '#ffffff';
      } else if (mode === 'draw') {
        targetScale = 1.35;
        targetColor = currentBrushColor();
      }
  
      st.displayScale += (targetScale - st.displayScale) * SCALE_RATE;
      st.color = targetColor;
  
      return st;
    }
  
    function render(ctx, st) {
      if (!st.visible) return;
      const radius = BASE_RADIUS * st.displayScale;
  
      ctx.save();
      ctx.shadowColor = st.color;
      ctx.shadowBlur = 22;
      ctx.fillStyle = st.color;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(st.x, st.y, radius * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
  
      ctx.save();
      ctx.globalAlpha = 0.65;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = 2;
      ctx.shadowColor = st.color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(st.x, st.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  
    return { update, render };
  })();
  
  /* =============================================================
     SECTION 13: SHAPE GEOMETRY LIBRARY
     ------------------------------------------------------------
     Pure geometry helpers, shared by the reference-outline renderer
     and the evaluator. No canvas/DOM dependencies.
     ============================================================= */
  const ShapeGeometry = (() => {
    const SHAPE_LIST = [
      { id: 'circle', name: 'Circle', icon: '⭕' },
      { id: 'square', name: 'Square', icon: '⬜' },
      { id: 'triangle', name: 'Triangle', icon: '🔺' },
      { id: 'pentagon', name: 'Pentagon', icon: '⬠' },
      { id: 'hexagon', name: 'Hexagon', icon: '⬡' },
      { id: 'star', name: 'Star', icon: '⭐' },
    ];
  
    function regularPolygonVertices(sides, cx, cy, radius) {
      const verts = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2 - Math.PI / 2;
        verts.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
      }
      return verts;
    }
  
    function starVertices(spikes, cx, cy, outerR, innerR) {
      const verts = [];
      for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
        verts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
      }
      return verts;
    }
  
    function squareVertices(cx, cy, radius) {
      const h = radius * 0.85;
      return [
        { x: cx - h, y: cy - h },
        { x: cx + h, y: cy - h },
        { x: cx + h, y: cy + h },
        { x: cx - h, y: cy + h },
      ];
    }
  
    // Subdivides a closed polyline into N evenly-spaced points by arc
    // length, so every shape gets consistent point density regardless
    // of vertex count or size.
    function densifyClosedPolyline(vertices, n) {
      const segLengths = [];
      let total = 0;
      for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % vertices.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        segLengths.push(len);
        total += len;
      }
  
      const result = [];
      const step = total / n;
      let segIndex = 0;
      let segStart = 0;
  
      for (let i = 0; i < n; i++) {
        const targetDist = i * step;
        while (
          segIndex < segLengths.length - 1 &&
          segStart + segLengths[segIndex] < targetDist
        ) {
          segStart += segLengths[segIndex];
          segIndex++;
        }
        const a = vertices[segIndex];
        const b = vertices[(segIndex + 1) % vertices.length];
        const segLen = segLengths[segIndex] || 1;
        const t = segLen > 0 ? (targetDist - segStart) / segLen : 0;
        result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
      return result;
    }
  
    function circlePoints(cx, cy, radius, n) {
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        pts.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
      }
      return pts;
    }
  
    function buildPoints(id, cx, cy, radius, n) {
      switch (id) {
        case 'circle':
          return circlePoints(cx, cy, radius, n);
        case 'square':
          return densifyClosedPolyline(squareVertices(cx, cy, radius), n);
        case 'triangle':
          return densifyClosedPolyline(regularPolygonVertices(3, cx, cy, radius), n);
        case 'pentagon':
          return densifyClosedPolyline(regularPolygonVertices(5, cx, cy, radius), n);
        case 'hexagon':
          return densifyClosedPolyline(regularPolygonVertices(6, cx, cy, radius), n);
        case 'star':
          return densifyClosedPolyline(starVertices(5, cx, cy, radius, radius * 0.45), n);
        default:
          return circlePoints(cx, cy, radius, n);
      }
    }
  
    return { SHAPE_LIST, buildPoints };
  })();
  
  /* =============================================================
     SECTION 14: SHAPE EVALUATOR (reusable scoring module)
     ------------------------------------------------------------
     Pure function module: takes a user's traced points and a
     reference point set, returns an encouraging accuracy score.
     Has no knowledge of canvases, hands, or the app's mode system,
     so future practice-style modes (Letter Practice, Number
     Practice, Connect the Dots) can reuse it directly by supplying
     their own reference point sets.
     ============================================================= */
  const ShapeEvaluator = (() => {
    const MIN_POINTS_REQUIRED = 15;
  
    function boundingBox(points) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    }
  
    function nearestDist(point, targetSet) {
      let best = Infinity;
      for (const t of targetSet) {
        const d = Math.hypot(point.x - t.x, point.y - t.y);
        if (d < best) best = d;
      }
      return best;
    }
  
    // Fraction of referencePoints that have a nearby user point
    // (did the user cover the whole outline?).
    function computeCompleteness(userPoints, referencePoints, tolerance) {
      let covered = 0;
      for (const r of referencePoints) {
        if (nearestDist(r, userPoints) <= tolerance) covered++;
      }
      return covered / referencePoints.length;
    }
  
    // Fraction of userPoints that landed near the reference outline
    // (penalizes wild scribbling far from the guide).
    function computePrecision(userPoints, referencePoints, tolerance) {
      let onTarget = 0;
      for (const u of userPoints) {
        if (nearestDist(u, referencePoints) <= tolerance) onTarget++;
      }
      return onTarget / userPoints.length;
    }
  
    // Compares the aspect ratio of the user's drawing bounding box
    // against the reference shape's bounding box.
    function computeProportionScore(userBox, refBox) {
      const userAspect = userBox.width / Math.max(userBox.height, 1);
      const refAspect = refBox.width / Math.max(refBox.height, 1);
      const diff = Math.abs(userAspect - refAspect) / Math.max(refAspect, 0.01);
      return Math.max(0, 1 - Math.min(diff, 1));
    }
  
    // Measures jitter via average turning-angle change between
    // consecutive points (subsampled for performance). Smoother
    // curves have smaller, more consistent turning angles.
    function computeSmoothnessScore(userPoints) {
      if (userPoints.length < 6) return 0.6; // not enough data — neutral score
      const step = Math.max(1, Math.floor(userPoints.length / 60));
      const sampled = userPoints.filter((_, i) => i % step === 0);
  
      let totalJitter = 0;
      let count = 0;
      for (let i = 2; i < sampled.length; i++) {
        const a = sampled[i - 2];
        const b = sampled[i - 1];
        const c = sampled[i];
        const v1 = { x: b.x - a.x, y: b.y - a.y };
        const v2 = { x: c.x - b.x, y: c.y - b.y };
        const len1 = Math.hypot(v1.x, v1.y);
        const len2 = Math.hypot(v2.x, v2.y);
        if (len1 < 0.5 || len2 < 0.5) continue;
  
        const dot = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2);
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
        totalJitter += angle;
        count++;
      }
  
      if (count === 0) return 0.6;
      const avgJitter = totalJitter / count; // radians, 0 = perfectly straight/smooth
      // Map avg jitter (0..~1.2 rad is a reasonable "shaky" range) to a 0..1 score.
      return Math.max(0, 1 - Math.min(avgJitter / 1.2, 1));
    }
  
    function pickMessage(percent) {
      if (percent >= 90) {
        return 'Excellent!';
      }
      if (percent >= 75) {
        return 'Great attempt! Try making the edges a little straighter.';
      }
      return 'Good start! Try following the guide a little more closely.';
    }
  
    // Main entry point. userPoints/referencePoints are arrays of
    // {x, y} in the same coordinate space (screen pixels).
    function evaluate(userPoints, referencePoints) {
      if (!userPoints || userPoints.length < MIN_POINTS_REQUIRED) {
        return { insufficient: true };
      }
  
      const refBox = boundingBox(referencePoints);
      const userBox = boundingBox(userPoints);
      const shapeRadius = Math.max(refBox.width, refBox.height) / 2 || 1;
      const tolerance = shapeRadius * 0.2; // forgiving hand-drawn tolerance
  
      const completeness = computeCompleteness(userPoints, referencePoints, tolerance);
      const precision = computePrecision(userPoints, referencePoints, tolerance * 1.3);
      const proportion = computeProportionScore(userBox, refBox);
      const smoothness = computeSmoothnessScore(userPoints);
  
      const rawScore =
        completeness * 0.4 + precision * 0.25 + proportion * 0.15 + smoothness * 0.2;
  
      // Floor-clamp so feedback always stays encouraging, per design spec.
      const percent = Math.round(Math.max(40, Math.min(99, rawScore * 100)));
  
      return {
        insufficient: false,
        percent,
        message: pickMessage(percent),
        breakdown: { completeness, precision, proportion, smoothness },
      };
    }
  
    return { evaluate };
  })();
  
  /* =============================================================
     SECTION 15: PRACTICE REFERENCE (static dotted outline layer)
     ------------------------------------------------------------
     Purely visual — renders a thin, semi-transparent dotted guide
     on practiceCanvas. It never reacts to drawing; it is redrawn
     only when the shape changes or the stage resizes.
     ============================================================= */
  const PracticeReference = (() => {
    const POINT_COUNT = 120;
    const DOT_SPACING = 3; // draw every Nth point as a visible dot
  
    let currentPoints = [];
  
    function build(shapeId, stageW, stageH) {
      const radius = Math.min(stageW, stageH) * 0.28;
      const cx = stageW / 2;
      const cy = stageH / 2;
      currentPoints = ShapeGeometry.buildPoints(shapeId, cx, cy, radius, POINT_COUNT);
      return currentPoints;
    }
  
    function render(ctx, stageW, stageH) {
      ctx.clearRect(0, 0, stageW, stageH);
      if (currentPoints.length === 0) return;
  
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.shadowColor = 'rgba(0, 255, 255, 0.6)';
      ctx.shadowBlur = 8;
  
      for (let i = 0; i < currentPoints.length; i += DOT_SPACING) {
        const p = currentPoints[i];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  
    function getPoints() {
      return currentPoints;
    }
  
    return { build, render, getPoints };
  })();
  
  /* =============================================================
     SECTION 16: PRACTICE MODE (orchestrates reference + evaluation)
     ------------------------------------------------------------
     Records the fingertip points traced while the app is in
     'practice' mode and drives shape switching / evaluation. Does
     NOT touch DrawEngine/EraserEngine — those are called from the
     same processHand() function used by Free Draw.
     ============================================================= */
  const PracticeMode = (() => {
    let currentIndex = 0;
    let userPoints = [];
    let callbacks = {};
  
    function init(cb) {
      callbacks = cb;
    }
  
    function currentShape() {
      return ShapeGeometry.SHAPE_LIST[currentIndex];
    }
  
    function updateLabel() {
      const shape = currentShape();
      if (callbacks.onLabelChange) callbacks.onLabelChange(`${shape.icon} ${shape.name}`);
    }
  
    function regenerate(stageW, stageH) {
      PracticeReference.build(currentShape().id, stageW, stageH);
    }
  
    function setActive(isActive, stageW, stageH) {
      if (isActive) {
        userPoints = [];
        regenerate(stageW, stageH);
        updateLabel();
        if (callbacks.onHideFeedback) callbacks.onHideFeedback();
      }
    }
  
    function resize(stageW, stageH) {
      regenerate(stageW, stageH);
    }
  
    function recordPoint(x, y) {
      userPoints.push({ x, y });
      // Cap memory/perf for very long freehand sessions.
      if (userPoints.length > 4000) userPoints.shift();
    }
  
    function clearAttempt(stageW, stageH) {
      userPoints = [];
      if (callbacks.onHideFeedback) callbacks.onHideFeedback();
    }
  
    function switchShape(direction, stageW, stageH) {
      currentIndex = (currentIndex + direction + ShapeGeometry.SHAPE_LIST.length) % ShapeGeometry.SHAPE_LIST.length;
      userPoints = [];
      regenerate(stageW, stageH);
      updateLabel();
      if (callbacks.onHideFeedback) callbacks.onHideFeedback();
      if (callbacks.onShapeSwitch) callbacks.onShapeSwitch();
    }
  
    function next(stageW, stageH) {
      switchShape(1, stageW, stageH);
    }
  
    function prev(stageW, stageH) {
      switchShape(-1, stageW, stageH);
    }
  
    function checkDrawing() {
      const referencePoints = PracticeReference.getPoints();
      const result = ShapeEvaluator.evaluate(userPoints, referencePoints);
  
      if (result.insufficient) {
        if (callbacks.onInsufficientAttempt) callbacks.onInsufficientAttempt();
        return;
      }
  
      if (appState.particlesEnabled) {
        // Light celebratory sparkle burst along the reference outline.
        for (let i = 0; i < referencePoints.length; i += 8) {
          const p = referencePoints[i];
          ParticlePool.spawnSparkles(p.x, p.y, '#39ff14');
        }
      }
  
      if (callbacks.onResult) callbacks.onResult(result);
    }
  
    return {
      init,
      setActive,
      resize,
      recordPoint,
      clearAttempt,
      next,
      prev,
      checkDrawing,
    };
  })();
  
  /* =============================================================
     SECTION 17: CANVAS SETUP / RESIZE (DPR-aware)
     ============================================================= */
  function setupCanvasDPR(canvas, ctx) {
    canvas.width = stageWidth * DPR;
    canvas.height = stageHeight * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  
  function resizeCanvases() {
    stageWidth = appEl.clientWidth;
    stageHeight = appEl.clientHeight;
  
    const prevDraw = drawCanvas.width > 0 ? drawCanvas.toDataURL() : null;
    const prevBloom = bloomCanvas.width > 0 ? bloomCanvas.toDataURL() : null;
  
    setupCanvasDPR(overlayCanvas, overlayCtx);
    setupCanvasDPR(particleCanvas, particleCtx);
    setupCanvasDPR(bloomCanvas, bloomCtx);
    setupCanvasDPR(drawCanvas, drawCtx);
    setupCanvasDPR(practiceCanvas, practiceCtx);
    setupCanvasDPR(handCursorCanvas, handCursorCtx);
  
    if (prevDraw) {
      const img = new Image();
      img.onload = () => drawCtx.drawImage(img, 0, 0, stageWidth, stageHeight);
      img.src = prevDraw;
    }
    if (prevBloom) {
      const img = new Image();
      img.onload = () => bloomCtx.drawImage(img, 0, 0, stageWidth, stageHeight);
      img.src = prevBloom;
    }
  
    if (appState.mode === 'practice') {
      PracticeMode.resize(stageWidth, stageHeight);
    }
  }
  
  function setBloomVisibility() {
    bloomCanvas.style.opacity = appState.glowEnabled ? '0.85' : '0';
  }
  
  setBloomVisibility();
  
  /* =============================================================
     SECTION 18: MODE SWITCHING (Free Draw <-> Practice Mode)
     ============================================================= */
  function applyModeVisibility() {
    const isPractice = appState.mode === 'practice';
  
    practiceStage.classList.toggle('visible', isPractice);
    practiceNavGroup.classList.toggle('hidden', !isPractice);
  
    modeFreeBtn.classList.toggle('active', !isPractice);
    modePracticeBtn.classList.toggle('active', isPractice);
  }
  
  function setMode(mode) {
    if (appState.mode === mode) return;
    appState.mode = mode;
  
    resetHandRenderState(handRenderStates.Left);
    resetHandRenderState(handRenderStates.Right);
  
    applyModeVisibility();
    PracticeMode.setActive(mode === 'practice', stageWidth, stageHeight);
  }
  
  PracticeMode.init({
    onLabelChange: (label) => {
      shapeNameLabel.classList.add('swapping');
      setTimeout(() => {
        shapeNameLabel.textContent = label;
        shapeNameLabel.classList.remove('swapping');
      }, 150);
    },
    onShapeSwitch: () => {
      practiceStage.classList.add('fading');
      setTimeout(() => practiceStage.classList.remove('fading'), 300);
    },
    onResult: (result) => {
      feedbackPercent.textContent = `${result.percent}%`;
      feedbackMessage.textContent = result.message;
      practiceFeedbackCard.classList.remove('hidden');
    },
    onHideFeedback: () => {
      practiceFeedbackCard.classList.add('hidden');
    },
    onInsufficientAttempt: () => {
      feedbackPercent.textContent = '✏️';
      feedbackMessage.textContent = 'Keep going! Trace a bit more of the outline before checking.';
      practiceFeedbackCard.classList.remove('hidden');
    },
  });
  
  modeFreeBtn.addEventListener('click', () => setMode('free'));
  modePracticeBtn.addEventListener('click', () => setMode('practice'));
  
  shapePrevBtn.addEventListener('click', () => PracticeMode.prev(stageWidth, stageHeight));
  shapeNextBtn.addEventListener('click', () => PracticeMode.next(stageWidth, stageHeight));
  checkDrawingBtn.addEventListener('click', () => PracticeMode.checkDrawing());
  
  practiceTryAgainBtn.addEventListener('click', () => {
    practiceFeedbackCard.classList.add('hidden');
    drawCtx.clearRect(0, 0, stageWidth, stageHeight);
    bloomCtx.clearRect(0, 0, stageWidth, stageHeight);
    PracticeMode.clearAttempt(stageWidth, stageHeight);
  });
  
  practiceNextShapeBtn.addEventListener('click', () => {
    practiceFeedbackCard.classList.add('hidden');
    drawCtx.clearRect(0, 0, stageWidth, stageHeight);
    bloomCtx.clearRect(0, 0, stageWidth, stageHeight);
    PracticeMode.next(stageWidth, stageHeight);
  });
  
  /* =============================================================
     SECTION 19: HAND LANDMARKER SETUP (Tasks Vision)
     ============================================================= */
  let handLandmarker = null;
  let latestLandmarkResult = null;
  let appIsActive = false;
  
  async function initHandTracking() {
    resizeCanvases();
    window.addEventListener('resize', resizeCanvases);
  
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );
  
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
  
    startDetectionLoop();
  }
  
  function startDetectionLoop() {
    const useVideoFrameCallback = 'requestVideoFrameCallback' in videoElement;
  
    function detectFrame() {
      if (handLandmarker && videoElement.readyState >= 2) {
        const now = performance.now();
        const result = handLandmarker.detectForVideo(videoElement, now);
        latestLandmarkResult = result;
        HandInputStore.ingest(result, stageWidth, stageHeight, now);
      }
  
      if (appIsActive) {
        if (useVideoFrameCallback) {
          videoElement.requestVideoFrameCallback(detectFrame);
        } else {
          requestAnimationFrame(detectFrame);
        }
      }
    }
  
    if (useVideoFrameCallback) {
      videoElement.requestVideoFrameCallback(detectFrame);
    } else {
      requestAnimationFrame(detectFrame);
    }
  }
  
  /* =============================================================
     SECTION 20: LANDMARK OVERLAY RENDERING
     ============================================================= */
  function renderOverlay() {
    overlayCtx.clearRect(0, 0, stageWidth, stageHeight);
    if (!latestLandmarkResult || !latestLandmarkResult.landmarks) return;
  
    for (const landmarks of latestLandmarkResult.landmarks) {
      overlayCtx.strokeStyle = 'rgba(0, 255, 255, 0.6)';
      overlayCtx.lineWidth = 2;
      overlayCtx.shadowColor = '#00ffff';
      overlayCtx.shadowBlur = 8;
  
      for (const [a, b] of HAND_CONNECTIONS) {
        const start = landmarks[a];
        const end = landmarks[b];
        overlayCtx.beginPath();
        overlayCtx.moveTo(start.x * stageWidth, start.y * stageHeight);
        overlayCtx.lineTo(end.x * stageWidth, end.y * stageHeight);
        overlayCtx.stroke();
      }
  
      overlayCtx.fillStyle = '#00ffff';
      overlayCtx.shadowColor = '#00ffff';
      overlayCtx.shadowBlur = 15;
  
      for (const point of landmarks) {
        overlayCtx.beginPath();
        overlayCtx.arc(point.x * stageWidth, point.y * stageHeight, 6, 0, Math.PI * 2);
        overlayCtx.fill();
      }
    }
    overlayCtx.shadowBlur = 0;
  }
  
  /* =============================================================
     SECTION 21: RENDER ENGINE (single rAF loop)
     ------------------------------------------------------------
     processHand() is IDENTICAL for Free Draw and Practice Mode —
     both call the same DrawEngine/EraserEngine. The only Practice
     Mode addition is one extra call to PracticeMode.recordPoint()
     when actively drawing in that mode, purely for evaluation data.
     ============================================================= */
  const RenderEngine = (() => {
    let lastFrameTime = performance.now();
    let rafId = null;
  
    function processHand(label) {
      const hs = handRenderStates[label];
      const target = HandInputStore.getSlot(label);
  
      if (!target.valid) {
        DrawEngine.endStroke(hs);
        hs.mode = 'idle';
        hs.lastSampleT = 0;
        return target;
      }
  
      const isNewSample = target.t !== hs.lastSampleT;
  
      if (target.gesture === 'erase') {
        if (hs.mode !== 'erase') {
          DrawEngine.endStroke(hs);
          EraserEngine.eraseSingle(target.x, target.y);
        } else if (isNewSample && hs.lastProcessed) {
          EraserEngine.eraseSegment(hs.lastProcessed.x, hs.lastProcessed.y, target.x, target.y);
        }
        hs.mode = 'erase';
        hs.lastProcessed = { x: target.x, y: target.y };
        hs.lastSampleT = target.t;
        return target;
      }
  
      if (target.gesture === 'draw') {
        if (hs.mode !== 'draw') {
          DrawEngine.endStroke(hs);
        }
        if (isNewSample || hs.mode !== 'draw') {
          const speed = hs.lastProcessed
            ? Math.hypot(target.x - hs.lastProcessed.x, target.y - hs.lastProcessed.y) / 16
            : 0;
  
          DrawEngine.processDraw(hs, target, speed);
  
          if (appState.mode === 'practice' && !target.predicted) {
            PracticeMode.recordPoint(target.x, target.y);
          }
  
          if (appState.particlesEnabled && !target.predicted) {
            ParticlePool.spawnSparkles(target.x, target.y, currentBrushColor());
            if (speed > 1.0) ParticlePool.spawnExplosion(target.x, target.y, speed * 6, currentBrushColor());
          }
        }
        hs.mode = 'draw';
        hs.lastSampleT = target.t;
        return target;
      }
  
      // 'idle' or 'open' -> stop
      DrawEngine.endStroke(hs);
      hs.mode = 'idle';
      hs.lastSampleT = target.t;
      return target;
    }
  
    function tick(now) {
      if (!appIsActive) return;
  
      const dt = now - lastFrameTime;
      lastFrameTime = now;
      const dtScale = Math.min(dt / 16.6667, 3);
  
      advanceRainbowHue(dt);
  
      const targets = {
        Left: processHand('Left'),
        Right: processHand('Right'),
      };
  
      const cursorStates = {
        Left: CursorFX.update('Left', targets.Left, handRenderStates.Left.mode),
        Right: CursorFX.update('Right', targets.Right, handRenderStates.Right.mode),
      };
  
      const anyDrawing =
        handRenderStates.Left.mode === 'draw' || handRenderStates.Right.mode === 'draw';
      MiniReminder.setDrawingActive(anyDrawing);
  
      particleCtx.clearRect(0, 0, stageWidth, stageHeight);
      ParticlePool.updateAndDraw(particleCtx, dtScale);
  
      renderOverlay();
  
      if (appState.mode === 'practice') {
        PracticeReference.render(practiceCtx, stageWidth, stageHeight);
      }
  
      handCursorCtx.clearRect(0, 0, stageWidth, stageHeight);
      CursorFX.render(handCursorCtx, cursorStates.Left);
      CursorFX.render(handCursorCtx, cursorStates.Right);
  
      rafId = requestAnimationFrame(tick);
    }
  
    function start() {
      lastFrameTime = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  
    function stop() {
      if (rafId) cancelAnimationFrame(rafId);
    }
  
    return { start, stop };
  })();
  
  /* =============================================================
     SECTION 22: UI CONTROLS (Clear / Save / Sliders / Toggles)
     ============================================================= */
  function clearCanvas() {
    drawCtx.clearRect(0, 0, stageWidth, stageHeight);
    bloomCtx.clearRect(0, 0, stageWidth, stageHeight);
    ParticlePool.clear();
    resetHandRenderState(handRenderStates.Left);
    resetHandRenderState(handRenderStates.Right);
  
    if (appState.mode === 'practice') {
      PracticeMode.clearAttempt(stageWidth, stageHeight);
    }
  }
  
  function saveArtwork() {
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = stageWidth;
    exportCanvas.height = stageHeight;
    const exportCtx = exportCanvas.getContext('2d');
  
    exportCtx.fillStyle = '#000';
    exportCtx.fillRect(0, 0, stageWidth, stageHeight);
  
    if (appState.glowEnabled) {
      exportCtx.globalAlpha = 0.85;
      exportCtx.filter = 'blur(10px) brightness(1.3)';
      exportCtx.drawImage(bloomCanvas, 0, 0, stageWidth, stageHeight);
      exportCtx.filter = 'none';
      exportCtx.globalAlpha = 1;
    }
  
    exportCtx.drawImage(drawCanvas, 0, 0, stageWidth, stageHeight);
  
    const link = document.createElement('a');
    link.download = `neon-artwork-${Date.now()}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
  }
  
  function toggleGlow() {
    appState.glowEnabled = !appState.glowEnabled;
    glowToggle.classList.toggle('active', appState.glowEnabled);
    setBloomVisibility();
  }
  
  function toggleRainbow() {
    appState.rainbowEnabled = !appState.rainbowEnabled;
    rainbowToggle.classList.toggle('active', appState.rainbowEnabled);
  }
  
  function toggleParticles() {
    appState.particlesEnabled = !appState.particlesEnabled;
    particleToggle.classList.toggle('active', appState.particlesEnabled);
    if (!appState.particlesEnabled) ParticlePool.clear();
  }
  
  clearBtn.addEventListener('click', clearCanvas);
  saveBtn.addEventListener('click', saveArtwork);
  glowToggle.addEventListener('click', toggleGlow);
  rainbowToggle.addEventListener('click', toggleRainbow);
  particleToggle.addEventListener('click', toggleParticles);
  
  brushSizeSlider.addEventListener('input', (e) => {
    appState.brushSize = parseInt(e.target.value, 10);
  });
  
  colorPicker.addEventListener('input', (e) => {
    appState.brushColor = e.target.value;
  });
  
  colorSwatches.forEach((swatch) => {
    swatch.addEventListener('click', () => {
      const color = swatch.dataset.color;
      appState.brushColor = color;
      colorPicker.value = color;
    });
  });
  
  window.addEventListener('keydown', (e) => {
    if (!appIsActive) return;
    const key = e.key.toLowerCase();
    if (key === 'c') clearCanvas();
    if (key === 's') saveArtwork();
  });
  
  /* =============================================================
     SECTION 23: WEBCAM BOOTSTRAP
     ============================================================= */
  async function startWebcam() {
    let stream;
  
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          facingMode: 'user',
        },
        audio: false,
      });
    } catch (error) {
      console.error('[Gesture Canvas] Webcam permission/access error:', error);
      alert(
        'Could not access your webcam. Please check that camera permission is granted for this site and that no other application is using the camera.'
      );
      return;
    }
  
    videoElement.srcObject = stream;
  
    await new Promise((resolve) => {
      videoElement.onloadedmetadata = () => resolve();
    });
  
    try {
      appIsActive = true;
      await initHandTracking();
      RenderEngine.start();
      OnboardingController.show();
    } catch (error) {
      console.error('[Gesture Canvas] Hand-tracking initialization error:', error);
      appIsActive = false;
      alert(
        'Your webcam is working, but hand tracking failed to load (unrelated to camera permissions). Check the browser console for details, and try refreshing the page.'
      );
    }
  }
  
  /* =============================================================
     SECTION 24: INIT
     ============================================================= */
  startWebcam();