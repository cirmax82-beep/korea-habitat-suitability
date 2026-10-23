// 영향 예측 — 사업지 안과 주변의 종별 서식지 적합성·출현 기록으로 영향 정도를 매기고, 맞춤 저감방안과 대체서식지 후보를 보여 줌
// 계산은 모두 브라우저에서: 사업지 주변 16 km 묶음 파일(모든 종의 적합성 + 환경 값)만 받아 250 m 칸 단위로 셈
(() => {
  const H = window.H;
  const { S, $, $$, esc, fmt, toast, saveBlob } = H;
  const TURF = "https://cdn.jsdelivr.net/npm/@turf/turf@7.1.0/turf.min.js";
  const PRESETS = [0.5, 1, 2, 3, 5];
  const SUB = 4;            // 사업지가 칸을 덮는 비율: 칸마다 4×4 표본점
  const BUILT_MAX = 20;     // 대체서식지 후보에서 뺄 시가지 비율(%)
  const ALT_TOP = 5;
  const GRADE_NAME = { high: "높음", mid: "보통", low: "낮음" };
  const GRADE_RANK = { high: 0, mid: 1, low: 2 };
  // 토지피복(환경부 세분류 2025년 묶음)
  const COVER = [["tree", "산림", "#2f9e44"], ["grass", "초지", "#94d82d"], ["paddy", "논", "#fff3a0"], ["field", "밭·과수", "#fcc419"],
    ["built", "시가지", "#868e96"], ["artbare", "나대지", "#ced4da"], ["bare", "자연 나지", "#d8c39a"], ["rock", "암벽", "#a1887f"], ["river", "하천", "#1c7ed6"],
    ["lake", "호소", "#4dabf7"], ["wetland", "습지", "#22b8cf"], ["tidal", "갯벌", "#b197fc"], ["sea", "바다", "#1864ab"]];
  const ALT_COLOR = "#7048e8";
  const I = { inited: false, map: null, res: null, sel: null, running: false, km: 1, showLow: false };

  // ---------- 묶음 파일 ----------
  const blocks = new Map();   // by*1000+bx → Uint8Array(행 × 4096)
  const loadBlock = async (key) => {
    if (!blocks.has(key)) {
      blocks.set(key, H.decodeGray(`data/blocks/${key % 1000}-${Math.floor(key / 1000)}.webp`).then((d) => d.data)
        .catch((err) => { blocks.delete(key); throw err; }));
    }
    return blocks.get(key);
  };
  const B = () => S.grid.block;
  // 행(row)의 (r, c) 칸 값. 묶음이 없으면(바다) 255
  const getter = (loaded) => (row, r, c) => {
    const b = B();
    const d = loaded.get(Math.floor(r / b) * 1000 + Math.floor(c / b));
    return d ? d[row * b * b + (r % b) * b + (c % b)] : 255;
  };
  const envRow = (name) => S.grid.rows.length + S.grid.env.findIndex((e) => e[0] === name);
  const envK = (name) => (S.grid.env.find((e) => e[0] === name) || [0, 1])[1];
  // 칸의 토지피복 비율(0–1)을 읽는 함수
  const fracOf = (get, name) => { const row = envRow(name), k = envK(name); return (r, c) => get(row, r, c) / k; };
  // 칸 안 서식지가 될 수 있는 부분의 비율 — 면적을 셀 때 곱함
  // 물에 사는 종은 그 물(하천·호소 등), 그 밖의 종은 시가지·나대지를 뺀 부분(‘도시’ 서식 종은 칸 전체)
  const habOf = (get, sp) => {
    if (sp.urban) return () => 1;
    const fs = sp.aqua ? sp.aqua.map((n) => fracOf(get, n)) : [fracOf(get, "built"), fracOf(get, "artbare")];
    return sp.aqua ? (r, c) => Math.min(1, fs.reduce((a, f) => a + f(r, c), 0))
      : (r, c) => Math.max(0, 1 - fs[0](r, c) - fs[1](r, c));
  };

  // ---------- 사업지 도형(UTM-K) ----------
  const prepSite = async (features, widthM) => {
    const polys = [], pts = [];
    let lines = 0;
    for (const f of features) {
      const g = f.geometry;
      if (g.type === "Point") { pts.push(S.utmk.forward(g.coordinates)); continue; }
      let geom = g;
      if (/LineString/.test(g.type)) {
        await H.loadScript(TURF, "turf");
        geom = turf.buffer(f, widthM / 2, { units: "meters", steps: 8 }).geometry;
        lines++;
      }
      (geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates).forEach((p) => polys.push(p.map((ring) => ring.map((c) => S.utmk.forward(c)))));
    }
    // 거리 계산용 선분(32개씩 묶고 범위 상자)
    const seg = [];
    polys.forEach((p) => p.forEach((ring) => { for (let i = 1; i < ring.length; i++) seg.push(ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]); }));
    pts.forEach(([x, y]) => seg.push(x, y, x, y));
    const S4 = new Float64Array(seg), n = S4.length / 4, CH = 32, boxes = [];
    for (let i = 0; i < n; i += CH) {
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      for (let j = i; j < Math.min(n, i + CH); j++) {
        const o = j * 4;
        b[0] = Math.min(b[0], S4[o], S4[o + 2]); b[1] = Math.min(b[1], S4[o + 1], S4[o + 3]);
        b[2] = Math.max(b[2], S4[o], S4[o + 2]); b[3] = Math.max(b[3], S4[o + 1], S4[o + 3]);
      }
      boxes.push([i, Math.min(n, i + CH), b]);
    }
    const all = polys.flat(2).concat(pts);
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    all.forEach(([x, y]) => { bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y); });
    return { polys, pts, lines, seg: S4, boxes, bb };
  };
  // 점에서 사업지 경계까지 최단 거리(m)
  const distTo = (G, x, y) => {
    let best = Infinity;
    for (const [i0, i1, b] of G.boxes) {
      const dx = Math.max(b[0] - x, 0, x - b[2]), dy = Math.max(b[1] - y, 0, y - b[3]);
      if (dx * dx + dy * dy >= best) continue;
      for (let i = i0; i < i1; i++) {
        const o = i * 4, ax = G.seg[o], ay = G.seg[o + 1], vx = G.seg[o + 2] - ax, vy = G.seg[o + 3] - ay;
        const L2 = vx * vx + vy * vy;
        const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / L2)) : 0;
        const ex = ax + t * vx - x, ey = ay + t * vy - y, d = ex * ex + ey * ey;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  };
  // 면이 칸을 덮는 비율 — 표본점 줄마다 면 경계와 만나는 점을 구해 안쪽 구간을 채움(짝홀 규칙이라 구멍이 빠짐, 여러 면은 합침)
  const coverage = (G, win) => {
    const { r0, c0, h, w } = win, res = S.grid.res, n = SUB;
    const mask = new Uint8Array(h * n * w * n);
    G.polys.forEach((poly) => {
      let ymin = Infinity, ymax = -Infinity;
      poly[0].forEach(([, y]) => { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); });
      const sr0 = Math.max(0, Math.floor(((S.grid.y1 - ymax) / res - r0) * n)), sr1 = Math.min(h * n - 1, Math.ceil(((S.grid.y1 - ymin) / res - r0) * n));
      for (let sr = sr0; sr <= sr1; sr++) {
        const y = S.grid.y1 - (r0 + (sr + 0.5) / n) * res;
        const xs = [];
        poly.forEach((ring) => {
          for (let i = 1; i < ring.length; i++) {
            const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
            if ((ay > y) !== (by > y)) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
          }
        });
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const sc0 = Math.max(0, Math.ceil(((xs[k] - S.grid.x0) / res - c0) * n - 0.5));
          const sc1 = Math.min(w * n - 1, Math.floor(((xs[k + 1] - S.grid.x0) / res - c0) * n - 0.5));
          for (let sc = sc0; sc <= sc1; sc++) mask[sr * w * n + sc] = 1;
        }
      }
    });
    const cov = new Float32Array(h * w);
    for (let sr = 0; sr < h * n; sr++) {
      const r = Math.floor(sr / n);
      for (let sc = 0; sc < w * n; sc++) if (mask[sr * w * n + sc]) cov[r * w + Math.floor(sc / n)] += 1 / (n * n);
    }
    return cov;
  };

  // ---------- 칸 묶음 → 면 ----------
  // 묶음 밖과 맞닿은 칸 변만 모아 이음(바깥 고리 반시계, 구멍 시계). 대각선으로만 닿은 칸은 따로 떼어 냄(왼쪽으로 꺾기 우선)
  const trace = (inSet, win) => {
    const { h, w, r0, c0 } = win, W1 = w + 1, G = S.grid;
    const E = [], out = new Map();
    const add = (c1, r1, c2, r2) => {
      const a = r1 * W1 + c1;
      E.push([a, r2 * W1 + c2, c2 - c1, r2 - r1]);
      if (!out.has(a)) out.set(a, []);
      out.get(a).push(E.length - 1);
    };
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const k = r * w + c;
        if (!inSet(k)) continue;
        if (c === 0 || !inSet(k - 1)) add(c, r, c, r + 1);
        if (r === h - 1 || !inSet(k + w)) add(c, r + 1, c + 1, r + 1);
        if (c === w - 1 || !inSet(k + 1)) add(c + 1, r + 1, c + 1, r);
        if (r === 0 || !inSet(k - w)) add(c + 1, r, c, r);
      }
    }
    const next = (e) => {
      const [, b, dc, dr] = E[e], outs = out.get(b);
      return outs.length === 1 ? outs[0] : (outs.find((x) => E[x][2] === dr && E[x][3] === -dc) ?? outs[0]);
    };
    const used = new Uint8Array(E.length), rings = [];
    for (let s = 0; s < E.length; s++) {
      if (used[s]) continue;
      const ring = [];
      let e = s;
      do {
        used[e] = 1;
        const [a, , dc, dr] = E[e], p = E[(ring.length ? ring[ring.length - 1].e : e)];
        if (!ring.length || p[2] !== dc || p[3] !== dr) ring.push({ v: a, e });   // 방향이 바뀌는 꼭짓점만
        else ring[ring.length - 1].e = e;
        e = next(e);
      } while (e !== s && !used[e]);
      const xy = ring.map(({ v }) => [G.x0 + (c0 + (v % W1)) * G.res, G.y1 - (r0 + Math.floor(v / W1)) * G.res]);
      if (xy.length >= 3) rings.push(xy);
    }
    const area = (rg) => { let a = 0; for (let i = 0, j = rg.length - 1; i < rg.length; j = i++) a += (rg[j][0] - rg[i][0]) * (rg[j][1] + rg[i][1]); return a / 2; };
    const inRing = ([x, y], rg) => {
      let ins = false;
      for (let i = 0, j = rg.length - 1; i < rg.length; j = i++) {
        if ((rg[i][1] > y) !== (rg[j][1] > y) && x < ((rg[j][0] - rg[i][0]) * (y - rg[i][1])) / (rg[j][1] - rg[i][1]) + rg[i][0]) ins = !ins;
      }
      return ins;
    };
    const outer = rings.filter((rg) => area(rg) > 0).map((rg) => [rg]);
    rings.filter((rg) => area(rg) < 0).forEach((hole) => {
      const p = [(hole[0][0] + hole[1][0]) / 2, (hole[0][1] + hole[1][1]) / 2];
      const o = outer.find((poly) => inRing(p, poly[0]));
      if (o) o.push(hole);
    });
    const ll = (rg) => { const r = rg.map((p) => S.utmk.inverse(p)); r.push(r[0]); return r; };
    return outer.map((poly) => poly.map(ll));
  };

  // ---------- 분석 ----------
  const progress = (f, msg) => {
    const p = $("#an-progress");
    p.hidden = f === null;
    if (f !== null) { p.querySelector("i").style.width = `${Math.round(f * 100)}%`; p.querySelector("span").textContent = msg; }
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  const run = async () => {
    const site = Site.get();
    if (!site) { toast("먼저 사업지를 정해 주세요."); return; }
    if (I.running) return;
    I.running = true;
    $("#an-run").disabled = true;
    try {
      const km = I.km, alt = Number($("#an-alt").value), widthM = Math.max(2, Math.min(200, Number($("#an-width").value) || 20));
      progress(0.05, "사업지를 격자로 바꾸는 중…");
      const G = await prepSite(site.features, widthM);
      const Gd = S.grid, res = Gd.res, reach = Math.max(km, alt) * 1000 + res;
      const c0 = Math.max(0, Math.floor((G.bb[0] - reach - Gd.x0) / res)), c1 = Math.min(Gd.W - 1, Math.floor((G.bb[2] + reach - Gd.x0) / res));
      const r0 = Math.max(0, Math.floor((Gd.y1 - G.bb[3] - reach) / res)), r1 = Math.min(Gd.H - 1, Math.floor((Gd.y1 - G.bb[1] + reach) / res));
      if (c1 < c0 || r1 < r0) throw new Error("사업지가 분석 범위(남한) 밖에 있습니다.");
      const win = { r0, c0, h: r1 - r0 + 1, w: c1 - c0 + 1 };
      if (win.h * win.w > 1.2e6) throw new Error("사업지가 너무 넓습니다. 구역을 나눠 분석해 주세요.");

      // 묶음 받기
      const b = Gd.block, keys = [];
      for (let by = Math.floor(r0 / b); by <= Math.floor(r1 / b); by++) for (let bx = Math.floor(c0 / b); bx <= Math.floor(c1 / b); bx++) if (S.blockSet.has(by * 1000 + bx)) keys.push(by * 1000 + bx);
      const loaded = new Map();
      let done = 0;
      await Promise.all(keys.map(async (k) => {
        loaded.set(k, await loadBlock(k));
        progress(0.1 + 0.6 * (++done / keys.length), `격자 자료 받는 중… ${done}/${keys.length}`);
      }));
      const get = getter(loaded);
      progress(0.75, "사업지와 주변 칸 계산 중…");
      await tick();

      // 칸마다 사업지가 덮는 비율·사업지까지 거리
      const cov = coverage(G, win), n = win.h * win.w, dist = new Float32Array(n);
      for (let r = 0; r < win.h; r++) {
        const y = Gd.y1 - (r0 + r + 0.5) * res;
        for (let c = 0; c < win.w; c++) {
          const k = r * win.w + c;
          dist[k] = cov[k] > 0 ? 0 : distTo(G, Gd.x0 + (c0 + c + 0.5) * res, y);
        }
      }
      const ptCells = G.pts.map(([x, y]) => [Math.floor((Gd.y1 - y) / res), Math.floor((x - Gd.x0) / res)]);
      const cellHa = (res * res) / 1e4, R = km * 1000;
      const ELEV = envRow("elev");
      const land = (r, c) => get(ELEV, r, c) !== 255;
      // 사업지·주변 면적과 토지피복
      let siteHa = 0, ringHa = 0;
      const cover = { site: {}, ring: {} };
      const envF = COVER.map(([k]) => fracOf(get, k));
      for (let k = 0; k < n; k++) {
        const r = r0 + Math.floor(k / win.w), c = c0 + (k % win.w);
        if (!land(r, c)) continue;
        const a = cov[k] * cellHa, ra = dist[k] <= R ? (1 - cov[k]) * cellHa : 0;
        siteHa += a; ringHa += ra;
        COVER.forEach(([key], j) => {
          const v = envF[j](r, c);
          cover.site[key] = (cover.site[key] || 0) + v * a;
          cover.ring[key] = (cover.ring[key] || 0) + v * ra;
        });
      }
      if (!G.polys.length) ptCells.forEach(([r, c]) => { if (land(r, c)) COVER.forEach(([key], j) => { cover.site[key] = (cover.site[key] || 0) + envF[j](r, c); }); });
      // 위치(시군구)
      const cx = (G.bb[0] + G.bb[2]) / 2, cy = (G.bb[1] + G.bb[3]) / 2;
      const rc = [Math.floor((Gd.y1 - cy) / res), Math.floor((cx - Gd.x0) / res)];
      const sggIdx = get(envRow("sgg_lo"), ...rc) + 256 * get(envRow("sgg_hi"), ...rc);
      if (!siteHa && !ptCells.some(([r, c]) => land(r, c)) && !ringHa) throw new Error("사업지와 주변이 모두 바다입니다. 이 사이트는 육상 격자만 다룹니다.");

      // 출현 기록 칸(약 250 m) — 칸 가운데에서 사업지까지 거리
      progress(0.85, "종별 계산 중…");
      await tick();
      const occ = await H.loadOcc();
      const wx0 = Gd.x0 + c0 * res, wx1 = Gd.x0 + (c1 + 1) * res, wy1 = Gd.y1 - r0 * res, wy0 = Gd.y1 - (r1 + 1) * res;
      const recDist = (id) => {
        let best = null, nIn = 0;
        (occ[id] || []).forEach((cell) => {
          const [x, y] = S.utmk.forward(H.occCenter(cell));
          if (x < wx0 || x > wx1 || y < wy0 || y > wy1) return;
          const kr = Math.floor((Gd.y1 - y) / res) - r0, kc = Math.floor((x - Gd.x0) / res) - c0;
          const d = kr >= 0 && kr < win.h && kc >= 0 && kc < win.w && cov[kr * win.w + kc] > 0 ? 0 : distTo(G, x, y);
          if (best === null || d < best) best = d;
          if (d <= R) nIn++;
        });
        return [best, nIn];
      };

      // 종별
      const want = { en1: $("#an-en1").checked, en2: $("#an-en2").checked, nm: $("#an-nm").checked, absent: $("#an-absent").checked };
      const targets = S.cat.filter((s) => s.row >= 0 && (want.absent || !s.absent) && ((s.grade && want[s.grade]) || (!s.grade && s.nm && want.nm)));
      const near = [];
      for (let k = 0; k < n; k++) if (dist[k] <= R) near.push(k);
      const rows = [];
      targets.forEach((sp) => {
        const t = H.thrOf(sp), row = sp.row, hab = habOf(get, sp);
        let suitIn = 0, sumV = 0, sumW = 0, ringSuit = 0, atPt = -1;
        near.forEach((k) => {
          const r = r0 + Math.floor(k / win.w), c = c0 + (k % win.w), v = get(row, r, c);
          if (v > 100) return;
          const cw = cov[k], a = cellHa * hab(r, c);   // 칸 안 서식지가 될 수 있는 부분만
          if (cw > 0) { if (v >= t) suitIn += cw * a; sumV += v * cw; sumW += cw; }
          if (cw < 1 && v >= t) ringSuit += (1 - cw) * a;
        });
        ptCells.forEach(([r, c]) => { const v = get(row, r, c); if (v <= 100) atPt = Math.max(atPt, v); });
        const [rd, nRec] = recDist(sp.id);
        const recNear = rd !== null && rd <= R;
        const hitIn = suitIn >= 0.5 || atPt >= t;
        let grade = null;
        if (hitIn) grade = recNear ? "high" : "mid";
        else if (ringSuit > 0 && recNear) grade = "mid";
        else if (ringSuit > 0 || recNear) grade = "low";
        if (grade && sp.model && sp.model.method !== "maxent" && !recNear) grade = "low";
        if (grade) rows.push({ sp, grade, suitIn, meanIn: sumW ? sumV / sumW : atPt >= 0 ? atPt : null, ringSuit, recDist: rd, nRec, t });
      });
      rows.sort((a, b) => GRADE_RANK[a.grade] - GRADE_RANK[b.grade] || (a.sp.grade || "en3").localeCompare(b.sp.grade || "en3")
        || b.suitIn - a.suitIn || b.ringSuit - a.ringSuit || a.sp.ko.localeCompare(b.sp.ko, "ko"));
      I.res = { km, alt, widthM, G, win, get, cov, dist, siteHa, ringHa, cover, ptOnly: !G.polys.length, sgg: S.grid.sgg[sggIdx - 1] || "",
        rows, nTargets: targets.length, name: Site.name(), lines: G.lines };
      I.sel = null;
      progress(1, "완료");
      await drawRange();
      renderResult();
      setTimeout(() => progress(null), 600);
    } catch (err) {
      console.warn(err);
      progress(null);
      toast(err.message || "분석하지 못했습니다.", 6000);
    } finally {
      I.running = false;
      $("#an-run").disabled = false;
    }
  };

  // ---------- 지도 ----------
  const clearResult = () => {
    I.res = null; I.sel = null;
    if (!I.map) return;
    I.rangeLayer.clearLayers(); I.recLayer.clearLayers(); I.altLayer.clearLayers();
    if (I.suit) { I.suit.remove(); I.suit = null; }
    $("#an-legend").hidden = true;
    $("#an-result").innerHTML = `<div class="an-empty muted"><p><b>영향 예측하기</b>를 누르면 사업지와 주변에 서식할 가능성이 있는 종을 보여 줍니다.</p></div>`;
  };
  const drawRange = async () => {
    I.rangeLayer.clearLayers();
    const site = Site.get();
    if (!site) return;
    await H.loadScript(TURF, "turf");
    try {
      const bufs = site.features.map((f) => turf.buffer(f, I.res.km, { units: "kilometers", steps: 24 })).filter(Boolean);
      const u = bufs.length > 1 ? turf.union(turf.featureCollection(bufs)) : bufs[0];
      L.geoJSON(u, { renderer: I.renderer, interactive: false, style: { color: "#495057", weight: 1.5, dashArray: "6 5", fill: false } }).addTo(I.rangeLayer);
      I.map.fitBounds(L.geoJSON(u).getBounds(), { padding: [20, 20] });
    } catch (err) { console.warn(err); }
    Site.toFront();
  };
  const showSpeciesOnMap = async (row) => {
    const res = I.res, sp = row.sp;
    if (I.suit) I.suit.remove();
    I.suit = new H.SuitLayer((r, c) => res.get(sp.row, r, c), row.t, { opacity: 0.75 }).addTo(I.map);
    I.recLayer.clearLayers(); I.altLayer.clearLayers();
    const occ = await H.loadOcc();
    const Gd = S.grid;
    const { r0, c0, h, w } = res.win;
    (occ[sp.id] || []).forEach((cell) => {
      const [x, y] = S.utmk.forward(H.occCenter(cell));
      const rr = (Gd.y1 - y) / Gd.res, cc = (x - Gd.x0) / Gd.res;
      if (rr >= r0 && rr < r0 + h && cc >= c0 && cc < c0 + w) L.polygon(H.occCellLatLngs(cell), { ...H.REC_STYLE, renderer: I.renderer }).addTo(I.recLayer);
    });
    row.alt = row.alt || altPatches(row);
    row.alt.forEach((p, i) => {
      L.polygon(p.geom.map((poly) => poly.map((rg) => rg.map(([x, y]) => [y, x]))), { renderer: I.renderer, color: ALT_COLOR, weight: 2, fillColor: ALT_COLOR, fillOpacity: 0.12 })
        .bindTooltip(`대체서식지 후보 ${i + 1}`, { sticky: true }).addTo(I.altLayer);
    });
    $("#an-legend").hidden = false;
    $("#an-legend").innerHTML = H.legendHtml(sp, `<div><i class="rec"></i>출현 기록(약 250 m 칸)</div><div><i style="background:rgba(112,72,232,.15);border:2px solid ${ALT_COLOR}"></i>대체서식지 후보</div>`);
    Site.toFront();
  };

  // ---------- 대체서식지 후보 ----------
  // 사업지 밖, 정한 거리 안, ‘적합’ 이상이고 시가지 20% 미만인 칸을 상하좌우로 이어 묶고 적합도·면적·거리로 순위
  const altPatches = (row) => {
    const res = I.res, { win, get, cov, dist } = res, { h, w, r0, c0 } = win, n = h * w;
    const maxD = res.alt * 1000, built = fracOf(get, "built"), hab = habOf(get, row.sp), cellHa = (S.grid.res ** 2) / 1e4;
    const cand = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      if (cov[k] > 0 || dist[k] > maxD) continue;
      const r = r0 + Math.floor(k / w), c = c0 + (k % w), v = get(row.sp.row, r, c);
      if (v <= 100 && v >= row.t && built(r, c) * 100 < BUILT_MAX) cand[k] = 1;
    }
    const label = new Int32Array(n).fill(-1), patches = [];
    const envF = COVER.map(([k]) => fracOf(get, k)), lo = envRow("sgg_lo"), hi = envRow("sgg_hi");
    for (let k = 0; k < n; k++) {
      if (!cand[k] || label[k] >= 0) continue;
      const id = patches.length, stack = [k], cells = [];
      label[k] = id;
      while (stack.length) {
        const q = stack.pop();
        cells.push(q);
        const qr = Math.floor(q / w), qc = q % w;
        [[qr - 1, qc], [qr + 1, qc], [qr, qc - 1], [qr, qc + 1]].forEach(([a, b]) => {
          if (a < 0 || b < 0 || a >= h || b >= w) return;
          const m = a * w + b;
          if (cand[m] && label[m] < 0) { label[m] = id; stack.push(m); }
        });
      }
      let sumV = 0, minD = Infinity, ha = 0;
      const cv = {}, sgg = new Map();
      cells.forEach((q) => {
        const r = r0 + Math.floor(q / w), c = c0 + (q % w);
        sumV += get(row.sp.row, r, c);
        minD = Math.min(minD, dist[q]);
        ha += cellHa * hab(r, c);
        COVER.forEach(([key], j) => { cv[key] = (cv[key] || 0) + envF[j](r, c) * 100; });
        const s = get(lo, r, c) + 256 * get(hi, r, c);
        sgg.set(s, (sgg.get(s) || 0) + 1);
      });
      const mean = sumV / cells.length;
      const main = COVER.map(([key, name]) => [name, cv[key] / cells.length]).sort((a, b) => b[1] - a[1])[0];
      const sg = [...sgg].sort((a, b) => b[1] - a[1])[0][0];
      patches.push({ id, cells, ha, mean, minD, cover: main ? `${main[0]} ${fmt(main[1])}%` : "", sgg: S.grid.sgg[sg - 1] || "",
        score: (mean / 100) * Math.log1p(ha) / (1 + minD / 2000) });
    }
    return patches.sort((a, b) => b.score - a.score).slice(0, ALT_TOP).map((p) => {
      const set = new Set(p.cells);
      return { ...p, geom: trace((k) => set.has(k), win) };
    });
  };

  // ---------- 결과 ----------
  const haText = (v) => (v >= 100 ? `${fmt(v / 100, 2)} ㎢` : `${fmt(v, 1)} ha`);
  const distText = (m) => (m === null ? "-" : m === 0 ? "사업지 안" : m >= 1000 ? `${fmt(m / 1000, 1)} km` : `${fmt(m)} m`);
  const coverBar = (c, total) => {
    if (!total) return "";
    const parts = COVER.map(([k, name, color]) => [name, color, ((c[k] || 0) / total) * 100]).filter((x) => x[2] >= 0.5);
    return `<div class="cover-bar">${parts.map(([n, col, p]) => `<i style="width:${p}%;background:${col}" title="${n} ${fmt(p)}%"></i>`).join("")}</div>
      <div class="cover-key">${parts.map(([n, col, p]) => `<span><i style="background:${col}"></i>${n} ${fmt(p)}%</span>`).join("")}</div>`;
  };
  const renderResult = () => {
    const r = I.res, cnt = { high: 0, mid: 0, low: 0 };
    r.rows.forEach((x) => cnt[x.grade]++);
    const siteTotal = r.ptOnly ? COVER.reduce((s, [k]) => s + (r.cover.site[k] || 0), 0) : r.siteHa;
    $("#an-result").innerHTML = `
      <h2>${esc(r.name)} 영향 예측</h2>
      <div class="muted small">${esc(r.sgg)} · ${r.ptOnly ? "사업지 지점" : `사업지 ${haText(r.siteHa)}${r.lines ? ` (선형 사업은 폭 ${fmt(r.widthM)} m로 계산)` : ""}`} · 주변 ${fmt(r.km, 1)} km · 대상 ${fmt(r.nTargets)}종</div>
      <div class="an-cards">
        <div class="an-card ${cnt.high ? "warn" : ""}"><b>${fmt(cnt.high)}종</b><span>영향 높음</span></div>
        <div class="an-card"><b>${fmt(cnt.mid)}종</b><span>영향 보통</span></div>
        <div class="an-card"><b>${fmt(cnt.low)}종</b><span>영향 낮음</span></div>
      </div>
      <div class="im-cols">
        <div><b class="small">${r.ptOnly ? "사업지 지점" : "사업지 안"} 토지피복</b>${coverBar(r.cover.site, siteTotal)}</div>
        <div><b class="small">주변 ${fmt(r.km, 1)} km 토지피복</b>${coverBar(r.cover.ring, r.ringHa)}</div>
      </div>
      <h3>서식 가능성이 있는 종 <span class="muted small">줄을 누르면 지도·저감방안·대체서식지 후보</span></h3>
      ${r.rows.length ? `<div class="table-wrap an-rows-wrap"><table class="table" id="im-table"><thead><tr>
        <th>종</th><th>분류군</th><th>영향</th><th class="num">${r.ptOnly ? "지점 적합도" : "사업지 안 적합 서식지"}</th><th class="num">주변 적합 서식지</th><th class="num">가까운 기록</th><th>방식</th>
      </tr></thead><tbody>${r.rows.map((x, i) => (x.grade === "low" && !I.showLow ? "" : `<tr data-i="${i}" class="${I.sel === i ? "sel" : ""}">
        <td><b>${esc(x.sp.ko)}</b> ${H.shortBadge(x.sp)}</td><td>${esc(H.GROUPS[x.sp.group] || "")}</td>
        <td><span class="grade g-${x.grade}">${GRADE_NAME[x.grade]}</span></td>
        <td class="num">${r.ptOnly ? (x.meanIn === null ? "-" : `${fmt(x.meanIn)}%`) : x.suitIn ? haText(x.suitIn) : "-"}</td>
        <td class="num">${x.ringSuit ? haText(x.ringSuit) : "-"}</td><td class="num">${distText(x.recDist)}</td>
        <td><span class="method">${x.sp.model && x.sp.model.method === "maxent" ? "모형" : "지수"}</span></td></tr>`)).join("")}</tbody></table></div>
        ${cnt.low ? `<button class="link small" data-low>${I.showLow ? "‘낮음’ 종 접기" : `‘낮음’ ${fmt(cnt.low)}종 더 보기`}</button>` : ""}`
        : `<p class="muted">대상 종 가운데 사업지와 주변 ${fmt(r.km, 1)} km 안에 적합 서식지나 출현 기록이 있는 종이 없습니다.</p>`}
      <div class="row" style="margin-top:10px">
        <button class="btn btn-light btn-sm" data-dl="csv">결과표 CSV</button>
        <span class="muted small">적합도·면적은 250 m 격자 기준 추정값입니다. 실제 서식 여부는 현지조사로 확인하세요.</span>
      </div>
      <div id="im-detail" class="im-detail"></div>`;
  };
  const renderDetail = () => {
    const r = I.res, x = r.rows[I.sel], sp = x.sp, se = Measures.season(sp.season);
    const measures = Measures.list(sp, { lostHa: r.ptOnly ? 0 : Math.round(x.suitIn * 10) / 10, grade: x.grade });
    $("#im-detail").innerHTML = `
      <div class="panel">
        <div class="im-sp-head">
          <div><b style="font-size:17px">${esc(sp.ko)}</b> <span class="muted small"><i>${esc(sp.sci)}</i></span> <span class="grade g-${x.grade}">영향 ${GRADE_NAME[x.grade]}</span></div>
          <div class="small"><a href="#species/${sp.id}">종 정보</a> · <button class="link" data-copy>저감방안 복사</button></div>
        </div>
        <div class="badges" style="margin:6px 0 10px">${H.badges(sp)}</div>
        <dl class="facts">
          ${r.ptOnly ? `<dt>지점 적합도</dt><dd>${x.meanIn === null ? "-" : `${fmt(x.meanIn)}%`} <span class="muted small">‘적합’ 기준 ${x.t}%</span></dd>`
            : `<dt>사업지 안 적합 서식지</dt><dd>${x.suitIn ? haText(x.suitIn) : "없음"}${sp.aqua ? ` <span class="muted small">${esc(H.aquaText(sp))} 면적</span>` : ""} <span class="muted small">평균 적합도 ${x.meanIn === null ? "-" : `${fmt(x.meanIn)}%`}, ‘적합’ 기준 ${x.t}%</span></dd>`}
          <dt>주변 ${fmt(r.km, 1)} km 적합 서식지</dt><dd>${x.ringSuit ? haText(x.ringSuit) : "없음"}</dd>
          <dt>가까운 출현 기록</dt><dd>${distText(x.recDist)}${x.nRec ? ` <span class="muted small">주변 ${fmt(r.km, 1)} km 안 ${fmt(x.nRec)}칸</span>` : ""}</dd>
          <dt>서식 환경</dt><dd>${H.tagList(sp.habitat) || "-"}</dd>
          ${se ? `<dt>민감 시기</dt><dd>${esc(se.text)}</dd>` : ""}
          <dt>계산 방식</dt><dd>${H.methodName(sp.model)}${sp.model && sp.model.auc ? ` (AUC ${sp.model.auc.toFixed(2)})` : ""}</dd>
        </dl>
      </div>
      <div class="im-cols">
        <div class="panel"><h3>맞춤 저감방안</h3>${Measures.html(measures, esc)}</div>
        <div class="panel"><h3>대체서식지 후보 <span class="muted small">사업지에서 ${fmt(r.alt)} km 안</span></h3>
          ${x.alt.length ? `<div class="table-wrap"><table class="table an-sum"><thead><tr><th>후보</th><th class="num">면적</th><th class="num">평균 적합도</th><th class="num">거리</th><th>주 토지피복</th><th>시군구</th></tr></thead>
            <tbody>${x.alt.map((p, i) => `<tr data-alt="${i}"><td>${i + 1}</td><td class="num">${haText(p.ha)}</td><td class="num">${fmt(p.mean)}%</td><td class="num">${distText(p.minD)}</td><td>${esc(p.cover)}</td><td>${esc(p.sgg)}</td></tr>`).join("")}</tbody></table></div>
            ${!r.ptOnly && x.suitIn ? `<p class="small muted">훼손되는 적합 서식지 ${haText(x.suitIn)} 이상을 확보할 수 있는 후보를 고르세요.</p>` : ""}
            <div class="row" style="margin-top:8px">
              <select id="im-crs" class="input" aria-label="좌표계">${Site.OUT_CRS.map((c) => `<option value="${c.id}" ${c.id === "5186" ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
              <button class="btn btn-light btn-sm" data-dl="shp">SHP(zip)</button><button class="btn btn-light btn-sm" data-dl="geojson">GeoJSON</button><button class="btn btn-light btn-sm" data-dl="kml">KML</button>
            </div>
            <p class="small muted" style="margin:6px 0 0">사업지, 후보지, 주변 범위 안 적합 서식지(‘적합’·‘매우 적합’)를 함께 담습니다.</p>`
            : `<p class="muted small">정한 거리 안에서 조건(‘적합’ 이상, 시가지 20% 미만)을 만족하는 곳을 찾지 못했습니다. 거리를 넓혀 다시 예측해 보세요.</p>`}
        </div>
      </div>`;
  };
  const select = async (i) => {
    I.sel = i;
    $$("#im-table tbody tr").forEach((tr) => tr.classList.toggle("sel", Number(tr.dataset.i) === i));
    const row = I.res.rows[i];
    await showSpeciesOnMap(row);
    renderDetail();
    $("#an-main").scrollTo({ top: 0, behavior: "smooth" });
  };

  // ---------- 내려받기 ----------
  const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "사업지";
  const csvCell = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const downloadCsv = () => {
    const r = I.res;
    const head = ["국명", "학명", "분류군", "구분", "천연기념물", "영향", r.ptOnly ? "지점_적합도(%)" : "사업지_적합서식지(ha)", "사업지_평균적합도(%)", `주변${r.km}km_적합서식지(ha)`,
      "가까운_기록(m)", "적합_기준(%)", "계산방식"];
    const rows = r.rows.map((x) => [x.sp.ko, x.sp.sci, H.GROUPS[x.sp.group], H.GRADE[x.sp.grade] || "", x.sp.nm || "", GRADE_NAME[x.grade],
      r.ptOnly ? (x.meanIn === null ? "" : Math.round(x.meanIn)) : x.suitIn.toFixed(2), x.meanIn === null ? "" : Math.round(x.meanIn), x.ringSuit.toFixed(2),
      x.recDist === null ? "" : Math.round(x.recDist), x.t, H.methodName(x.sp.model)]);
    const text = "﻿" + [head, ...rows].map((l) => l.map(csvCell).join(",")).join("\r\n");
    saveBlob(new Blob([text], { type: "text/csv;charset=utf-8" }), `${safeName(r.name)}_영향예측.csv`, "#impact");
  };
  // 주변 범위 안 ‘적합’·‘매우 적합’ 칸 → 등급별 면
  const suitPolys = (x) => {
    const r = I.res, { win, get, dist } = r, R = r.km * 1000;
    return [[3, "매우 적합"], [2, "적합"]].map(([k, name]) => {
      const geom = trace((q) => dist[q] <= R && H.classOf(get(x.sp.row, win.r0 + Math.floor(q / win.w), win.c0 + (q % win.w)), x.t) === k, win);
      return geom.length ? { type: "Feature", properties: { 종: x.sp.ko, 등급: name }, geometry: { type: "MultiPolygon", coordinates: geom } } : null;
    }).filter(Boolean);
  };
  const downloadAlt = async (kind) => {
    const r = I.res, x = r.rows[I.sel], base = `${safeName(r.name)}_${safeName(x.sp.ko)}`;
    const site = Site.get().features.map((f) => ({ type: "Feature", properties: { 이름: r.name }, geometry: f.geometry }));
    const alt = x.alt.map((p, i) => ({ type: "Feature", properties: { 후보: i + 1, 종: x.sp.ko, 면적_ha: Math.round(p.ha * 100) / 100, 적합도: Math.round(p.mean),
      거리_m: Math.round(p.minD), 토지피복: p.cover, 시군구: p.sgg }, geometry: { type: "MultiPolygon", coordinates: p.geom } }));
    const suit = suitPolys(x);
    if (kind === "geojson") {
      const fc = { type: "FeatureCollection", features: [...site.map((f) => ({ ...f, properties: { 구분: "사업지", ...f.properties } })),
        ...alt.map((f) => ({ ...f, properties: { 구분: "대체서식지 후보", ...f.properties } })), ...suit.map((f) => ({ ...f, properties: { 구분: "적합 서식지", ...f.properties } }))] };
      saveBlob(new Blob([JSON.stringify(fc)], { type: "application/geo+json" }), `${base}.geojson`, "#impact");
      return;
    }
    if (kind === "kml") {
      const fs = [...site.map((f) => ({ ...f, properties: { 이름: `사업지 ${r.name}` } })), ...alt.map((f) => ({ ...f, properties: { 이름: `대체서식지 후보 ${f.properties.후보}`, ...f.properties } })),
        ...suit.map((f) => ({ ...f, properties: { 이름: `${f.properties.등급} 서식지`, ...f.properties } }))];
      saveBlob(new Blob([ShpWrite.kml(fs, "이름")], { type: "application/vnd.google-earth.kml+xml" }), `${base}.kml`, "#impact");
      return;
    }
    await H.loadJSZip();
    const crs = Site.OUT_CRS.find((c) => c.id === $("#im-crs").value);
    const tr = crs.id === "4326" ? null : proj4("WGS84", crs.def);
    const conv = (fs) => (tr ? fs.map((f) => ({ ...f, geometry: { type: f.geometry.type, coordinates: mapC(f.geometry.coordinates, (c) => tr.forward(c)) } })) : fs);
    const zip = new JSZip();
    ShpWrite.addTo(zip, `${base}_사업지`, conv(site), [["이름", "NAME"]], crs.prj);
    if (alt.length) ShpWrite.addTo(zip, `${base}_대체서식지후보`, conv(alt), [["후보", "RANK", "N", 3, 0], ["종", "SPECIES"], ["면적_ha", "AREA_HA", "N", 12, 2], ["적합도", "SUIT", "N", 4, 0],
      ["거리_m", "DIST_M", "N", 8, 0], ["토지피복", "COVER"], ["시군구", "SIGUNGU"]], crs.prj);
    if (suit.length) ShpWrite.addTo(zip, `${base}_적합서식지`, conv(suit), [["종", "SPECIES"], ["등급", "CLASS"]], crs.prj);
    saveBlob(await zip.generateAsync({ type: "blob", compression: "DEFLATE" }), `${base}_shp.zip`, "#impact");
  };
  const mapC = (c, fn) => (typeof c[0] === "number" ? fn(c) : c.map((x) => mapC(x, fn)));

  // ---------- 화면 ----------
  const bindUI = () => {
    $("#an-chips").innerHTML = PRESETS.map((k) => `<button class="chip ${k === I.km ? "on" : ""}" data-km="${k}">${k} km</button>`).join("");
    $("#an-chips").addEventListener("click", (e) => {
      const c = e.target.closest("[data-km]");
      if (!c) return;
      I.km = Number(c.dataset.km);
      $$("#an-chips .chip").forEach((x) => x.classList.toggle("on", x === c));
    });
    $("#an-run").onclick = run;
    $("#an-result").addEventListener("click", async (e) => {
      const d = e.target.closest("[data-dl]");
      if (d) {
        try { if (d.dataset.dl === "csv") downloadCsv(); else await downloadAlt(d.dataset.dl); } catch (err) { console.warn(err); toast("파일을 만들지 못했습니다.", 4000); }
        return;
      }
      if (e.target.closest("[data-low]")) {
        I.showLow = !I.showLow;
        const sel = I.sel;
        renderResult();
        if (sel !== null && I.res.rows[sel]) { I.sel = sel; renderDetail(); $$("#im-table tbody tr").forEach((tr) => tr.classList.toggle("sel", Number(tr.dataset.i) === sel)); }
        return;
      }
      if (e.target.closest("[data-copy]")) {
        const x = I.res.rows[I.sel];
        const txt = `${x.sp.ko} 저감방안\n${Measures.text(Measures.list(x.sp, { lostHa: I.res.ptOnly ? 0 : Math.round(x.suitIn * 10) / 10 }))}`;
        try { await navigator.clipboard.writeText(txt); toast("저감방안을 복사했습니다."); } catch (_) { toast("복사하지 못했습니다.", 3000); }
        return;
      }
      const a = e.target.closest("tr[data-alt]");
      if (a) {
        const p = I.res.rows[I.sel].alt[Number(a.dataset.alt)];
        I.map.fitBounds(L.polygon(p.geom.map((poly) => poly.map((rg) => rg.map(([x, y]) => [y, x])))).getBounds(), { padding: [40, 40], maxZoom: 15 });
        $("#an-main").scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      const tr = e.target.closest("#im-table tbody tr[data-i]");
      if (tr) select(Number(tr.dataset.i));
    });
  };

  const show = () => {
    if (!I.inited) {
      I.inited = true;
      I.map = H.makeMap($("#an-map"), { minZoom: 6 });
      I.renderer = L.canvas({ padding: 0.3, tolerance: 3 });
      I.rangeLayer = L.featureGroup().addTo(I.map);
      I.altLayer = L.featureGroup().addTo(I.map);
      I.recLayer = L.featureGroup().addTo(I.map);
      Site.init(I.map, clearResult);
      bindUI();
    }
    setTimeout(() => I.map.invalidateSize(), 30);
  };
  window.Impact = { show };
})();
