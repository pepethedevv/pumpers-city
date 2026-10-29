// generated from src/mapgen.js, do not edit here
const T = 16;
// ================= TILES =================
const G = {
  GRASS: 0, ROAD: 1, WALK: 2, BLD: 3, WATER: 4, TREE: 5, PLAZA: 6, FOUNT: 7, SAND: 8, ROCK: 9, LAVA: 10, CONE: 11, PALM: 12,
  LAMP: 13, BENCH: 14, HEDGE: 15, CAR: 16, PATH: 17, FLOWER: 18, ALLEY: 19, BOULDER: 20, BIN: 21,
  DOCK: 22, CONCRETE: 23, RAIL: 24, FENCE: 25, PIPE: 26, BARREL: 27, CRATE: 28, PINE: 29, BIGTREE: 30, LOG: 31, MUSHROOM: 32,
  SNOW: 33, ICE: 34, BRIDGE: 35, DIRT: 36, OBSIDIAN: 37, CRYSTAL: 38, TALLGRASS: 39, CLIFF: 40, DEADTREE: 41, CAMPFIRE: 42,
  SNOWMAN: 43, SCRAP: 44, LOT: 45,
};
// Walls and big objects block movement. Small props are walk-through so nobody gets stuck on them.
const SOLID = new Set([G.BLD, G.WATER, G.FOUNT, G.LAVA, G.CONE, G.HEDGE, G.CAR, G.FENCE, G.PINE, G.BIGTREE, G.CLIFF, G.CAMPFIRE]);
const DECOR = new Set([G.PIPE, G.TREE, G.PALM, G.LAMP, G.BENCH, G.BOULDER, G.BIN, G.BARREL, G.CRATE, G.LOG, G.MUSHROOM, G.CRYSTAL, G.DEADTREE, G.SNOWMAN, G.SCRAP, G.TALLGRASS]);
// Tiles that are the ground itself (the painter draws these first, props go on top)
const GROUND = new Set([G.GRASS, G.ROAD, G.WALK, G.WATER, G.PLAZA, G.SAND, G.ROCK, G.LAVA, G.CONE, G.PATH, G.FLOWER, G.ALLEY, G.HEDGE,
  G.DOCK, G.CONCRETE, G.RAIL, G.SNOW, G.ICE, G.BRIDGE, G.DIRT, G.OBSIDIAN, G.CLIFF, G.LOT]);

const grid = (W, H, v) => Array.from({ length: H }, () => new Array(W).fill(v));
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function hash2(x, y, s) { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 982451653)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
function noise(s, scale) {
  return (x, y) => {
    const X = x / scale, Y = y / scale, xi = Math.floor(X), yi = Math.floor(Y), xf = X - xi, yf = Y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
function fbm(s, scale) { const a = noise(s, scale), b = noise(s + 1, scale / 2), c = noise(s + 2, scale / 4); return (x, y) => a(x, y) * 0.57 + b(x, y) * 0.29 + c(x, y) * 0.14; }

function newMap(key, name, biome, W, H, fill, seed) {
  return { key, name, biome, W, H, seed, g: grid(W, H, fill), gr: grid(W, H, fill), mark: new Uint8Array(W * H), objs: [], portals: [],
    smokes: [], lights: [], fires: [], steams: [], spawn: null, ground: fill, trail: G.PATH };
}
const inb = (m, x, y) => x >= 0 && y >= 0 && x < m.W && y < m.H;
function set(m, x, y, t) { if (!inb(m, x, y)) return; m.g[y][x] = t; if (GROUND.has(t)) m.gr[y][x] = t; }
function fillR(m, x, y, w, h, t) { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(m, xx, yy, t); }
function areaOk(m, x, y, w, h, ok) { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { if (!inb(m, xx, yy) || !ok(m.g[yy][xx], xx, yy)) return false; } return true; }
function addObj(m, o, tile = G.BLD) { m.objs.push(o); if (tile !== null) for (let yy = o.y; yy < o.y + o.h; yy++) for (let xx = o.x; xx < o.x + o.w; xx++) if (inb(m, xx, yy)) m.g[yy][xx] = tile; return o; }
const isOpenGround = t => t === G.GRASS || t === G.CONCRETE || t === G.SNOW || t === G.SAND || t === G.ROCK || t === G.DIRT || t === G.FLOWER || t === G.TALLGRASS || t === G.PLAZA || t === G.ALLEY || t === G.OBSIDIAN;

// Paint a wobbly trail through waypoints. Water becomes a bridge, lava becomes cooled rock, walls get a gap.
function carve(m, pts, w, tile, r) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1;
    const bend = (r() - 0.5) * Math.min(18, n * 0.25), nx = -(y1 - y0) / n, ny = (x1 - x0) / n;
    for (let k = 0; k <= n; k++) {
      const t = k / n, off = Math.sin(t * Math.PI) * bend;
      const cx = Math.round(x0 + (x1 - x0) * t + nx * off), cy = Math.round(y0 + (y1 - y0) * t + ny * off);
      for (let dy = 0; dy < w; dy++) for (let dx = 0; dx < w; dx++) {
        const X = cx + dx, Y = cy + dy; if (!inb(m, X, Y)) continue;
        const cur = m.g[Y][X];
        if (cur === G.WATER) set(m, X, Y, G.BRIDGE);
        else if (cur === G.LAVA) set(m, X, Y, G.OBSIDIAN);
        else if (cur === G.BRIDGE || cur === G.ROAD || cur === G.WALK || cur === G.DOCK || cur === G.BLD || cur === G.CONE || cur === G.ICE || cur === G.FOUNT || cur === G.CAR) { /* keep */ }
        else set(m, X, Y, tile);
      }
    }
  }
}
// Waypoint grid connected like a loose net, used for trails in nature maps
function netNodes(m, cols, rows, r, ok) {
  const nodes = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    let x, y, k = 0;
    do { x = Math.round((i + 0.5 + (r() - 0.5) * 0.6) * m.W / cols); y = Math.round((j + 0.5 + (r() - 0.5) * 0.6) * m.H / rows); k++; } while (ok && !ok(x, y) && k < 30);
    nodes.push({ x, y, i, j });
  }
  return nodes;
}
function netEdges(nodes, cols, rows, r, keep = 0.75) {
  const at = (i, j) => nodes[j * cols + i], e = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    if (i < cols - 1 && (j === Math.floor(rows / 2) || r() < keep)) e.push([at(i, j), at(i + 1, j)]);
    if (j < rows - 1 && (i === 0 || i === cols - 1 || r() < keep)) e.push([at(i, j), at(i, j + 1)]);
  }
  return e;
}

// Roads: 3 tiles wide, with optional 2-tile sidewalks, centre dashes and crosswalks (stored in m.mark bits)
// mark bits: 1 dash on horizontal road, 2 dash on vertical road, 4 crosswalk on horizontal road, 8 crosswalk on vertical road
function buildRoads(m, vr, hr, walk) {
  for (const v of vr) for (let y = v.a; y <= v.b; y++) for (let x = v.at; x < v.at + 3; x++) set(m, x, y, G.ROAD);
  for (const h of hr) for (let x = h.a; x <= h.b; x++) for (let y = h.at; y < h.at + 3; y++) set(m, x, y, G.ROAD);
  if (walk) for (let y = 0; y < m.H; y++) for (let x = 0; x < m.W; x++) {
    if (m.g[y][x] === G.ROAD || m.g[y][x] === G.WATER) continue;
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) if (m.g[y + dy]?.[x + dx] === G.ROAD) { near = true; break; }
    if (near) set(m, x, y, G.WALK);
  }
  const inV = (x, y) => vr.some(v => x >= v.at && x < v.at + 3 && y >= v.a && y <= v.b);
  const inH = (x, y) => hr.some(h => y >= h.at && y < h.at + 3 && x >= h.a && x <= h.b);
  for (const h of hr) for (let x = h.a; x <= h.b; x++) if (!inV(x, h.at + 1)) m.mark[(h.at + 1) * m.W + x] |= 1;
  for (const v of vr) for (let y = v.a; y <= v.b; y++) if (!inH(v.at + 1, y)) m.mark[y * m.W + v.at + 1] |= 2;
  for (const v of vr) for (const h of hr) {
    if (!(v.at >= h.a && v.at <= h.b && h.at >= v.a && h.at <= v.b)) continue;
    for (let k = 0; k < 3; k++) {
      for (const X of [v.at - 1, v.at + 3]) if (m.g[h.at + k]?.[X] === G.ROAD) m.mark[(h.at + k) * m.W + X] |= 4;
      for (const Y of [h.at - 1, h.at + 3]) if (m.g[Y]?.[v.at + k] === G.ROAD) m.mark[Y * m.W + v.at + k] |= 8;
    }
  }
  m.vr = (m.vr || []).concat(vr); m.hr = (m.hr || []).concat(hr);
}
function roadLamps(m, every, onTile = G.WALK) {
  for (const h of m.hr) for (let x = h.a + 2; x <= h.b; x += every) for (const y of [h.at - 2, h.at + 4]) if (m.g[y]?.[x] === onTile) set(m, x, y, G.LAMP);
  for (const v of m.vr) for (let y = v.a + 2; y <= v.b; y += every) for (const x of [v.at - 2, v.at + 4]) if (m.g[y]?.[x] === onTile) set(m, x, y, G.LAMP);
}
function parkedCars(m, r, chance, palette) {
  const nearCross = (x, y) => m.hr.some(h => Math.abs(y - h.at - 1) < 6 && x >= h.a - 6 && x <= h.b + 6) && m.vr.some(v => Math.abs(x - v.at - 1) < 6 && y >= v.a - 6 && y <= v.b + 6);
  const ok = (x, y) => m.g[y]?.[x] === G.ROAD && !nearCross(x, y);
  for (const h of m.hr) for (let x = h.a + 3; x < h.b - 3; x++) if (r() < chance) {
    const y = r() < 0.5 ? h.at : h.at + 2;
    if (ok(x, y) && ok(x + 1, y)) { addObj(m, { kind: "car", x, y, w: 2, h: 1, horiz: true, c: Math.floor(r() * 6), pal: palette }, G.CAR); x += 4; }
  }
  for (const v of m.vr) for (let y = v.a + 3; y < v.b - 3; y++) if (r() < chance) {
    const x = r() < 0.5 ? v.at : v.at + 2;
    if (ok(x, y) && ok(x, y + 1)) { addObj(m, { kind: "car", x, y, w: 1, h: 2, horiz: false, c: Math.floor(r() * 6), pal: palette }, G.CAR); y += 4; }
  }
}
// Fill a rectangle of land with 3/4-view houses separated by alleys
function fillHouses(m, b, r, opts = {}) {
  const ok = opts.ok || ((t) => isOpenGround(t));
  let y = b.y0;
  while (y <= b.y1 - 4) {
    const h = Math.min((opts.hmin || 4) + Math.floor(r() * 3), b.y1 - y + 1); let x = b.x0;
    while (x <= b.x1 - 3) {
      const w = Math.min((opts.wmin || 4) + Math.floor(r() * (opts.wvar || 6)), b.x1 - x + 1);
      if (w >= 4 && h >= 4 && areaOk(m, x, y, w, h, ok)) addObj(m, { kind: opts.kind || "house", x, y, w, h, roof: Math.floor(r() * 7), wall: Math.floor(r() * 5), shop: r() < (opts.shops ?? 0.45), deco: Math.floor(r() * 5), seed: Math.floor(r() * 1e6) });
      x += w + 1;
    }
    y += h + 1;
  }
  if (opts.alley) for (let yy = b.y0; yy <= b.y1; yy++) for (let xx = b.x0; xx <= b.x1; xx++) if (m.g[yy]?.[xx] === G.GRASS) set(m, xx, yy, r() < 0.04 ? G.BIN : G.ALLEY), m.gr[yy][xx] = G.ALLEY;
}
function placePortal(m, x, y, to) {
  for (let yy = y - 2; yy <= y + 2; yy++) for (let xx = x - 2; xx <= x + 2; xx++) {
    if (!inb(m, xx, yy)) continue;
    const t = m.g[yy][xx];
    if (SOLID.has(t) || DECOR.has(t) || t === G.ROAD) { const gnd = SOLID.has(m.gr[yy][xx]) || m.gr[yy][xx] === G.ROAD || m.gr[yy][xx] === G.LAVA ? m.ground : m.gr[yy][xx]; set(m, xx, yy, gnd); m.g[yy][xx] = gnd; }
  }
  m.portals.push({ x, y, to });
}
function ellipse(m, cx, cy, rx, ry, t, nz, onlyIf) {
  for (let y = Math.floor(cy - ry - 4); y <= cy + ry + 4; y++) for (let x = Math.floor(cx - rx - 4); x <= cx + rx + 4; x++) {
    if (!inb(m, x, y)) continue;
    const d = Math.hypot((x - cx) / rx, (y - cy) / ry) + (nz ? (nz(x, y) - 0.5) * 0.35 : 0);
    if (d < 1 && (!onlyIf || onlyIf(m.g[y][x]))) set(m, x, y, t);
  }
}

// Breadth-first reachability from the spawn. Boxes, NPCs and exploration only use tiles you can actually walk to.
// Natural barriers that may be opened up so every area has a way in and out (never water, lava or buildings)
const CUTTABLE = new Set([G.CLIFF, G.PINE, G.BIGTREE, G.HEDGE, G.FENCE]);
function openTile(m, x, y) {
  if (!inb(m, x, y) || !CUTTABLE.has(m.g[y][x])) return;
  const under = m.gr[y][x], gnd = SOLID.has(under) || under === G.ROAD ? (m.trail === G.DIRT ? G.DIRT : m.ground) : under;
  set(m, x, y, gnd); m.g[y][x] = gnd; m.gr[y][x] = gnd;
}
function walkDist(m) {
  const W = m.W, H = m.H, dist = new Int32Array(W * H).fill(-1), q = [m.spawn.y * W + m.spawn.x]; dist[q[0]] = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i], x = p % W, y = (p - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const k = Y * W + X; if (dist[k] >= 0 || SOLID.has(m.g[Y][X])) continue; dist[k] = dist[p] + 1; q.push(k);
    }
  }
  return dist;
}
// 1) open areas nobody can get into get a passage cut to the nearest reachable ground (tiny ones are filled in)
function connectPockets(m) {
  const W = m.W, H = m.H;
  for (let round = 0; round < 6; round++) {
    const dist = walkDist(m), comp = new Int32Array(W * H).fill(-1), comps = [];
    for (let i = 0; i < W * H; i++) {
      const x = i % W, y = (i - x) / W;
      if (dist[i] >= 0 || comp[i] >= 0 || SOLID.has(m.g[y][x])) continue;
      const id = comps.length, list = [i]; comp[i] = id;
      for (let j = 0; j < list.length; j++) { const p = list[j], px = p % W, py = (p - px) / W;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = px + dx, Y = py + dy, k = Y * W + X; if (X < 0 || Y < 0 || X >= W || Y >= H || comp[k] >= 0 || dist[k] >= 0 || SOLID.has(m.g[Y][X])) continue; comp[k] = id; list.push(k); } }
      comps.push(list);
    }
    if (!comps.length) return;
    let cut = 0;
    for (const list of comps) {
      if (list.length < 8) { // a crumb of ground inside a cliff or a hedge: fill it with what surrounds it
        for (const p of list) { const x = p % W, y = (p - x) / W; const around = [m.g[y - 1]?.[x], m.g[y + 1]?.[x], m.g[y]?.[x - 1], m.g[y]?.[x + 1]].find(t => CUTTABLE.has(t)); if (around !== undefined) { set(m, x, y, around); m.g[y][x] = around; } }
        continue;
      }
      // shortest way out through cuttable barriers
      const prev = new Int32Array(W * H).fill(-2), q = [];
      for (const p of list) { prev[p] = -1; q.push(p); }
      let hit = -1;
      for (let i = 0; i < q.length && hit < 0; i++) { const p = q[i], x = p % W, y = (p - x) / W;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy, k = Y * W + X;
          if (X < 1 || Y < 1 || X >= W - 1 || Y >= H - 1 || prev[k] !== -2) continue;
          const t = m.g[Y][X];
          if (dist[k] >= 0) { prev[k] = p; hit = k; break; }
          if (!CUTTABLE.has(t) && SOLID.has(t)) continue;
          prev[k] = p; q.push(k); } }
      if (hit < 0) continue;
      for (let p = prev[hit]; p >= 0 && prev[p] !== -1; p = prev[p]) { const x = p % W, y = (p - x) / W; openTile(m, x, y); openTile(m, x + 1, y); openTile(m, x, y + 1); cut++; }
    }
    if (!cut) return;
  }
}
// 2) no dead ends behind thin walls: where a thin natural wall (up to 4 tiles) separates two spots that are
// far apart on foot, open a 2-wide gap in it
function openShortcuts(m) {
  const W = m.W, H = m.H;
  for (let round = 0; round < 4; round++) {
    const dist = walkDist(m), cands = [];
    for (const [ax, ay] of [[1, 0], [0, 1]]) {
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const a = y * W + x; if (dist[a] < 0) continue;
        const nx = x + ax, ny = y + ay; if (!CUTTABLE.has(m.g[ny]?.[nx])) continue;
        let len = 0, X = nx, Y = ny;
        while (len < 5 && inb(m, X, Y) && CUTTABLE.has(m.g[Y][X])) { len++; X += ax; Y += ay; }
        if (len > 4 || !inb(m, X, Y)) continue;
        const b = Y * W + X; if (dist[b] < 0) continue;
        const gain = Math.abs(dist[a] - dist[b]) - len;
        if (gain > 45) cands.push({ x, y, ax, ay, len, gain });
      }
    }
    if (!cands.length) return;
    cands.sort((p, q) => q.gain - p.gain);
    const used = new Uint8Array(W * H); let made = 0;
    for (const c of cands) {
      if (used[c.y * W + c.x]) continue;
      for (let i = 1; i <= c.len; i++) { const X = c.x + c.ax * i, Y = c.y + c.ay * i; openTile(m, X, Y); openTile(m, X + c.ay, Y + c.ax); }
      for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) if (inb(m, c.x + dx, c.y + dy)) used[(c.y + dy) * W + c.x + dx] = 1;
      if (++made >= 60) break;
    }
  }
}
function finishMap(m) {
  const W = m.W, H = m.H;
  fillDeadEnds(m);
  connectPockets(m);
  openShortcuts(m);
  fillDeadEnds(m);
  const reach = () => {
    const seen = new Uint8Array(W * H), q = [m.spawn.y * W + m.spawn.x]; seen[q[0]] = 1;
    for (let i = 0; i < q.length; i++) {
      const p = q[i], x = p % W, y = (p - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const k = Y * W + X; if (seen[k] || SOLID.has(m.g[Y][X])) continue; seen[k] = 1; q.push(k);
      }
    }
    return seen;
  };
  let seen = reach();
  const r = rng(m.seed + 999);
  for (const p of m.portals) if (!seen[p.y * W + p.x]) { carve(m, [[m.spawn.x, m.spawn.y], [p.x, p.y]], 2, m.trail, r); seen = reach(); }
  m.reach = seen;
  m.spots = [];
  const CELL = 4; m.cellW = Math.ceil(W / CELL); m.cellH = Math.ceil(H / CELL); m.cellOk = new Uint8Array(m.cellW * m.cellH); m.cells = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!seen[y * W + x]) continue;
    const t = m.g[y][x], c = Math.floor(y / CELL) * m.cellW + Math.floor(x / CELL);
    if (!m.cellOk[c]) { m.cellOk[c] = 1; m.cells++; }
    if (!DECOR.has(t) && t !== G.ROAD && t !== G.RAIL && t !== G.BRIDGE) m.spots.push(y * W + x);
  }
  m.objs.sort((a, b) => (a.y + a.h) - (b.y + b.h));
  return m;
}

// Close up one-tile dead-end slots between natural walls (rocks, trees, water, lava, hedges),
// so you never walk into a narrow nook and have to back out.
function fillDeadEnds(m) {
  const NAT = new Set([G.CLIFF, G.PINE, G.BIGTREE, G.WATER, G.LAVA, G.HEDGE, G.CONE]);
  const keep = new Set(m.portals.map(p => p.y * m.W + p.x).concat([m.spawn.y * m.W + m.spawn.x]));
  for (let pass = 0; pass < 12; pass++) {
    let changed = 0;
    for (let y = 1; y < m.H - 1; y++) for (let x = 1; x < m.W - 1; x++) {
      const t = m.g[y][x];
      if (SOLID.has(t) || t === G.BRIDGE || t === G.ROAD || keep.has(y * m.W + x)) continue;
      const nb = [m.g[y - 1][x], m.g[y + 1][x], m.g[y][x - 1], m.g[y][x + 1]], solid = nb.filter(v => SOLID.has(v));
      if (solid.length >= 3 && solid.every(v => NAT.has(v))) { const f = solid.includes(G.CLIFF) ? G.CLIFF : solid[0]; set(m, x, y, f === G.CONE ? G.CLIFF : f); changed++; }
    }
    if (!changed) break;
  }
}

// ================= DOWNTOWN (hub) =================
function makeDowntown() {
  const W = 360, H = 260, m = newMap("downtown", "DOWNTOWN", "city", W, H, G.GRASS, 42), r = rng(42);
  const xs = [], ys = [];
  for (let x = 9; x < W - 18; x += 24 + Math.floor(r() * 12)) xs.push(x);
  for (let y = 9; y < H - 16; y += 21 + Math.floor(r() * 12)) ys.push(y);
  const RI = 2, riverMid = xs[RI] + 1, cxm = W / 2, cym = H / 2;
  // roads as segments between crossings; some are dropped so blocks merge into bigger ones
  const vr = [], hr = [];
  const keep = (x, y) => Math.hypot(x - cxm, y - cym) < 45 || r() > 0.17;
  xs.forEach((x, i) => { if (i === RI) return; const yy = [0, ...ys.map(y => y + 1), H - 1]; for (let k = 0; k < yy.length - 1; k++) if (keep(x, (yy[k] + yy[k + 1]) / 2)) vr.push({ at: x, a: yy[k], b: yy[k + 1] + 1 }); });
  ys.forEach(y => { const xx = [0, ...xs.map(x => x + 1), W - 1]; for (let k = 0; k < xx.length - 1; k++) if (keep((xx[k] + xx[k + 1]) / 2, y)) hr.push({ at: y, a: xx[k], b: xx[k + 1] + 1 }); });
  buildRoads(m, vr, hr, true);

  // a river runs down the corridor where a road would be; roads cross it on bridges
  const rn = noise(7, 30), amp = Math.min(riverMid - xs[RI - 1], xs[RI + 1] - riverMid) - 12, riverX = y => Math.round(riverMid + (rn(3, y) - 0.5) * 2 * amp);
  const bank = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { const cx = riverX(y); for (let x = cx - 10; x <= cx + 10; x++) {
    if (!inb(m, x, y)) continue; const d = Math.abs(x - cx), t = m.g[y][x];
    if (d <= 3) set(m, x, y, t === G.ROAD || t === G.WALK ? G.BRIDGE : G.WATER);
    else if (d <= 8 && t !== G.ROAD && t !== G.WALK) bank[y * W + x] = 1;
  } }
  // blocks = connected patches of open land between roads
  const blocks = landBlocks(m, t => t === G.GRASS);
  const center = blocks.filter(b => b.w >= 16 && b.h >= 14).reduce((a, b) => Math.hypot(b.cx - cxm, b.cy - cym) < Math.hypot(a.cx - cxm, a.cy - cym) ? b : a);
  for (const b of blocks) {
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (bank[y * W + x] && m.g[y][x] === G.GRASS) set(m, x, y, r() < 0.18 ? G.TREE : r() < 0.05 ? G.BENCH : G.GRASS);
    if (b === center) continue;
    if (b.w < 7 || b.h < 7) { for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (m.g[y][x] === G.GRASS && r() < 0.2) set(m, x, y, G.TREE); continue; }
    const big = b.w * b.h > 1000, roll = r();
    if (big ? roll < 0.45 : roll < 0.12) parkBlock(m, b, r);
    else if (roll < 0.18) parkingBlock(m, b, r);
    else if (roll < 0.205) squareBlock(m, b, r);
    else fillHouses(m, b, r, { alley: true, ok: (t, x, y) => t === G.GRASS && !bank[y * W + x] });
  }
  // portal plaza in the middle: fountain and six black holes, one for each district
  const b = center;
  for (let y = b.y0 - 1; y <= b.y1 + 1; y++) for (let x = b.x0 - 1; x <= b.x1 + 1; x++) if (m.g[y]?.[x] === G.GRASS) set(m, x, y, G.PLAZA);
  const fx = Math.round(b.cx) - 2, fy = Math.round(b.cy) - 2;
  addObj(m, { kind: "fountain", x: fx, y: fy, w: 4, h: 4 }, G.FOUNT);
  for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) set(m, x, y, G.TREE);
  const dests = ["harbor", "industrial", "park", "forest", "volcano", "frost"];
  const rx = Math.min(16, (b.x1 - b.x0) / 2 - 3), ry = Math.min(12, (b.y1 - b.y0) / 2 - 3);
  dests.forEach((to, i) => { const a = -Math.PI / 2 + Math.PI / 6 + i * Math.PI / 3; placePortal(m, Math.round(b.cx + Math.cos(a) * rx), Math.round(b.cy + Math.sin(a) * ry), to); });
  for (const [dx, dy] of [[-4, 1], [5, 1], [1, -4], [1, 5]]) set(m, fx + dx, fy + dy, G.BENCH);
  m.spawn = { x: fx + 2, y: fy + 7 };
  roadLamps(m, 9); parkedCars(m, r, 0.035);
  return finishMap(m);
}
// Connected patches of land (4-neighbour) that match ok(); returns bounding boxes
function landBlocks(m, ok) {
  const W = m.W, H = m.H, seen = new Uint8Array(W * H), out = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (seen[y * W + x] || !ok(m.g[y][x])) continue;
    let x0 = x, x1 = x, y0 = y, y1 = y, n = 0; const q = [y * W + x]; seen[q[0]] = 1;
    for (let i = 0; i < q.length; i++) {
      const p = q[i], px = p % W, py = (p - px) / W; n++;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = px + dx, Y = py + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const k = Y * W + X; if (!seen[k] && ok(m.g[Y][X])) { seen[k] = 1; q.push(k); } }
    }
    out.push({ x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, n, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
  }
  return out;
}
function parkBlock(m, b, r) {
  const cx = Math.floor((b.x0 + b.x1) / 2), cy = Math.floor((b.y0 + b.y1) / 2), style = Math.floor(r() * 3);
  const inner = (x, y) => m.g[y][x] === G.GRASS || m.g[y][x] === G.TREE;
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
    if (!inner(x, y)) continue;
    const edge = x === b.x0 || x === b.x1 || y === b.y0 || y === b.y1, gate = Math.abs(x - cx) <= 1 || Math.abs(y - cy) <= 1;
    if (edge && !gate) { set(m, x, y, G.HEDGE); continue; }
    if (edge) { set(m, x, y, G.PATH); continue; }
    const ring = Math.abs(Math.hypot((x - cx) / ((b.x1 - b.x0) / 2 - 3), (y - cy) / ((b.y1 - b.y0) / 2 - 3)) - 1) < 0.09;
    if (style === 0 && (x === cx || y === cy || x === cx + 1 || y === cy + 1)) set(m, x, y, G.PATH);
    else if (style === 1 && (ring || (gate && Math.hypot((x - cx) / ((b.x1 - b.x0) / 2), (y - cy) / ((b.y1 - b.y0) / 2)) > 0.9))) set(m, x, y, G.PATH);
    else if (style === 2 && (Math.abs((x - b.x0) / (b.x1 - b.x0) - (y - b.y0) / (b.y1 - b.y0)) < 0.04 || Math.abs((x - b.x0) / (b.x1 - b.x0) + (y - b.y0) / (b.y1 - b.y0) - 1) < 0.04)) set(m, x, y, G.PATH);
    else set(m, x, y, r() < (style === 2 ? 0.14 : 0.07) ? G.TREE : r() < 0.12 ? G.FLOWER : G.GRASS);
  }
  if (style === 0 && r() < 0.7) { const px = cx + Math.floor((b.x1 - cx) / 2), py = cy + Math.floor((b.y1 - cy) / 2) + 1; ellipse(m, px, py, Math.min(6, (b.x1 - cx) / 2 - 2), Math.min(4, (b.y1 - cy) / 2 - 2), G.WATER, null, t => t !== G.PATH && t !== G.HEDGE); }
  if (style === 1 && areaOk(m, cx - 1, cy - 1, 3, 3, t => t === G.GRASS || t === G.FLOWER || t === G.TREE)) addObj(m, { kind: "gazebo", x: cx - 1, y: cy - 1, w: 3, h: 3 });
  if (style === 2) {
    // sandbox in the middle of the lawn; skipped if anything other than lawn or the park's own paths is under it
    const w = Math.min(10, b.x1 - b.x0 - 6), h = Math.min(7, b.y1 - b.y0 - 6), sx = cx - (w >> 1), sy = cy - (h >> 1);
    if (w >= 4 && h >= 3 && sx > b.x0 && sy - 1 > b.y0 && sx + w <= b.x1 && sy + h <= b.y1 && areaOk(m, sx, sy - 1, w, h + 1, t => t === G.GRASS || t === G.FLOWER || t === G.TREE || t === G.PATH)) {
      fillR(m, sx, sy, w, h, G.SAND); for (let k = 0; k < 4; k++) set(m, sx + 1 + k * 2, sy - 1, G.BENCH);
    }
  }
  for (const [x, y] of [[cx - 3, cy - 1], [cx + 4, cy + 2], [cx - 1, cy + 4]]) if (m.g[y]?.[x] === G.GRASS || m.g[y]?.[x] === G.FLOWER) set(m, x, y, G.BENCH);
}
function parkingBlock(m, b, r) {
  fillR(m, b.x0, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, G.LOT);
  for (let y = b.y0 + 1; y + 1 <= b.y1 - 1; y += 5) for (let x = b.x0 + 1; x <= b.x1 - 1; x++) if (r() < 0.55) addObj(m, { kind: "car", x, y, w: 1, h: 2, horiz: false, c: Math.floor(r() * 6) }, G.CAR);
}
function squareBlock(m, b, r) {
  fillR(m, b.x0, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, G.PLAZA);
  const cx = Math.round((b.x0 + b.x1) / 2) - 2, cy = Math.round((b.y0 + b.y1) / 2) - 2;
  addObj(m, { kind: "fountain", x: cx, y: cy, w: 4, h: 4 }, G.FOUNT);
  for (let x = b.x0; x <= b.x1; x += 4) { set(m, x, b.y0, G.TREE); set(m, x, b.y1, G.TREE); }
}

// ================= HARBOR =================
function makeHarbor() {
  const W = 340, H = 260, m = newMap("harbor", "HARBOR", "harbor", W, H, G.WATER, 11), r = rng(11);
  m.ground = G.CONCRETE;
  const cn = noise(12, 34), coast = y => Math.round(W * 0.6 + (cn(5, y) - 0.5) * 44), beachY = Math.round(H * 0.78);
  for (let y = 0; y < H; y++) { const c = coast(y); for (let x = 0; x < c; x++) set(m, x, y, y >= beachY ? (x >= c - 34 ? G.SAND : G.GRASS) : (x >= c - 18 ? G.CONCRETE : G.GRASS)); }
  const quay = Math.round(W * 0.6) - 40, inland = 66, ys = [];
  for (let y = 12; y < beachY - 6; y += 34 + Math.floor(r() * 8)) ys.push(y);
  const southYs = [beachY + 24, beachY + 46].filter(y => y < H - 6);
  buildRoads(m, [{ at: quay, a: 0, b: beachY + 2 }, { at: inland, a: 0, b: H - 1 }, { at: Math.round(quay * 0.55), a: beachY - 1, b: H - 1 }],
    [...ys.map(at => ({ at, a: 0, b: quay + 2 })), { at: beachY - 1, a: 0, b: quay + 2 }, ...southYs.map(at => ({ at, a: 0, b: coast(at) - 30 }))], true);
  // concrete apron between the quay road and the water
  for (let y = 0; y < beachY - 2; y++) for (let x = quay + 3; x < coast(y); x++) if (m.g[y][x] === G.GRASS) set(m, x, y, G.CONCRETE);
  // piers with moored boats
  for (let y = 10; y < beachY - 8; y += 14 + Math.floor(r() * 8)) {
    if (y > H * 0.08 && y < H * 0.4 && r() < 0.5) continue; // container quay is mostly straight
    const x0 = coast(y) - 1, len = 22 + Math.floor(r() * 22);
    fillR(m, x0, y, len, 3, G.DOCK);
    for (let k = 4; k < len - 6; k += 9) for (const by of [y - 3, y + 4]) {
      const bw = 6 + Math.floor(r() * 2);
      if (r() < 0.7 && areaOk(m, x0 + k, by - 1, bw, 4, t => t === G.WATER)) addObj(m, { kind: "boat", x: x0 + k, y: by, w: bw, h: 2, c: Math.floor(r() * 4), seed: Math.floor(r() * 1e6) }, null);
    }
    set(m, x0 + len - 1, y, G.LAMP); set(m, x0 + len - 1, y + 2, G.CRATE);
  }
  // container yard with gantry cranes on the north quay
  const yx0 = quay + 6, yy0 = 4, yy1 = Math.round(H * 0.4);
  for (let y = yy0; y < yy1; y += 4) for (let x = yx0; x < W; x += 4) {
    if (r() < 0.18) continue;
    if (areaOk(m, x, y, 3, 2, t => t === G.CONCRETE) && x + 3 < coast(y) - 6 && x + 3 < coast(y + 1) - 6) {
      addObj(m, { kind: "container", x, y, w: 3, h: 1, c: Math.floor(r() * 6), stack: r() < 0.5, seed: Math.floor(r() * 1e6) });
      if (r() < 0.8) addObj(m, { kind: "container", x, y: y + 1, w: 3, h: 1, c: Math.floor(r() * 6), stack: r() < 0.4, seed: Math.floor(r() * 1e6) });
    }
  }
  for (let y = yy0 + 6; y < yy1 - 6; y += 24) { const x = coast(y) - 5; if (areaOk(m, x, y, 3, 5, t => t === G.CONCRETE)) addObj(m, { kind: "crane", x, y, w: 3, h: 5, seed: y }); }
  // warehouses along the quay road and houses inland
  const bxs = [-3, inland, quay], blocks = [];
  for (let j = 0; j <= ys.length; j++) for (let i = 0; i < 2; i++) {
    const x0 = bxs[i] + 5, x1 = bxs[i + 1] - 3, y0 = (j ? ys[j - 1] : -3) + 5, y1 = (ys[j] ?? beachY - 1) - 3;
    if (x1 - x0 > 5 && y1 - y0 > 5) blocks.push({ x0: Math.max(0, x0), x1, y0, y1, i });
  }
  for (const b of blocks) {
    if (b.i === 1) {
      fillR(m, b.x0, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, G.CONCRETE);
      fillHouses(m, b, r, { kind: "warehouse", hmin: 7, wmin: 10, wvar: 8, shops: 0, ok: t => t === G.CONCRETE });
      for (let k = 0; k < 14; k++) { const x = b.x0 + Math.floor(r() * (b.x1 - b.x0)), y = b.y0 + Math.floor(r() * (b.y1 - b.y0)); if (m.g[y][x] === G.CONCRETE) set(m, x, y, r() < 0.5 ? G.CRATE : G.BARREL); }
    } else fillHouses(m, b, r, { shops: 0.15, ok: t => t === G.GRASS });
  }
  // south side: houses behind a palm promenade along the beach
  for (const b of landBlocks(m, t => t === G.GRASS)) if (b.y0 >= beachY - 4 && b.w >= 6 && b.h >= 6) fillHouses(m, b, r, { shops: 0.3, ok: t => t === G.GRASS });
  for (let y = beachY; y < H; y++) for (let x = 0; x < W; x++) {
    if (m.g[y][x] === G.GRASS && (m.g[y][x + 1] === G.SAND || m.g[y][x + 2] === G.SAND || m.g[y][x + 3] === G.SAND)) set(m, x, y, (y % 7 === 0) ? G.PALM : (y % 7 === 3 ? G.BENCH : G.PLAZA)), m.gr[y][x] = G.PLAZA;
    else if (m.g[y][x] === G.SAND && r() < 0.035) set(m, x, y, G.PALM);
  }
  // the quay apron: fish stalls, crate stacks, barrels
  for (let y = Math.round(H * 0.42); y < beachY - 4; y += 3) for (let x = quay + 5; x < coast(y) - 3; x++) {
    if (m.g[y][x] !== G.CONCRETE) continue;
    const q = r();
    if (q < 0.025 && areaOk(m, x, y, 3, 2, t => t === G.CONCRETE)) addObj(m, { kind: "stall", x, y, w: 3, h: 2, c: Math.floor(r() * 4) });
    else if (q < 0.06) set(m, x, y, r() < 0.6 ? G.CRATE : G.BARREL);
  }
  const bwY = Math.round(H * 0.52), bx0 = coast(bwY) - 2, bx1 = W - 22;
  for (let x = bx0; x <= bx1; x++) for (let y = bwY; y < bwY + 3; y++) set(m, x, y, G.ROCK);
  for (let x = bx0; x <= bx1; x += 3) { if (r() < 0.5) set(m, x, bwY - 1, G.BOULDER), m.gr[bwY - 1][x] = m.gr[bwY - 1][x]; }
  fillR(m, bx1 - 2, bwY - 4, 10, 11, G.ROCK);
  addObj(m, { kind: "lighthouse", x: bx1 + 4, y: bwY - 3, w: 2, h: 2 });
  m.lights.push({ x: (bx1 + 5) * T, y: (bwY - 3) * T - 46 });
  placePortal(m, bx1 + 1, bwY + 3, "industrial");
  placePortal(m, 6, ys[2] - 6, "downtown");
  m.spawn = { x: 6, y: ys[2] - 2 };
  roadLamps(m, 9); parkedCars(m, r, 0.03);
  for (let y = 0; y < beachY; y += 6) { const x = coast(y) - 2; if (m.g[y][x] === G.CONCRETE) set(m, x, y, G.LAMP); }
  return finishMap(m);
}

// ================= INDUSTRIAL =================
function makeIndustrial() {
  const W = 340, H = 260, m = newMap("industrial", "INDUSTRIAL ZONE", "industrial", W, H, G.CONCRETE, 23), r = rng(23);
  m.ground = G.CONCRETE;
  const gn = fbm(24, 26);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (gn(x, y) < 0.36) set(m, x, y, G.GRASS);
  const xs = [], ys = [];
  for (let x = 10; x < W - 24; x += 42 + Math.floor(r() * 12)) xs.push(x);
  for (let y = 10; y < H - 24; y += 40 + Math.floor(r() * 10)) ys.push(y);
  buildRoads(m, xs.map(at => ({ at, a: 0, b: H - 1 })), ys.map(at => ({ at, a: 0, b: W - 1 })), false);
  // a green canal and a double rail line
  const ck = xs.findIndex(x => x > W * 0.62), cmid = Math.round((xs[ck] + xs[ck + 1]) / 2) + 1, cn = noise(25, 30), canal = y => Math.round(cmid + (cn(1, y) - 0.5) * 12);
  for (let y = 0; y < H; y++) { const c = canal(y); for (let x = c - 3; x <= c + 3; x++) set(m, x, y, m.g[y][x] === G.ROAD || y % 20 < 2 ? G.BRIDGE : G.WATER); }
  const ry = Math.round((ys[2] + ys[3]) / 2);
  for (let x = 0; x < W; x++) for (const y of [ry, ry + 1]) { const t = m.g[y][x]; if (t !== G.ROAD) set(m, x, y, t === G.WATER || t === G.BRIDGE ? G.BRIDGE : G.RAIL); }
  for (const y of [ry, ry + 1]) for (let x = 4; x < W - 8;) { if (r() < 0.35 && areaOk(m, x, y, 5, 1, t => t === G.RAIL)) { addObj(m, { kind: "wagon", x, y, w: 5, h: 1, c: Math.floor(r() * 4) }); x += 6; } else x += 3 + Math.floor(r() * 10); }
  const okG = t => t === G.CONCRETE || t === G.GRASS;
  const bx = [-4, ...xs], by = [-4, ...ys];
  for (let j = 0; j < by.length; j++) for (let i = 0; i < bx.length; i++) {
    const b = { x0: Math.max(1, bx[i] + 5), x1: Math.min(W - 2, (xs[i] ?? W + 3) - 2), y0: Math.max(1, by[j] + 5), y1: Math.min(H - 2, (ys[j] ?? H + 3) - 2) };
    if (b.x1 - b.x0 < 12 || b.y1 - b.y0 < 12) continue;
    const roll = r();
    if (roll < 0.55) factoryBlock(m, b, r, okG); else if (roll < 0.72) tankBlock(m, b, r, okG); else if (roll < 0.87) scrapBlock(m, b, r, okG);
    else for (let k = 0; k < 30; k++) { const x = b.x0 + Math.floor(r() * (b.x1 - b.x0)), y = b.y0 + Math.floor(r() * (b.y1 - b.y0)); if (okG(m.g[y][x])) set(m, x, y, [G.CRATE, G.BARREL, G.CRATE, G.SCRAP][k % 4]); }
  }
  for (const h of m.hr) for (let x = h.a + 2; x <= h.b; x += 11) for (const y of [h.at - 1, h.at + 3]) if (okG(m.g[y]?.[x])) set(m, x, y, G.LAMP);
  for (const v of m.vr) for (let y = v.a + 2; y <= v.b; y += 11) for (const x of [v.at - 1, v.at + 3]) if (okG(m.g[y]?.[x])) set(m, x, y, G.LAMP);
  parkedCars(m, r, 0.015);
  placePortal(m, 5, ys[1] + 8, "downtown");
  m.spawn = { x: 5, y: ys[1] + 12 };
  placePortal(m, W - 8, ys[ys.length - 1] + 10, "harbor");
  return finishMap(m);
}
function fenceRect(m, b, okG) {
  const gx = Math.round((b.x0 + b.x1) / 2), gy = Math.round((b.y0 + b.y1) / 2);
  for (let x = b.x0; x <= b.x1; x++) for (const y of [b.y0, b.y1]) if (Math.abs(x - gx) > 1 && okG(m.g[y][x])) set(m, x, y, G.FENCE);
  for (let y = b.y0; y <= b.y1; y++) for (const x of [b.x0, b.x1]) if (Math.abs(y - gy) > 1 && okG(m.g[y][x])) set(m, x, y, G.FENCE);
}
function factoryBlock(m, b, r, okG) {
  fenceRect(m, b, okG);
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const w = Math.min(bw - 8, 12 + Math.floor(r() * 12)), h = Math.min(bh - 10, 9 + Math.floor(r() * 7));
  const right = r() < 0.5, bottom = r() < 0.5;
  const x = right ? b.x1 - 2 - w : b.x0 + 3, y = bottom ? b.y1 - 3 - h : b.y0 + 4;
  if (w >= 8 && h >= 7 && areaOk(m, x, y, w, h, okG)) {
    const stacks = [];
    for (let k = 0; k < 1 + Math.floor(r() * 3); k++) stacks.push(2 + Math.floor(r() * (w - 4)));
    addObj(m, { kind: "factory", x, y, w, h, stacks, seed: Math.floor(r() * 1e6), c: Math.floor(r() * 3) });
    for (const s of stacks) m.smokes.push({ x: (x + s) * T + 4, y: y * T - 30 });
    // the free side gets tanks with a pipe, a warehouse, or a container stack
    const fx0 = right ? b.x0 + 3 : x + w + 3, fx1 = right ? x - 3 : b.x1 - 2, extra = r();
    if (extra < 0.45) {
      for (let ty = b.y0 + 4; ty + 4 <= b.y1 - 2; ty += 6) for (let tx = fx0; tx + 4 <= fx1; tx += 6) {
        if (!areaOk(m, tx, ty, 4, 4, okG)) continue;
        addObj(m, { kind: "tank", x: tx, y: ty, w: 4, h: 4, c: Math.floor(r() * 3) });
        if (ty + 2 >= y && ty + 2 < y + h) { const a = right ? tx + 4 : x + w, e = right ? x : tx; for (let px = a; px < e; px++) if (okG(m.g[ty + 2][px])) set(m, px, ty + 2, G.PIPE); }
      }
    } else if (extra < 0.75) {
      const ww = Math.min(fx1 - fx0, 10 + Math.floor(r() * 6)), wy = bottom ? b.y0 + 4 : b.y1 - 11;
      if (ww >= 8 && areaOk(m, fx0, wy, ww, 8, okG)) addObj(m, { kind: "warehouse", x: fx0, y: wy, w: ww, h: 8, roof: Math.floor(r() * 3) });
    } else {
      for (let cy2 = b.y0 + 4; cy2 < b.y1 - 3; cy2 += 3) for (let cx2 = fx0; cx2 + 3 <= fx1; cx2 += 4) if (r() < 0.7 && areaOk(m, cx2, cy2, 3, 1, okG)) addObj(m, { kind: "container", x: cx2, y: cy2, w: 3, h: 1, c: Math.floor(r() * 6), stack: r() < 0.5 });
    }
    // a couple of trucks parked at the loading door
    const dy = y + h + 1;
    for (let k = 0; k < 2; k++) { const cx3 = x + 2 + k * 3; if (areaOk(m, cx3, dy, 1, 2, okG)) addObj(m, { kind: "car", x: cx3, y: dy, w: 1, h: 2, horiz: false, c: Math.floor(r() * 6) }, G.CAR); }
  }
  for (let k = 0; k < 14; k++) { const xx = b.x0 + 1 + Math.floor(r() * (bw - 2)), yy = b.y0 + 1 + Math.floor(r() * (bh - 2)); if (okG(m.g[yy][xx])) set(m, xx, yy, r() < 0.6 ? G.BARREL : G.CRATE); }
}
function tankBlock(m, b, r, okG) {
  fenceRect(m, b, okG);
  for (let y = b.y0 + 3; y + 4 <= b.y1 - 2; y += 7) {
    let last = null;
    for (let x = b.x0 + 3; x + 4 <= b.x1 - 2; x += 7) if (areaOk(m, x, y, 4, 4, okG)) {
      addObj(m, { kind: "tank", x, y, w: 4, h: 4, c: Math.floor(r() * 3) });
      if (last !== null) for (let px = last; px < x; px++) if (okG(m.g[y + 2][px])) set(m, px, y + 2, G.PIPE);
      last = x + 4;
    }
  }
}
function scrapBlock(m, b, r, okG) {
  fenceRect(m, b, okG);
  for (let y = b.y0 + 2; y < b.y1 - 1; y++) for (let x = b.x0 + 2; x < b.x1 - 1; x++) {
    if (!okG(m.g[y][x])) continue;
    const q = r();
    if (q < 0.16) set(m, x, y, G.SCRAP); else if (q < 0.19 && areaOk(m, x, y, 2, 1, okG)) addObj(m, { kind: "car", x, y, w: 2, h: 1, horiz: true, c: Math.floor(r() * 6), wreck: true }, G.CAR);
  }
}

// ================= PARK =================
function makePark() {
  const W = 340, H = 260, m = newMap("park", "CENTRAL PARK", "park", W, H, G.GRASS, 31), r = rng(31);
  const lx = W * 0.5, ly = H * 0.48, ln = fbm(32, 18);
  ellipse(m, lx, ly, 40, 26, G.WATER, ln);
  ellipse(m, lx + 4, ly, 8, 6, G.GRASS);
  addObj(m, { kind: "gazebo", x: Math.round(lx + 2), y: Math.round(ly - 2), w: 3, h: 3 });
  const nodes = netNodes(m, 6, 5, r, (x, y) => Math.hypot((x - lx) / 50, (y - ly) / 34) > 1);
  nodes.push({ x: Math.round(W / 2), y: H - 8 }, { x: Math.round(W / 2), y: 7 });
  const crossesLake = (a, b) => { for (let k = 0; k <= 12; k++) { const px = a.x + (b.x - a.x) * k / 12, py = a.y + (b.y - a.y) * k / 12; if (Math.hypot((px - lx) / 54, (py - ly) / 38) < 1) return true; } return false; };
  const edges = netEdges(nodes.slice(0, 30), 6, 5, r, 0.7).filter(([a, b]) => !crossesLake(a, b));
  edges.push([nodes[30], nodes[27]], [nodes[31], nodes[2]]);
  // a ring path around the lake and two bridges to the island
  const ring = []; for (let k = 0; k <= 48; k++) { const a = k / 48 * Math.PI * 2; ring.push([Math.round(lx + Math.cos(a) * 50), Math.round(ly + Math.sin(a) * 34)]); }
  for (let k = 0; k < ring.length - 1; k++) carve(m, [ring[k], ring[k + 1]], 2, G.PATH, () => 0.5);
  for (const [a, b] of edges) carve(m, [[a.x, a.y], [b.x, b.y]], 2, G.PATH, r);
  for (const sx of [lx - 50, lx + 50]) carve(m, [[Math.round(sx), Math.round(ly)], [Math.round(lx + 4), Math.round(ly)]], 2, G.PATH, () => 0.5);
  // flower meadows, groves, small ponds
  const fl = fbm(33, 18), gv = fbm(34, 22);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (m.g[y][x] !== G.GRASS) continue;
    if (fl(x, y) > 0.66) set(m, x, y, G.FLOWER);
    if (gv(x, y) > 0.6 && r() < 0.5) set(m, x, y, G.TREE); else if (r() < 0.01) set(m, x, y, G.TREE);
  }
  for (let k = 0; k < 5; k++) { const n = nodes[Math.floor(r() * 30)]; ellipse(m, n.x + 8, n.y + 6, 4 + r() * 3, 3 + r() * 2, G.WATER, null, t => t === G.GRASS || t === G.FLOWER || t === G.TREE); }
  // hedge maze in the north-east
  formalGarden(m, Math.round(W * 0.74), 14, 46, 40, r);
  // benches, lamps, gazebos along the paths
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const t = m.g[y][x]; if (t !== G.GRASS && t !== G.FLOWER) continue;
    const nearPath = m.g[y - 1][x] === G.PATH || m.g[y + 1][x] === G.PATH || m.g[y][x - 1] === G.PATH || m.g[y][x + 1] === G.PATH;
    if (nearPath) { const q = r(); if (q < 0.018) set(m, x, y, G.BENCH); else if (q < 0.03) set(m, x, y, G.LAMP); else if (q < 0.034) set(m, x, y, G.BIN); }
  }
  for (const n of nodes.slice(0, 30)) if (r() < 0.25 && areaOk(m, n.x + 4, n.y - 5, 3, 3, t => t === G.GRASS || t === G.FLOWER || t === G.TREE)) addObj(m, { kind: "gazebo", x: n.x + 4, y: n.y - 5, w: 3, h: 3 });
  placePortal(m, Math.round(W / 2), H - 5, "downtown");
  m.spawn = { x: Math.round(W / 2), y: H - 9 };
  placePortal(m, Math.round(W / 2), 5, "forest");
  return finishMap(m);
}
// Open garden: low hedge rows with wide gaps and flower beds, nothing to get lost in
function formalGarden(m, x0, y0, w, h, r) {
  fillR(m, x0, y0, w, h, G.PATH);
  for (let y = y0 + 3; y < y0 + h - 2; y += 5) for (let x = x0 + 2; x < x0 + w - 2; x++) {
    const seg = Math.floor((x - x0 - 2) / 7);
    if ((x - x0 - 2) % 7 < 5) set(m, x, y, (seg + Math.floor(y / 5)) % 3 === 0 ? G.HEDGE : G.FLOWER);
  }
  const cx = x0 + Math.floor(w / 2) - 2, cy = y0 + Math.floor(h / 2) - 2;
  fillR(m, cx - 3, cy - 3, 10, 10, G.PLAZA);
  addObj(m, { kind: "fountain", x: cx, y: cy, w: 4, h: 4 }, G.FOUNT);
}
function hedgeMaze(m, x0, y0, cw, ch, r) {
  const S = 3, W = cw * S + 1, H = ch * S + 1;
  fillR(m, x0, y0, W, H, G.HEDGE);
  const seen = new Uint8Array(cw * ch), st = [[0, 0]]; seen[0] = 1;
  const open = (cx, cy) => fillR(m, x0 + 1 + cx * S, y0 + 1 + cy * S, S - 1, S - 1, G.PATH);
  open(0, 0);
  while (st.length) {
    const [cx, cy] = st[st.length - 1];
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [cx + dx, cy + dy, dx, dy]).filter(([x, y]) => x >= 0 && y >= 0 && x < cw && y < ch && !seen[y * cw + x]);
    if (!nb.length) { st.pop(); continue; }
    const [nx, ny, dx, dy] = nb[Math.floor(r() * nb.length)];
    seen[ny * cw + nx] = 1; open(nx, ny);
    if (dx) fillR(m, x0 + (dx > 0 ? (cx + 1) * S : cx * S), y0 + 1 + cy * S, 1, S - 1, G.PATH);
    else fillR(m, x0 + 1 + cx * S, y0 + (dy > 0 ? (cy + 1) * S : cy * S), S - 1, 1, G.PATH);
    st.push([nx, ny]);
  }
  const mid = Math.floor(cw / 2);
  fillR(m, x0 + 1 + mid * S, y0 + H - 1, 2, 3, G.PATH); fillR(m, x0 + 1 + mid * S, y0 - 2, 2, 3, G.PATH);
  carve(m, [[x0 + 1 + mid * S, y0 + H + 1], [x0 - 20, y0 + H + 18]], 2, G.PATH, () => 0.5);
}

// ================= FOREST =================
function makeForest() {
  const W = 340, H = 260, m = newMap("forest", "WHISPER FOREST", "forest", W, H, G.GRASS, 51), r = rng(51);
  m.trail = G.DIRT;
  const dens = fbm(52, 24), dirt = fbm(54, 16), ridge = fbm(53, 46), gaps = noise(56, 9);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = dens(x, y);
    if (Math.abs(ridge(x, y) - 0.5) < 0.025 && gaps(x, y) > 0.45) { set(m, x, y, G.CLIFF); continue; }
    // big trees stand on a loose 3x3 lattice, so there is always room to walk between them
    if (d > 0.55 && x % 3 === Math.floor(hash2(Math.floor(x / 3), Math.floor(y / 3), 57) * 2) && y % 3 === Math.floor(hash2(Math.floor(x / 3), Math.floor(y / 3), 58) * 2)) set(m, x, y, G.BIGTREE);
    else if (d > 0.55 && r() < 0.25) set(m, x, y, G.TREE);
    else if (d > 0.47 && r() < 0.45) set(m, x, y, G.TREE);
    else {
      if (dirt(x, y) > 0.64) set(m, x, y, G.DIRT);
      const q = r();
      if (q < 0.06) set(m, x, y, G.TALLGRASS); else if (q < 0.07) set(m, x, y, G.MUSHROOM); else if (q < 0.075) set(m, x, y, G.LOG); else if (q < 0.081) set(m, x, y, G.BOULDER); else if (q < 0.1) set(m, x, y, G.FLOWER);
    }
  }
  const sn = noise(55, 38), streamY = x => Math.round(H * 0.56 + (sn(x, 9) - 0.5) * 60);
  for (let x = 0; x < W; x++) { const c = streamY(x); for (let y = c - 4; y <= c + 4; y++) { if (!inb(m, x, y)) continue; set(m, x, y, Math.abs(y - c) <= 2 ? (x % 22 < 2 ? G.BRIDGE : G.WATER) : G.GRASS); } }
  const nodes = netNodes(m, 6, 5, r);
  for (const [a, b] of netEdges(nodes, 6, 5, r, 0.7)) carve(m, [[a.x, a.y], [b.x, b.y]], 2, G.DIRT, r);
  // clearings with a cabin, a campfire or an old stone circle
  nodes.forEach((n, i) => {
    if (r() > 0.45 && i !== 0 && i !== 29) return;
    ellipse(m, n.x, n.y, 7 + r() * 3, 6 + r() * 2, G.GRASS, null, t => t !== G.WATER && t !== G.BRIDGE && t !== G.DIRT);
    const kind = i === 0 || i === 29 ? -1 : Math.floor(r() * 3);
    if (kind === 0 && areaOk(m, n.x + 2, n.y - 6, 6, 5, t => t === G.GRASS)) { addObj(m, { kind: "cabin", x: n.x + 2, y: n.y - 6, w: 6, h: 5, seed: i }); m.smokes.push({ x: (n.x + 6) * T + 4, y: (n.y - 6) * T - 6, soft: true }); }
    if (kind === 1) { set(m, n.x + 3, n.y + 3, G.CAMPFIRE); m.fires.push({ x: (n.x + 3) * T + 8, y: (n.y + 3) * T + 8 }); for (const [dx, dy] of [[-1, 0], [1, 1], [0, 2]]) set(m, n.x + 3 + dx * 2, n.y + 3 + dy, G.LOG); }
    if (kind === 2) for (let k = 0; k < 7; k++) { const a = k / 7 * Math.PI * 2; const x = Math.round(n.x + Math.cos(a) * 5), y = Math.round(n.y + Math.sin(a) * 4); if (m.g[y]?.[x] === G.GRASS) addObj(m, { kind: "pillar", x, y, w: 1, h: 1, mossy: true, seed: k }); }
  });
  placePortal(m, nodes[0].x, nodes[0].y, "downtown");
  m.spawn = { x: nodes[0].x, y: nodes[0].y + 4 };
  placePortal(m, nodes[29].x, nodes[29].y, "park");
  return finishMap(m);
}

// ================= VOLCANO ISLAND =================
function makeVolcano() {
  const W = 360, H = 270, m = newMap("volcano", "VOLCANO ISLAND", "volcano", W, H, G.WATER, 61), r = rng(61);
  m.ground = G.ROCK;
  const cx = Math.round(W / 2), cy = Math.round(H / 2), isl = fbm(62, 40);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot((x - cx) / (W * 0.45), (y - cy) / (H * 0.43)) + (isl(x, y) - 0.5) * 0.4;
    if (d < 1) set(m, x, y, d < 0.88 ? G.ROCK : G.SAND);
  }
  const RC = 24, RL = 8;
  for (let y = cy - 40; y <= cy + 40; y++) for (let x = cx - 40; x <= cx + 40; x++) { const d = Math.hypot(x - cx, (y - cy) * 1.15); if (d < RC) set(m, x, y, d < RL ? G.LAVA : G.CONE); }
  addObj(m, { kind: "cone", x: cx - RC, y: Math.round(cy - RC / 1.15), w: RC * 2, h: Math.round(RC * 2 / 1.15), cx, cy, rc: RC, rl: RL }, null);
  // lava rivers running down to the beach
  for (const ang of [0.4, 1.5, 2.6, 3.7, 5.0]) for (let t = RC + 7; t < 180; t++) {
    if (t % 16 < 3) continue; // natural crossings
    const a = ang + Math.sin(t * 0.09 + ang) * 0.22, x = Math.round(cx + Math.cos(a) * t), y = Math.round(cy + Math.sin(a) * t / 1.15);
    if (!inb(m, x, y) || m.gr[y][x] === G.SAND || m.gr[y][x] === G.WATER) break;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (m.g[y + dy]?.[x + dx] === G.ROCK) set(m, x + dx, y + dy, G.LAVA);
  }
  const ob = fbm(63, 20), ash = fbm(64, 24);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = m.g[y][x];
    if (t === G.ROCK) {
      if (ob(x, y) > 0.66) set(m, x, y, G.OBSIDIAN);
      if (ash(x, y) > 0.63 && r() < 0.3) set(m, x, y, G.DEADTREE); else if (r() < 0.012) set(m, x, y, G.BOULDER);
    } else if (t === G.SAND && r() < 0.05) set(m, x, y, G.PALM);
  }
  // hot springs and two ruined temples
  for (let k = 0; k < 6; k++) { const a = r() * 6.28, d = 45 + r() * 60, x = Math.round(cx + Math.cos(a) * d), y = Math.round(cy + Math.sin(a) * d / 1.2); if (m.g[y]?.[x] === G.ROCK || m.g[y]?.[x] === G.OBSIDIAN) { ellipse(m, x, y, 3.5, 2.5, G.WATER, null, t => t !== G.LAVA); m.steams.push({ x: x * T + 8, y: y * T }); } }
  for (const a of [2.0, 5.6]) {
    const x0 = Math.round(cx + Math.cos(a) * 95), y0 = Math.round(cy + Math.sin(a) * 75);
    ellipse(m, x0, y0, 9, 7, G.ROCK, null, t => t !== G.WATER && t !== G.SAND);
    for (let k = 0; k < 10; k++) { const b = k / 10 * Math.PI * 2, x = Math.round(x0 + Math.cos(b) * 7), y = Math.round(y0 + Math.sin(b) * 5); addObj(m, { kind: "pillar", x, y, w: 1, h: 1, seed: k + x }); }
  }
  // trails: lava crossings become cooled obsidian
  const nodes = netNodes(m, 6, 5, r, (x, y) => m.g[y]?.[x] === G.ROCK || m.g[y]?.[x] === G.SAND || m.g[y]?.[x] === G.OBSIDIAN);
  for (const [a, b] of netEdges(nodes, 6, 5, r, 0.75)) if (m.g[a.y][a.x] !== G.WATER && m.g[b.y][b.x] !== G.WATER) carve(m, [[a.x, a.y], [b.x, b.y]], 2, G.PATH, r);
  const sY = (x) => { for (let y = H - 1; y > 0; y--) if (m.g[y][x] === G.SAND) return y; return H - 20; };
  const nY = (x) => { for (let y = 0; y < H; y++) if (m.g[y][x] === G.SAND) return y; return 20; };
  placePortal(m, cx, sY(cx) - 3, "downtown");
  m.spawn = { x: cx, y: sY(cx) - 7 };
  placePortal(m, cx + 40, nY(cx + 40) + 3, "frost");
  carve(m, [[cx, sY(cx) - 6], [nodes[27].x, nodes[27].y]], 2, G.PATH, r);
  m.crater = { x: cx, y: cy };
  return finishMap(m);
}

// ================= FROST PEAKS (exotic) =================
function makeFrost() {
  const W = 340, H = 260, m = newMap("frost", "FROST PEAKS", "frost", W, H, G.SNOW, 71), r = rng(71);
  m.ground = G.SNOW;
  const mt = fbm(72, 36), pf = fbm(73, 22);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (mt(x, y) > 0.64) { set(m, x, y, G.CLIFF); continue; }
    const p = pf(x, y);
    if (p > 0.55 && x % 3 === Math.floor(hash2(Math.floor(x / 3), Math.floor(y / 3), 77) * 2) && y % 3 === Math.floor(hash2(Math.floor(x / 3), Math.floor(y / 3), 78) * 2)) set(m, x, y, G.PINE); else if (p > 0.52 && r() < 0.03) set(m, x, y, G.PINE);
    else { const q = r(); if (q < 0.008) set(m, x, y, G.CRYSTAL); else if (q < 0.014) set(m, x, y, G.BOULDER); else if (q < 0.0155) set(m, x, y, G.SNOWMAN); }
  }
  const rn = noise(74, 40), riverX = y => Math.round(W * 0.36 + (rn(2, y) - 0.5) * 50);
  for (let y = 0; y < H; y++) { const c = riverX(y); for (let x = c - 3; x <= c + 3; x++) set(m, x, y, G.ICE); }
  const lakes = [[W * 0.66, H * 0.3, 26, 17], [W * 0.2, H * 0.72, 20, 14], [W * 0.78, H * 0.76, 18, 13]];
  for (const [x, y, a, b] of lakes) { ellipse(m, x, y, a, b, G.ICE, fbm(75 + x, 14)); for (let k = 0; k < 4; k++) { const hx = Math.round(x + (r() - 0.5) * a), hy = Math.round(y + (r() - 0.5) * b); if (m.g[hy]?.[hx] === G.ICE) set(m, hx, hy, G.WATER); } }
  const nodes = netNodes(m, 6, 5, r);
  for (const [a, b] of netEdges(nodes, 6, 5, r, 0.72)) carve(m, [[a.x, a.y], [b.x, b.y]], 2, G.PATH, r);
  // igloo village around a campfire
  const v = nodes[15];
  ellipse(m, v.x, v.y, 14, 11, G.SNOW, null, t => t !== G.PATH);
  set(m, v.x, v.y, G.CAMPFIRE); m.fires.push({ x: v.x * T + 8, y: v.y * T + 8 });
  for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2 + 0.3, x = Math.round(v.x + Math.cos(a) * 9) - 2, y = Math.round(v.y + Math.sin(a) * 7) - 1; if (areaOk(m, x, y, 4, 3, t => t === G.SNOW || t === G.PATH)) addObj(m, { kind: "igloo", x, y, w: 4, h: 3 }); }
  placePortal(m, nodes[2].x, H - 6, "downtown");
  m.spawn = { x: nodes[2].x, y: H - 10 };
  carve(m, [[nodes[2].x, H - 8], [nodes[26].x, nodes[26].y]], 2, G.PATH, r);
  placePortal(m, nodes[5].x, nodes[5].y, "volcano");
  return finishMap(m);
}

const MAP_MAKERS = { downtown: makeDowntown, harbor: makeHarbor, industrial: makeIndustrial, park: makePark, forest: makeForest, volcano: makeVolcano, frost: makeFrost };
const MAP_NAMES = { downtown: "DOWNTOWN", harbor: "HARBOR", industrial: "INDUSTRIAL ZONE", park: "CENTRAL PARK", forest: "WHISPER FOREST", volcano: "VOLCANO ISLAND", frost: "FROST PEAKS" };
const MAPS = {};
function getMap(key) { return MAPS[key] || (MAPS[key] = MAP_MAKERS[key]()); }

export { getMap, SOLID, MAP_NAMES, T, G };
