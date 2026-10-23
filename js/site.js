// 사업지 정하기 — 주소·좌표·지도 그리기·파일(SHP·GeoJSON·KML·DXF)로 사업지를 정함(보호구역 종합포털 사업지 분석과 같은 입력)
window.Site = (() => {
  const { $, $$, esc, fmt, toast } = window.H;
  const LIB = { shp: "https://cdn.jsdelivr.net/npm/shpjs@4.0.4/dist/shp.min.js" };
  const RAD = Math.PI / 180;
  const inKorea = ([x, y]) => x > 123 && x < 133 && y > 32 && y < 40;

  // ---------- 좌표계 ----------
  const BESSEL = "+ellps=bessel +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43";
  const tm = (lon0, y0, datum = "+ellps=GRS80") => `+proj=tmerc +lat_0=38 +lon_0=${lon0} +k=1 +x_0=200000 +y_0=${y0} ${datum} +units=m +no_defs`;
  const CRS = [
    { id: "4326", name: "WGS84 경위도 (위도, 경도)" },
    { id: "5186", name: "EPSG:5186 중부원점 (GRS80)", def: tm(127, 600000) },
    { id: "5185", name: "EPSG:5185 서부원점 (GRS80)", def: tm(125, 600000) },
    { id: "5187", name: "EPSG:5187 동부원점 (GRS80)", def: tm(129, 600000) },
    { id: "5188", name: "EPSG:5188 동해원점 (GRS80)", def: tm(131, 600000) },
    { id: "5179", name: "EPSG:5179 UTM-K (GRS80)", def: "+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs" },
    { id: "5181", name: "EPSG:5181 중부원점 (GRS80, Y 500000)", def: tm(127, 500000) },
    { id: "5174", name: "EPSG:5174 보정 중부원점 (Bessel, 옛 지적)", def: tm(127.0028902777778, 500000, BESSEL) },
    { id: "2097", name: "EPSG:2097 중부원점 (Bessel)", def: tm(127, 500000, BESSEL) },
    { id: "32652", name: "EPSG:32652 UTM 52N (WGS84)", def: "+proj=utm +zone=52 +datum=WGS84 +units=m +no_defs" },
  ];
  const crsDef = (id) => (CRS.find((c) => c.id === id) || {}).def;
  const GCS_KOREA = 'GEOGCS["GCS_Korea_2000",DATUM["D_Korea_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
  const prjTM = (name, lon0, k, x0, y0) => `PROJCS["${name}",${GCS_KOREA},PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",${x0}],` +
    `PARAMETER["False_Northing",${y0}],PARAMETER["Central_Meridian",${lon0}],PARAMETER["Scale_Factor",${k}],PARAMETER["Latitude_Of_Origin",38.0],UNIT["Meter",1.0]]`;
  const OUT_CRS = [
    { id: "4326", name: "WGS84 경위도 (EPSG:4326)" },
    { id: "5186", name: "EPSG:5186 중부원점", prj: prjTM("Korea_2000_Korea_Central_Belt_2010", "127.0", "1.0", "200000.0", "600000.0") },
    { id: "5179", name: "EPSG:5179 UTM-K", prj: prjTM("Korea_2000_Korea_Unified_Coordinate_System", "127.5", "0.9996", "1000000.0", "2000000.0") },
    { id: "5185", name: "EPSG:5185 서부원점", prj: prjTM("Korea_2000_Korea_West_Belt_2010", "125.0", "1.0", "200000.0", "600000.0") },
    { id: "5187", name: "EPSG:5187 동부원점", prj: prjTM("Korea_2000_Korea_East_Belt_2010", "129.0", "1.0", "200000.0", "600000.0") },
    { id: "5188", name: "EPSG:5188 동해원점", prj: prjTM("Korea_2000_Korea_East_Sea_Belt_2010", "131.0", "1.0", "200000.0", "600000.0") },
  ];
  OUT_CRS.forEach((c) => { if (c.id !== "4326") c.def = crsDef(c.id); });

  // .prj(WKT)에서 proj4 정의 만들기. 횡메르카토르는 직접 풀어 Bessel(옛 한국 측지계)이면 좌표 이동값을 붙임
  // (.prj에는 이동값이 없어 그대로 쓰면 수백 m 어긋남)
  const fromPrj = (wkt) => {
    if (!wkt || !wkt.trim()) return null;
    const sph = /SPHEROID\s*\[\s*"[^"]*"\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(wkt);
    const a = sph ? parseFloat(sph[1]) : 6378137;
    const rf = sph ? parseFloat(sph[2]) : 298.257222101;
    const bessel = Math.abs(a - 6377397.155) < 1;
    const datum = bessel ? BESSEL : `+a=${a} +rf=${rf}`;
    if (!/PROJCS/i.test(wkt)) return bessel ? `+proj=longlat ${BESSEL} +no_defs` : "geo";
    if (!/Transverse_Mercator/i.test(wkt)) return wkt;   // 그 밖의 투영은 proj4가 WKT를 직접 읽게 함
    const p = (name, d) => {
      const m = new RegExp(`PARAMETER\\s*\\[\\s*"${name}"\\s*,\\s*(-?[\\d.eE+-]+)`, "i").exec(wkt);
      return m ? parseFloat(m[1]) : d;
    };
    return `+proj=tmerc +lat_0=${p("Latitude_Of_Origin", 0)} +lon_0=${p("Central_Meridian", 0)} +k=${p("Scale_Factor", 1)} ` +
      `+x_0=${p("False_Easting", 0)} +y_0=${p("False_Northing", 0)} ${datum} +units=m +no_defs`;
  };

  // ---------- 도형 도구 ----------
  // 위도 φ(라디안)에서 경도·위도 1도의 길이(m) — 타원체 기준 급수
  const KX = (φ) => 111412.84 * Math.cos(φ) - 93.5 * Math.cos(3 * φ) + 0.118 * Math.cos(5 * φ);
  const KY = (φ) => 111132.92 - 559.82 * Math.cos(2 * φ) + 1.175 * Math.cos(4 * φ) - 0.0023 * Math.cos(6 * φ);
  // 사업지 중심 기준 국지 평면(m). 반경 20 km 안에서는 오차가 아주 작음
  const projAt = (lng0, lat0) => ({ lng0, lat0, kx: KX(lat0 * RAD), ky: KY(lat0 * RAD) });
  const unproj = (x, y, o) => [x / o.kx + o.lng0, y / o.ky + o.lat0];
  // 두 경위도 점 사이 거리(m) — 중간 위도의 1도 길이로 계산(수십 km 안에서 cm 수준)
  const geoDist = (a, b) => {
    const φ = ((a[1] + b[1]) / 2) * RAD;
    return Math.hypot((b[0] - a[0]) * KX(φ), (b[1] - a[1]) * KY(φ));
  };
  const feat = (geometry, properties = {}) => ({ type: "Feature", properties, geometry });
  const mapCoords = (c, fn) => (typeof c[0] === "number" ? fn(c) : c.map((x) => mapCoords(x, fn)));
  const mapGeom = (g, fn) => ({ type: g.type, coordinates: mapCoords(g.coordinates, fn) });
  const kindOf = (g) => (/Point/.test(g.type) ? "point" : /LineString/.test(g.type) ? "line" : "polygon");
  const eachXY = (c, fn) => { if (typeof c[0] === "number") fn(c); else c.forEach((x) => eachXY(x, fn)); };
  const bboxOf = (features) => {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    features.forEach((f) => eachXY(f.geometry.coordinates, ([x, y]) => {
      if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
    }));
    return b;
  };
  // 면 넓이(㎡) — 국지 평면은 경위도에 대한 일차 변환이라 경위도 넓이 × kx × ky
  const polyArea = (g, o) => {
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    let s = 0;
    polys.forEach((p) => p.forEach((r, k) => {
      let a = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
      s += (k ? -1 : 1) * Math.abs(a / 2);
    }));
    return s * o.kx * o.ky;
  };
  const lineLen = (g) => {
    const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    let s = 0;
    lines.forEach((l) => { for (let i = 1; i < l.length; i++) s += geoDist(l[i - 1], l[i]); });
    return s;
  };

  // 사업지 도형 다듬기: 높이(Z) 버림, 잘못된 좌표 버림, 면 고리 닫기, 묶음(GeometryCollection) 풀기
  const normalize = (features) => {
    const out = [];
    const ok = (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]);
    const pts = (cs) => (cs || []).filter(ok).map((c) => [c[0], c[1]]);
    const ring = (cs) => {
      const r = pts(cs);
      if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0].slice());
      return r.length >= 4 ? r : null;
    };
    const poly = (p) => { const rs = (p || []).map(ring); return rs[0] ? rs.filter(Boolean) : null; };
    const add = (g, props) => {
      if (!g) return;
      const c = g.coordinates;
      if (g.type === "GeometryCollection") return g.geometries.forEach((x) => add(x, props));
      if (g.type === "Point" && ok(c)) out.push(feat({ type: "Point", coordinates: [c[0], c[1]] }, props));
      if (g.type === "MultiPoint") pts(c).forEach((p) => out.push(feat({ type: "Point", coordinates: p }, props)));
      if (g.type === "LineString") { const l = pts(c); if (l.length >= 2) out.push(feat({ type: "LineString", coordinates: l }, props)); }
      if (g.type === "MultiLineString") { const ls = c.map(pts).filter((l) => l.length >= 2); if (ls.length) out.push(feat({ type: "MultiLineString", coordinates: ls }, props)); }
      if (g.type === "Polygon") { const p = poly(c); if (p) out.push(feat({ type: "Polygon", coordinates: p }, props)); }
      if (g.type === "MultiPolygon") { const ps = c.map(poly).filter(Boolean); if (ps.length) out.push(feat({ type: "MultiPolygon", coordinates: ps }, props)); }
    };
    features.forEach((f) => add(f.geometry, f.properties || {}));
    return out;
  };

  // ---------- 상태·지도 ----------
  const A = { map: null, renderer: null, site: null, raw: null, onChange: () => {} };
  const SITE_STYLE = { color: "#111", weight: 3, opacity: 1, fillColor: "#ffd43b", fillOpacity: 0.3 };
  const drawSite = () => {
    A.siteLayer.clearLayers();
    if (!A.site) return;
    const g = L.geoJSON({ type: "FeatureCollection", features: A.site.features }, {
      renderer: A.renderer, interactive: false, style: () => SITE_STYLE,
      pointToLayer: (f, ll) => L.circleMarker(ll, { renderer: A.renderer, interactive: false, radius: 7, color: "#111", weight: 2, fillColor: "#ffd43b", fillOpacity: 1 }),
    });
    A.siteLayer.addLayer(g);
    A.siteLayer.bringToFront();
    const b = g.getBounds();
    if (b.isValid()) {
      if (b.getNorthEast().equals(b.getSouthWest())) A.map.setView(b.getCenter(), Math.max(A.map.getZoom(), 14));
      else A.map.fitBounds(b, { padding: [30, 30], maxZoom: 16 });
    }
  };

  // ---------- 사업지 정하기 ----------
  // raw: 파일에서 읽은 원래 도형(좌표계·DXF 레이어를 바꿀 때 다시 씀)
  const setSite = (features, label, raw = null) => {
    features = normalize(features);
    if (!features.length) { toast("사업지로 쓸 점·선·면을 찾지 못했습니다.", 4000); return false; }
    A.site = { features, label };
    A.raw = raw;
    A.onChange();
    drawSite();
    renderSite();
    const b = bboxOf(features);
    if (!inKorea([b[0], b[1]]) || !inKorea([b[2], b[3]])) toast("사업지가 한반도 밖에 있습니다. 좌표나 좌표계를 확인하세요.", 6000);
    return true;
  };
  const renderSite = () => {
    const box = $("#an-site");
    if (!A.site) { box.hidden = true; box.innerHTML = ""; return; }
    const fs = A.site.features;
    const b = bboxOf(fs);
    const o = projAt((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
    const n = { point: 0, line: 0, polygon: 0 };
    let ha = 0, km = 0;
    fs.forEach((f) => {
      const k = kindOf(f.geometry);
      n[k]++;
      if (k === "polygon") ha += polyArea(f.geometry, o) / 1e4;
      if (k === "line") km += lineLen(f.geometry) / 1000;
    });
    const parts = [];
    if (n.polygon) parts.push(`면 ${fmt(n.polygon)}개 · ${fmt(ha, 2)} ha`);
    if (n.line) parts.push(`선 ${fmt(n.line)}개 · ${fmt(km, 3)} km`);
    if (n.point) parts.push(`점 ${fmt(n.point)}개`);
    const dxf = A.raw && A.raw.dxf && A.raw.dxf.layers.size > 1 ? A.raw.dxf : null;
    box.hidden = false;
    box.innerHTML = `
      <div class="an-site-head"><b>정한 사업지</b><button class="link" id="an-site-clear">지우기</button></div>
      <div>${esc(parts.join(" / "))}</div>
      <div class="muted small">중심 ${((b[1] + b[3]) / 2).toFixed(5)}, ${((b[0] + b[2]) / 2).toFixed(5)} · ${esc(A.site.label)}</div>
      ${dxf ? `<label class="small">DXF 레이어 <select id="an-dxf-layer" class="input">
        <option value="*" ${dxf.pick === "*" ? "selected" : ""}>모든 레이어</option>
        ${[...dxf.layers].map(([name, v]) => `<option value="${esc(name)}" ${dxf.pick === name ? "selected" : ""}>${esc(name)} (면 ${v.polygons.length} · 선 ${v.lines.length})</option>`).join("")}
      </select></label>` : ""}
      ${A.site.swap ? `<div class="small">TM 좌표를 ${A.site.swap === "en" ? "X=동쪽, Y=북쪽" : "X=북쪽, Y=동쪽"}으로 읽었습니다. 위치가 틀리면 <button class="link" id="an-swap">X·Y 바꿔 읽기</button></div>` : ""}`;
    const swap = $("#an-swap");
    if (swap) swap.onclick = () => { $("#an-order").value = A.site.swap === "en" ? "ne" : "en"; useCoords(); };
    $("#an-site-clear").onclick = () => { A.site = null; A.raw = null; drawSite(); renderSite(); A.onChange(); };
    const sel = $("#an-dxf-layer");
    if (sel) sel.onchange = () => { A.raw.dxf.pick = sel.value; buildFromRaw(); };
  };

  // 주소·장소 찾기 — 국토교통부 브이월드 검색(도로명·지번·장소)을 먼저 쓰고, 못 찾으면 오픈스트리트맵 Nominatim
  // 브이월드 인증키는 배포할 때 저장소 비밀값(VWORLD_KEY)에서 js/config.js로 넣음. 버튼을 누를 때만 보냄
  const VW_KEY = (window.PORTAL_CONFIG || {}).vworldKey || "";
  const VW_DOMAIN = "https://habitat.biogrideia.com";   // 인증키에 등록한 서비스 주소
  // 브이월드는 CORS를 열어 두지 않아 JSONP(callback)로 받음
  let jsonpSeq = 0;
  const jsonp = (url, ms = 8000) => new Promise((resolve, reject) => {
    const cb = `__vw${++jsonpSeq}_${Date.now().toString(36)}`;
    const s = document.createElement("script");
    const t = setTimeout(() => done(new Error("검색 서버가 응답하지 않습니다.")), ms);
    function done(err, data) {
      clearTimeout(t);
      window[cb] = () => {};   // 늦게 온 응답은 버림
      s.remove();
      if (err) reject(err); else resolve(data);
    }
    window[cb] = (data) => done(null, data);
    s.onerror = () => done(new Error("검색 서버에 연결하지 못했습니다."));
    s.src = `${url}&callback=${cb}`;
    document.head.appendChild(s);
  });
  const vworld = async (q, type, category) => {
    const p = new URLSearchParams({ service: "search", request: "search", version: "2.0", crs: "EPSG:4326", size: "10", page: "1",
      query: q, type, format: "json", errorformat: "json", key: VW_KEY, domain: VW_DOMAIN });
    if (category) p.set("category", category);
    const d = (await jsonp(`https://api.vworld.kr/req/search?${p}`)).response || {};
    if (d.status === "ERROR") throw new Error((d.error && d.error.text) || "브이월드 검색 오류");
    return ((d.result && d.result.items) || []).map((it) => {
      const a = it.address || {};
      if (type === "place") return { name: it.title || "", sub: a.road || a.parcel || "", lon: +it.point.x, lat: +it.point.y, kind: "장소" };
      if (category === "road") return { name: a.road || "", sub: a.parcel ? `지번 ${a.parcel}` : "", lon: +it.point.x, lat: +it.point.y, kind: "도로명" };
      return { name: a.parcel || "", sub: a.road ? `도로명 ${a.road}` : "", lon: +it.point.x, lat: +it.point.y, kind: "지번" };
    });
  };
  const nominatim = async (q) => {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=kr&accept-language=ko&limit=8&q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(res.status);
    // 도로명 주소를 찾으면 그 도로가 아닌 엉뚱한 곳을 돌려줄 때가 많아 걸러 냄
    const road = (/([가-힣A-Za-z0-9]+(?:로|길))\s*\d+(?:-\d+)?\s*$/.exec(q) || [])[1];
    return (await res.json()).filter((x) => !road || x.display_name.replace(/\s/g, "").includes(road))
      .map((x) => ({ name: x.name || x.display_name.split(",")[0], sub: x.display_name, lon: +x.lon, lat: +x.lat, kind: "OSM" }));
  };
  let addrList = [];
  const searchAddr = async (q) => {
    const box = $("#an-addr-res");
    box.hidden = false;
    box.innerHTML = `<p class="muted small pad">찾는 중…</p>`;
    q = q.replace(/(로|길)(\d+(?:-\d+)?)\s*$/, "$1 $2");   // ‘남부10길3’ → ‘남부10길 3’
    let list = [], failed = false;
    if (VW_KEY) {
      try {
        const [road, parcel] = await Promise.all([vworld(q, "address", "road"), vworld(q, "address", "parcel")]);
        list = [...road, ...parcel];
        if (list.length < 3) list.push(...(await vworld(q, "place")));
      } catch (err) {
        console.warn(err);
        failed = true;
      }
    }
    if (!list.length) {
      try { list = await nominatim(q); failed = false; } catch (err) { console.warn(err); failed = true; }
    }
    const seen = new Set();
    addrList = list.filter((x) => x.name && Number.isFinite(x.lon) && Number.isFinite(x.lat)).filter((x) => {
      const k = `${x.name}|${x.sub}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 12);
    box.innerHTML = addrList.length ? addrList.map((x, i) => `<button data-i="${i}">${esc(x.name)} <span class="kind">${esc(x.kind)}</span>${x.sub ? `<small>${esc(x.sub)}</small>` : ""}</button>`).join("")
      : `<p class="muted small pad">${failed ? "주소 검색 서버에 연결하지 못했습니다. 잠시 뒤 다시 하거나 ‘지도에 그리기’에서 점을 찍으세요."
        : "찾지 못했습니다. 시·군 이름을 붙이거나(예: 양산시 남부10길 3) 지번 주소·장소 이름으로 다시 찾거나, ‘지도에 그리기’에서 점을 찍으세요."}</p>`;
  };

  // 좌표 글 읽기 — 한 줄에 한 점. 숫자 둘(또는 번호 + 둘), 한 줄에 여러 쌍도 됨. 도·분·초는 십진수로 바꿈
  const DMS = /(\d+(?:\.\d+)?)\s*[°˚도]\s*(?:(\d+(?:\.\d+)?)\s*['′’분])?\s*(?:(\d+(?:\.\d+)?)\s*(?:["″”초]|''))?\s*([NSEWnsew북남동서])?/g;
  const parseCoordText = (text) => {
    const rows = [];
    text.split(/\r?\n/).forEach((line) => {
      const s = line.replace(DMS, (_, d, m, sec, h) => {
        let v = +d + (+m || 0) / 60 + (+sec || 0) / 3600;
        if (h && /[SWsw남서]/.test(h)) v = -v;
        return ` ${v} `;
      });
      const nums = (s.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      if (nums.length < 2) return;
      if (nums.length % 2) nums.shift();   // 앞의 점 번호
      for (let i = 0; i < nums.length; i += 2) rows.push([nums[i], nums[i + 1]]);
    });
    return rows;
  };
  const shapeOf = (pts, want) => {
    const kind = want !== "auto" ? want : pts.length === 1 ? "point" : pts.length === 2 ? "line" : "polygon";
    if (kind === "point") return pts.map((p) => feat({ type: "Point", coordinates: p }));
    if (kind === "line") return pts.length >= 2 ? [feat({ type: "LineString", coordinates: pts })] : [];
    return pts.length >= 3 ? [feat({ type: "Polygon", coordinates: [[...pts, pts[0]]] })] : [];
  };
  const useCoords = async () => {
    const rows = parseCoordText($("#an-coord").value);
    if (!rows.length) { toast("좌표를 읽지 못했습니다. 한 줄에 ‘위도, 경도’ 또는 ‘X, Y’로 적어 주세요.", 4500); return; }
    const crs = $("#an-crs").value;
    const want = $("#an-shape").value;
    let pts, used = "";
    if (crs === "4326") {
      pts = rows.map(([a, b]) => (a >= 32 && a <= 40 && b >= 123 && b <= 133 ? [b, a] : b >= 32 && b <= 40 && a >= 123 && a <= 133 ? [a, b] : null));
      if (pts.some((p) => !p)) { toast("한반도 범위의 위도·경도가 아닙니다. TM 좌표라면 좌표계를 바꿔 주세요.", 5000); return; }
    } else {
      const tr = proj4(crsDef(crs), "WGS84");
      const en = rows.map(([a, b]) => tr.forward([a, b]));
      const ne = rows.map(([a, b]) => tr.forward([b, a]));
      const order = $("#an-order").value;
      const okEn = en.every(inKorea), okNe = ne.every(inKorea);
      if (order === "en" || order === "ne") used = order;
      else if (okEn) { used = "en"; if (okNe) toast("X·Y 순서가 애매해 X=동쪽으로 읽었습니다. 위치가 틀리면 ‘X·Y 바꿔 읽기’를 누르세요.", 6000); }
      else if (okNe) { used = "ne"; toast("X=북쪽(측량 성과표 순서)으로 읽었습니다.", 3500); }
      else used = "en";
      pts = used === "ne" ? ne : en;
    }
    const orderName = { en: "X=동쪽", ne: "X=북쪽" }[used];
    if (setSite(shapeOf(pts, want), `좌표 ${rows.length}개 (${CRS.find((c) => c.id === crs).name}${orderName ? `, ${orderName}` : ""})`) && used) {
      A.site.swap = used;
      renderSite();
    }
  };

  // ---------- 그리기 ----------
  const D = { mode: null, pts: [] };
  const drawMsg = () => {
    const need = D.mode === "polygon" ? 3 : 2;
    $("#an-draw-msg").textContent = `${D.mode === "polygon" ? "구역" : "선"} 꼭짓점 ${D.pts.length}개${D.pts.length < need ? ` — ${need}개 이상 찍으세요` : ""}`;
  };
  const redrawTmp = () => {
    A.drawLayer.clearLayers();
    const ll = D.pts.map(([x, y]) => [y, x]);
    if (ll.length >= 2) L.polyline(ll, { renderer: A.renderer, interactive: false, color: "#e8590c", weight: 2.5 }).addTo(A.drawLayer);
    if (D.mode === "polygon" && ll.length >= 3) L.polyline([ll[ll.length - 1], ll[0]], { renderer: A.renderer, interactive: false, color: "#e8590c", weight: 1.5, dashArray: "5 5" }).addTo(A.drawLayer);
    ll.forEach((p) => L.circleMarker(p, { renderer: A.renderer, interactive: false, radius: 4, color: "#e8590c", weight: 2, fillColor: "#fff", fillOpacity: 1 }).addTo(A.drawLayer));
    A.drawLayer.bringToFront();
    drawMsg();
  };
  const startDraw = (mode) => {
    stopDraw();
    D.mode = mode;
    A.map.doubleClickZoom.disable();
    $("#an-map").classList.add("drawing");
    $$("[data-draw]").forEach((b) => b.classList.toggle("on", b.dataset.draw === mode));
    $("#an-draw-bar").hidden = mode === "point";
    if (mode === "point") toast("지도에서 사업지 위치를 누르세요.");
    else drawMsg();
  };
  const stopDraw = () => {
    D.mode = null;
    D.pts = [];
    if (!A.map) return;
    A.drawLayer.clearLayers();
    A.map.doubleClickZoom.enable();
    $("#an-map").classList.remove("drawing");
    $$("[data-draw]").forEach((b) => b.classList.remove("on"));
    $("#an-draw-bar").hidden = true;
  };
  const finishDraw = () => {
    const { mode, pts } = D;
    if (mode === "polygon" && pts.length < 3) return toast("구역은 꼭짓점이 3개 이상 있어야 합니다.");
    if (mode === "line" && pts.length < 2) return toast("선은 꼭짓점이 2개 이상 있어야 합니다.");
    stopDraw();
    setSite(shapeOf(pts, mode), mode === "polygon" ? "지도에 그린 구역" : "지도에 그린 선");
  };
  const onMapClick = (e) => {
    if (!D.mode) return;
    const p = [e.latlng.lng, e.latlng.lat];
    if (D.mode === "point") {
      stopDraw();
      setSite([feat({ type: "Point", coordinates: p })], "지도에 찍은 점");
      return;
    }
    const last = D.pts[D.pts.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) return;   // 두 번 누를 때 겹친 점
    D.pts.push(p);
    redrawTmp();
  };

  // ---------- 파일 읽기 ----------
  const ext = (name) => (/\.([^.]+)$/.exec(name.toLowerCase()) || [])[1] || "";
  const stem = (name) => name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const decode = (buf) => {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch (_) { return new TextDecoder("euc-kr").decode(buf); }
  };
  const fromGeoJSON = (text) => {
    const j = JSON.parse(text);
    const fs = j.type === "FeatureCollection" ? j.features : j.type === "Feature" ? [j] : j.type ? [feat(j)] : [];
    const crsName = j.crs && j.crs.properties && j.crs.properties.name;
    const m = crsName && /EPSG:+(\d+)/i.exec(crsName);
    const def = m ? (m[1] === "4326" ? "geo" : crsDef(m[1]) || null) : crsName && /CRS84/i.test(crsName) ? "geo" : null;
    return { features: fs.filter((f) => f && f.geometry), def };
  };
  const fromKml = (text) => {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("KML 파일을 읽지 못했습니다.");
    const tag = (el, name) => (el ? Array.from(el.getElementsByTagNameNS("*", name)) : []);
    const cs = (el) => (el ? el.textContent.trim().split(/\s+/).map((t) => t.split(",").map(Number))
      .filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])).map((c) => [c[0], c[1]]) : []);
    const fs = [];
    tag(doc, "Placemark").forEach((pm) => {
      const props = { name: (tag(pm, "name")[0] || {}).textContent || "" };
      tag(pm, "Point").forEach((g) => { const c = cs(tag(g, "coordinates")[0]); if (c.length) fs.push(feat({ type: "Point", coordinates: c[0] }, props)); });
      tag(pm, "LineString").forEach((g) => fs.push(feat({ type: "LineString", coordinates: cs(tag(g, "coordinates")[0]) }, props)));
      tag(pm, "Polygon").forEach((g) => {
        const outer = cs(tag(tag(g, "outerBoundaryIs")[0], "coordinates")[0]);
        const holes = tag(g, "innerBoundaryIs").map((h) => cs(tag(h, "coordinates")[0]));
        fs.push(feat({ type: "Polygon", coordinates: [outer, ...holes] }, props));
      });
    });
    return { features: fs, def: "geo" };
  };
  // DXF(ASCII) — ENTITIES 구역의 LWPOLYLINE·POLYLINE·LINE을 레이어별로 모음. 닫힌 선은 면으로, 끝이 이어진 선 조각도 이어 붙여 봄
  const fromDxf = (text) => {
    const L2 = text.split(/\r?\n/);
    const layers = new Map();
    const layer = (name) => { if (!layers.has(name)) layers.set(name, { polygons: [], lines: [] }); return layers.get(name); };
    const pieces = new Map();   // 레이어 → 열린 선 조각
    let inEnt = false, ent = null;
    const flush = () => {
      if (!ent) return;
      const pts = ent.pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      const name = ent.layer || "0";
      if ((ent.type === "LWPOLYLINE" || ent.type === "POLYLINE") && pts.length >= 2) {
        const closed = ent.closed || (pts.length >= 4 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]);
        if (closed && pts.length >= 3) layer(name).polygons.push(pts);
        else { if (!pieces.has(name)) pieces.set(name, []); pieces.get(name).push(pts); }
      } else if (ent.type === "LINE" && pts.length === 2) {
        if (!pieces.has(name)) pieces.set(name, []);
        pieces.get(name).push(pts);
      }
      ent = null;
    };
    for (let i = 0; i + 1 < L2.length; i += 2) {
      const code = parseInt(L2[i], 10), v = L2[i + 1].trim();
      if (code === 2 && v === "ENTITIES") { inEnt = true; continue; }
      if (!inEnt) continue;
      if (code === 0) {
        if (v === "ENDSEC") { flush(); break; }
        if (ent && ent.type === "POLYLINE" && v === "VERTEX") { ent.vertex = true; continue; }
        flush();
        ent = { type: v, pts: [], closed: false, layer: "", vertex: false };
        continue;
      }
      if (!ent) continue;
      if (code === 8 && !ent.vertex) ent.layer = v;
      if (ent.type === "LWPOLYLINE") {
        if (code === 10) ent.pts.push([+v, NaN]);
        else if (code === 20 && ent.pts.length) ent.pts[ent.pts.length - 1][1] = +v;
        else if (code === 70) ent.closed = (parseInt(v, 10) & 1) === 1;
      } else if (ent.type === "POLYLINE") {
        if (code === 70 && !ent.vertex) ent.closed = (parseInt(v, 10) & 1) === 1;
        else if (ent.vertex && code === 10) ent.pts.push([+v, NaN]);
        else if (ent.vertex && code === 20 && ent.pts.length) ent.pts[ent.pts.length - 1][1] = +v;
      } else if (ent.type === "LINE") {
        if (code === 10) ent.pts[0] = [+v, NaN];
        else if (code === 20 && ent.pts[0]) ent.pts[0][1] = +v;
        else if (code === 11) ent.pts[1] = [+v, NaN];
        else if (code === 21 && ent.pts[1]) ent.pts[1][1] = +v;
      }
    }
    flush();
    // 열린 조각 잇기(끝점이 거의 같은 조각끼리)
    pieces.forEach((list, name) => {
      const geo = list.every((p) => p.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90));
      const tol = geo ? 1e-8 : 1e-3;
      const near = (a, b) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
      const left = list.length <= 5000 ? list.map((p) => p.slice()) : [];
      const out = layer(name);
      if (!left.length) list.forEach((p) => out.lines.push(p));
      while (left.length) {
        let cur = left.pop();
        for (let grown = true; grown;) {
          grown = false;
          for (let i = 0; i < left.length; i++) {
            const p = left[i], h = cur[0], t = cur[cur.length - 1];
            if (near(t, p[0])) cur = cur.concat(p.slice(1));
            else if (near(t, p[p.length - 1])) cur = cur.concat(p.slice(0, -1).reverse());
            else if (near(h, p[p.length - 1])) cur = p.slice(0, -1).concat(cur);
            else if (near(h, p[0])) cur = p.slice(1).reverse().concat(cur);
            else continue;
            left.splice(i, 1);
            grown = true;
            break;
          }
        }
        if (cur.length >= 4 && near(cur[0], cur[cur.length - 1])) out.polygons.push(cur);
        else out.lines.push(cur);
      }
    });
    [...layers].forEach(([k, v]) => { if (!v.polygons.length && !v.lines.length) layers.delete(k); });
    if (!layers.size) throw new Error("DXF에서 폴리선·선을 찾지 못했습니다(블록 안 도형은 읽지 않습니다).");
    // 기본 레이어: 이름에 구역·경계·사업 등이 들어간 면 레이어 → 면이 가장 적은 레이어 → 첫 레이어
    const named = [...layers].find(([k, v]) => v.polygons.length && /구역|경계|사업|계획|부지|편입|boundary|site|area/i.test(k));
    const fewest = [...layers].filter(([, v]) => v.polygons.length).sort((a, b) => a[1].polygons.length - b[1].polygons.length)[0];
    const pick = layers.size === 1 ? [...layers.keys()][0] : (named || fewest || [...layers][0])[0];
    return { layers, pick };
  };
  const dxfFeatures = (dxf) => {
    const fs = [];
    dxf.layers.forEach((v, name) => {
      if (dxf.pick !== "*" && dxf.pick !== name) return;
      v.polygons.forEach((p) => fs.push(feat({ type: "Polygon", coordinates: [p] }, { layer: name })));
      v.lines.forEach((l) => fs.push(feat({ type: "LineString", coordinates: l }, { layer: name })));
    });
    return fs;
  };

  const readFiles = async (fileList) => {
    const files = [...fileList];
    if (!files.length) return;
    const sources = [];
    let dxf = null;
    const label = files.map((f) => f.name).join(", ");
    try {
      toast("파일을 읽는 중…", 1500);
      // zip(SHP 묶음·KMZ)은 풀어서 같은 목록에 넣음
      const items = [];
      for (const f of files) {
        if (["zip", "kmz"].includes(ext(f.name))) {
          await window.H.loadJSZip();
          const z = await JSZip.loadAsync(f);
          for (const e of Object.values(z.files)) {
            if (e.dir || /(^|\/)__MACOSX\//.test(e.name)) continue;
            items.push({ name: e.name, buf: () => e.async("arraybuffer") });
          }
        } else items.push({ name: f.name, buf: () => f.arrayBuffer() });
      }
      const find = (base, x) => items.find((it) => ext(it.name) === x && stem(it.name).toLowerCase() === base.toLowerCase());
      for (const it of items) {
        const x = ext(it.name);
        if (x === "shp") {
          await window.H.loadScript(LIB.shp, "shp");
          const prjItem = find(stem(it.name), "prj");
          const prj = prjItem ? decode(await prjItem.buf()) : "";
          const geoms = await shp.parseShp(await it.buf());   // 좌표는 그대로 받고 좌표계는 아래에서 직접 바꿈
          sources.push({ features: geoms.filter(Boolean).map((g) => feat(g)), def: fromPrj(prj) });
        } else if (x === "geojson" || x === "json") sources.push(fromGeoJSON(decode(await it.buf())));
        else if (x === "kml") sources.push(fromKml(decode(await it.buf())));
        else if (x === "dxf") dxf = fromDxf(decode(await it.buf()));
      }
    } catch (err) {
      console.warn(err);
      toast(err.message || "파일을 읽지 못했습니다.", 5000);
      return;
    }
    if (!sources.length && !dxf) { toast("읽을 수 있는 파일이 없습니다. SHP(.shp, 또는 zip)·GeoJSON·KML·DXF를 올려 주세요.", 5000); return; }
    if (!$("#an-name").value.trim()) $("#an-name").value = stem(files[0].name).slice(0, 40);
    buildFromRaw({ sources, dxf, label: `파일: ${label}` });
  };
  const looksProjected = (features) => {
    let p = false;
    features.forEach((f) => f.geometry && eachXY(f.geometry.coordinates, ([x, y]) => { if (Math.abs(x) > 180 || Math.abs(y) > 90) p = true; }));
    return p;
  };
  const reproject = async (features, def) => {
    const tr = proj4(def, "WGS84");
    return normalize(features).map((f) => feat(mapGeom(f.geometry, (c) => tr.forward([c[0], c[1]])), f.properties));
  };
  // 파일에서 읽은 도형을 경위도로 바꿔 사업지로(좌표계 선택을 바꾸면 다시 부름)
  const buildFromRaw = async (R = A.raw) => {
    if (!R) return;
    const all = [];
    const groups = [...R.sources];
    if (R.dxf) groups.push({ features: dxfFeatures(R.dxf), def: null });
    let guessed = false;
    try {
      for (const g of groups) {
        let def = g.def;
        if (!def && looksProjected(g.features)) { def = crsDef($("#an-file-crs").value); guessed = true; }
        all.push(...(def && def !== "geo" ? await reproject(g.features, def) : g.features));
      }
    } catch (err) {
      console.warn(err);
      toast("좌표계를 바꾸지 못했습니다. ‘좌표계 정보가 없으면’에서 맞는 좌표계를 골라 주세요.", 6000);
      return;
    }
    const crsName = CRS.find((c) => c.id === $("#an-file-crs").value).name;
    setSite(all, guessed ? `${R.label} · ${crsName}로 읽음` : R.label, R);
  };

  const bindUI = () => {
    const crsOpts = (list) => list.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    $("#an-crs").innerHTML = crsOpts(CRS);
    $("#an-file-crs").innerHTML = crsOpts(CRS.filter((c) => c.def));
    $("#an-file-crs").value = "5186";
    $("#an-crs").onchange = () => { $("#an-order-row").hidden = $("#an-crs").value === "4326"; };
    $("#an-src").addEventListener("click", (e) => {
      const b = e.target.closest("[data-src]");
      if (!b) return;
      $$("#an-src button").forEach((x) => x.classList.toggle("on", x === b));
      $$(".an-pane").forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.src; });
      if (b.dataset.src !== "draw") stopDraw();
    });
    $("#an-addr-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const q = $("#an-addr").value.trim();
      if (!q) return;
      const btn = $("#an-addr-form button");
      btn.disabled = true;
      setTimeout(() => { btn.disabled = false; }, 1100);   // 검색 서버 이용 규칙(초당 1번)
      searchAddr(q);
    });
    $("#an-addr-res").addEventListener("click", (e) => {
      const b = e.target.closest("[data-i]");
      if (!b) return;
      const x = addrList[Number(b.dataset.i)];
      if (!$("#an-name").value.trim()) $("#an-name").value = x.name.slice(0, 40);
      setSite([feat({ type: "Point", coordinates: [x.lon, x.lat] })], `주소 검색(${x.kind}): ${x.name}${x.sub ? ` · ${x.sub}` : ""}`);
      $("#an-addr-res").hidden = true;
    });
    $("#an-coord-go").onclick = useCoords;
    $$("[data-draw]").forEach((b) => { b.onclick = () => startDraw(b.dataset.draw); });
    $("#an-draw-done").onclick = finishDraw;
    $("#an-draw-undo").onclick = () => { D.pts.pop(); redrawTmp(); };
    $("#an-draw-cancel").onclick = stopDraw;
    $("#an-file").addEventListener("change", (e) => { readFiles(e.target.files); e.target.value = ""; });
    const drop = $("#an-drop");
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
    drop.addEventListener("drop", (e) => { e.preventDefault(); readFiles(e.dataTransfer.files); });
    $("#an-file-crs").onchange = () => { if (A.raw) buildFromRaw(); };
  };

  // map: 사업지를 그릴 지도, onChange: 사업지가 바뀔 때(결과 지우기 등)
  const init = (map, onChange) => {
    A.map = map;
    A.onChange = onChange;
    A.renderer = L.canvas({ padding: 0.3, tolerance: 3 });
    A.siteLayer = L.featureGroup().addTo(map);
    A.drawLayer = L.featureGroup().addTo(map);
    map.on("click", onMapClick);
    map.on("dblclick", () => { if (D.mode === "line" || D.mode === "polygon") finishDraw(); });
    bindUI();
  };
  const toFront = () => { A.siteLayer.bringToFront(); A.drawLayer.bringToFront(); };

  return { init, get: () => A.site, name: () => $("#an-name").value.trim() || "사업지", toFront, feat, kindOf, bboxOf, polyArea, projAt, eachXY, OUT_CRS };
})();
