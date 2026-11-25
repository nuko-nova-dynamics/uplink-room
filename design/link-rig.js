/* Uplink Room character rig. Every character is one SVG built from numbers:
   a superellipse body (width, height, roundness, top taper), two parametric eyes,
   brows, a mouth, cheeks and, for Link, an antenna. States set target numbers;
   springs carry every number there, so states and shapes morph into each other. */
(function () {
  const NS = 'http://www.w3.org/2000/svg', TAU = Math.PI * 2;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const BODIES = {
    link:     { w: 128, h: 116, n: 4.2, taper: 1,    c1: '#F7E7CB', c2: '#EBC896', faceDy: -4,  antenna: 1 },
    notetaker:{ w: 120, h: 112, n: 4.6, taper: 1,    c1: '#B5CBA3', c2: '#93AD81', faceDy: -4,  antenna: 0 },
    deploy:   { w: 86,  h: 136, n: 3.0, taper: 1,    c1: '#7E9DEB', c2: '#5878D2', faceDy: -14, antenna: 0 },
    hermes:   { w: 142, h: 124, n: 2.3, taper: 0.16, c1: '#F09A85', c2: '#D9725F', faceDy: 14,  antenna: 0 },
    scribe:   { w: 122, h: 122, n: 2.0, taper: 1,    c1: '#BDA8EA', c2: '#987FD6', faceDy: -4,  antenna: 0 },
    chief:    { w: 88,  h: 142, n: 6.0, taper: 1,    c1: '#F0DDBC', c2: '#D9BE93', faceDy: -18, antenna: 0 },
    watch:    { w: 140, h: 108, n: 2.6, taper: 1,    c1: '#F6CD6E', c2: '#E2AC43', faceDy: -2,  antenna: 0 }
  };

  // Face poses per state. rx/ry: eye size. kt/kb: top and bottom lid curvature
  // (kb below 0 bends the lower edge up into a happy crescent). tilt: inner corners up.
  const POSES = {
    idle:    { rx: 12.5, ry: 15,  kt: 1,   kb: 1,    tilt: 0,   lx: 0,  ly: 0,  brow: 0,   browT: 0,   mw: 18, mc: 6,  mo: 0,  cheek: .35, glow: .12, bend: 4,  sy: 1,   rot: 0 },
    working: { rx: 13,   ry: 10,  kt: .75, kb: 1,    tilt: -5,  lx: -2, ly: 3,  brow: .75, browT: -10, mw: 11, mc: 1,  mo: 0,  cheek: .25, glow: .35, bend: 2,  sy: 1,   rot: 0 },
    waiting: { rx: 14,   ry: 18,  kt: 1,   kb: 1,    tilt: 0,   lx: 0,  ly: -1, brow: .55, browT: 8,   mw: 10, mc: 2,  mo: 6,  cheek: .3,  glow: 1,   bend: 0,  sy: 1,   rot: 0 },
    blocked: { rx: 12,   ry: 14,  kt: 1,   kb: 1,    tilt: 14,  lx: 0,  ly: 2,  brow: 1,   browT: 18,  mw: 16, mc: -6, mo: 0,  cheek: .08, glow: .04, bend: 20, sy: .97, rot: -4 },
    done:    { rx: 13,   ry: 11,  kt: 1,   kb: -.55, tilt: 0,   lx: 0,  ly: -1, brow: 0,   browT: 0,   mw: 26, mc: 10, mo: 10, cheek: .6,  glow: .3,  bend: 3,  sy: 1,   rot: 0 }
  };

  // One accessory per agent, drawn in the same cel style: a fill, an ink outline, one highlight.
  // Each part sits at an anchor given in body-relative units and rotates with the body.
  const INK = '#1F2228';
  // An agent takes its accessory out while it is active and puts it away when idle or done.
  const ACTIVE = new Set(['working', 'waiting', 'blocked']);
  const ACC = {
    notetaker: [
      { layer: 'front', band: true, from: [0, -26] },
      { layer: 'front', at: (w, h) => [-w / 2 - 1, -4], from: [0, -26], svg: `<rect x="-9" y="-16" width="18" height="32" rx="8" fill="#4B505A" stroke="${INK}" stroke-width="3.2"/><rect x="-4.5" y="-10" width="5" height="20" rx="2.5" fill="#6E747F"/>` },
      { layer: 'front', at: (w, h) => [w / 2 + 1, -4], from: [0, -26], svg: `<rect x="-9" y="-16" width="18" height="32" rx="8" fill="#4B505A" stroke="${INK}" stroke-width="3.2"/><rect x="-0.5" y="-10" width="5" height="20" rx="2.5" fill="#6E747F"/>` }
    ],
    deploy: [
      { layer: 'back', at: (w, h) => [w / 2 - 2, -h / 2 + 18], rot: 36, k: 1.75, from: [-18, 30], svg: `<rect x="-5" y="-4" width="10" height="46" rx="5" fill="#C9CED6" stroke="${INK}" stroke-width="3.2"/><path d="M-6 -2 L-11 -8 A13 13 0 0 1 -6 -26 L-6 -16 L6 -16 L6 -26 A13 13 0 0 1 11 -8 L6 -2 Z" fill="#C9CED6" stroke="${INK}" stroke-width="3.2" stroke-linejoin="round"/><rect x="-2" y="4" width="3" height="30" rx="1.5" fill="#EEF1F5"/>` }
    ],
    hermes: [ { layer: 'front', glasses: true, from: [0, -30] } ],
    scribe: [
      { layer: 'back', at: (w, h) => [w * 0.22, -h / 2 + 14], rot: 26, k: 1.45, from: [-10, 34], svg: `<rect x="-5.5" y="-40" width="11" height="44" fill="#F2C14E" stroke="${INK}" stroke-width="3.2"/><path d="M-5.5 -40L0 -54L5.5 -40Z" fill="#F4D9A8" stroke="${INK}" stroke-width="3.2" stroke-linejoin="round"/><path d="M-1.8 -49.5L0 -54L1.8 -49.5Z" fill="${INK}"/><rect x="-2" y="-36" width="3" height="34" fill="#F8DA8A"/>` }
    ],
    chief: [
      { layer: 'front', at: (w, h) => [w / 2 - 6, h / 2 - 32], rot: 9, k: 1.4, from: [10, 40], svg: `<rect x="-16" y="-20" width="32" height="40" rx="3.5" fill="#B07D45" stroke="${INK}" stroke-width="3.2"/><rect x="-11" y="-13" width="22" height="28" rx="1.5" fill="#F3EEE4"/><rect x="-7" y="-24" width="14" height="7" rx="2" fill="#9AA1AB" stroke="${INK}" stroke-width="2.6"/><path d="M-7 -5h14M-7 1h14M-7 7h9" stroke="#9AA1AB" stroke-width="2.2" stroke-linecap="round"/>` }
    ],
    watch: [
      { layer: 'front', at: (w, h) => [w / 2 + 12, 2], k: 1.55, from: [26, -18], swing: true, svg: `<circle cx="0" cy="10" r="15" fill="#FFC961" opacity=".28"/><path d="M-6 -6a6 6 0 0 1 12 0" fill="none" stroke="${INK}" stroke-width="3"/><rect x="-9" y="-4" width="18" height="24" rx="4" fill="#3E434C" stroke="${INK}" stroke-width="3.2"/><rect x="-5" y="0" width="10" height="15" rx="2.5" fill="#FFD27A"/><rect x="-3" y="1.5" width="2.5" height="9" rx="1.2" fill="#FFF1C9"/>` }
    ]
  };
  const KEYS = Object.keys(POSES.idle);

  function el(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
  let uid = 0;

  class Char {
    constructor(host, opts = {}) {
      this.kind = opts.kind || 'link';
      this.accKind = opts.acc || null; // an accessory set chosen apart from the body (used by the agent builder)
      this.state = opts.state || 'idle';
      this.lively = opts.lively !== false;
      this.size = opts.size || 160;
      this.seed = Math.random() * 100;
      const id = 'c' + (++uid);
      const svg = el('svg', { viewBox: '0 0 200 200', width: this.size, height: this.size, role: 'img', 'aria-label': opts.label || this.kind });
      svg.style.overflow = 'visible';
      const defs = el('defs', {}, svg);
      this.grad = el('linearGradient', { id: id + 'g', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      this.s1 = el('stop', { offset: '0' }, this.grad); this.s2 = el('stop', { offset: '1' }, this.grad);
      const blur = el('filter', { id: id + 'b', x: '-1', y: '-1', width: '3', height: '3' }, defs);
      el('feGaussianBlur', { stdDeviation: 6 }, blur);
      this.shadow = el('ellipse', { cx: 100, cy: 172, rx: 50, ry: 6, fill: '#000', opacity: .22 }, svg);
      this.g = el('g', {}, svg);
      this.stalkO = el('path', { fill: 'none', stroke: '#7A4E1E', 'stroke-width': 9, 'stroke-linecap': 'round' }, this.g);
      this.stalk = el('path', { fill: 'none', stroke: '#E8AE55', 'stroke-width': 4.5, 'stroke-linecap': 'round' }, this.g);
      this.halo = el('circle', { r: 16, fill: '#F0A73A', filter: `url(#${id}b)` }, this.g);
      this.dot = el('circle', { r: 8.5, fill: '#F0A73A', stroke: '#7A4E1E', 'stroke-width': 3.5 }, this.g);
      this.accBack = el('g', {}, this.g);
      this.clip = el('clipPath', { id: id + 'k' }, defs); this.clipP = el('path', {}, this.clip);
      this.bodyG = el('g', { 'clip-path': `url(#${id}k)` }, this.g);
      this.shade = el('path', {}, this.bodyG); this.lit = el('path', {}, this.bodyG);
      this.hiB = el('ellipse', {}, this.bodyG);
      this.outline = el('path', { fill: 'none', 'stroke-width': 4.5, 'stroke-linejoin': 'round' }, this.g);
      this.cheekL = el('ellipse', { rx: 11, ry: 6.5, fill: '#F28B7E' }, this.g);
      this.cheekR = el('ellipse', { rx: 11, ry: 6.5, fill: '#F28B7E' }, this.g);
      this.browL = el('path', { fill: 'none', stroke: '#3A2A1C', 'stroke-width': 3.2, 'stroke-linecap': 'round' }, this.g);
      this.browR = el('path', { fill: 'none', stroke: '#3A2A1C', 'stroke-width': 3.2, 'stroke-linecap': 'round' }, this.g);
      this.eyeL = el('path', { fill: '#2B1D12' }, this.g);
      this.eyeR = el('path', { fill: '#2B1D12' }, this.g);
      this.hiL = el('circle', { fill: '#fff' }, this.g); this.hiR = el('circle', { fill: '#fff' }, this.g);
      this.mouth = el('path', { fill: '#3A2416', stroke: '#3A2416', 'stroke-width': 3.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, this.g);
      this.accFront = el('g', {}, this.g);
      this.parts = [];
      for (const kind in ACC) for (const part of ACC[kind]) {
        const parent = part.layer === 'back' ? this.accBack : this.accFront;
        const g = el('g', {}, parent), rec = { kind, part, g };
        if (part.svg) g.innerHTML = part.svg;
        if (part.band) { rec.bo = el('path', { fill: 'none', stroke: INK, 'stroke-width': 10, 'stroke-linecap': 'round' }, g); rec.bi = el('path', { fill: 'none', stroke: '#5A606B', 'stroke-width': 4.5, 'stroke-linecap': 'round' }, g); }
        if (part.glasses) { rec.gl = el('circle', { fill: 'rgba(255,255,255,.14)', stroke: '#3A2416', 'stroke-width': 3.4 }, g); rec.gr = el('circle', { fill: 'rgba(255,255,255,.14)', stroke: '#3A2416', 'stroke-width': 3.4 }, g); rec.br = el('path', { fill: 'none', stroke: '#3A2416', 'stroke-width': 3.4, 'stroke-linecap': 'round' }, g); }
        this.parts.push(rec);
      }
      host.appendChild(svg);
      this.svg = svg;
      // spring state
      const b = BODIES[this.kind], p = POSES[this.state];
      this.cur = {}; this.vel = {};
      const init = { ...p, w: b.w, h: b.h, n: b.n, taper: b.taper, faceDy: b.faceDy, ant: b.antenna, y: 0, sx: 1, ...this.cols(b), ...this.accT() };
      for (const k in init) { this.cur[k] = init[k]; this.vel[k] = 0; }
      this.blinkAt = 1 + Math.random() * 3; this.blink = 0; this.enteredAt = 0; this.t = 0;
      Char.all.push(this);
    }
    accT() { const on = ACTIVE.has(this.state), ak = this.accKind || this.kind, o = {}; for (const k in ACC) o['acc_' + k] = (k === ak && on) ? 1 : 0; return o; }
    setAcc(a) { this.accKind = a; }
    cols(b) { const a = hex(b.c1), c = hex(b.c2); return { r1: a[0], g1: a[1], b1: a[2], r2: c[0], g2: c[1], b2: c[2] }; }
    setState(s) { if (s === this.state) return; this.state = s; this.enteredAt = this.t; if (!reduce) { this.vel.sy = (this.vel.sy || 0) - 2.2; this.vel.y = (this.vel.y || 0) - 60; } }
    setKind(k) { if (k === this.kind) return; this.kind = k; if (!reduce) this.vel.sx = (this.vel.sx || 0) + 1.5; }
    targets() {
      const b = BODIES[this.kind], p = POSES[this.state], t = this.t - this.enteredAt, T = this.t + this.seed;
      const o = { ...p, w: b.w, h: b.h, n: b.n, taper: b.taper, faceDy: b.faceDy, ant: b.antenna, y: 0, sx: 1, ...this.cols(b), ...this.accT() };
      if (reduce) return o;
      const L = this.lively ? 1 : 0.45;
      switch (this.state) {
        case 'idle':
          o.sy = 1 + 0.018 * Math.sin(T * 1.7) * L; o.lx = 2.2 * Math.sin(T * 0.45) * L; o.ly = 0.8 * Math.sin(T * 0.3);
          break;
        case 'working': {
          o.y = -2.6 * Math.abs(Math.sin(T * 6.2)) * L; o.rot = 2.2 * Math.sin(T * 3.1) * L;
          const scan = (T * 0.9) % 1; o.lx = -4 + 8 * scan; o.ly = 3; o.glow = .3 + .1 * Math.sin(T * 4);
          break; }
        case 'waiting': {
          const ph = (T % 2.6) / 2.6;
          const hop = ph < .12 ? Math.sin(ph / .12 * Math.PI) : (ph > .18 && ph < .28 ? .55 * Math.sin((ph - .18) / .1 * Math.PI) : 0);
          o.y = -14 * hop * L; o.rot = (ph < .28 ? 5 * Math.sin(ph / .28 * TAU) : 0) * L;
          o.glow = .75 + .25 * Math.sin(T * 5); o.sy = 1 + (hop > 0 ? .04 * hop : 0) * L;
          break; }
        case 'blocked':
          o.rot = -4 + 3 * Math.sin(T * 1.3) * L; o.lx = 1.5 * Math.sin(T * .8);
          if ((T % 4.2) < .25) o.sx = 1 + .03 * Math.sin(T * 60) * L;
          break;
        case 'done':
          o.rot = 2.4 * Math.sin(T * 1.6) * L; o.y = t < .5 ? -18 * Math.sin(t / .5 * Math.PI) * L : 0;
          break;
      }
      return o;
    }
    step(dt) {
      this.t += dt;
      const tg = this.targets();
      if (reduce) {
        // Reduced motion: no springs, every number goes straight to its target.
        for (const key in tg) { this.cur[key] = tg[key]; this.vel[key] = 0; }
      } else {
        // Springs, integrated in small fixed substeps so a slow frame can't make them diverge.
        const k = 190, c = 17, steps = Math.max(1, Math.ceil(dt / (1 / 240))), h = dt / steps;
        for (const key in tg) if (this.cur[key] === undefined) { this.cur[key] = tg[key]; this.vel[key] = 0; }
        for (let i = 0; i < steps; i++) for (const key in tg) {
          const a = (tg[key] - this.cur[key]) * k - this.vel[key] * c;
          this.vel[key] += a * h; this.cur[key] += this.vel[key] * h;
        }
      }
      // blink
      if (this.state !== 'done' && this.t > this.blinkAt) { this.blink = 1; this.blinkAt = this.t + 2.4 + Math.random() * 3.2; }
      this.blink = Math.max(0, this.blink - dt * 7);
      this.draw();
    }
    draw() {
      const p = this.cur, cx = 100, bottom = 168 + p.y;
      const w = p.w * p.sx, h = p.h * clamp(p.sy, .8, 1.2), n = clamp(p.n, 1.6, 9);
      const cy = bottom - h / 2;
      // local frame: origin at the body's bottom center, rotated by p.rot; y given relative to body center
      const rad = p.rot * Math.PI / 180, cr = Math.cos(rad), sr = Math.sin(rad);
      const P = (x, y) => { const Y = y - h / 2; return [cx + x * cr - Y * sr, bottom + x * sr + Y * cr]; };
      // body
      const N = 96, pts = [];
      for (let i = 0; i < N; i++) {
        const t = i / N * TAU, co = Math.cos(t), si = Math.sin(t);
        let x = Math.sign(co) * Math.pow(Math.abs(co), 2 / n) * w / 2;
        const y = Math.sign(si) * Math.pow(Math.abs(si), 2 / n) * h / 2;
        const up = Math.max(0, -y / (h / 2)); x *= 1 - (1 - clamp(p.taper, .05, 1)) * Math.pow(up, 0.85);
        pts.push(P(x, y));
      }
      const toD = arr => arr.map(([X, Y], i) => (i ? 'L' : 'M') + X.toFixed(2) + ' ' + Y.toFixed(2)).join('') + 'Z';
      const d = toD(pts);
      // cel shading: the light is fixed up-left in the scene, so the hard shadow band
      // slides across the body as the character tilts and hops.
      const [bcx, bcy] = P(0, 0), ox = -w * 0.11, oy = -h * 0.13;
      const litD = toD(pts.map(([X, Y]) => [bcx + (X - bcx) * 0.95 + ox, bcy + (Y - bcy) * 0.95 + oy]));
      this.clipP.setAttribute('d', d); this.shade.setAttribute('d', d); this.lit.setAttribute('d', litD);
      const c1 = [p.r1, p.g1, p.b1], c2 = [p.r2, p.g2, p.b2];
      const rgb = c => `rgb(${clamp(c[0], 0, 255) | 0},${clamp(c[1], 0, 255) | 0},${clamp(c[2], 0, 255) | 0})`;
      this.lit.setAttribute('fill', rgb(c1)); this.shade.setAttribute('fill', rgb(c2));
      this.hiB.setAttribute('fill', rgb(c1.map(v => v + (255 - v) * 0.55)));
      this.hiB.setAttribute('cx', (bcx - w * 0.22).toFixed(1)); this.hiB.setAttribute('cy', (bcy - h * 0.27).toFixed(1));
      this.hiB.setAttribute('rx', (w * 0.13).toFixed(1)); this.hiB.setAttribute('ry', (h * 0.065).toFixed(1));
      this.hiB.setAttribute('transform', `rotate(-28 ${(bcx - w * 0.22).toFixed(1)} ${(bcy - h * 0.27).toFixed(1)})`);
      this.outline.setAttribute('d', d); this.outline.setAttribute('stroke', rgb(c2.map(v => v * 0.5)));
      const lift = clamp(-p.y / 20, 0, 1);
      this.shadow.setAttribute('rx', (w * 0.42 * (1 - .3 * lift)).toFixed(1));
      this.shadow.setAttribute('opacity', (.22 * (1 - .5 * lift)).toFixed(2));
      // antenna
      const ant = clamp(p.ant, 0, 1);
      const topY = -h / 2, baseL = P(6, topY + 3);
      const tip = P(14 + p.bend * .8, topY - 28 + p.bend * .9), ctrl = P(10 + p.bend * .2, topY - 16);
      this.stalk.setAttribute('d', `M${baseL[0].toFixed(1)} ${baseL[1].toFixed(1)} Q${ctrl[0].toFixed(1)} ${ctrl[1].toFixed(1)} ${tip[0].toFixed(1)} ${tip[1].toFixed(1)}`);
      this.stalk.setAttribute('opacity', ant); this.stalkO.setAttribute('d', this.stalk.getAttribute('d')); this.stalkO.setAttribute('opacity', ant);
      for (const c of [this.dot, this.halo]) { c.setAttribute('cx', tip[0].toFixed(1)); c.setAttribute('cy', tip[1].toFixed(1)); }
      const g = clamp(p.glow, 0, 1);
      this.dot.setAttribute('opacity', ant);
      this.dot.setAttribute('fill', `rgb(${lerp(205, 240, g) | 0},${lerp(150, 167, g) | 0},${lerp(80, 58, g) | 0})`);
      this.halo.setAttribute('opacity', (ant * g * .85).toFixed(2));
      // face
      const fy = p.faceDy - 2, sp = clamp(w * 0.21, 18, 30);
      const open = clamp(1 - this.blink, 0, 1);
      const eye = (side, path, hi, brow, cheek) => {
        const ex = side * sp + p.lx * .6, ey = fy + p.ly * .5;
        const rx = p.rx, ry = Math.max(.6, p.ry * open), kt = p.kt, kb = lerp(.08, p.kb, open);
        const tilt = side * p.tilt * Math.PI / 180, ct = Math.cos(tilt), st = Math.sin(tilt);
        const Q = (x, y) => P(ex + x * ct - y * st, ey + x * st + y * ct);
        const K = .5523;
        const pts = [[-rx, 0], [-rx, -ry * kt * K], [-rx * K, -ry * kt], [0, -ry * kt], [rx * K, -ry * kt], [rx, -ry * kt * K], [rx, 0],
          [rx, ry * kb * K], [rx * K, ry * kb], [0, ry * kb], [-rx * K, ry * kb], [-rx, ry * kb * K], [-rx, 0]].map(([x, y]) => Q(x, y).map(v => v.toFixed(2)));
        path.setAttribute('d', `M${pts[0]}C${pts[1]} ${pts[2]} ${pts[3]}C${pts[4]} ${pts[5]} ${pts[6]}C${pts[7]} ${pts[8]} ${pts[9]}C${pts[10]} ${pts[11]} ${pts[12]}Z`);
        (this.eyeC || (this.eyeC = {}))[side] = { c: Q(0, 0), r: p.rx };
        const hp = Q(rx * .32 + p.lx * .25, -ry * kt * .42 + p.ly * .2);
        hi.setAttribute('cx', hp[0].toFixed(2)); hi.setAttribute('cy', hp[1].toFixed(2));
        hi.setAttribute('r', (rx * .3).toFixed(2));
        hi.setAttribute('opacity', clamp((ry * Math.min(kt, kb + 1) - 4) / 6, 0, 1).toFixed(2));
        const bt = -side * p.browT * Math.PI / 180, by = -p.ry * p.kt - 8;
        const b1 = Q(-rx * .9 * Math.cos(bt), by - rx * .9 * Math.sin(bt) * -1), b2 = Q(rx * .9 * Math.cos(bt), by - rx * .9 * Math.sin(bt)), bm = Q(0, by - 2.5);
        brow.setAttribute('d', `M${b1[0].toFixed(1)} ${b1[1].toFixed(1)}Q${bm[0].toFixed(1)} ${bm[1].toFixed(1)} ${b2[0].toFixed(1)} ${b2[1].toFixed(1)}`);
        brow.setAttribute('opacity', clamp(p.brow, 0, 1).toFixed(2));
        const ck = P(side * (sp + 10), fy + 19);
        cheek.setAttribute('cx', ck[0].toFixed(1)); cheek.setAttribute('cy', ck[1].toFixed(1));
        cheek.setAttribute('opacity', clamp(p.cheek, 0, 1).toFixed(2));
      };
      eye(-1, this.eyeL, this.hiL, this.browL, this.cheekL);
      eye(1, this.eyeR, this.hiR, this.browR, this.cheekR);
      // mouth
      const my = fy + 25, mw = p.mw, mc = p.mc, mo = Math.max(0, p.mo);
      const m1 = P(-mw / 2 + p.lx * .3, my), m2 = P(mw / 2 + p.lx * .3, my), mt = P(p.lx * .3, my + mc * .9 - mo * .15), mb = P(p.lx * .3, my + mc * .9 + mo);
      this.mouth.setAttribute('d', `M${m1[0].toFixed(1)} ${m1[1].toFixed(1)}Q${mt[0].toFixed(1)} ${mt[1].toFixed(1)} ${m2[0].toFixed(1)} ${m2[1].toFixed(1)}Q${mb[0].toFixed(1)} ${mb[1].toFixed(1)} ${m1[0].toFixed(1)} ${m1[1].toFixed(1)}Z`);
      // accessories
      for (const r of this.parts) {
        const vis = clamp(p['acc_' + r.kind] || 0, 0, 1);
        r.g.setAttribute('opacity', vis.toFixed(2));
        if (vis < 0.01) continue;
        if (r.part.at) {
          const off = r.part.from || [0, 0], away = 1 - vis;
          const [ax, ay] = r.part.at(w, h), [X, Y] = P(ax + off[0] * away, ay + off[1] * away);
          const swing = r.part.swing ? 14 * Math.sin(this.t * 2.2) * vis * (this.lively ? 1 : .4) + 40 * away : 0;
          r.g.setAttribute('transform', `translate(${X.toFixed(1)} ${Y.toFixed(1)}) rotate(${(p.rot + (r.part.rot || 0) + swing).toFixed(1)}) scale(${((0.6 + 0.4 * vis) * (r.part.k || 1)).toFixed(3)})`);
        }
        if (r.part.band) {
          const dy = (r.part.from || [0, 0])[1] * (1 - vis);
          const a = P(-w / 2 - 1, -12 + dy), b2 = P(w / 2 + 1, -12 + dy), c1 = P(-w / 2 - 4, -h / 2 - 26 + dy), c2 = P(w / 2 + 4, -h / 2 - 26 + dy);
          const dd = `M${a[0].toFixed(1)} ${a[1].toFixed(1)}C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${b2[0].toFixed(1)} ${b2[1].toFixed(1)}`;
          r.bo.setAttribute('d', dd); r.bi.setAttribute('d', dd);
        }
        if (r.part.glasses && this.eyeC) {
          const gy = (r.part.from || [0, 0])[1] * (1 - vis);
          const L = { c: [this.eyeC[-1].c[0], this.eyeC[-1].c[1] + gy], r: this.eyeC[-1].r }, R = { c: [this.eyeC[1].c[0], this.eyeC[1].c[1] + gy], r: this.eyeC[1].r }, rr = (L.r + 6).toFixed(1);
          r.gl.setAttribute('cx', L.c[0].toFixed(1)); r.gl.setAttribute('cy', L.c[1].toFixed(1)); r.gl.setAttribute('r', rr);
          r.gr.setAttribute('cx', R.c[0].toFixed(1)); r.gr.setAttribute('cy', R.c[1].toFixed(1)); r.gr.setAttribute('r', rr);
          const m = [(L.c[0] + R.c[0]) / 2, (L.c[1] + R.c[1]) / 2 - 3];
          r.br.setAttribute('d', `M${(L.c[0] + L.r + 6).toFixed(1)} ${L.c[1].toFixed(1)}Q${m[0].toFixed(1)} ${m[1].toFixed(1)} ${(R.c[0] - R.r - 6).toFixed(1)} ${R.c[1].toFixed(1)}`);
        }
      }
    }
  }
  Char.all = [];
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    for (const c of Char.all) if (c.svg.isConnected) c.step(dt);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  window.UplinkCast = { Char, BODIES, POSES };
})();
