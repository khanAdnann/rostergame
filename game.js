(function () {
  'use strict';

  var loadingScreen = document.getElementById('loading-screen');

  if (!window.THREE) {
    if (loadingScreen) {
      loadingScreen.classList.add('is-error');
      loadingScreen.innerHTML = '<span>THREE.JS FAILED TO LOAD. CHECK YOUR CONNECTION AND RELOAD.</span>';
    }
    return;
  }

  /* ------------------------------------------------------------------ */
  /* Constants and helpers                                               */
  /* ------------------------------------------------------------------ */

  var STEP = 1 / 120;
  var TAU = Math.PI * 2;

  var CFG = {
    gravity: 32.2 * 0.32,
    mphToWorld: 1.4666667 * 0.18,
    rideHeight: 1.06,
    startX: -56,
    driveAccel: 52,
    thrust: 26,
    gasDrain: 0.28,
    gasRefill: 0.35,
    sinkLimit: 39,
    uprightLimit: 28 * Math.PI / 180,
    angularAccel: 6.1,
    angularDamping: 0.96,
    maxOmega: 7.2,
    landingDelay: 1.75,
    crashDelay: 2.25,
    ringCount: 6
  };

  var RAMP = {
    radius: 22,
    wallHeight: 14,
    curlRadius: 9,
    curlSweep: 22 * Math.PI / 180,
    width: 18
  };

  var COLORS = {
    cyan: 0x59e6ff,
    cyanHot: 0xc6f8ff,
    violet: 0x9d7cff,
    orange: 0xff9654,
    red: 0xff4d58,
    green: 0x63ffa4,
    white: 0xe9fbff
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function lerp(a, b, amount) {
    return a + (b - a) * amount;
  }

  function damp(current, target, lambda, dt) {
    return lerp(current, target, 1 - Math.exp(-lambda * dt));
  }

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function normalizeAngle(angle) {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
  }

  function isUpsideDown(angle) {
    return Math.abs(normalizeAngle(angle)) > Math.PI / 2;
  }

  function padScore(value) {
    return String(Math.max(0, Math.floor(value || 0))).padStart(6, '0');
  }

  function formatScore(value) {
    return Math.max(0, Math.round(value || 0)).toLocaleString('en-US');
  }

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, String(value));
    } catch (error) {
      /* Storage is unavailable in some embedded contexts. */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Sound                                                               */
  /* ------------------------------------------------------------------ */

  var SoundFX = {
    ctx: null,
    master: null,
    noiseBuffer: null,
    thrustGain: null,
    muted: false,

    init: function () {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return;
      }

      var AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return;

      try {
        this.ctx = new AudioCtor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.72;
        this.master.connect(this.ctx.destination);
        this.makeNoise();
        this.makeThrustLoop();
      } catch (error) {
        this.ctx = null;
      }
    },

    makeNoise: function () {
      var length = Math.floor(this.ctx.sampleRate * 1.6);
      var buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      var data = buffer.getChannelData(0);
      for (var i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buffer;
    },

    makeThrustLoop: function () {
      var source = this.ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      source.loop = true;

      var filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 560;
      filter.Q.value = 0.7;

      var gain = this.ctx.createGain();
      gain.gain.value = 0;

      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      source.start();
      this.thrustGain = gain;
    },

    setMuted: function (muted) {
      this.muted = muted;
      if (!this.ctx) return;
      var now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(muted ? 0 : 0.72, now, 0.025);
    },

    setThrust: function (active) {
      if (!this.ctx || !this.thrustGain) return;
      var now = this.ctx.currentTime;
      this.thrustGain.gain.cancelScheduledValues(now);
      this.thrustGain.gain.setTargetAtTime(active ? 0.15 : 0, now, 0.045);
    },

    tone: function (frequency, duration, type, volume, endFrequency) {
      if (!this.ctx) return;
      var now = this.ctx.currentTime;
      var oscillator = this.ctx.createOscillator();
      var gain = this.ctx.createGain();
      oscillator.type = type || 'sine';
      oscillator.frequency.setValueAtTime(frequency, now);
      if (endFrequency) {
        oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + duration);
      }
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(volume || 0.08, now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      oscillator.connect(gain);
      gain.connect(this.master);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.03);
    },

    noiseBurst: function (duration, volume, filterFrequency, filterType) {
      if (!this.ctx || !this.noiseBuffer) return;
      var now = this.ctx.currentTime;
      var source = this.ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      source.playbackRate.value = rand(0.8, 1.15);

      var filter = this.ctx.createBiquadFilter();
      filter.type = filterType || 'lowpass';
      filter.frequency.setValueAtTime(filterFrequency || 900, now);
      filter.frequency.exponentialRampToValueAtTime(80, now + duration);

      var gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(volume || 0.3, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      source.start(now);
      source.stop(now + duration + 0.05);
    },

    tick: function () {
      this.tone(440, 0.045, 'square', 0.025, 390);
    },

    early: function () {
      this.tone(185, 0.13, 'square', 0.06, 135);
      var self = this;
      window.setTimeout(function () {
        self.tone(120, 0.18, 'square', 0.055, 95);
      }, 100);
    },

    green: function () {
      this.tone(820, 0.08, 'sine', 0.075, 980);
      this.tone(1230, 0.12, 'sine', 0.035, 1420);
    },

    launch: function () {
      this.tone(90, 0.72, 'sawtooth', 0.06, 300);
      this.noiseBurst(0.55, 0.12, 1600, 'bandpass');
    },

    ramp: function () {
      this.noiseBurst(0.4, 0.05, 620, 'bandpass');
    },

    ring: function () {
      this.tone(940, 0.1, 'sine', 0.075, 1280);
      var self = this;
      window.setTimeout(function () {
        self.tone(1420, 0.18, 'sine', 0.045, 1720);
      }, 55);
    },

    flip: function () {
      this.noiseBurst(0.25, 0.06, 2500, 'highpass');
    },

    land: function () {
      this.noiseBurst(0.3, 0.24, 430, 'lowpass');
      this.tone(74, 0.18, 'sine', 0.08, 48);
    },

    crash: function () {
      this.noiseBurst(0.9, 0.42, 1800, 'lowpass');
      this.tone(52, 0.7, 'sawtooth', 0.11, 30);
      var self = this;
      window.setTimeout(function () {
        self.noiseBurst(0.5, 0.18, 620, 'lowpass');
      }, 150);
    }
  };

  /* ------------------------------------------------------------------ */
  /* DOM and state                                                       */
  /* ------------------------------------------------------------------ */

  var dom = {
    canvas: document.getElementById('game-canvas'),
    loading: loadingScreen,
    bestScore: document.getElementById('best-score'),
    titleBest: document.getElementById('title-best'),
    soundToggle: document.getElementById('sound-toggle'),
    soundLabel: document.querySelector('#sound-toggle .sound-label'),
    startLights: document.getElementById('start-lights'),
    lightsStatus: document.getElementById('lights-status'),
    lamps: Array.prototype.slice.call(document.querySelectorAll('.lamp')),
    runHud: document.getElementById('run-hud'),
    hudSpeed: document.getElementById('hud-speed'),
    hudAltitude: document.getElementById('hud-altitude'),
    hudRings: document.getElementById('hud-rings'),
    hudFlips: document.getElementById('hud-flips'),
    hudTilt: document.getElementById('hud-tilt'),
    gasFill: document.getElementById('gas-fill'),
    gasValue: document.getElementById('gas-value'),
    announce: document.getElementById('announce'),
    titleScreen: document.getElementById('title-screen'),
    resultsScreen: document.getElementById('results-screen'),
    startButton: document.getElementById('start-button'),
    retryButton: document.getElementById('retry-button'),
    homeButton: document.getElementById('home-button'),
    resultOutcome: document.getElementById('result-outcome'),
    newBest: document.getElementById('new-best'),
    resultGrade: document.getElementById('result-grade'),
    resultScore: document.getElementById('result-score'),
    resultReaction: document.getElementById('result-reaction'),
    resultRampSpeed: document.getElementById('result-ramp-speed'),
    resultPeakG: document.getElementById('result-peak-g'),
    resultAltitude: document.getElementById('result-altitude'),
    resultAirtime: document.getElementById('result-airtime'),
    resultFlips: document.getElementById('result-flips'),
    resultRings: document.getElementById('result-rings'),
    resultTouchdown: document.getElementById('result-touchdown'),
    resultSoft: document.getElementById('result-soft'),
    touchControls: document.getElementById('touch-controls'),
    touchLeft: document.getElementById('touch-left'),
    touchRight: document.getElementById('touch-right'),
    touchThrust: document.getElementById('touch-thrust')
  };

  var state = 'title';
  var stateTime = 0;
  var accumulator = 0;
  var previousFrame = 0;
  var elapsed = 0;
  var green = false;
  var greenAtMs = 0;
  var inputLock = 0;
  var countdownTime = 0;
  var lastLit = 0;
  var wheelSpin = 0;
  var cameraShake = 0;
  var announcerTimeout = null;
  var scoreAnimation = null;
  var muted = safeStorageGet('roadsterLoop.muted') === '1';
  var best = parseInt(safeStorageGet('roadsterLoop.best') || '0', 10);
  if (!Number.isFinite(best) || best < 0) best = 0;

  var keys = { left: false, right: false, space: false };

  var car = {
    x: CFG.startX,
    y: CFG.rideHeight,
    vx: 0,
    vy: 0,
    angle: 0,
    omega: 0,
    speed: 0
  };

  var run = createRunState();
  var rampS = 0;
  var targetSpeed = 0;

  function createRunState() {
    return {
      outcome: 'none',
      reaction: 0,
      rampSpeedMph: 0,
      maxAltitude: 0,
      airTime: 0,
      flips: 0,
      rings: 0,
      touchdown: 0,
      peakG: 1,
      gas: 1,
      wasUpsideDown: false,
      thrusting: false,
      softBonus: 0,
      score: 0,
      newBest: false
    };
  }

  /* ------------------------------------------------------------------ */
  /* Three.js globals                                                    */
  /* ------------------------------------------------------------------ */

  var scene = null;
  var camera = null;
  var renderer = null;
  var cameraLook = null;
  var cameraDesired = null;

  var glowTexture = null;
  var carRoot = null;
  var carShadow = null;
  var thrusterLight = null;
  var thrusterGroups = [];
  var thrusterOuterMaterial = null;
  var thrusterInnerMaterial = null;
  var wheelGroups = [];
  var rings = [];
  var ringGroup = null;
  var rampPath = null;
  var effects = [];
  var fxSphereGeometry = null;
  var fxBoxGeometry = null;

  function makeGlowTexture() {
    var canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    var ctx = canvas.getContext('2d');
    var gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.18, 'rgba(255,255,255,0.9)');
    gradient.addColorStop(0.42, 'rgba(255,255,255,0.38)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    var texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
  }

  function addGlowSprite(parent, color, scale, opacity) {
    var material = new THREE.SpriteMaterial({
      map: glowTexture,
      color: color,
      transparent: true,
      opacity: opacity === undefined ? 0.8 : opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    });
    var sprite = new THREE.Sprite(material);
    sprite.scale.set(scale, scale, 1);
    parent.add(sprite);
    return sprite;
  }

  function buildRampPathData() {
    var points = [];
    var total = 0;
    var quarterSamples = 96;
    var wallSamples = 40;
    var curlSamples = 32;

    function addPoint(x, y, tx, ty, radius) {
      var length = Math.hypot(tx, ty) || 1;
      if (points.length) {
        var previous = points[points.length - 1];
        total += Math.hypot(x - previous.x, y - previous.y);
      }
      points.push({
        x: x,
        y: y,
        tx: tx / length,
        ty: ty / length,
        s: total,
        radius: radius
      });
    }

    var i;
    var t;

    for (i = 0; i <= quarterSamples; i += 1) {
      t = (i / quarterSamples) * Math.PI / 2;
      addPoint(
        RAMP.radius * Math.sin(t),
        RAMP.radius * (1 - Math.cos(t)),
        Math.cos(t),
        Math.sin(t),
        RAMP.radius
      );
    }

    for (i = 1; i <= wallSamples; i += 1) {
      addPoint(22, 22 + RAMP.wallHeight * (i / wallSamples), 0, 1, 0);
    }

    var curlCenterX = 22 + RAMP.curlRadius;
    var curlCenterY = 22 + RAMP.wallHeight;

    for (i = 1; i <= curlSamples; i += 1) {
      t = Math.PI - RAMP.curlSweep * (i / curlSamples);
      addPoint(
        curlCenterX + RAMP.curlRadius * Math.cos(t),
        curlCenterY + RAMP.curlRadius * Math.sin(t),
        Math.sin(t),
        -Math.cos(t),
        RAMP.curlRadius
      );
    }

    var lip = points[points.length - 1];
    return {
      points: points,
      total: total,
      lip: lip,
      lipAngle: Math.atan2(lip.ty, lip.tx),
      quarterLength: RAMP.radius * Math.PI / 2
    };
  }

  function sampleRamp(distance) {
    var s = clamp(distance, 0, rampPath.total);
    var points = rampPath.points;
    var low = 0;
    var high = points.length - 1;

    while (low < high - 1) {
      var mid = (low + high) >> 1;
      if (points[mid].s <= s) low = mid;
      else high = mid;
    }

    var a = points[low];
    var b = points[high];
    var span = b.s - a.s;
    var t = span > 0.00001 ? (s - a.s) / span : 0;
    var tx = lerp(a.tx, b.tx, t);
    var ty = lerp(a.ty, b.ty, t);
    var tangentLength = Math.hypot(tx, ty) || 1;

    return {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      tx: tx / tangentLength,
      ty: ty / tangentLength,
      angle: Math.atan2(ty, tx),
      radius: b.radius,
      s: s
    };
  }

  function initScene() {
    renderer = new THREE.WebGLRenderer({
      canvas: dom.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x040813, 160, 720);

    camera = new THREE.PerspectiveCamera(49, window.innerWidth / window.innerHeight, 0.1, 1800);
    camera.position.set(-82, 12, 56);
    cameraLook = new THREE.Vector3(-50, 7.5, 0);
    cameraDesired = new THREE.Vector3();

    glowTexture = makeGlowTexture();
    fxSphereGeometry = new THREE.SphereGeometry(0.18, 7, 5);
    fxBoxGeometry = new THREE.BoxGeometry(0.34, 0.2, 0.6);
    rampPath = buildRampPathData();

    buildLights();
    buildSky();
    buildCity();
    buildCourse();
    buildRamp();
    buildRings();
    buildCar();

    window.addEventListener('resize', onResize);
  }

  function onResize() {
    if (!renderer || !camera) return;
    var width = window.innerWidth;
    var height = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }

  function buildLights() {
    scene.add(new THREE.HemisphereLight(0x3c6982, 0x020306, 0.78));
    scene.add(new THREE.AmbientLight(0x1e2d3f, 0.55));

    var moonLight = new THREE.DirectionalLight(0xa6d6ff, 1.32);
    moonLight.position.set(-60, 110, 80);
    moonLight.target.position.set(20, 0, 0);
    scene.add(moonLight);
    scene.add(moonLight.target);

    var cityLight = new THREE.DirectionalLight(0x765dff, 0.38);
    cityLight.position.set(80, 35, -120);
    cityLight.target.position.set(20, 20, 0);
    scene.add(cityLight);
    scene.add(cityLight.target);

    var rampGlow = new THREE.PointLight(0x3dddff, 1.15, 95, 2);
    rampGlow.position.set(30, 35, 12);
    scene.add(rampGlow);

    var landingGlow = new THREE.PointLight(0x735cff, 0.9, 80, 2);
    landingGlow.position.set(76, 4, 8);
    scene.add(landingGlow);
  }

  function buildSky() {
    var skyGeometry = new THREE.SphereGeometry(880, 36, 22);
    var skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x02040b) },
        horizonColor: { value: new THREE.Color(0x0b1930) },
        bottomColor: { value: new THREE.Color(0x050810) }
      },
      vertexShader: [
        'varying vec3 vWorldPosition;',
        'void main() {',
        '  vec4 worldPosition = modelMatrix * vec4(position, 1.0);',
        '  vWorldPosition = worldPosition.xyz;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 topColor;',
        'uniform vec3 horizonColor;',
        'uniform vec3 bottomColor;',
        'varying vec3 vWorldPosition;',
        'void main() {',
        '  float h = normalize(vWorldPosition).y;',
        '  vec3 color = mix(bottomColor, horizonColor, smoothstep(-0.10, 0.04, h));',
        '  color = mix(color, topColor, smoothstep(0.05, 0.66, h));',
        '  float horizonGlow = pow(max(0.0, 1.0 - abs(h - 0.01)), 14.0);',
        '  color += vec3(0.035, 0.075, 0.085) * horizonGlow;',
        '  gl_FragColor = vec4(color, 1.0);',
        '}'
      ].join('\n'),
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    });
    var sky = new THREE.Mesh(skyGeometry, skyMaterial);
    sky.frustumCulled = false;
    scene.add(sky);

    var starPositions = [];
    var starColors = [];
    var starColor = new THREE.Color();

    for (var i = 0; i < 950; i += 1) {
      var theta = Math.random() * TAU;
      var cosPhi = rand(-0.08, 0.98);
      var sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
      var radius = rand(560, 790);
      starPositions.push(
        Math.cos(theta) * sinPhi * radius,
        cosPhi * radius,
        Math.sin(theta) * sinPhi * radius
      );
      var tint = Math.random();
      if (tint > 0.82) starColor.setHex(0xffd7b0);
      else if (tint > 0.65) starColor.setHex(0x9dbbff);
      else starColor.setHex(0xd7f4ff);
      var brightness = rand(0.45, 1);
      starColors.push(starColor.r * brightness, starColor.g * brightness, starColor.b * brightness);
    }

    var starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
    starGeometry.setAttribute('color', new THREE.Float32BufferAttribute(starColors, 3));
    var stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({
      map: glowTexture,
      size: 2.2,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    }));
    scene.add(stars);

    var moon = new THREE.Mesh(
      new THREE.CircleGeometry(9, 40),
      new THREE.MeshBasicMaterial({ color: 0xd7ebff, fog: false })
    );
    moon.position.set(176, 144, -350);
    scene.add(moon);

    var moonAura = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0x9bcaff,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    }));
    moonAura.scale.set(84, 84, 1);
    moonAura.position.set(176, 144, -352);
    scene.add(moonAura);

    var nebulaA = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0x4936b5,
      transparent: true,
      opacity: 0.09,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    }));
    nebulaA.scale.set(340, 210, 1);
    nebulaA.position.set(-90, 120, -410);
    scene.add(nebulaA);

    var nebulaB = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0x1b789a,
      transparent: true,
      opacity: 0.07,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    }));
    nebulaB.scale.set(420, 180, 1);
    nebulaB.position.set(290, 60, -430);
    scene.add(nebulaB);
  }

  function buildCity() {
    var group = new THREE.Group();
    var buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
    var materials = [
      new THREE.MeshStandardMaterial({ color: 0x070c16, roughness: 0.82, metalness: 0.28 }),
      new THREE.MeshStandardMaterial({ color: 0x09111d, roughness: 0.78, metalness: 0.34 }),
      new THREE.MeshStandardMaterial({ color: 0x0a0c18, roughness: 0.88, metalness: 0.2 })
    ];
    var windowPositions = [];
    var windowColors = [];
    var color = new THREE.Color();
    var count = 58;

    for (var i = 0; i < count; i += 1) {
      var width = rand(7, 25);
      var depth = rand(7, 21);
      var height = 10 + Math.pow(Math.random(), 1.65) * 80;
      var x = -230 + (i / (count - 1)) * 860 + rand(-10, 10);
      var z = rand(-245, -95);
      var mesh = new THREE.Mesh(buildingGeometry, materials[i % materials.length]);
      mesh.position.set(x, height / 2 - 1.4, z);
      mesh.scale.set(width, height, depth);
      group.add(mesh);

      if (Math.random() > 0.25) {
        var roofLight = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTexture,
          color: Math.random() > 0.55 ? 0xff7b5a : 0x5edcff,
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false
        }));
        roofLight.scale.set(3.2, 3.2, 1);
        roofLight.position.set(x, height - 0.6, z + depth / 2 + 0.4);
        group.add(roofLight);
      }

      var windows = Math.floor(rand(4, 16));
      for (var w = 0; w < windows; w += 1) {
        var wx = x + rand(-width * 0.4, width * 0.4);
        var wy = rand(2, height - 3);
        windowPositions.push(wx, wy, z + depth / 2 + 0.08);
        if (Math.random() > 0.72) color.setHex(0xffb480);
        else if (Math.random() > 0.56) color.setHex(0x99eaff);
        else color.setHex(0x5b86d9);
        var alpha = rand(0.4, 1);
        windowColors.push(color.r * alpha, color.g * alpha, color.b * alpha);
      }
    }

    var windowGeometry = new THREE.BufferGeometry();
    windowGeometry.setAttribute('position', new THREE.Float32BufferAttribute(windowPositions, 3));
    windowGeometry.setAttribute('color', new THREE.Float32BufferAttribute(windowColors, 3));
    var windowPoints = new THREE.Points(windowGeometry, new THREE.PointsMaterial({
      map: glowTexture,
      size: 0.92,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    }));
    group.add(windowPoints);
    scene.add(group);
  }

  function makeSignTexture(title, subtitle, accent) {
    var canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 256;
    var ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, 1024, 256);
    ctx.fillStyle = 'rgba(4, 10, 18, 0.9)';
    ctx.fillRect(0, 0, 1024, 256);

    ctx.strokeStyle = accent || 'rgba(89,230,255,0.7)';
    ctx.lineWidth = 4;
    ctx.strokeRect(10, 10, 1004, 236);
    ctx.strokeStyle = 'rgba(89,230,255,0.22)';
    ctx.lineWidth = 2;
    ctx.strokeRect(26, 26, 972, 204);

    ctx.fillStyle = 'rgba(89,230,255,0.78)';
    ctx.fillRect(44, 62, 8, 132);

    ctx.font = '700 76px Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e9fbff';
    ctx.fillText(title, 82, 119);

    ctx.font = '600 25px Arial, sans-serif';
    ctx.fillStyle = accent || '#59e6ff';
    ctx.fillText(subtitle, 86, 192);

    ctx.textAlign = 'right';
    ctx.font = '600 20px Arial, sans-serif';
    ctx.fillStyle = 'rgba(163,197,210,0.8)';
    ctx.fillText('NIGHT RAMP PROGRAM', 970, 192);

    var texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
  }

  function buildCourse() {
    var ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1400, 500),
      new THREE.MeshStandardMaterial({ color: 0x04070d, roughness: 0.91, metalness: 0.08 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(300, -0.18, 0);
    scene.add(ground);

    var road = new THREE.Mesh(
      new THREE.PlaneGeometry(1400, 26),
      new THREE.MeshStandardMaterial({ color: 0x0b1018, roughness: 0.34, metalness: 0.62 })
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(290, 0.005, 0);
    scene.add(road);

    var edgeMaterial = new THREE.MeshBasicMaterial({
      color: 0x39dfff,
      transparent: true,
      opacity: 0.52,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    var edgeGeometry = new THREE.BoxGeometry(1200, 0.028, 0.08);
    var leftEdge = new THREE.Mesh(edgeGeometry, edgeMaterial);
    leftEdge.position.set(260, 0.035, -11.7);
    scene.add(leftEdge);
    var rightEdge = leftEdge.clone();
    rightEdge.position.z = 11.7;
    scene.add(rightEdge);

    var markGeometry = new THREE.BoxGeometry(4.3, 0.018, 0.075);
    var markMaterial = new THREE.MeshBasicMaterial({ color: 0x243c4b, transparent: true, opacity: 0.72 });

    for (var x = -120; x < 640; x += 13) {
      var markA = new THREE.Mesh(markGeometry, markMaterial);
      markA.position.set(x, 0.028, -5.9);
      scene.add(markA);
      var markB = markA.clone();
      markB.position.z = 5.9;
      scene.add(markB);
    }

    var gridCanvas = document.createElement('canvas');
    gridCanvas.width = 512;
    gridCanvas.height = 512;
    var gridCtx = gridCanvas.getContext('2d');
    var cell = 32;
    for (var gy = 0; gy < 16; gy += 1) {
      for (var gx = 0; gx < 16; gx += 1) {
        if ((gx + gy) % 2 === 0) {
          gridCtx.fillStyle = 'rgba(218,247,255,0.38)';
          gridCtx.fillRect(gx * cell, gy * cell, cell, cell);
        }
      }
    }
    var gridTexture = new THREE.CanvasTexture(gridCanvas);
    var startGrid = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 17),
      new THREE.MeshBasicMaterial({
        map: gridTexture,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    startGrid.rotation.x = -Math.PI / 2;
    startGrid.position.set(CFG.startX, 0.04, 0);
    scene.add(startGrid);

    var landingCanvas = document.createElement('canvas');
    landingCanvas.width = 1024;
    landingCanvas.height = 512;
    var landingCtx = landingCanvas.getContext('2d');

    landingCtx.strokeStyle = 'rgba(89,230,255,0.65)';
    landingCtx.lineWidth = 5;
    landingCtx.strokeRect(18, 18, 988, 476);
    landingCtx.strokeStyle = 'rgba(89,230,255,0.2)';
    landingCtx.lineWidth = 2;
    landingCtx.strokeRect(42, 42, 940, 428);
    landingCtx.fillStyle = 'rgba(89,230,255,0.105)';
    landingCtx.fillRect(18, 18, 988, 476);

    landingCtx.fillStyle = 'rgba(159,238,255,0.78)';
    landingCtx.font = '700 62px Arial, sans-serif';
    landingCtx.textAlign = 'center';
    landingCtx.fillText('LANDING ZONE', 512, 160);

    landingCtx.fillStyle = 'rgba(159,238,255,0.32)';
    landingCtx.font = '600 24px Arial, sans-serif';
    landingCtx.fillText('SINK < 39 FT/S   //   TILT < 28 DEG', 512, 214);

    landingCtx.strokeStyle = 'rgba(89,230,255,0.45)';
    landingCtx.lineWidth = 8;
    for (var a = 0; a < 5; a += 1) {
      var ax = 260 + a * 126;
      landingCtx.beginPath();
      landingCtx.moveTo(ax - 45, 330);
      landingCtx.lineTo(ax, 378);
      landingCtx.lineTo(ax + 45, 330);
      landingCtx.stroke();
    }

    var landingTexture = new THREE.CanvasTexture(landingCanvas);
    landingTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    var landingZone = new THREE.Mesh(
      new THREE.PlaneGeometry(58, 22),
      new THREE.MeshBasicMaterial({
        map: landingTexture,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    landingZone.rotation.x = -Math.PI / 2;
    landingZone.position.set(72, 0.045, 0);
    scene.add(landingZone);

    buildRoadLights();
    buildGantry();
  }

  function buildRoadLights() {
    var poleGeometry = new THREE.CylinderGeometry(0.075, 0.1, 8, 8);
    var poleMaterial = new THREE.MeshStandardMaterial({ color: 0x111a24, roughness: 0.48, metalness: 0.7 });
    var orbGeometry = new THREE.SphereGeometry(0.18, 10, 8);
    var poolGeometry = new THREE.CircleGeometry(3.4, 20);

    for (var x = -118; x < 610; x += 34) {
      for (var side = -1; side <= 1; side += 2) {
        var pole = new THREE.Mesh(poleGeometry, poleMaterial);
        pole.position.set(x, 4, side * 16.5);
        scene.add(pole);

        var isWarm = ((x + 118) / 34) % 4 === 0;
        var orb = new THREE.Mesh(orbGeometry, new THREE.MeshBasicMaterial({
          color: isWarm ? 0xffa66b : 0x75ebff
        }));
        orb.position.set(x, 8, side * 16.5);
        scene.add(orb);

        var glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTexture,
          color: isWarm ? 0xff9a5b : 0x59e6ff,
          transparent: true,
          opacity: 0.48,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        }));
        glow.scale.set(5.5, 5.5, 1);
        glow.position.copy(orb.position);
        scene.add(glow);

        var pool = new THREE.Mesh(poolGeometry, new THREE.MeshBasicMaterial({
          map: glowTexture,
          color: isWarm ? 0xff9a5b : 0x3dcdf7,
          transparent: true,
          opacity: 0.13,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        }));
        pool.rotation.x = -Math.PI / 2;
        pool.position.set(x, 0.03, side * 15.2);
        scene.add(pool);
      }
    }
  }

  function buildGantry() {
    var metal = new THREE.MeshStandardMaterial({ color: 0x101a26, roughness: 0.38, metalness: 0.8 });
    var postGeometry = new THREE.BoxGeometry(0.45, 14.5, 0.45);
    var leftPost = new THREE.Mesh(postGeometry, metal);
    leftPost.position.set(-67, 7.25, -13.2);
    scene.add(leftPost);
    var rightPost = leftPost.clone();
    rightPost.position.z = 13.2;
    scene.add(rightPost);

    var beam = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.55, 27), metal);
    beam.position.set(-67, 14.4, 0);
    scene.add(beam);

    var neonMaterial = new THREE.MeshBasicMaterial({
      color: 0x59e6ff,
      transparent: true,
      opacity: 0.76,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    var neonLeft = new THREE.Mesh(new THREE.BoxGeometry(0.08, 13.8, 0.08), neonMaterial);
    neonLeft.position.set(-66.72, 7.25, -13.45);
    scene.add(neonLeft);
    var neonRight = neonLeft.clone();
    neonRight.position.z = 13.45;
    scene.add(neonRight);

    var signTexture = makeSignTexture('ROADSTER LOOP', 'AERON R1 / NIGHT RUN', '#59e6ff');
    var sign = new THREE.Mesh(
      new THREE.PlaneGeometry(15, 3.75),
      new THREE.MeshBasicMaterial({
        map: signTexture,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        fog: false
      })
    );
    sign.position.set(-67, 12.25, 0.36);
    scene.add(sign);

    var lampGeometry = new THREE.SphereGeometry(0.17, 8, 6);
    var lampMaterial = new THREE.MeshBasicMaterial({ color: 0xff4d58 });
    for (var i = 0; i < 5; i += 1) {
      var lamp = new THREE.Mesh(lampGeometry, lampMaterial);
      lamp.position.set(-67, 14.95, -8 + i * 4);
      scene.add(lamp);
      var glow = addGlowSprite(scene, 0xff4d58, 2.8, 0.42);
      glow.position.copy(lamp.position);
    }
  }

  function buildRamp() {
    var shape = new THREE.Shape();
    var points = rampPath.points;
    shape.moveTo(points[0].x, points[0].y);

    for (var i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i].x, points[i].y);
    }

    var lip = rampPath.lip;
    shape.lineTo(lip.x, 0);
    shape.lineTo(0, 0);
    shape.closePath();

    var geometry = new THREE.ExtrudeGeometry(shape, {
      depth: RAMP.width,
      bevelEnabled: false,
      curveSegments: 24,
      steps: 1
    });
    geometry.translate(0, 0, -RAMP.width / 2);
    geometry.computeVertexNormals();

    var ramp = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: 0x101926,
      roughness: 0.4,
      metalness: 0.7,
      emissive: 0x041019,
      emissiveIntensity: 0.9
    }));
    scene.add(ramp);

    var edgeMaterial = new THREE.MeshBasicMaterial({
      color: 0x58e6ff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    for (var s = -1; s <= 1; s += 2) {
      var curvePoints = [];
      for (var p = 0; p < points.length; p += 1) {
        curvePoints.push(new THREE.Vector3(
          points[p].x + points[p].ty * 0.02,
          points[p].y - points[p].tx * 0.02,
          s * (RAMP.width / 2 + 0.05)
        ));
      }
      var curve = new THREE.CatmullRomCurve3(curvePoints);
      scene.add(new THREE.Mesh(
        new THREE.TubeGeometry(curve, 150, 0.055, 5, false),
        edgeMaterial
      ));
    }

    var centerCurvePoints = [];
    for (var c = 0; c < points.length; c += 1) {
      centerCurvePoints.push(new THREE.Vector3(
        points[c].x + points[c].ty * 0.025,
        points[c].y - points[c].tx * 0.025,
        0
      ));
    }
    var centerCurve = new THREE.CatmullRomCurve3(centerCurvePoints);
    scene.add(new THREE.Mesh(
      new THREE.TubeGeometry(centerCurve, 140, 0.025, 4, false),
      new THREE.MeshBasicMaterial({
        color: 0x5dbbd1,
        transparent: true,
        opacity: 0.28,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    ));

    var edgePositions = [];
    for (var e = 0; e < points.length; e += 8) {
      edgePositions.push(points[e].x, points[e].y, -RAMP.width / 2 - 0.05);
      edgePositions.push(points[e].x, points[e].y, RAMP.width / 2 + 0.05);
    }

    var edgePointGeometry = new THREE.BufferGeometry();
    edgePointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
    scene.add(new THREE.Points(edgePointGeometry, new THREE.PointsMaterial({
      map: glowTexture,
      color: 0x8cf4ff,
      size: 2.2,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })));

    var lipGlow = addGlowSprite(scene, 0x59e6ff, 15, 0.5);
    lipGlow.position.set(lip.x, lip.y, 0);

    var supportMaterial = new THREE.MeshStandardMaterial({
      color: 0x0b141f,
      roughness: 0.55,
      metalness: 0.6
    });

    for (var ribIndex = 2; ribIndex < points.length; ribIndex += 14) {
      var ribPoint = points[ribIndex];
      if (ribPoint.y < 2) continue;
      var rib = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, ribPoint.y * 0.84, RAMP.width - 1),
        supportMaterial
      );
      rib.position.set(ribPoint.x + 0.25, ribPoint.y * 0.42, 0);
      scene.add(rib);
    }
  }

  function buildRings() {
    ringGroup = new THREE.Group();
    scene.add(ringGroup);

    var definitions = [
      { x: 31, y: 56 },
      { x: 38, y: 64 },
      { x: 46, y: 69.5 },
      { x: 57, y: 66 },
      { x: 69, y: 55 },
      { x: 83, y: 38 }
    ];

    var torusGeometry = new THREE.TorusGeometry(3.9, 0.105, 10, 56);
    var outerGeometry = new THREE.TorusGeometry(4.24, 0.045, 8, 56);

    for (var i = 0; i < definitions.length; i += 1) {
      var definition = definitions[i];
      var group = new THREE.Group();
      group.position.set(definition.x, definition.y, 0);

      var ringMaterial = new THREE.MeshBasicMaterial({
        color: 0x8bf3ff,
        transparent: true,
        opacity: 0.98,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false
      });
      var torus = new THREE.Mesh(torusGeometry, ringMaterial);
      group.add(torus);

      var outerMaterial = new THREE.MeshBasicMaterial({
        color: 0x8a72ff,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false
      });
      var outerTorus = new THREE.Mesh(outerGeometry, outerMaterial);
      group.add(outerTorus);

      var centerGlow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0x45dcff,
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false
      }));
      centerGlow.scale.set(14, 14, 1);
      group.add(centerGlow);

      ringGroup.add(group);
      rings.push({
        group: group,
        material: ringMaterial,
        outerMaterial: outerMaterial,
        glow: centerGlow,
        active: true,
        phase: Math.random() * TAU
      });
    }
  }

  function buildCar() {
    carRoot = new THREE.Group();
    scene.add(carRoot);

    var paint = new THREE.MeshStandardMaterial({
      color: 0x172b3d,
      metalness: 0.92,
      roughness: 0.2,
      emissive: 0x030b12,
      emissiveIntensity: 0.7
    });
    var trim = new THREE.MeshStandardMaterial({
      color: 0x06090d,
      metalness: 0.55,
      roughness: 0.48
    });

    var bodyShape = new THREE.Shape();
    bodyShape.moveTo(2.33, -0.16);
    bodyShape.quadraticCurveTo(2.54, 0.01, 2.27, 0.23);
    bodyShape.quadraticCurveTo(1.64, 0.33, 1.16, 0.4);
    bodyShape.quadraticCurveTo(0.76, 0.44, 0.47, 0.84);
    bodyShape.quadraticCurveTo(0.23, 1.05, -0.28, 1.04);
    bodyShape.quadraticCurveTo(-0.82, 1.01, -1.17, 0.7);
    bodyShape.quadraticCurveTo(-1.45, 0.49, -1.79, 0.45);
    bodyShape.lineTo(-2.2, 0.39);
    bodyShape.quadraticCurveTo(-2.43, 0.28, -2.44, -0.06);
    bodyShape.lineTo(-2.3, -0.47);
    bodyShape.quadraticCurveTo(-1.2, -0.61, 0.1, -0.6);
    bodyShape.quadraticCurveTo(1.63, -0.59, 2.2, -0.5);
    bodyShape.closePath();

    var bodyGeometry = new THREE.ExtrudeGeometry(bodyShape, {
      depth: 2.02,
      bevelEnabled: true,
      bevelSegments: 3,
      bevelSize: 0.1,
      bevelThickness: 0.08,
      curveSegments: 18,
      steps: 1
    });
    bodyGeometry.translate(0, 0, -1.01);
    bodyGeometry.computeVertexNormals();
    carRoot.add(new THREE.Mesh(bodyGeometry, paint));

    var glassShape = new THREE.Shape();
    glassShape.moveTo(-1.03, 0.38);
    glassShape.quadraticCurveTo(-0.73, 0.76, -0.15, 0.92);
    glassShape.quadraticCurveTo(0.35, 1.0, 0.58, 0.72);
    glassShape.lineTo(1.04, 0.39);
    glassShape.lineTo(-0.13, 0.42);
    glassShape.closePath();

    var glassGeometry = new THREE.ExtrudeGeometry(glassShape, {
      depth: 1.58,
      bevelEnabled: true,
      bevelSegments: 2,
      bevelSize: 0.04,
      bevelThickness: 0.03,
      curveSegments: 12,
      steps: 1
    });
    glassGeometry.translate(0, 0, -0.79);
    carRoot.add(new THREE.Mesh(glassGeometry, new THREE.MeshStandardMaterial({
      color: 0x06121b,
      metalness: 0.92,
      roughness: 0.08,
      transparent: true,
      opacity: 0.86,
      emissive: 0x071c29,
      emissiveIntensity: 0.9
    })));

    var splitter = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.09, 2.2), trim);
    splitter.position.set(2.18, -0.51, 0);
    carRoot.add(splitter);

    var diffuser = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.16, 1.95), trim);
    diffuser.position.set(-2.08, -0.51, 0);
    carRoot.add(diffuser);

    var sideAccentMaterial = new THREE.MeshBasicMaterial({
      color: 0x43e9ff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    var accentGeometry = new THREE.BoxGeometry(3.8, 0.035, 0.03);
    var accentLeft = new THREE.Mesh(accentGeometry, sideAccentMaterial);
    accentLeft.position.set(-0.12, -0.35, 1.03);
    carRoot.add(accentLeft);
    var accentRight = accentLeft.clone();
    accentRight.position.z = -1.03;
    carRoot.add(accentRight);

    var wing = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.045, 1.86), trim);
    wing.position.set(-2.02, 0.67, 0);
    wing.rotation.z = -0.06;
    carRoot.add(wing);
    var wingSupportGeometry = new THREE.BoxGeometry(0.08, 0.32, 0.07);
    var wingSupportLeft = new THREE.Mesh(wingSupportGeometry, trim);
    wingSupportLeft.position.set(-1.97, 0.49, 0.62);
    carRoot.add(wingSupportLeft);
    var wingSupportRight = wingSupportLeft.clone();
    wingSupportRight.position.z = -0.62;
    carRoot.add(wingSupportRight);

    var lightMaterial = new THREE.MeshBasicMaterial({ color: 0xe5fbff });
    var headlightGeometry = new THREE.BoxGeometry(0.04, 0.09, 0.38);
    var headlightLeft = new THREE.Mesh(headlightGeometry, lightMaterial);
    headlightLeft.position.set(2.35, 0.08, 0.61);
    carRoot.add(headlightLeft);
    var headlightRight = headlightLeft.clone();
    headlightRight.position.z = -0.61;
    carRoot.add(headlightRight);

    var headlightGlowLeft = addGlowSprite(carRoot, 0xc6f8ff, 2.25, 0.72);
    headlightGlowLeft.position.set(2.4, 0.09, 0.61);
    var headlightGlowRight = addGlowSprite(carRoot, 0xc6f8ff, 2.25, 0.72);
    headlightGlowRight.position.set(2.4, 0.09, -0.61);

    var tailMaterial = new THREE.MeshBasicMaterial({ color: 0xff3f4d });
    var tailBar = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.08, 1.64), tailMaterial);
    tailBar.position.set(-2.42, 0.1, 0);
    carRoot.add(tailBar);
    var tailGlow = addGlowSprite(carRoot, 0xff4452, 4, 0.42);
    tailGlow.position.set(-2.46, 0.1, 0);

    var badge = new THREE.Mesh(
      new THREE.CircleGeometry(0.11, 18),
      new THREE.MeshBasicMaterial({ color: 0x8af1ff })
    );
    badge.rotation.y = Math.PI / 2;
    badge.position.set(2.38, 0.13, 0);
    carRoot.add(badge);

    var wheelGeometry = new THREE.CylinderGeometry(0.47, 0.47, 0.34, 26);
    var tireMaterial = new THREE.MeshStandardMaterial({ color: 0x050609, roughness: 0.72, metalness: 0.12 });
    var rimGeometry = new THREE.CylinderGeometry(0.29, 0.29, 0.36, 24);
    var rimMaterial = new THREE.MeshStandardMaterial({ color: 0x7a95a5, metalness: 0.96, roughness: 0.22 });
    var rimAccentMaterial = new THREE.MeshBasicMaterial({
      color: 0x48e6ff,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    var rimAccentGeometry = new THREE.TorusGeometry(0.24, 0.018, 5, 26);
    var spokeGeometry = new THREE.BoxGeometry(0.045, 0.49, 0.035);
    var spokeMaterial = new THREE.MeshStandardMaterial({ color: 0x9bb6c4, metalness: 0.95, roughness: 0.2 });

    var wheelPositions = [
      { x: 1.47, z: 1.04 },
      { x: 1.47, z: -1.04 },
      { x: -1.48, z: 1.04 },
      { x: -1.48, z: -1.04 }
    ];

    for (var i = 0; i < wheelPositions.length; i += 1) {
      var position = wheelPositions[i];
      var wheel = new THREE.Group();
      wheel.position.set(position.x, -0.58, position.z);

      var tire = new THREE.Mesh(wheelGeometry, tireMaterial);
      tire.rotation.x = Math.PI / 2;
      wheel.add(tire);

      var rim = new THREE.Mesh(rimGeometry, rimMaterial);
      rim.rotation.x = Math.PI / 2;
      wheel.add(rim);

      var rimAccent = new THREE.Mesh(rimAccentGeometry, rimAccentMaterial);
      rimAccent.position.z = position.z > 0 ? 0.185 : -0.185;
      wheel.add(rimAccent);

      for (var spokeIndex = 0; spokeIndex < 5; spokeIndex += 1) {
        var spoke = new THREE.Mesh(spokeGeometry, spokeMaterial);
        spoke.position.z = position.z > 0 ? 0.18 : -0.18;
        spoke.rotation.z = (spokeIndex / 5) * TAU;
        wheel.add(spoke);
      }

      carRoot.add(wheel);
      wheelGroups.push(wheel);
    }

    var underglow = new THREE.Mesh(
      new THREE.PlaneGeometry(7.4, 4.2),
      new THREE.MeshBasicMaterial({
        map: glowTexture,
        color: 0x44ddff,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    underglow.rotation.x = -Math.PI / 2;
    underglow.position.y = -0.96;
    carRoot.add(underglow);

    var nozzleGeometry = new THREE.CylinderGeometry(0.075, 0.1, 0.18, 10);
    var nozzleMaterial = new THREE.MeshBasicMaterial({ color: 0x3adfff });
    var plumePositions = [
      { x: 1.34, z: 0.56 },
      { x: 1.34, z: -0.56 },
      { x: -1.35, z: 0.56 },
      { x: -1.35, z: -0.56 }
    ];

    thrusterOuterMaterial = new THREE.MeshBasicMaterial({
      color: 0x52dfff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false
    });
    thrusterInnerMaterial = new THREE.MeshBasicMaterial({
      color: 0xe3fdff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false
    });

    for (var p = 0; p < plumePositions.length; p += 1) {
      var plumePosition = plumePositions[p];
      var nozzle = new THREE.Mesh(nozzleGeometry, nozzleMaterial);
      nozzle.position.set(plumePosition.x, -0.59, plumePosition.z);
      carRoot.add(nozzle);

      var plume = new THREE.Group();
      plume.position.set(plumePosition.x, -0.68, plumePosition.z);

      var outerCone = new THREE.Mesh(
        new THREE.ConeGeometry(0.25, 3.9, 8, 1, true),
        thrusterOuterMaterial
      );
      outerCone.position.y = -1.95;
      plume.add(outerCone);

      var innerCone = new THREE.Mesh(
        new THREE.ConeGeometry(0.085, 2.3, 7, 1, true),
        thrusterInnerMaterial
      );
      innerCone.position.y = -1.15;
      plume.add(innerCone);

      plume.visible = false;
      plume.userData.phase = Math.random() * TAU;
      carRoot.add(plume);
      thrusterGroups.push(plume);
    }

    thrusterLight = new THREE.PointLight(0x57e7ff, 0, 16, 2);
    thrusterLight.position.set(0, -1.4, 0);
    carRoot.add(thrusterLight);

    var headlight = new THREE.SpotLight(0xc2f2ff, 1.15, 60, 0.44, 0.74, 1.25);
    headlight.position.set(2.3, 0.2, 0);
    headlight.target.position.set(22, -1.4, 0);
    carRoot.add(headlight);
    carRoot.add(headlight.target);

    carShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(7.2, 4.4),
      new THREE.MeshBasicMaterial({
        map: glowTexture,
        color: 0x000000,
        transparent: true,
        opacity: 0.55,
        depthWrite: false
      })
    );
    carShadow.rotation.x = -Math.PI / 2;
    carShadow.position.set(CFG.startX, 0.035, 0);
    scene.add(carShadow);

    updateCarVisuals(0);
  }

  function updateCarVisuals(dt) {
    if (!carRoot) return;

    carRoot.position.set(car.x, car.y, 0);
    carRoot.rotation.z = car.angle;

    var speedForWheels = car.speed;
    if (state === 'air' || state === 'crashed') {
      speedForWheels = Math.hypot(car.vx, car.vy);
    }
    wheelSpin += speedForWheels * dt * 2.3;
    for (var i = 0; i < wheelGroups.length; i += 1) {
      wheelGroups[i].rotation.z = wheelSpin;
    }

    var thrusting = state === 'air' && run.thrusting && carRoot.visible;
    var pulse = 0.85 + Math.sin(elapsed * 32) * 0.11;

    for (var t = 0; t < thrusterGroups.length; t += 1) {
      var plume = thrusterGroups[t];
      plume.visible = thrusting;
      if (thrusting) {
        plume.scale.set(
          0.85 + Math.sin(elapsed * 25 + plume.userData.phase) * 0.12,
          pulse + Math.sin(elapsed * 19 + plume.userData.phase) * 0.08,
          0.85 + Math.cos(elapsed * 22 + plume.userData.phase) * 0.12
        );
      }
    }

    if (thrusterOuterMaterial) {
      thrusterOuterMaterial.opacity = thrusting ? 0.5 + Math.sin(elapsed * 29) * 0.09 : 0;
    }
    if (thrusterInnerMaterial) {
      thrusterInnerMaterial.opacity = thrusting ? 0.82 + Math.cos(elapsed * 35) * 0.1 : 0;
    }
    if (thrusterLight) {
      thrusterLight.intensity = damp(thrusterLight.intensity, thrusting ? 1.85 : 0, 14, dt);
    }

    SoundFX.setThrust(thrusting);

    if (carShadow) {
      var altitude = Math.max(0, car.y - CFG.rideHeight);
      carShadow.visible = carRoot.visible && state !== 'results';
      carShadow.position.set(car.x, 0.036, 0);
      var shadowScale = 1 + altitude * 0.007;
      carShadow.scale.set(shadowScale, shadowScale, 1);
      carShadow.material.opacity = clamp(0.55 - altitude * 0.006, 0.12, 0.55);
    }
  }

  function spawnBurst(x, y, z, color, count, speed, life) {
    for (var i = 0; i < count; i += 1) {
      var mesh = new THREE.Mesh(fxSphereGeometry, new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      }));
      mesh.position.set(x, y, z);
      var angle = Math.random() * TAU;
      var velocity = rand(speed * 0.35, speed);
      var scale = rand(0.6, 1.7);
      mesh.scale.set(scale, scale, scale);
      scene.add(mesh);
      effects.push({
        type: 'particle',
        object: mesh,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity,
        vz: rand(-speed * 0.7, speed * 0.7),
        gravity: rand(3, 10),
        life: life,
        maxLife: life,
        spin: rand(-4, 4)
      });
    }
  }

  function spawnFlash(x, y, z, color, size, life) {
    var sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture,
      color: color,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    }));
    sprite.position.set(x, y, z);
    sprite.scale.set(size * 0.3, size * 0.3, 1);
    scene.add(sprite);
    effects.push({
      type: 'flash',
      object: sprite,
      vx: 0,
      vy: 0,
      vz: 0,
      gravity: 0,
      life: life,
      maxLife: life,
      size: size,
      spin: 0
    });
  }

  function spawnDebris(x, y, z) {
    for (var i = 0; i < 28; i += 1) {
      var mesh = new THREE.Mesh(fxBoxGeometry, new THREE.MeshStandardMaterial({
        color: i % 4 === 0 ? 0x243746 : 0x0d141c,
        metalness: 0.72,
        roughness: 0.45,
        emissive: i % 3 === 0 ? 0x3b0c00 : 0x000000,
        emissiveIntensity: i % 3 === 0 ? 1.6 : 0
      }));
      mesh.position.set(x + rand(-1, 1), y + rand(-0.3, 1), z + rand(-0.8, 0.8));
      mesh.rotation.set(rand(0, TAU), rand(0, TAU), rand(0, TAU));
      var angle = Math.random() * TAU;
      var speed = rand(5, 25);
      var scale = rand(0.6, 2.1);
      mesh.scale.set(scale, scale, scale);
      scene.add(mesh);
      effects.push({
        type: 'debris',
        object: mesh,
        vx: Math.cos(angle) * speed,
        vy: rand(4, 28),
        vz: rand(-12, 12),
        gravity: 25,
        life: rand(1.6, 3.1),
        maxLife: 3.1,
        spin: rand(-8, 8)
      });
    }
  }

  function spawnSmoke(x, y, z) {
    for (var i = 0; i < 15; i += 1) {
      var sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture,
        color: i % 2 === 0 ? 0x24272c : 0x3d2117,
        transparent: true,
        opacity: 0.3,
        depthWrite: false
      }));
      sprite.position.set(x + rand(-2, 2), y + rand(0, 2), z + rand(-1, 1));
      var size = rand(3, 8);
      sprite.scale.set(size, size, 1);
      scene.add(sprite);
      effects.push({
        type: 'smoke',
        object: sprite,
        vx: rand(-3, 3),
        vy: rand(2, 7),
        vz: rand(-1, 1),
        gravity: -1,
        life: rand(1.2, 2.4),
        maxLife: 2.4,
        spin: rand(-1, 1)
      });
    }
  }

  function spawnLandingDust(x) {
    for (var i = 0; i < 20; i += 1) {
      var mesh = new THREE.Mesh(fxSphereGeometry, new THREE.MeshBasicMaterial({
        color: i % 3 === 0 ? 0x8cefff : 0x637786,
        transparent: true,
        opacity: 0.48,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      }));
      mesh.position.set(x + rand(-1.4, 1.4), 0.15 + rand(0, 0.35), rand(-0.8, 0.8));
      var scale = rand(0.6, 1.7);
      mesh.scale.set(scale, scale, scale);
      scene.add(mesh);
      effects.push({
        type: 'particle',
        object: mesh,
        vx: rand(-8, 8),
        vy: rand(1.5, 6),
        vz: rand(-3, 3),
        gravity: 5,
        life: rand(0.4, 0.9),
        maxLife: 0.9,
        spin: rand(-2, 2)
      });
    }
  }

  function createExplosion(x, y) {
    spawnFlash(x, y, 0.2, 0xffa15c, 34, 0.45);
    spawnFlash(x, y, -0.5, 0xffffff, 20, 0.24);
    spawnBurst(x, y, 0, 0xff9a4c, 38, 32, 1.05);
    spawnBurst(x, y, 0, 0x59e6ff, 22, 22, 0.9);
    spawnDebris(x, y, 0);
    spawnSmoke(x, y, 0);
    cameraShake = 2.1;
  }

  function updateEffects(dt) {
    for (var i = effects.length - 1; i >= 0; i -= 1) {
      var effect = effects[i];
      effect.life -= dt;
      if (effect.life <= 0) {
        scene.remove(effect.object);
        if (effect.object.material) effect.object.material.dispose();
        effects.splice(i, 1);
        continue;
      }

      var progress = 1 - effect.life / effect.maxLife;
      effect.object.position.x += effect.vx * dt;
      effect.object.position.y += effect.vy * dt;
      effect.object.position.z += effect.vz * dt;
      effect.vy -= effect.gravity * dt;

      if (effect.type === 'flash') {
        var flashScale = effect.size * (0.25 + progress * 1.25);
        effect.object.scale.set(flashScale, flashScale, 1);
        effect.object.material.opacity = (1 - progress) * 0.85;
      } else if (effect.type === 'smoke') {
        var smokeScale = effect.object.scale.x + dt * 3.3;
        effect.object.scale.set(smokeScale, smokeScale, 1);
        effect.object.material.opacity = (1 - progress) * 0.25;
      } else {
        effect.object.rotation.z += effect.spin * dt;
        effect.object.rotation.x += effect.spin * 0.55 * dt;
        effect.object.material.opacity = clamp((1 - progress) * 1.7, 0, 1);
        if (effect.type === 'particle') {
          effect.object.scale.multiplyScalar(1 - dt * 0.55);
        }
      }
    }
  }

  function clearEffects() {
    for (var i = 0; i < effects.length; i += 1) {
      scene.remove(effects[i].object);
      if (effects[i].object.material) effects[i].object.material.dispose();
    }
    effects.length = 0;
  }

  function collectRing(ring) {
    if (!ring.active) return;
    ring.active = false;
    ring.group.visible = false;
    spawnBurst(ring.group.position.x, ring.group.position.y, 0, 0x7df2ff, 18, 18, 0.8);
    spawnFlash(ring.group.position.x, ring.group.position.y, 0, 0x59e6ff, 16, 0.4);
    run.rings += 1;
    run.gas = clamp(run.gas + CFG.gasRefill, 0, 1);
    SoundFX.ring();
    announce('RING +500', 'good', 0.72);
  }

  function checkRingCollisions() {
    for (var i = 0; i < rings.length; i += 1) {
      var ring = rings[i];
      if (!ring.active) continue;
      var dx = car.x - ring.group.position.x;
      var dy = car.y - ring.group.position.y;
      if (dx * dx + dy * dy < 24.5) collectRing(ring);
    }
  }

  function resetRings() {
    for (var i = 0; i < rings.length; i += 1) {
      rings[i].active = true;
      rings[i].group.visible = true;
      rings[i].group.scale.set(1, 1, 1);
    }
  }

  function updateRings() {
    for (var i = 0; i < rings.length; i += 1) {
      var ring = rings[i];
      if (!ring.active) continue;
      ring.group.rotation.y = Math.sin(elapsed * 0.75 + ring.phase) * 0.24;
      ring.group.rotation.x = Math.sin(elapsed * 0.52 + ring.phase) * 0.08;
      var pulse = 1 + Math.sin(elapsed * 2.6 + ring.phase) * 0.035;
      ring.group.scale.set(pulse, pulse, pulse);
      ring.material.opacity = 0.82 + Math.sin(elapsed * 3.1 + ring.phase) * 0.16;
      ring.outerMaterial.opacity = 0.4 + Math.cos(elapsed * 2.2 + ring.phase) * 0.18;
      ring.glow.material.opacity = 0.14 + Math.sin(elapsed * 2.4 + ring.phase) * 0.05;
    }
  }

  function updateBestUI() {
    var text = padScore(best);
    if (dom.bestScore) dom.bestScore.textContent = text;
    if (dom.titleBest) dom.titleBest.textContent = text;
  }

  function updateSoundUI() {
    if (!dom.soundToggle) return;
    dom.soundToggle.setAttribute('aria-pressed', String(muted));
    dom.soundToggle.setAttribute('aria-label', muted ? 'Enable sound' : 'Mute sound');
    if (dom.soundLabel) dom.soundLabel.textContent = muted ? 'SOUND OFF' : 'SOUND ON';
  }

  function announce(text, tone, duration) {
    if (!dom.announce) return;
    if (announcerTimeout) {
      window.clearTimeout(announcerTimeout);
      announcerTimeout = null;
    }
    if (!text) {
      dom.announce.classList.remove('is-visible');
      return;
    }
    dom.announce.textContent = text;
    dom.announce.setAttribute('data-tone', tone || '');
    dom.announce.classList.add('is-visible');
    announcerTimeout = window.setTimeout(function () {
      dom.announce.classList.remove('is-visible');
      announcerTimeout = null;
    }, (duration || 1.3) * 1000);
  }

  function setLightsVisible(visible) {
    if (dom.startLights) dom.startLights.classList.toggle('is-live', visible);
  }

  function clearLamps() {
    for (var i = 0; i < dom.lamps.length; i += 1) {
      dom.lamps[i].classList.remove('is-red', 'is-green');
    }
  }

  function setRedLights(count) {
    for (var i = 0; i < dom.lamps.length; i += 1) {
      dom.lamps[i].classList.toggle('is-red', i < count);
      dom.lamps[i].classList.remove('is-green');
    }
  }

  function setGreenLight() {
    for (var i = 0; i < dom.lamps.length; i += 1) {
      dom.lamps[i].classList.toggle('is-red', i < dom.lamps.length - 1);
      dom.lamps[i].classList.toggle('is-green', i === dom.lamps.length - 1);
    }
  }

  function setLightsStatus(text, tone) {
    if (!dom.lightsStatus) return;
    dom.lightsStatus.textContent = text;
    dom.lightsStatus.classList.toggle('is-go', tone === 'go');
    dom.lightsStatus.classList.toggle('is-bad', tone === 'bad');
  }

  function setHudVisible(visible) {
    if (!dom.runHud) return;
    dom.runHud.classList.toggle('is-live', visible);
    dom.runHud.setAttribute('aria-hidden', String(!visible));
    if (!visible) setTouchVisible(false);
  }

  function setTouchVisible(visible) {
    if (!dom.touchControls) return;
    dom.touchControls.classList.toggle('is-live', visible);
    dom.touchControls.setAttribute('aria-hidden', String(!visible));
  }

  function hideScreens() {
    var screens = [dom.titleScreen, dom.resultsScreen];
    for (var i = 0; i < screens.length; i += 1) {
      if (!screens[i]) continue;
      screens[i].classList.remove('is-visible');
      screens[i].hidden = true;
    }
  }

  function showScreen(screen) {
    hideScreens();
    var target = screen === 'title' ? dom.titleScreen : screen === 'results' ? dom.resultsScreen : null;
    if (!target) return;
    target.hidden = false;
    window.requestAnimationFrame(function () {
      target.classList.add('is-visible');
    });
  }

  function updateHud() {
    if (!dom.runHud) return;

    var displaySpeed = 0;
    var altitude = Math.max(0, car.y - CFG.rideHeight);

    if (state === 'drive' || state === 'ramp') {
      displaySpeed = car.speed / CFG.mphToWorld;
    } else if (state === 'air' || state === 'crashed') {
      displaySpeed = Math.hypot(car.vx, car.vy) / CFG.mphToWorld;
      altitude = Math.max(altitude, run.maxAltitude);
    } else if (state === 'landed') {
      displaySpeed = Math.hypot(car.vx, car.vy) / CFG.mphToWorld;
      altitude = 0;
    }

    dom.hudSpeed.textContent = String(Math.max(0, Math.round(displaySpeed)));
    dom.hudAltitude.textContent = String(Math.max(0, Math.round(altitude)));
    dom.hudRings.textContent = String(run.rings);
    dom.hudFlips.textContent = String(run.flips);

    var tilt = Math.abs(normalizeAngle(car.angle)) * 180 / Math.PI;
    dom.hudTilt.textContent = Math.round(tilt) + '\u00B0';
    dom.hudTilt.classList.toggle('is-danger', (state === 'air' || state === 'crashed') && tilt > 28);

    var gasPercent = clamp(run.gas, 0, 1);
    dom.gasFill.style.transform = 'scaleX(' + gasPercent + ')';
    dom.gasFill.classList.toggle('is-low', gasPercent < 0.25);
    dom.gasValue.textContent = Math.round(gasPercent * 100) + '%';

    setTouchVisible(state === 'air');
  }

  function getGrade(score) {
    if (score >= 14000) return 'S+';
    if (score >= 10500) return 'S';
    if (score >= 8000) return 'A';
    if (score >= 5000) return 'B';
    if (score >= 2500) return 'C';
    return 'D';
  }

  function finalizeScore() {
    var altitudePoints = Math.round(Math.max(0, run.maxAltitude));
    var airtimePoints = Math.round(Math.max(0, run.airTime) * 100);
    var softBonus = run.outcome === 'landed'
      ? Math.round(clamp(CFG.sinkLimit - run.touchdown, 0, CFG.sinkLimit) * 42)
      : 0;
    run.softBonus = softBonus;
    run.score = run.rings * 500 + run.flips * 1500 + altitudePoints + airtimePoints + softBonus;
    run.newBest = run.score > best;

    if (run.newBest) {
      best = run.score;
      safeStorageSet('roadsterLoop.best', best);
      updateBestUI();
    }
  }

  function animateResultScore(score) {
    if (scoreAnimation) {
      window.cancelAnimationFrame(scoreAnimation);
      scoreAnimation = null;
    }
    var start = performance.now();
    var duration = 780;

    function tick(now) {
      var progress = clamp((now - start) / duration, 0, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      dom.resultScore.textContent = formatScore(score * eased);
      if (progress < 1) {
        scoreAnimation = window.requestAnimationFrame(tick);
      } else {
        dom.resultScore.textContent = formatScore(score);
        scoreAnimation = null;
      }
    }

    dom.resultScore.textContent = '0';
    scoreAnimation = window.requestAnimationFrame(tick);
  }

  function showResults() {
    if (state === 'results') return;
    state = 'results';
    setHudVisible(false);
    setLightsVisible(false);
    announce('');

    var landed = run.outcome === 'landed';
    var grade = getGrade(run.score);

    dom.resultOutcome.textContent = landed ? 'TOUCHDOWN CONFIRMED' : 'VEHICLE LOST';
    dom.resultGrade.textContent = grade;
    dom.resultGrade.setAttribute('data-grade', grade);
    dom.newBest.hidden = !run.newBest;

    dom.resultReaction.textContent = run.reaction.toFixed(3) + ' s';
    dom.resultRampSpeed.textContent = Math.round(run.rampSpeedMph) + ' mph';
    dom.resultPeakG.textContent = run.peakG.toFixed(1) + ' G';
    dom.resultAltitude.textContent = Math.round(run.maxAltitude) + ' ft';
    dom.resultAirtime.textContent = run.airTime.toFixed(1) + ' s';
    dom.resultFlips.textContent = String(run.flips);
    dom.resultRings.textContent = run.rings + ' / ' + CFG.ringCount;
    dom.resultTouchdown.textContent = run.touchdown.toFixed(1) + ' ft/s';
    dom.resultSoft.textContent = formatScore(run.softBonus) + ' pts';

    showScreen('results');
    animateResultScore(run.score);
  }

  function resetRun() {
    stateTime = 0;
    accumulator = 0;
    green = false;
    greenAtMs = 0;
    inputLock = 0;
    countdownTime = 0;
    lastLit = 0;
    wheelSpin = 0;
    cameraShake = 0;
    rampS = 0;
    targetSpeed = 0;

    car.x = CFG.startX;
    car.y = CFG.rideHeight;
    car.vx = 0;
    car.vy = 0;
    car.angle = 0;
    car.omega = 0;
    car.speed = 0;

    run = createRunState();
    keys.left = false;
    keys.right = false;
    keys.space = false;

    clearLamps();
    setLightsStatus('STANDBY', '');
    setLightsVisible(false);
    setHudVisible(false);
    setTouchVisible(false);
    announce('');
    resetRings();
    clearEffects();

    if (carRoot) {
      carRoot.visible = true;
      carRoot.position.set(car.x, car.y, 0);
      carRoot.rotation.z = 0;
    }
    if (carShadow) {
      carShadow.visible = true;
      carShadow.material.opacity = 0.55;
    }

    SoundFX.setThrust(false);
    updateCarVisuals(0);
    updateHud();
  }

  function beginCountdown() {
    SoundFX.init();
    resetRun();
    hideScreens();
    state = 'count';
    stateTime = 0;
    countdownTime = 0;
    green = false;
    greenAtMs = 0;
    inputLock = 0;
    lastLit = 0;
    setLightsVisible(true);
    setRedLights(0);
    setLightsStatus('STAGING', '');
    announce('');
    cameraShake = 0;
  }

  function goToTitle() {
    SoundFX.setThrust(false);
    state = 'title';
    resetRun();
    state = 'title';
    setLightsVisible(false);
    showScreen('title');
    updateBestUI();
  }

  function tooEarly() {
    if (state !== 'count' || green) return;
    inputLock = 0.4;
    setLightsStatus('TOO EARLY', 'bad');
    announce('TOO EARLY \u2014 WAIT FOR GREEN', 'bad', 1.25);
    SoundFX.early();
    cameraShake = 0.16;
    if (dom.startLights) {
      dom.startLights.style.borderColor = 'rgba(255,77,88,0.7)';
      window.setTimeout(function () {
        if (dom.startLights) dom.startLights.style.borderColor = '';
      }, 240);
    }
  }

  function launchRun() {
    if (state !== 'count' || !green || inputLock > 0) return;

    var reaction = Math.max(0, (performance.now() - greenAtMs) / 1000);
    var rampSpeedMph = clamp(90 - 5 * reaction, 76, 90);

    run.reaction = reaction;
    run.rampSpeedMph = rampSpeedMph;
    targetSpeed = rampSpeedMph * CFG.mphToWorld;

    state = 'drive';
    stateTime = 0;
    car.x = CFG.startX;
    car.y = CFG.rideHeight;
    car.vx = 0;
    car.vy = 0;
    car.angle = 0;
    car.omega = 0;
    car.speed = 0;

    setLightsStatus('LAUNCH', 'go');
    announce('LAUNCH', 'go', 0.82);
    setHudVisible(true);
    SoundFX.launch();

    window.setTimeout(function () {
      if (state === 'drive' || state === 'ramp' || state === 'air') setLightsVisible(false);
    }, 700);
  }

  function handlePrimaryPress(source) {
    if (state === 'title') {
      beginCountdown();
      return;
    }

    if (state === 'count') {
      if (!green) {
        tooEarly();
        return;
      }
      if (inputLock <= 0) launchRun();
      return;
    }

    if (state === 'results' && source === 'key') beginCountdown();
  }

  function updateCountdown(dt) {
    countdownTime += dt;
    if (inputLock > 0) inputLock = Math.max(0, inputLock - dt);

    var lit = Math.min(4, Math.floor(countdownTime / 0.5));
    if (lit !== lastLit) {
      lastLit = lit;
      SoundFX.tick();
    }
    if (!green) setRedLights(lit);

    if (!green && countdownTime >= 2.58) {
      green = true;
      greenAtMs = performance.now();
      setGreenLight();
      setLightsStatus('GO', 'go');
      announce('GO', 'go', 0.78);
      SoundFX.green();
    }

    if (green) {
      if (inputLock > 0) setLightsStatus('INPUT LOCK', 'bad');
      else if (dom.lightsStatus && dom.lightsStatus.textContent !== 'GO') {
        setLightsStatus('GO', 'go');
      }
    }
  }

  function updateDrive(dt) {
    car.speed = Math.min(targetSpeed, car.speed + CFG.driveAccel * dt);
    car.x += car.speed * dt;
    car.y = CFG.rideHeight;
    car.angle = 0;
    car.omega = 0;

    if (car.x >= 0) {
      car.x = 0;
      car.y = CFG.rideHeight;
      car.speed = targetSpeed;
      rampS = 0;
      state = 'ramp';
      stateTime = 0;
    }
  }

  function updateRamp(dt) {
    rampS += targetSpeed * dt;

    if (rampS >= rampPath.total) {
      var lip = rampPath.lip;
      var normalX = -lip.ty;
      var normalY = lip.tx;
      car.x = lip.x + normalX * CFG.rideHeight;
      car.y = lip.y + normalY * CFG.rideHeight;
      car.angle = rampPath.lipAngle;
      car.vx = lip.tx * targetSpeed;
      car.vy = lip.ty * targetSpeed;
      car.speed = targetSpeed;
      car.omega = 0;
      state = 'air';
      stateTime = 0;
      run.airTime = 0;
      run.wasUpsideDown = isUpsideDown(car.angle);
      run.maxAltitude = Math.max(0, car.y - CFG.rideHeight);
      announce('AIRBORNE', 'good', 0.82);
      spawnBurst(car.x, car.y, 0, 0x59e6ff, 10, 8, 0.5);
      SoundFX.ramp();
      return;
    }

    var point = sampleRamp(rampS);
    var nX = -point.ty;
    var nY = point.tx;
    car.x = point.x + nX * CFG.rideHeight;
    car.y = point.y + nY * CFG.rideHeight;
    car.angle = point.angle;
    car.speed = targetSpeed;
    car.omega = 0;

    if (point.radius > 0) {
      var centripetal = targetSpeed * targetSpeed / point.radius;
      var combined = Math.sqrt(centripetal * centripetal + CFG.gravity * CFG.gravity);
      run.peakG = Math.max(run.peakG, combined / CFG.gravity);
    }
  }

  function updateAir(dt) {
    if (keys.left) car.omega += CFG.angularAccel * dt;
    if (keys.right) car.omega -= CFG.angularAccel * dt;

    car.omega *= Math.exp(-CFG.angularDamping * dt);
    car.omega = clamp(car.omega, -CFG.maxOmega, CFG.maxOmega);
    car.angle += car.omega * dt;

    var thrusting = keys.space && run.gas > 0.0005;
    run.thrusting = thrusting;

    if (thrusting) {
      run.gas = Math.max(0, run.gas - CFG.gasDrain * dt);
      var upX = -Math.sin(car.angle);
      var upY = Math.cos(car.angle);
      var thrustX = upX * CFG.thrust;
      var thrustY = upY * CFG.thrust;
      car.vx += thrustX * dt;
      car.vy += thrustY * dt;

      var totalAcceleration = Math.sqrt(
        thrustX * thrustX + (thrustY - CFG.gravity) * (thrustY - CFG.gravity)
      );
      run.peakG = Math.max(run.peakG, totalAcceleration / CFG.gravity);
    }

    car.vy -= CFG.gravity * dt;
    car.x += car.vx * dt;
    car.y += car.vy * dt;
    car.speed = Math.hypot(car.vx, car.vy);

    run.airTime += dt;
    run.maxAltitude = Math.max(run.maxAltitude, Math.max(0, car.y - CFG.rideHeight));

    checkRingCollisions();

    var upsideDown = isUpsideDown(car.angle);
    if (upsideDown && !run.wasUpsideDown) {
      run.flips += 1;
      announce('FLIP +1500', 'good', 0.72);
      SoundFX.flip();
      spawnFlash(car.x, car.y, 0, 0x9d7cff, 12, 0.35);
    }
    run.wasUpsideDown = upsideDown;

    var contactHeight = CFG.rideHeight + Math.abs(Math.sin(car.angle)) * 1.15;
    if (car.y <= contactHeight && car.vy <= 0) {
      resolveLanding();
    }
  }

  function resolveLanding() {
    var sink = Math.max(0, -car.vy);
    var tilt = Math.abs(normalizeAngle(car.angle));
    run.touchdown = sink;
    run.thrusting = false;

    if (sink <= CFG.sinkLimit && tilt <= CFG.uprightLimit) {
      state = 'landed';
      stateTime = 0;
      run.outcome = 'landed';
      run.peakG = Math.max(run.peakG, Math.min(20, sink / (CFG.gravity * 0.25)));
      car.y = CFG.rideHeight;
      car.vy = 0;
      car.vx *= 0.42;
      car.omega = 0;
      finalizeScore();
      spawnLandingDust(car.x);
      SoundFX.land();
      cameraShake = 0.5;
      announce('CLEAN TOUCHDOWN', 'good', 1.2);
    } else {
      state = 'crashed';
      stateTime = 0;
      run.outcome = 'crashed';
      run.peakG = Math.max(run.peakG, Math.min(25, sink / (CFG.gravity * 0.12)));
      finalizeScore();
      createExplosion(car.x, car.y);
      SoundFX.crash();
      carRoot.visible = false;
      if (carShadow) carShadow.visible = false;
      announce(tilt > CFG.uprightLimit ? 'CRASHED \u2014 BAD ATTITUDE' : 'CRASHED \u2014 HARD IMPACT', 'bad', 1.65);
    }
  }

  function updateLanded(dt) {
    stateTime += dt;
    car.x += car.vx * dt;
    car.vx *= Math.exp(-3.4 * dt);
    car.speed = Math.abs(car.vx);
    car.angle = damp(car.angle, 0, 7, dt);
    car.y = CFG.rideHeight;
    car.omega = 0;

    if (stateTime >= CFG.landingDelay) showResults();
  }

  function updateCrashed(dt) {
    stateTime += dt;
    if (stateTime >= CFG.crashDelay) showResults();
  }

  function updatePhysics(dt) {
    if (state !== 'title') stateTime += dt;

    switch (state) {
      case 'count':
        updateCountdown(dt);
        break;
      case 'drive':
        updateDrive(dt);
        break;
      case 'ramp':
        updateRamp(dt);
        break;
      case 'air':
        updateAir(dt);
        break;
      case 'landed':
        updateLanded(dt);
        break;
      case 'crashed':
        updateCrashed(dt);
        break;
      default:
        break;
    }
  }

  var cameraLookTarget = new THREE.Vector3();

  function updateCamera(dt) {
    if (!camera) return;

    var desiredX;
    var desiredY;
    var desiredZ;
    var lookX;
    var lookY;
    var lookZ;
    var positionSmooth;
    var lookSmooth;

    if (state === 'title') {
      desiredX = -80 + Math.sin(elapsed * 0.14) * 7;
      desiredY = 11.8 + Math.sin(elapsed * 0.29) * 1.1;
      desiredZ = 55 + Math.cos(elapsed * 0.18) * 2.5;
      lookX = -50 + Math.sin(elapsed * 0.1) * 2;
      lookY = 7.6;
      lookZ = 0;
      positionSmooth = 1 - Math.exp(-dt * 1.35);
      lookSmooth = 1 - Math.exp(-dt * 1.5);
    } else if (state === 'count') {
      desiredX = car.x + 18;
      desiredY = 9.4;
      desiredZ = 59;
      lookX = car.x + 31;
      lookY = 7.4;
      lookZ = 0;
      positionSmooth = 1 - Math.exp(-dt * 2.6);
      lookSmooth = 1 - Math.exp(-dt * 2.8);
    } else if (state === 'drive' || state === 'ramp') {
      desiredX = car.x + 12;
      desiredY = 8.6 + car.y * 0.3;
      desiredZ = 59 + car.y * 0.07;
      lookX = car.x + 34;
      lookY = 5.4 + car.y * 0.5;
      lookZ = 0;
      positionSmooth = 1 - Math.exp(-dt * 3.8);
      lookSmooth = 1 - Math.exp(-dt * 4.2);
    } else if (state === 'air') {
      desiredX = car.x - 3;
      desiredY = 12 + car.y * 0.58;
      desiredZ = 60 + car.y * 0.16;
      lookX = car.x + 19;
      lookY = car.y * 0.72 + 3;
      lookZ = 0;
      positionSmooth = 1 - Math.exp(-dt * 3.5);
      lookSmooth = 1 - Math.exp(-dt * 4);
    } else {
      desiredX = car.x + 12 + Math.sin(elapsed * 0.18) * 2;
      desiredY = 9.5;
      desiredZ = 58;
      lookX = car.x + 17;
      lookY = 3;
      lookZ = 0;
      positionSmooth = 1 - Math.exp(-dt * 2.2);
      lookSmooth = 1 - Math.exp(-dt * 2.4);
    }

    cameraDesired.set(desiredX, desiredY, desiredZ);
    camera.position.lerp(cameraDesired, positionSmooth);

    if (cameraShake > 0.001) {
      camera.position.x += (Math.random() - 0.5) * cameraShake * 0.55;
      camera.position.y += (Math.random() - 0.5) * cameraShake * 0.42;
      camera.position.z += (Math.random() - 0.5) * cameraShake * 0.22;
      cameraShake *= Math.exp(-dt * 3.4);
    } else {
      cameraShake = 0;
    }

    cameraLookTarget.set(lookX, lookY, lookZ);
    cameraLook.lerp(cameraLookTarget, lookSmooth);
    camera.lookAt(cameraLook);
  }

  function updateVisuals(dt) {
    updateCarVisuals(dt);
    updateRings();
    updateEffects(dt);
    updateHud();
  }

  function loop(now) {
    window.requestAnimationFrame(loop);

    if (!previousFrame) previousFrame = now;
    var frameDt = Math.min((now - previousFrame) / 1000, 0.12);
    previousFrame = now;
    elapsed += frameDt;
    accumulator += frameDt;

    var steps = 0;
    while (accumulator >= STEP && steps < 24) {
      updatePhysics(STEP);
      accumulator -= STEP;
      steps += 1;
    }
    if (steps >= 24) accumulator = 0;

    updateVisuals(frameDt);
    updateCamera(frameDt);
    renderer.render(scene, camera);
  }

  function bindHold(button, keyName) {
    if (!button) return;

    function press(event) {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      keys[keyName] = true;
      button.classList.add('is-pressed');
      if (button.setPointerCapture) {
        try {
          button.setPointerCapture(event.pointerId);
        } catch (error) {
          /* Pointer capture is best effort. */
        }
      }
    }

    function release(event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      keys[keyName] = false;
      button.classList.remove('is-pressed');
    }

    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
  }

  function bindEvents() {
    dom.startButton.addEventListener('click', function () {
      if (state === 'title') beginCountdown();
    });

    dom.retryButton.addEventListener('click', function () {
      if (state === 'results') beginCountdown();
    });

    dom.homeButton.addEventListener('click', function () {
      if (state === 'results') goToTitle();
    });

    dom.soundToggle.addEventListener('click', function () {
      SoundFX.init();
      muted = !muted;
      SoundFX.setMuted(muted);
      safeStorageSet('roadsterLoop.muted', muted ? '1' : '0');
      updateSoundUI();
      if (!muted) SoundFX.tick();
    });

    window.addEventListener('keydown', function (event) {
      if (event.code === 'Space') {
        event.preventDefault();
        if (!event.repeat) {
          keys.space = true;
          handlePrimaryPress('key');
        }
      } else if (event.code === 'ArrowLeft') {
        event.preventDefault();
        keys.left = true;
      } else if (event.code === 'ArrowRight') {
        event.preventDefault();
        keys.right = true;
      }
    });

    window.addEventListener('keyup', function (event) {
      if (event.code === 'Space') keys.space = false;
      else if (event.code === 'ArrowLeft') keys.left = false;
      else if (event.code === 'ArrowRight') keys.right = false;
    });

    window.addEventListener('pointerdown', function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target.closest && event.target.closest('button, a')) return;
      if (state === 'title') {
        beginCountdown();
      } else if (state === 'count') {
        handlePrimaryPress('pointer');
      }
    });

    window.addEventListener('blur', function () {
      keys.left = false;
      keys.right = false;
      keys.space = false;
      SoundFX.setThrust(false);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        keys.left = false;
        keys.right = false;
        keys.space = false;
        SoundFX.setThrust(false);
      }
    });

    bindHold(dom.touchLeft, 'left');
    bindHold(dom.touchRight, 'right');
    bindHold(dom.touchThrust, 'space');
  }

  function initGame() {
    try {
      initScene();
      resetRun();
      bindEvents();
      state = 'title';
      updateBestUI();
      updateSoundUI();
      SoundFX.muted = muted;
      showScreen('title');
      previousFrame = performance.now();
      updateCamera(0.016);
      renderer.render(scene, camera);

      window.setTimeout(function () {
        if (dom.loading) dom.loading.classList.add('is-hidden');
      }, 260);

      window.requestAnimationFrame(loop);
    } catch (error) {
      if (dom.loading) {
        dom.loading.classList.add('is-error');
        dom.loading.innerHTML = '<span>WEBGL INITIALIZATION FAILED. TRY A WEBGL-CAPABLE BROWSER.</span>';
      }
      if (window.console && console.error) console.error(error);
    }
  }

  initGame();
})();
