const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, W = 2400, H = 2400, TICK = 30, DT = 1 / TICK;
// Оружие: dmg урон, rate пауза между выстрелами, spd скорость пули, n дробинок, sp разброс, am расход патронов
const WP = {
  pistol: { dmg: 25, rate: .35, spd: 900, n: 1, sp: .03, am: 0 },
  shotgun: { dmg: 15, rate: .8, spd: 800, n: 6, sp: .28, am: 1 },
  smg: { dmg: 11, rate: .09, spd: 1000, n: 1, sp: .1, am: 1 },
};
const ZT = {
  walker: { hp: 60, sp: 75, dmg: 10, r: 16 },
  runner: { hp: 34, sp: 150, dmg: 8, r: 14 },
  tank: { hp: 320, sp: 55, dmg: 28, r: 27 },
};
const rooms = {}; let uid = 1;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Карта: сетка 5x5, в каждой клетке дом с дверью и контейнерами; центр свободен (лагерь)
function genMap() {
  const bs = [], ws = [], cs = [], ts = [], T = 14; let id = 1;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    if ((i === 2 && j === 2) || Math.random() < .2) continue;
    const w = rnd(240, 340) | 0, h = rnd(200, 320) | 0, x = (i * 480 + (480 - w) / 2 + rnd(-20, 20)) | 0, y = (j * 480 + (480 - h) / 2 + rnd(-20, 20)) | 0, d = Math.random() * 4 | 0, G = 80;
    bs.push([x, y, w, h, d]);
    [[x, y, w, 1], [x, y + h - T, w, 1], [x, y, h, 0], [x + w - T, y, h, 0]].forEach(([sx, sy, l, hz], k) => {
      if (k === d) { const a = (l - G) / 2 | 0; ws.push(hz ? [sx, sy, a, T] : [sx, sy, T, a], hz ? [sx + a + G, sy, l - a - G, T] : [sx, sy + a + G, T, l - a - G]); }
      else ws.push(hz ? [sx, sy, l, T] : [sx, sy, T, l]);
    });
    const n = 2 + Math.random() * 2 | 0;
    for (let k = 0; k < n; k++) cs.push([id++, x + T + 22 + Math.random() * (w - 2 * T - 44) | 0, y + T + 22 + Math.random() * (h - 2 * T - 44) | 0]);
  }
  for (let k = 0; k < 80; k++) { const x = rnd(0, W), y = rnd(0, H); if (!bs.some(b => x > b[0] - 40 && x < b[0] + b[2] + 40 && y > b[1] - 40 && y < b[1] + b[3] + 40) && Math.hypot(x - W / 2, y - H / 2) > 220) ts.push([x | 0, y | 0, rnd(28, 50) | 0]); }
  return { id: Math.random(), b: bs, w: ws, c: cs, t: ts };
}
function push(e, r, ws) {
  for (const [x, y, w, h] of ws) {
    const dx = e.x - clamp(e.x, x, x + w), dy = e.y - clamp(e.y, y, y + h), d = Math.hypot(dx, dy);
    if (d < r) { if (d > .001) { e.x += dx / d * (r - d); e.y += dy / d * (r - d); } else e.x += r; }
  }
}
// Навигация: сетка 20px. bl[клетка]=1 — рядом со стеной (непроходимо для центра зомби)
const CS = 20, GN = W / CS, DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1], BQ = new Int32Array(GN * GN);
const cellOf = (x, y) => clamp(y / CS | 0, 0, GN - 1) * GN + clamp(x / CS | 0, 0, GN - 1);
function buildGrid(ws) {
  const bl = new Uint8Array(GN * GN), M = 12;
  for (const [x, y, w, h] of ws) {
    const i0 = Math.max(0, (x - M) / CS | 0), i1 = Math.min(GN - 1, (x + w + M) / CS | 0), j0 = Math.max(0, (y - M) / CS | 0), j1 = Math.min(GN - 1, (y + h + M) / CS | 0);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const cx = (i + .5) * CS, cy = (j + .5) * CS;
      if (Math.hypot(cx - clamp(cx, x, x + w), cy - clamp(cy, y, y + h)) < M) bl[j * GN + i] = 1;
    }
  }
  return bl;
}
function flow(r, ps) {
  const bl = r.bl, d = r.fd || (r.fd = new Int16Array(GN * GN)); d.fill(-1);
  let h = 0, t = 0;
  for (const p of ps) if (p.alive) { const c = cellOf(p.x, p.y); if (d[c] < 0) { d[c] = 0; BQ[t++] = c; } }
  while (h < t) {
    const c = BQ[h++], ci = c % GN, cj = c / GN | 0, nd = d[c] + 1;
    for (let k = 0; k < 8; k++) {
      const ni = ci + DX[k], nj = cj + DY[k];
      if (ni < 0 || nj < 0 || ni >= GN || nj >= GN) continue;
      const n = nj * GN + ni;
      if (d[n] >= 0 || bl[n]) continue;
      if (k >= 4 && (bl[cj * GN + ni] || bl[nj * GN + ci])) continue;
      d[n] = nd; BQ[t++] = n;
    }
  }
}
function los(bl, ax, ay, bx, by) {
  const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 10);
  for (let k = 1; k < n; k++) if (bl[cellOf(ax + (bx - ax) * k / n, ay + (by - ay) * k / n)]) return false;
  return true;
}
// Направление движения зомби: напрямую, если путь свободен, иначе по полю расстояний (в обход стен, через дверь)
function dirTo(r, z, p, bd) {
  const ux = (p.x - z.x) / (bd || 1), uy = (p.y - z.y) / (bd || 1);
  if (bd < 40 || los(r.bl, z.x, z.y, p.x, p.y)) return [ux, uy];
  const ci = clamp(z.x / CS | 0, 0, GN - 1), cj = clamp(z.y / CS | 0, 0, GN - 1), fd = r.fd, bl = r.bl;
  let bi = -1, bj = -1, bv = 1e9;
  for (let k = 0; k < 8; k++) {
    const ni = ci + DX[k], nj = cj + DY[k];
    if (ni < 0 || nj < 0 || ni >= GN || nj >= GN) continue;
    const v = fd[nj * GN + ni];
    if (v < 0 || v >= bv) continue;
    if (k >= 4 && (bl[cj * GN + ni] || bl[nj * GN + ci])) continue;
    bv = v; bi = ni; bj = nj;
  }
  if (bi < 0) return [ux, uy];
  const tx = (bi + .5) * CS - z.x, ty = (bj + .5) * CS - z.y, l = Math.hypot(tx, ty);
  return l < .5 ? [ux, uy] : [tx / l, ty / l];
}
function edgePos() {
  const s = Math.random() * 4 | 0, u = Math.random();
  return [s < 2 ? u * W : (s === 2 ? 0 : W), s < 2 ? (s === 0 ? 0 : H) : u * H];
}
const hitW = (x, y, ws) => ws.some(([a, b, w, h]) => x > a && x < a + w && y > b && y < b + h);
const html = fs.readFileSync(path.join(__dirname, 'index.html'));
const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(html); });
const wss = new WebSocketServer({ server: srv });
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };

function newRoom(code) {
  return { code, ps: new Map(), st: 'lobby', host: 0, z: [], b: [], l: [], wave: 0, left: 0, spT: 0, brk: 0, ev: [], nid: 1 };
}
function lobbyInfo(r) {
  const o = { t: 'lobby', code: r.code, host: r.host, st: r.st, wave: r.wave, names: [...r.ps.values()].map(p => [p.id, p.name]), map: r.st === 'play' ? r.map : undefined };
  r.ps.forEach(p => send(p.ws, { ...o, me: p.id }));
}
function resetPlayer(p) {
  Object.assign(p, { x: W / 2 + rnd(-80, 80), y: H / 2 + rnd(-80, 80), hp: 100, alive: true, w: 'pistol', has: { pistol: 1 }, am: 60, cd: 0, sc: 0, f: 0, ar: 0, eu: 0 });
}
function startGame(r) {
  r.st = 'play'; r.wave = 0; r.z = []; r.b = []; r.l = []; r.left = 0; r.brk = 3; r.map = genMap(); r.bl = buildGrid(r.map.w); r.fT = 0; r.tail = 0; r.cs = r.map.c.map(c => ({ id: c[0], x: c[1], y: c[2], o: 0 })); r.co = [];
  r.ps.forEach(resetPlayer); lobbyInfo(r);
}
function startWave(r) { r.wave++; r.left = 6 + r.wave * 4; r.spT = 0; }
function spawnZ(r) {
  const n = r.wave, q = Math.random();
  let t = 'walker';
  if (n >= 5 && q < Math.min(.18, .03 * (n - 4))) t = 'tank';
  else if (n >= 3 && q < .15 + Math.min(.35, .05 * n)) t = 'runner';
  const [x, y] = edgePos();
  const b = ZT[t], hp = b.hp * (1 + .1 * n);
  r.z.push({ id: r.nid++, x, y, t, hp, mx: hp, sp: b.sp * Math.min(1.6, 1 + .02 * n), dmg: b.dmg, r: b.r, cd: 0, mv: 0, sk: 0 });
}
function drop(r, x, y, force, rich) {
  if (!force && Math.random() > .1) return;
  const q = Math.random();
  const type = rich ? (q < .14 ? 'shotgun' : q < .26 ? 'smg' : q < .42 ? 'armor' : q < .7 ? 'ammo' : 'med')
    : (q < .2 ? 'shotgun' : q < .3 ? 'smg' : q < .45 ? 'armor' : q < .75 ? 'ammo' : 'med');
  r.l.push({ id: r.nid++, x, y, type, ttl: rich ? 90 : 40 });
}

wss.on('connection', ws => {
  let r = null, p = null;
  ws.on('message', m => {
    let d; try { d = JSON.parse(m); } catch { return; }
    if (d.t === 'join' && !r) {
      let code = String(d.code || '').toUpperCase().trim();
      let room;
      if (!code) {
        do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''); } while (rooms[code]);
        room = rooms[code] = newRoom(code);
      } else room = rooms[code];
      if (!room) return send(ws, { t: 'err', m: 'Комната не найдена' });
      if (room.ps.size >= 6) return send(ws, { t: 'err', m: 'В комнате уже 6 игроков' });
      r = room;
      p = { id: uid++, name: String(d.name || 'Игрок').slice(0, 12), ws, a: 0, in: { dx: 0, dy: 0, s: 0 } };
      resetPlayer(p);
      if (!r.host) r.host = p.id;
      r.ps.set(p.id, p); lobbyInfo(r);
    } else if (r && d.t === 'start' && p.id === r.host && r.st !== 'play') startGame(r);
    else if (r && d.t === 'in') {
      p.in = { dx: +d.dx || 0, dy: +d.dy || 0, s: d.s ? 1 : 0, e: d.e ? 1 : 0 }; p.a = +d.a || 0;
      if (d.w && p.has[d.w]) p.w = d.w;
    }
  });
  ws.on('close', () => {
    if (!r) return;
    r.ps.delete(p.id);
    if (!r.ps.size) { delete rooms[r.code]; return; }
    if (r.host === p.id) r.host = r.ps.keys().next().value;
    lobbyInfo(r);
  });
});

function tick(r) {
  if (r.st !== 'play') return;
  const ps = [...r.ps.values()], ws = r.map.w;
  // Волны
  if (r.brk > 0) { r.brk -= DT; if (r.brk <= 0) startWave(r); }
  else if (r.left <= 0 && !r.z.length) {
    r.brk = 6;
    ps.forEach(p => { if (!p.alive) { p.alive = true; p.hp = 60; } else p.hp = Math.min(100, p.hp + 25); p.am = Math.min(200, p.am + 20); });
  } else if (r.left > 0) {
    r.spT -= DT;
    if (r.spT <= 0) { spawnZ(r); r.left--; r.spT = Math.max(.15, .9 - r.wave * .05); }
  }
  // Страховка: если в конце волны остались 1-3 зомби и их не удаётся добить 40 секунд — волна засчитывается
  if (r.brk <= 0 && r.left <= 0 && r.z.length && r.z.length <= 3) { r.tail += DT; if (r.tail > 40) { r.z = []; r.tail = 0; } } else r.tail = 0;
  r.fT -= DT; if (r.fT <= 0) { flow(r, ps); r.fT = .2; }
  // Игроки
  for (const p of ps) {
    p.f = 0; if (!p.alive) continue;
    const { dx, dy, s } = p.in, m = Math.hypot(dx, dy);
    if (m) { p.x = clamp(p.x + dx / m * 230 * DT, 20, W - 20); p.y = clamp(p.y + dy / m * 230 * DT, 20, H - 20); push(p, 14, ws); }
    if (p.in.e && !p.eu) {
      const c = r.cs.find(c => !c.o && Math.hypot(c.x - p.x, c.y - p.y) < 55);
      if (c) { c.o = 1; r.co.push(c.id); r.ev.push(['o', c.x, c.y]); for (let i = 0, n = 2 + (Math.random() * 2 | 0); i < n; i++) drop(r, c.x + rnd(-30, 30), c.y + rnd(-30, 30), 1, 1); }
    }
    p.eu = p.in.e;
    p.cd -= DT;
    if (s && p.cd <= 0) {
      let w = WP[p.w];
      if (w.am && p.am <= 0) { p.w = 'pistol'; w = WP.pistol; }
      if (w.am) p.am--;
      p.cd = w.rate; p.f = 1;
      for (let i = 0; i < w.n; i++) {
        const a = p.a + rnd(-w.sp, w.sp);
        r.b.push({ x: p.x + Math.cos(p.a) * 24, y: p.y + Math.sin(p.a) * 24, vx: Math.cos(a) * w.spd, vy: Math.sin(a) * w.spd, d: w.dmg, life: .7, o: p });
      }
    }
  }
  // Пули
  for (const b of r.b) {
    b.x += b.vx * DT; b.y += b.vy * DT; b.life -= DT; if (hitW(b.x, b.y, ws)) { b.life = 0; continue; }
    for (const z of r.z) {
      if (z.hp > 0 && Math.hypot(z.x - b.x, z.y - b.y) < z.r + 4) {
        z.hp -= b.d; b.life = 0; r.ev.push(['h', b.x | 0, b.y | 0]);
        const k = 6 / (Math.hypot(b.vx, b.vy) || 1); z.x += b.vx * k; z.y += b.vy * k;
        if (z.hp <= 0) { b.o.sc += z.t === 'tank' ? 50 : 10; r.ev.push(['k', z.x | 0, z.y | 0]); drop(r, z.x, z.y, z.t === 'tank'); }
        break;
      }
    }
  }
  r.b = r.b.filter(b => b.life > 0);
  r.z = r.z.filter(z => z.hp > 0);
  // Зомби
  for (const z of r.z) {
    let best = null, bd = 1e9;
    for (const p of ps) if (p.alive) { const d = Math.hypot(p.x - z.x, p.y - z.y); if (d < bd) { bd = d; best = p; } }
    if (!best) continue;
    const st = z.sp * DT, ox = z.x, oy = z.y, [ux, uy] = dirTo(r, z, best, bd);
    z.x = clamp(z.x + ux * st, 0, W); z.y = clamp(z.y + uy * st, 0, H); push(z, z.r, ws);
    // Если зомби за 2 секунды почти не сдвинулся и не рядом с игроком — перенести его на край карты
    z.mv += Math.hypot(z.x - ox, z.y - oy); z.sk += DT;
    if (z.sk >= 2) { if (z.mv < z.sp * 2 * .2 && bd > z.r + 40) { const [ex, ey] = edgePos(); z.x = ex; z.y = ey; } z.mv = 0; z.sk = 0; }
    z.cd -= DT;
    if (bd < z.r + 16 && z.cd <= 0) {
      const ab = Math.min(best.ar, z.dmg * .6); best.ar -= ab; best.hp -= z.dmg - ab; z.cd = .8; r.ev.push(['p', best.x | 0, best.y | 0]);
      if (best.hp <= 0) best.alive = false;
    }
  }
  for (let i = 0; i < r.z.length; i++) for (let j = i + 1; j < r.z.length; j++) {
    const a = r.z[i], b = r.z[j], d = Math.hypot(a.x - b.x, a.y - b.y), min = a.r + b.r - 4;
    if (d > 0 && d < min) { const k = (min - d) / 2 / d, ux = (a.x - b.x) * k, uy = (a.y - b.y) * k; a.x += ux; a.y += uy; b.x -= ux; b.y -= uy; }
  }
  // Лут
  for (const l of r.l) {
    l.ttl -= DT;
    for (const p of ps) {
      if (!p.alive || Math.hypot(p.x - l.x, p.y - l.y) > 30) continue;
      if (l.type === 'med') p.hp = Math.min(100, p.hp + 40);
      else if (l.type === 'armor') p.ar = Math.min(100, p.ar + 50);
      else if (l.type === 'ammo') p.am = Math.min(200, p.am + 25);
      else { p.has[l.type] = 1; p.w = l.type; p.am = Math.min(200, p.am + 20); }
      l.ttl = 0; break;
    }
  }
  r.l = r.l.filter(l => l.ttl > 0);
  // Конец игры
  if (ps.length && ps.every(p => !p.alive)) { r.st = 'over'; lobbyInfo(r); return; }
  // Рассылка
  const msg = JSON.stringify({
    t: 's', wave: r.wave, left: r.left + r.z.length, brk: Math.ceil(r.brk), ev: r.ev, co: r.co,
    p: ps.map(p => [p.id, p.x | 0, p.y | 0, +p.a.toFixed(2), p.hp | 0, p.alive ? 1 : 0, p.f, p.sc, p.w, p.am, (p.has.shotgun ? 1 : 0) + (p.has.smg ? 2 : 0), p.ar | 0]),
    z: r.z.map(z => [z.id, z.x | 0, z.y | 0, z.t, +(z.hp / z.mx).toFixed(2)]),
    b: r.b.map(b => [b.x | 0, b.y | 0, +Math.atan2(b.vy, b.vx).toFixed(2)]),
    l: r.l.map(l => [l.id, l.x | 0, l.y | 0, l.type]),
  });
  r.ev = [];
  ps.forEach(p => { if (p.ws.readyState === 1) p.ws.send(msg); });
}
setInterval(() => { for (const c in rooms) tick(rooms[c]); }, 1000 / TICK);
srv.listen(PORT, () => console.log('Last Light: http://localhost:' + PORT));
