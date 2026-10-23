// 멸종위기종 서식지 분석 — 공용 도구, 자료 불러오기, 적합성 지도 그리기, 종 정보 화면, 화면 전환
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n, d = 0) => Number(n || 0).toLocaleString("ko-KR", { maximumFractionDigits: d });
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  const ENDANGERED_SITE = "https://endangered.biogrideia.com/";

  const GROUPS = { mammal: "포유류", bird: "조류", herp: "양서·파충류", fish: "어류", insect: "곤충", invert: "무척추동물", plant: "육상식물", algae: "해조류", fungi: "고등균류" };
  const GRADE = { en1: "멸종위기 Ⅰ급", en2: "멸종위기 Ⅱ급" };
  const VARS = { elev: "고도", slope: "경사", tree: "산림", conifer: "침엽수림", grass: "초지", paddy: "논", field: "밭·과수", built: "시가지", road: "도로·철도", artbare: "나대지", bare: "자연 나지",
    rock: "암벽", wetland: "내륙습지", tidal: "갯벌", river: "하천", lake: "호소", dist_river: "하천까지 거리", dist_lake: "호소·습지까지 거리",
    dist_coast: "해안까지 거리", bio1: "연평균기온", bio4: "기온 계절성", bio12: "연강수량", bio15: "강수 계절성" };
  const AQUA = { river: "하천", lake: "호소", wetland: "습지", paddy: "논", tidal: "갯벌", sea: "바다" };
  const aquaText = (sp) => (sp.aqua ? sp.aqua.map((k) => AQUA[k]).join("·") : "");
  const STRESS = { 훼손: "서식지 훼손", 소음: "소음·진동", 수질: "탁수·수질 오염", 조명: "야간 조명", 로드킬: "로드킬", 단절: "서식지 단절",
    채집: "불법 채집·포획", 교란: "사람 출입·교란", 수위: "수위 변화", 벌채: "벌채" };
  // 적합성 등급 — 종마다 기준(0–100). MaxEnt는 학습 출현 칸 예측값의 분위수(가능 P10·적합 P20·매우 적합 P50), 서식 조건 지수는 50·70·85
  const CLASSES = [
    { k: 3, name: "매우 적합", color: [0, 104, 55] },
    { k: 2, name: "적합", color: [49, 163, 84] },
    { k: 1, name: "가능", color: [173, 221, 142] },
  ];
  const thrsOf = (sp) => {
    const m = sp.model || {}, t = m.threshold ?? 0.7;
    return { lo: Math.round((m.tLo ?? t * 0.7) * 100), t: Math.round(t * 100), hi: Math.round((m.tHi ?? Math.min(1, t * 1.2)) * 100) };
  };
  const thrOf = (sp) => thrsOf(sp).t;
  const classOf = (v, T) => (v > 100 ? 0 : v >= T.hi ? 3 : v >= T.t ? 2 : v >= T.lo ? 1 : 0);

  const S = { cat: [], byId: new Map(), grid: null, occ: null, ready: null };

  const toast = (msg, ms = 2600) => {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, ms);
  };

  // ---------- 파일 내려받기(보호구역 종합포털과 같은 방식) ----------
  // 컴퓨터는 바로 받고, 휴대폰은 화면 아래 ‘받기’ 버튼으로, 카카오톡 등 앱 안 브라우저는 크롬·사파리로 열게 함
  const IN_APP = /\bwv\b|KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|DaumApps|everytimeApp/i.test(navigator.userAgent);
  const KAKAO = /KAKAOTALK/i.test(navigator.userAgent);
  const MOBILE = IN_APP || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  const openOutside = (hash) => {
    const url = location.href.split("#")[0] + (hash || location.hash);
    if (KAKAO) location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
    else toast("오른쪽 위 메뉴에서 ‘다른 브라우저로 열기’를 눌러 크롬·사파리에서 열어 주세요.", 7000);
  };
  let sheetUrl = null;
  const closeSheet = () => {
    $("#dl-sheet").hidden = true;
    if (sheetUrl) { const u = sheetUrl; sheetUrl = null; setTimeout(() => URL.revokeObjectURL(u), 60000); }
  };
  const saveBlob = (blob, name, reopen) => {
    if (IN_APP) {
      closeSheet();
      $("#dl-sheet-name").textContent = name;
      $("#dl-sheet-save").hidden = true;
      $("#dl-sheet-share").hidden = true;
      $("#dl-sheet-note").hidden = false;
      const out = $("#dl-sheet-out");
      out.hidden = false;
      out.onclick = () => openOutside(reopen);
      $("#dl-sheet").hidden = false;
      return;
    }
    if (!MOBILE) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
      return;
    }
    closeSheet();
    sheetUrl = URL.createObjectURL(blob);
    const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    const kb = blob.size / 1024;
    $("#dl-sheet-name").textContent = `${name} (${kb >= 1024 ? `${fmt(kb / 1024, 1)} MB` : `${fmt(kb)} KB`})`;
    const link = $("#dl-sheet-save");
    link.href = sheetUrl;
    link.download = name;
    link.hidden = false;
    const share = $("#dl-sheet-share");
    share.hidden = !canShare;
    share.onclick = async () => {
      try { await navigator.share({ files: [file], title: name }); closeSheet(); } catch (err) { if (err.name !== "AbortError") toast("공유하지 못했습니다. ‘받기’를 눌러 보세요.", 4000); }
    };
    $("#dl-sheet-note").hidden = true;
    $("#dl-sheet-out").hidden = true;
    $("#dl-sheet").hidden = false;
  };

  const scripts = new Map();
  const loadScript = (url, global) => {
    if (global && window[global]) return Promise.resolve();
    if (!scripts.has(url)) scripts.set(url, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = resolve;
      s.onerror = () => { scripts.delete(url); s.remove(); reject(new Error("도구를 불러오지 못했습니다. 인터넷 연결을 확인하세요.")); };
      document.head.appendChild(s);
    }));
    return scripts.get(url);
  };
  const loadJSZip = () => loadScript(JSZIP_URL, "JSZip");

  // ---------- 자료 ----------
  const load = () => S.ready || (S.ready = (async () => {
    const [cat, grid] = await Promise.all(["data/catalog.json", "data/grid.json"].map((u) => fetch(u, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`${u} ${r.status}`);
      return r.json();
    })));
    S.at = cat.generatedAt;
    S.cat = cat.species;
    S.cat.forEach((s, i) => { s.row = grid.rows.indexOf(s.id); s.i = i; S.byId.set(s.id, s); });
    S.grid = grid;
    S.blockSet = new Set(grid.blocks);
    S.utmk = proj4("WGS84", grid.proj);
  })());
  // 출현 기록 칸(경위도 약 250 m) — 종 id → 칸 번호. 칸 격자 정보는 S.occGrid
  const loadOcc = () => S.occ || (S.occ = fetch("data/occ.json").then((r) => r.json()).then((d) => { S.occGrid = d.grid; return d.species; }));

  // 회색조 webp·png → 값 배열(빨강 채널). 색 관리·알파 곱하기를 끄고 읽어 값이 그대로 나오게 함
  const decodeGray = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    const blob = await res.blob();
    let src;
    try {
      src = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    } catch (_) {
      src = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("그림 자료를 읽지 못했습니다."));
        img.src = URL.createObjectURL(blob);
      });
    }
    const w = src.width, h = src.height;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    if (src.close) src.close();
    const d = ctx.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j];
    return { w, h, data: out };
  };
  // 종 전체 적합성 격자(최근 4종만 기억)
  const suitCache = new Map();
  const suitOf = (id) => {
    if (!suitCache.has(id)) {
      suitCache.set(id, decodeGray(`data/suit/${id}.webp`).catch((err) => { suitCache.delete(id); throw err; }));
      while (suitCache.size > 4) suitCache.delete(suitCache.keys().next().value);
    }
    return suitCache.get(id);
  };

  // ---------- 적합성 지도 층 ----------
  // 분석 격자(UTM-K 250 m) 값을 지도 타일마다 다시 투영해 그림. 타일을 8×8로 나눠 꼭짓점만 정확히 바꾸고 안은 보간
  // ---------- 10 m 토지피복(환경부 세분류를 묶음으로) ----------
  // data/lc10/<열>_<행>.webp: 분석 격자 80칸(20 km)마다 2000×2000 화소, 값 = 묶음 번호 + 1(0 = 분류 없음)
  const LC = { tiles: new Map() };
  const lcIndex = () => LC.idx || (LC.idx = fetch("data/lc10/index.json").then((r) => r.json()).then((d) => {
    LC.n = d.cells * S.grid.res / d.px; LC.px = d.px; LC.groups = d.groups; LC.set = new Set(d.tiles);
    return d;
  }).catch(() => null));
  const lcTile = (key) => {
    if (!LC.set || !LC.set.has(key)) return Promise.resolve(null);
    if (!LC.tiles.has(key)) {
      LC.tiles.set(key, decodeGray(`data/lc10/${key}.webp`).then((d) => d.data).catch(() => null));
      while (LC.tiles.size > 16) LC.tiles.delete(LC.tiles.keys().next().value);
    }
    return LC.tiles.get(key);
  };
  // 10 m 화소 (열, 행) 범위의 조각을 받아 (px, py) → 값(0–16) 읽는 함수로
  const lcReader = async (px0, py0, px1, py1) => {
    if (!(await lcIndex())) return null;
    const n = LC.n, got = new Map();
    const jobs = [];
    for (let ty = Math.floor(py0 / n); ty <= Math.floor(py1 / n); ty++) {
      for (let tx = Math.floor(px0 / n); tx <= Math.floor(px1 / n); tx++) {
        const key = `${tx}_${ty}`;
        jobs.push(lcTile(key).then((d) => { if (d) got.set(ty * 1000 + tx, d); }));
      }
    }
    await Promise.all(jobs);
    return (px, py) => {
      const d = got.get(Math.floor(py / n) * 1000 + Math.floor(px / n));
      return d ? d[(py % n) * n + (px % n)] : 0;
    };
  };
  // 종마다 10 m 화소가 서식지가 될 수 있는지(값 → 0/1). 서식지 층을 주면 그 층의 토지피복, 문헌 프로필 종은 대표 층들의 토지피복,
  // 물에 사는 종은 그 물, 그 밖은 시가지·도로·나대지 빼고
  const habLut = (sp, layer) => {
    const lut = new Uint8Array(256).fill(1);
    const groups = LC.groups || [];
    const allow = layer ? layer.groups : sp.hab;
    groups.forEach((g, i) => {
      if (sp.urban && !allow) return;
      const ok = allow ? allow.includes(g) : sp.aqua ? sp.aqua.includes(g) : !["built", "road", "artbare"].includes(g);
      lut[i + 1] = ok ? 1 : 0;
    });
    lut[0] = 1;   // 분류 없음(접경지역 등)은 칸 값 그대로
    return lut;
  };

  // ---------- 적합성 지도 층 ----------
  // 분석 격자(UTM-K 250 m) 값을 지도 타일마다 다시 투영해 그림. 타일을 8×8로 나눠 꼭짓점만 정확히 바꾸고 안은 보간
  // sp를 주면 확대(FINE_Z 이상)했을 때 10 m 토지피복으로 칸 안에서 서식지가 될 수 없는 곳(건물·도로, 물고기는 물 밖)을 지움
  const FINE_Z = 12;
  const SuitLayer = L.GridLayer.extend({
    // zIndex: 지도 바꾸기 단추가 바탕지도에 1·2·3을 매기므로 그보다 위에
    options: { tileSize: 256, opacity: 0.8, updateWhenZooming: false, maxNativeZoom: 19, zIndex: 10 },
    initialize(get, T, opts, sp, layer) {
      this.get = get;   // (행, 열) → 0–100, 범위 밖 255. T: 등급 기준 { lo, t, hi }
      this.sp = sp;
      this.layer = layer;
      this.lut = new Uint8ClampedArray(256 * 4);
      for (let v = 0; v <= 100; v++) {
        const c = CLASSES.find((x) => x.k === classOf(v, T));
        if (c) this.lut.set([...c.color, c.k === 1 ? 150 : 215], v * 4);
      }
      L.setOptions(this, opts);
    },
    createTile(coords, done) {
      const size = this.getTileSize();
      const tile = L.DomUtil.create("canvas", "leaflet-tile");
      tile.width = size.x; tile.height = size.y;
      const G = S.grid, N = 8, step = size.x / N, M = N + 1;
      const nw = coords.scaleBy(size);
      const cx = new Float64Array(M * M), cy = new Float64Array(M * M);
      for (let j = 0; j < M; j++) {
        for (let i = 0; i < M; i++) {
          const ll = this._map.unproject([nw.x + i * step, nw.y + j * step], coords.z);
          const p = S.utmk.forward([ll.lng, ll.lat]);
          cx[j * M + i] = (p[0] - G.x0) / G.res;
          cy[j * M + i] = (G.y1 - p[1]) / G.res;
        }
      }
      const draw = (lc, hab) => {
        const ctx = tile.getContext("2d");
        const img = ctx.createImageData(size.x, size.y);
        const px = img.data, lut = this.lut, get = this.get, f = lc ? G.res / LC.px : 0;
        let any = false;
        for (let y = 0; y < size.y; y++) {
          const fy = (y + 0.5) / step, j = Math.min(N - 1, fy | 0), v = fy - j;
          for (let x = 0; x < size.x; x++) {
            const fx = (x + 0.5) / step, i = Math.min(N - 1, fx | 0), u = fx - i;
            const k = j * M + i;
            const c = (1 - v) * ((1 - u) * cx[k] + u * cx[k + 1]) + v * ((1 - u) * cx[k + M] + u * cx[k + M + 1]);
            const r = (1 - v) * ((1 - u) * cy[k] + u * cy[k + 1]) + v * ((1 - u) * cy[k + M] + u * cy[k + M + 1]);
            const o = get(Math.floor(r), Math.floor(c)) * 4;
            if (!lut[o + 3]) continue;
            if (lc && !hab[lc(Math.floor(c * f), Math.floor(r * f))]) continue;
            const q = (y * size.x + x) * 4;
            px[q] = lut[o]; px[q + 1] = lut[o + 1]; px[q + 2] = lut[o + 2]; px[q + 3] = lut[o + 3];
            any = true;
          }
        }
        if (any) ctx.putImageData(img, 0, 0);
        done(null, tile);
      };
      if (!this.sp || coords.z < FINE_Z) { setTimeout(() => draw(null), 0); return tile; }
      const f = G.res / 10;
      const xs = Array.from(cx), ys = Array.from(cy);
      lcReader(Math.floor(Math.min(...xs) * f), Math.floor(Math.min(...ys) * f), Math.floor(Math.max(...xs) * f), Math.floor(Math.max(...ys) * f))
        .then((lc) => draw(lc, lc ? habLut(this.sp, this.layer) : null), () => draw(null));
      return tile;
    },
  });
  const rasterGet = (R) => (r, c) => (r >= 0 && r < R.h && c >= 0 && c < R.w ? R.data[r * R.w + c] : 255);
  const legendHtml = (sp, extra = "") => `<b>${esc(sp.ko)} 서식 가능성</b>${CLASSES.map((c) => `<div><i style="background:rgb(${c.color})"></i>${c.name}</div>`).join("")}${extra}`;

  // 출현 기록 칸 → 경위도 사각형, 칸 가운데 [경도, 위도]
  const occCellLatLngs = (cell) => {
    const g = S.occGrid, i = Math.floor(cell / g.w), j = cell % g.w;
    const la = g.lat0 + i * g.dlat, lo = g.lng0 + j * g.dlng;
    return [[la, lo], [la, lo + g.dlng], [la + g.dlat, lo + g.dlng], [la + g.dlat, lo]];
  };
  const occCenter = (cell) => {
    const g = S.occGrid;
    return [g.lng0 + ((cell % g.w) + 0.5) * g.dlng, g.lat0 + (Math.floor(cell / g.w) + 0.5) * g.dlat];
  };
  const REC_STYLE = { color: "#d6336c", weight: 1.5, fill: false, interactive: false };

  const baseLayers = () => {
    const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
    return {
      "밝은 지도": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: osmAttr, className: "tiles-muted" }),
      "일반 지도": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: osmAttr }),
      "위성 영상": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19, attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics" }),
    };
  };
  // 환경부 세분류 토지피복지도(환경공간정보서비스 지도 캐시). 적합도 층(zIndex 10) 아래, 바탕지도 위
  const LC_WMS = "https://api.mcee.go.kr/geoserver/gwc/service/wms";
  const LC_LEGEND = "https://api.mcee.go.kr/geoserver/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetLegendGraphic&FORMAT=image/png&LAYER=EGIS:lv3_2025y";
  const landcoverLayer = () => L.tileLayer.wms(LC_WMS, {
    layers: "EGIS:lv3_2025y", format: "image/png", transparent: true, version: "1.1.1", tiled: true, opacity: 0.6, zIndex: 5, maxZoom: 19,
    attribution: '토지피복: <a href="https://aid.mcee.go.kr" target="_blank" rel="noopener">기후에너지환경부 환경공간정보서비스</a>',
  });
  const makeMap = (el, opts = {}) => {
    const map = L.map(el, { zoomSnap: 0.5, minZoom: 6, maxZoom: 18, maxBounds: [[30.5, 121], [40.5, 134.5]], ...opts }).setView([36.1, 127.8], 7);
    const base = baseLayers();
    base["밝은 지도"].addTo(map);
    const overlays = { [`토지피복(환경부 세분류 2025) <a href="${LC_LEGEND}" target="_blank" rel="noopener">범례</a>`]: landcoverLayer() };
    L.control.layers(base, overlays, { position: "topright", autoZIndex: false }).addTo(map);
    L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);
    return map;
  };

  // ---------- 종 표시 도구 ----------
  const photoUrl = (code, size = "small") => {
    const m = /^([os])(\d+)\.(\w+)$/.exec(code || "");
    if (!m) return "";
    return `${m[1] === "o" ? "https://inaturalist-open-data.s3.amazonaws.com" : "https://static.inaturalist.org"}/photos/${m[2]}/${size}.${m[3]}`;
  };
  const badges = (sp) => [
    sp.grade ? `<span class="badge ${sp.grade}">${GRADE[sp.grade]}</span>` : "",
    sp.nm ? `<span class="badge nm">천연기념물 ${esc(sp.nm)}</span>` : "",
    `<span class="badge">${esc(GROUPS[sp.group] || sp.group)}</span>`,
    sp.absent ? `<span class="badge absent">남한 최근 기록 없음</span>` : "",
  ].join("");
  const shortBadge = (sp) => [sp.grade ? `<span class="badge ${sp.grade}">${sp.grade === "en1" ? "Ⅰ급" : "Ⅱ급"}</span>` : "", sp.nm ? `<span class="badge nm">천</span>` : ""].join(" ");
  const methodName = (m) => (m && m.method === "maxent" ? "MaxEnt 종분포모형" : m && m.method === "rule" ? "서식 조건 지수" : "자료 부족");
  const tagList = (list, cls = "") => `<span class="tags">${(list || []).map((t) => `<span class="tag ${cls}">${esc(t)}</span>`).join("")}</span>`;

  // ---------- 종 정보 화면 ----------
  const L1 = { q: "", group: "", kind: "", cur: null, map: null };
  const filtered = () => {
    const q = L1.q.toLowerCase();
    return S.cat.filter((s) => (!L1.group || s.group === L1.group)
      && (!L1.kind || (L1.kind === "nm" ? s.nm : s.grade === L1.kind))
      && (!q || s.ko.includes(L1.q) || s.sci.toLowerCase().includes(q)));
  };
  const renderList = () => {
    const list = filtered();
    $("#sp-count").textContent = `${fmt(list.length)}종`;
    $("#sp-list").innerHTML = list.map((s) => `<a class="sp-item ${L1.cur === s.id ? "on" : ""}" href="#species/${s.id}" data-id="${s.id}">
      ${s.photo ? `<img src="${photoUrl(s.photo, "square")}" alt="" loading="lazy">` : `<span class="noimg"></span>`}
      <span><b>${esc(s.ko)}</b> ${shortBadge(s)}<small>${esc(s.sci)}</small></span></a>`).join("");
  };
  const renderSpecies = async (id) => {
    const sp = S.byId.get(id);
    L1.cur = sp ? id : null;
    $$("#sp-list .sp-item").forEach((a) => a.classList.toggle("on", a.dataset.id === L1.cur));
    $("#view-species").classList.toggle("detail", !!sp);
    $("#sp-empty").hidden = !!sp;
    const box = $("#sp-detail");
    box.hidden = !sp;
    if (L1.map) { L1.map.remove(); L1.map = null; }
    if (!sp) return;
    const m = sp.model || {};
    const imp = Object.entries(m.importance || {}).slice(0, 6);
    const se = Measures.season(sp.season);
    box.innerHTML = `
      <button class="btn btn-light btn-sm sp-back" type="button" id="sp-back">← 종 목록</button>
      <div class="sp-head">
        <div>${sp.photo ? `<img class="sp-photo" src="${photoUrl(sp.photo, "medium")}" alt="${esc(sp.ko)} 사진"><div class="sp-photo-cap">${esc((sp.photoBy || "").trim())} · iNaturalist</div>` : `<div class="sp-photo"></div>`}</div>
        <div>
          <h1>${esc(sp.ko)}</h1>
          <div class="sp-sci">${esc(sp.sci)}${sp.family ? ` · ${esc(sp.family)}` : ""}</div>
          <div class="badges">${badges(sp)}</div>
          ${sp.remark ? `<p class="small">${esc(sp.remark)}</p>` : ""}
          <div class="sp-links">
            ${sp.grade ? `<a href="${ENDANGERED_SITE}" target="_blank" rel="noopener">멸종위기종 종합관리</a>` : ""}
            ${sp.gbif ? `<a href="https://www.gbif.org/species/${sp.gbif}" target="_blank" rel="noopener">GBIF</a>` : ""}
            ${sp.inat ? `<a href="https://www.inaturalist.org/taxa/${sp.inat}" target="_blank" rel="noopener">iNaturalist</a>` : ""}
          </div>
        </div>
      </div>
      <div class="sp-grid">
        <div>
          ${sp.layers ? `<div class="chips layer-chips" id="sp-layers"><button class="chip on" data-layer="">대표 서식지</button>${sp.layers.map((L) => `<button class="chip" data-layer="${esc(L.key)}">${esc(L.name)} <span class="muted">${esc(L.season || "")}</span></button>`).join("")}</div>` : ""}
          <div class="sp-map-wrap"><div class="sp-map" id="sp-map"></div>
            <div class="legend" id="sp-legend">${legendHtml(sp, `<div><i class="rec"></i>출현 기록(약 250 m 칸)</div>`)}</div>
            <label class="map-toggles"><span><input type="checkbox" id="sp-rec" checked> 출현 기록</span></label>
          </div>
          <p class="small muted">${m.method === "rule" ? "출현 기록이 적어 서식 환경 조건(서식지 유형·토지피복·지형)으로 계산한 참고 지수입니다." : m.method === "maxent" ? "출현 기록과 환경 변수로 계산한 서식 가능성입니다(250 m 격자)." : ""} 서식 가능성은 잠재적인 값이며 실제 서식 여부는 현지조사로 확인해야 합니다.</p>
        </div>
        <div>
          <div class="panel" style="margin-top:0">
            <h3>생태적 특징</h3>
            <dl class="facts">
              <dt>서식 환경</dt><dd>${tagList(sp.habitat) || "-"}</dd>
              ${se ? `<dt>민감 시기</dt><dd>${esc(se.text)}</dd>` : ""}
              ${sp.note ? `<dt>특징</dt><dd>${esc(sp.note)}</dd>` : ""}
              <dt>주요 위협</dt><dd>${tagList((sp.stress || []).map((k) => STRESS[k] || k), "warn")}</dd>
              ${sp.aqua && !sp.hab ? `<dt>서식 칸</dt><dd>${esc(aquaText(sp))}이 있는 칸만(면적은 칸 안의 물 면적)</dd>` : ""}
            </dl>
          </div>
          <div class="panel">
            <h3>서식지 적합성</h3>
            <dl class="facts">
              <dt>방식</dt><dd>${methodName(m)}</dd>
              <dt>출현 자료</dt><dd>${fmt(m.cells || 0)}칸(250 m)</dd>
              ${m.auc ? `<dt>예측력(AUC)</dt><dd>${m.auc.toFixed(2)} <span class="muted small">3겹 교차검증</span></dd>` : ""}
              ${m.noRecord ? `<dt>분포 기록</dt><dd>출현 칸·시군구 기록이 없어 ‘가능’까지만 표시</dd>` : ""}
              ${sp.road ? `<dt>도로 영향</dt><dd>도로 가까이 최대 ${Math.round(sp.road * 100)}% 낮춤</dd>` : ""}
              ${m.suitableKm2 !== undefined ? `<dt>적합 면적</dt><dd>${fmt(m.suitableKm2)} ㎢ <span class="muted small">‘적합’ 이상</span></dd>` : ""}
              ${(sp.layers || []).map((L) => `<dt>${esc(L.name)}</dt><dd>${fmt(L.suitableKm2)} ㎢ <span class="muted small">${esc(L.season || "")}</span></dd>`).join("")}
            </dl>
            ${imp.length ? `<h3 style="margin-top:14px">영향이 큰 환경 요인</h3><div class="bars">${imp.map(([k, v]) => `<div class="bar-row"><span>${esc(VARS[k] || k)}</span><span class="track"><i style="width:${Math.min(100, v)}%"></i></span><span class="v">${fmt(v)}%</span></div>`).join("")}</div>` : ""}
          </div>
        </div>
      </div>
      ${sp.profile ? `<div class="panel" id="sp-profile"><p class="muted small">문헌 정보를 불러오는 중…</p></div>` : ""}
      <div class="panel">
        <h3>저감방안</h3>
        ${Measures.html(Measures.list(sp), esc)}
        <p class="small muted" style="margin:10px 0 0">사업지에 맞춘 방안과 대체서식지 후보는 <a href="#impact">영향 예측</a>에서 볼 수 있습니다.</p>
      </div>`;
    $("#sp-back").onclick = () => { location.hash = "#species"; };
    $("#sp-main").scrollTop = 0;

    const map = L1.map = makeMap($("#sp-map"));
    const recLayer = L.featureGroup().addTo(map);
    $("#sp-rec").onchange = (e) => { if (e.target.checked) recLayer.addTo(map); else recLayer.remove(); };
    if (sp.profile) renderProfile(sp);
    let suit = null;
    const showLayer = async (key) => {
      const L = (sp.layers || []).find((x) => x.key === key) || null;
      const R = await suitOf(L ? `${sp.id}@${L.key}` : sp.id);
      if (L1.map !== map) return;
      if (suit) suit.remove();
      suit = new SuitLayer(rasterGet(R), thrsOf(sp), {}, sp, L).addTo(map);
      $("#sp-legend").innerHTML = legendHtml({ ko: L ? `${sp.ko} ${L.name}` : sp.ko }, `<div><i class="rec"></i>출현 기록(약 250 m 칸)</div>`);
    };
    if (sp.layers) {
      $("#sp-layers").addEventListener("click", (e) => {
        const b = e.target.closest("[data-layer]");
        if (!b) return;
        $$("#sp-layers .chip").forEach((x) => x.classList.toggle("on", x === b));
        showLayer(b.dataset.layer).catch((err) => { console.warn(err); toast("층 자료를 불러오지 못했습니다.", 4000); });
      });
    }
    try {
      const [, occ] = await Promise.all([showLayer(""), loadOcc()]);
      if (L1.map !== map) return;
      const canvas = L.canvas({ padding: 0.3 });
      (occ[sp.id] || []).forEach((cell) => L.polygon(occCellLatLngs(cell), { ...REC_STYLE, renderer: canvas }).addTo(recLayer));
    } catch (err) {
      console.warn(err);
      toast("서식지 적합성 자료를 불러오지 못했습니다.", 4000);
    }
  };

  // 문헌 기반 종 정보(data/profiles.json): 개요·분포·서식지·생활사·먹이·위협·보전, 서식지 층 설명, 참고문헌
  let profilesP = null;
  const renderProfile = async (sp) => {
    const box = $("#sp-profile");
    try {
      const all = await (profilesP || (profilesP = fetch("data/profiles.json").then((r) => r.json())));
      const P = all[sp.id];
      if (!P || !box || L1.cur !== sp.id) return;
      const cite = (ns) => (ns && ns.length ? ` <span class="cite">[${ns.join(", ")}]</span>` : "");
      const rows = [["개요", P.summary], ["국내 분포", P.distribution], ["서식지", P.habitat], ["생활사·번식", P.life], ["먹이", P.diet], ["위협 요인", P.threats], ["보전·관리", P.conservation]];
      box.innerHTML = `
        <h3>문헌 기반 종 정보</h3>
        <dl class="facts">${rows.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
        <h3 style="margin-top:16px">서식지 층(지도)</h3>
        <ul class="plain">${P.layers.map((L) => `<li><b>${esc(L.name)}</b> <span class="muted small">${esc(L.season || "")}</span> — ${esc(L.desc || "")}${cite(L.refs)}</li>`).join("")}
        ${P.range && P.range.note ? `<li><b>분포 범위</b> — ${esc(P.range.note)}</li>` : ""}</ul>
        <h3 style="margin-top:16px">참고문헌</h3>
        <ol class="refs">${P.refs.map((r) => `<li>${esc(r.text)}${r.url ? ` <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url.replace(/^https?:\/\/(dx\.)?doi\.org\//, "doi:"))}</a>` : ""}</li>`).join("")}</ol>
        <p class="small muted" style="margin:8px 0 0">문헌을 읽고 요약한 것입니다. 서식지 층의 수치(거리·고도 등)는 문헌 내용을 바탕으로 정한 값입니다.</p>`;
    } catch (err) {
      console.warn(err);
      if (box) box.innerHTML = `<p class="muted small">문헌 정보를 불러오지 못했습니다.</p>`;
    }
  };

  const bindSpecies = () => {
    $("#sp-group").innerHTML = `<option value="">모든 분류군</option>` + Object.entries(GROUPS)
      .filter(([k]) => S.cat.some((s) => s.group === k)).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
    $("#sp-q").addEventListener("input", debounce((e) => { L1.q = e.target.value.trim(); renderList(); }, 120));
    $("#sp-group").onchange = (e) => { L1.group = e.target.value; renderList(); };
    $("#sp-kind").onchange = (e) => { L1.kind = e.target.value; renderList(); };
    renderList();
  };

  // ---------- 자료·방법 ----------
  const renderAbout = () => {
    const n = S.cat.length, en = S.cat.filter((s) => s.grade).length, nm = S.cat.filter((s) => s.nm).length;
    const mx = S.cat.filter((s) => s.model && s.model.method === "maxent").length;
    $("#about").innerHTML = `
      <h1>자료·방법</h1>
      <p>멸종위기 야생생물 ${fmt(en)}종과 천연기념물(종 단위 지정) ${fmt(nm)}종, 모두 ${fmt(n)}종의 서식지 적합성을 남한 전역 250 m 격자로 계산했습니다. 자료 기준일 ${esc(S.at || "")}.</p>
      <h2>서식지 적합성</h2>
      <ul class="plain">
        <li><b>MaxEnt 종분포모형</b>(${fmt(mx)}종): 출현 기록이 15칸 이상인 종. 모든 대상 종의 출현 칸에서 배경을 뽑아(target-group background) 조사가 많이 된 곳에 치우치는 편향을 줄였습니다. 예측력은 3겹 교차검증 AUC입니다. 등급은 보수적으로 잡아, 출현 칸의 절반이 그 값 이상인 곳을 ‘매우 적합’, 80%가 그 값 이상인 곳을 ‘적합’, 90%인 곳을 ‘가능’으로 봅니다.</li>
        <li><b>서식 조건 지수</b>(${fmt(n - mx)}종): 기록이 적거나 바다에 사는 종. 서식지 유형별 토지피복·지형·물과의 거리로 계산한 참고값이며(통계 모형 아님), 0.85 이상 ‘매우 적합’, 0.7 이상 ‘적합’, 0.5 이상 ‘가능’입니다.</li>
        <li><b>알려진 분포 범위</b>: 출현 칸에서 조류 25 km·포유류 15 km·그 밖 5 km 안과 기록이 있는 시군구(위치를 흐린 기록 포함)는 그대로 두고, 그 밖은 같은 거리에 걸쳐 0까지 낮춥니다. 환경이 비슷해도 기록과 먼 곳은 적합으로 보지 않습니다. 칸·시군구 기록이 모두 없는 종은 ‘가능’까지만 표시합니다.</li>
        <li>환경 변수: 토지피복 비율 12종과 하천·호소까지 거리(환경부 세분류 토지피복지도 2025년, 1 m급 41개 분류를 묶음), 고도·경사(Copernicus DEM GLO-90), 해안까지 거리, 기후 4종(CHELSA V2.1 1981–2010).</li>
        <li><b>시가지·도로·나대지 제외</b>: 시가지(주거·상업·공업 등)·도로·철도·나대지(채광지·운동장·기타나지)는 서식지로 보지 않아, 칸의 적합도와 면적에서 그 비율만큼 뺍니다.</li>
        <li><b>도로 영향권</b>: 도로는 주변까지 소음·불빛·로드킬·단절로 서식지 질을 떨어뜨려, 국가교통정보센터 표준노드링크의 도로 등급별로 고속도로 500 m, 일반국도·광역시도 300 m, 지방도 200 m, 시군도 100~150 m 안은 도로에 가까울수록 적합도를 낮춥니다(농로·마을길은 제외). 최대 낮춤은 로드킬·소음·교란·단절에 민감한 포유류·조류·양서파충류 60%, 그 밖의 동물 30%, 육상식물 20%, 어류·물에 사는 무척추동물·수생식물 0%입니다.</li>
        <li><b>대도시·도심</b>: 주변 약 1 km와 약 5 km의 시가지·도로 비율로 도시 지수를 매겨, 15%를 넘으면 낮추기 시작해 45% 이상이면 모든 종의 적합도를 0으로 봅니다. 서울 같은 대도시 안 녹지·하천도 서식이 어렵다고 보는 보수적 기준입니다. <b>바다 종</b>은 실제 해안에서 1 km 안 칸만 봅니다.</li>
        <li><b>10 m 표현</b>: 적합도는 250 m 칸으로 계산하지만, 지도를 확대하거나 사업지 면적을 셀 때는 10 m 토지피복(환경부 세분류)으로 칸 안에서 서식지가 될 수 없는 곳(건물·도로·나대지, 물에 사는 종은 물 밖)을 뺍니다.</li>
        <li><b>물에 사는 종</b>(서식 유형이 하천·계곡·호소·습지·논습지·하구·갯벌·바다뿐인 어류·저서성 무척추동물·수서곤충·습지식물 등): 그 물이 있는 칸에서만 서식 가능으로 보고, 면적은 칸 안의 물 면적만 셉니다.</li>
        <li>출현 자료: GBIF 공개 기록과 iNaturalist 관찰(멸종위기종 종합관리 사이트와 같은 자료) 중 2000년 이후 기록만 씁니다. 위치 오차가 1 km를 넘거나 위치를 흐린 기록, 연도를 모르는 기록은 빼고, 기록마다의 좌표 대신 약 250 m 칸으로만 보여 줍니다.</li>
        <li><b>현재 토지이용과 맞지 않는 기록 제외</b>: 대도시 한가운데(도시 지수 45% 이상)와 동물원·사육 시설 주변 1.5 km 기록(방사·탈출·사육 개체)은 모든 종에서, 땅에 사는 종은 지금 시가지·도로·나대지가 80% 이상인 칸, 물에 사는 종은 주변 250 m에 그 물이 없는 칸, 바다 종은 실제 해안에서 2 km 넘게 떨어진 칸의 기록을 학습·분포 범위·영향 예측에서 뺍니다.</li>
      </ul>
      <h2>영향 예측</h2>
      <ul class="plain">
        <li>사업지 안 ‘적합’ 이상 서식지 면적, 주변 범위 안 적합 서식지, 가장 가까운 출현 기록을 종마다 계산해 영향 정도(높음·보통·낮음)를 매깁니다.</li>
        <li><b>높음</b>: 사업지 안에 적합 서식지가 있고 주변 범위 안에 출현 기록이 있음. <b>보통</b>: 사업지 안에 적합 서식지가 있음(기록 없음), 또는 주변 범위 안에 적합 서식지와 기록이 함께 있음. <b>낮음</b>: 주변 범위 안에만 적합 서식지가 있거나 기록만 있음. 서식 조건 지수로 계산한 종은 기록이 없으면 ‘낮음’까지만 매깁니다.</li>
        <li>대체서식지 후보: 사업지 밖, 정한 거리 안에서 그 종의 ‘적합’ 이상이고 시가지가 20% 미만인 칸을 이어 묶은 곳입니다. 적합도·면적·거리로 순위를 매깁니다.</li>
        <li>저감방안은 종의 위협 요인과 민감 시기에 맞춘 일반 방안입니다.</li>
      </ul>
      <h2>한계</h2>
      <p>출현 기록은 공개된 것만 썼고, 위치를 흐린 기록이나 비공개 조사 자료는 빠져 있습니다. 결과는 현지조사를 대신하지 않으며, 계획 초기 검토와 조사 지점 선정에 참고하세요.</p>
      <h2>출처</h2>
      <ul class="plain small">
        <li>GBIF.org, iNaturalist — 출현 기록</li>
        <li>국가유산청 국가유산 검색 오픈API — 천연기념물 목록</li>
        <li>기후에너지환경부 환경공간정보서비스 — 세분류 토지피복지도 2025년(토지피복지도 맵 서비스)</li>
        <li>Karger et al. CHELSA V2.1 · Copernicus DEM GLO-90 (© DLR, © Airbus)</li>
        <li>국토교통부 브이월드 — 시군구 경계</li>
        <li>생태적 특징 요약: 국립생물자원관 한반도의 생물다양성, 국립생태원 멸종위기 야생생물 정보 등 공개 자료</li>
      </ul>`;
  };

  // ---------- 화면 전환 ----------
  const show = async () => {
    const [name, arg] = (location.hash.slice(1) || "species").split("/");
    const view = ["species", "impact", "about"].includes(name) ? name : "species";
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    try { await load(); } catch (err) { console.warn(err); toast("자료를 불러오지 못했습니다. 새로 고침해 보세요.", 6000); return; }
    if (!show.bound) { show.bound = true; bindSpecies(); }
    if (view === "species") renderSpecies(decodeURIComponent(arg || ""));
    if (view === "impact") window.Impact.show();
    if (view === "about") renderAbout();
  };
  window.addEventListener("hashchange", show);

  $("#dl-sheet-close").onclick = closeSheet;
  $("#dl-sheet-save").addEventListener("click", () => setTimeout(closeSheet, 1500));
  if (IN_APP) {
    $("#inapp-bar").hidden = false;
    $("#inapp-open").textContent = KAKAO ? "크롬·사파리로 열기" : "여는 방법";
    $("#inapp-open").onclick = () => openOutside();
    $("#inapp-close").onclick = () => { $("#inapp-bar").hidden = true; };
  }

  window.H = { S, $, $$, esc, fmt, debounce, toast, saveBlob, loadScript, loadJSZip, decodeGray, makeMap, SuitLayer, legendHtml, classOf, thrOf, thrsOf, CLASSES, lcIndex, lcReader, habLut, LC,
    occCellLatLngs, occCenter, loadOcc, aquaText, REC_STYLE, GROUPS, GRADE, STRESS, VARS, badges, shortBadge, methodName, tagList, photoUrl };
  setTimeout(show, 0);
})();
