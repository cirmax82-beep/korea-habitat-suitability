// 종별 분석리포트 — 연구 보고서 형식(요약·서론·생태적 특징·재료 및 방법·결과·고찰·보전 제언·참고문헌)
// 표·그래프는 data/report/<id>.json(build_models.py가 만든 통계)로 그리고, 문장은 그 수치로 종마다 씀. 인쇄·PDF 저장, 표 CSV 받기
window.Report = (() => {
  const { S, $, esc, fmt, toast, saveBlob, makeMap, SuitLayer, legendHtml, thrsOf, CLASSES, occCellLatLngs, loadOcc, REC_STYLE, GROUPS, GRADE, STRESS,
    photoUrl, suitOf, rasterGet, loadProfiles } = window.H;

  // 환경변수: [이름, 단위, 소수 자리, 출처]. 단위 ‘%’는 칸 안 비율(0–1)을 백분율로 보임
  const LC_SRC = "세분류 토지피복지도 2025";
  const CLIM = "CHELSA V2.1(1981–2010)";
  const V = {
    elev: ["고도", "m", 0, "Copernicus DEM GLO-90"], slope: ["경사", "°", 1, "Copernicus DEM GLO-90"],
    tree: ["산림 비율", "%", 1, LC_SRC], broad: ["활엽·혼효림 비율", "%", 1, LC_SRC], conifer: ["침엽수림 비율", "%", 1, LC_SRC],
    grass: ["초지 비율", "%", 1, LC_SRC], paddy: ["논 비율", "%", 1, LC_SRC], field: ["밭·과수원 비율", "%", 1, LC_SRC],
    built: ["시가지 비율", "%", 1, LC_SRC], artbare: ["나대지 비율", "%", 1, LC_SRC], bare: ["자연 나지 비율", "%", 1, LC_SRC],
    rock: ["암벽·바위 비율", "%", 1, LC_SRC], wetland: ["내륙습지 비율", "%", 1, LC_SRC], tidal: ["갯벌 비율", "%", 1, LC_SRC],
    river: ["하천 비율", "%", 1, LC_SRC], lake: ["호소 비율", "%", 1, LC_SRC],
    dist_river: ["하천까지 거리", "km", 2, LC_SRC], dist_lake: ["호소·습지까지 거리", "km", 2, LC_SRC], dist_coast: ["해안까지 거리", "km", 1, "Copernicus DEM(해수면 칸)"],
    bio1: ["연평균기온", "°C", 1, CLIM], bio4: ["기온 계절성", "표준편차×100", 0, CLIM], bio12: ["연강수량", "mm", 0, CLIM], bio15: ["강수 계절성", "변동계수", 0, CLIM],
  };
  const SUFFIX = new Set(["m", "°", "km", "°C", "mm"]);
  const vName = (k) => (V[k] ? V[k][0] : k);
  const vNum = (k, v) => (v == null ? null : V[k] && V[k][1] === "%" ? v * 100 : v);
  const vFmt = (k, v, unit = true) => {
    if (v == null) return "–";
    const [, u, d] = V[k] || ["", "", 2];
    return `${fmt(vNum(k, v), d)}${unit ? (u === "%" ? "%" : SUFFIX.has(u) ? ` ${u}` : "") : ""}`;
  };
  const LCN = { broad: "활엽·혼효림", conifer: "침엽수림", grass: "초지", paddy: "논", field: "밭·과수원", wetland: "내륙습지", river: "하천", lake: "호소",
    tidal: "갯벌", sea: "바다", rock: "암벽·바위", bare: "자연 나지", built: "시가지", road: "도로·철도", artbare: "나대지", mixed: "혼효림" };
  const LG = { broad: "활엽수림", mixed: "혼효림", riverbar: "강기슭 나지(모래·자갈톱)" };   // 서식지 층의 토지피복 이름(층에서는 활엽·혼효를 나눠 씀)
  const PA = [["any", "보호지역 전체"], ["park", "자연공원(국립·도립·군립)"], ["eco", "생태·습지·야생생물 보호지역 등"], ["heritage", "국가유산(천연기념물·천연보호구역·명승)"],
    ["other", "그 밖(상수원·수산자원·도시자연공원구역 등)"]];
  const SERIES = { suit: ["적합 서식지", "var(--s1)"], rec: ["출현 칸", "var(--s2)"], land: ["국토 전체", "var(--s3)"] };
  // 방법 참고문헌(본문에 처음 나올 때 번호를 붙임)
  const MREF = {
    gbif: ["GBIF.org (2026) GBIF Occurrence Data", "https://www.gbif.org"],
    inat: ["iNaturalist (2026) Research-grade observations", "https://www.inaturalist.org"],
    lc: ["기후에너지환경부 (2025) 세분류 토지피복지도. 환경공간정보서비스", "https://aid.mcee.go.kr"],
    wc: ["Zanaga D 외 (2022) ESA WorldCover 10 m 2021 v200", "https://doi.org/10.5281/zenodo.7254221"],
    osm: ["OpenStreetMap contributors (2026) OpenStreetMap 물길(waterway) 자료, ODbL", "https://www.openstreetmap.org"],
    dem: ["European Space Agency (2022) Copernicus DEM GLO-90", "https://doi.org/10.5270/ESA-c5d3d65"],
    chelsa: ["Karger DN, Conrad O, Böhner J 외 (2017) Climatologies at high resolution for the earth’s land surface areas. Scientific Data 4:170122", "https://doi.org/10.1038/sdata.2017.122"],
    its: ["국토교통부 국가교통정보센터 (2026) 표준노드링크", "https://www.its.go.kr"],
    phillips2006: ["Phillips SJ, Anderson RP, Schapire RE (2006) Maximum entropy modeling of species geographic distributions. Ecological Modelling 190:231–259", "https://doi.org/10.1016/j.ecolmodel.2005.03.026"],
    phillips2017: ["Phillips SJ, Anderson RP, Dudík M 외 (2017) Opening the black box: an open-source release of Maxent. Ecography 40:887–893", "https://doi.org/10.1111/ecog.03049"],
    elapid: ["Anderson CB (2023) elapid: Species distribution modeling tools for Python. Journal of Open Source Software 8(84):4930", "https://doi.org/10.21105/joss.04930"],
    phillips2009: ["Phillips SJ, Dudík M, Elith J 외 (2009) Sample selection bias and presence-only distribution models: implications for background and pseudo-absence data. Ecological Applications 19:181–197", "https://doi.org/10.1890/07-2153.1"],
    fielding: ["Fielding AH, Bell JF (1997) A review of methods for the assessment of prediction errors in conservation presence/absence models. Environmental Conservation 24:38–49", "https://doi.org/10.1017/S0376892997000088"],
    kdpa: ["국립공원공단 (2025) 한국보호지역통합DB(KDPA) 2025년판", ""],
    scott: ["Scott JM, Davis F, Csuti B 외 (1993) Gap analysis: a geographic approach to protection of biological diversity. Wildlife Monographs 123:3–41", ""],
  };

  // 받침에 따라 조사 고르기(은/는, 이/가, 과/와, 을/를)
  const jo = (w, a, b) => {
    const c = String(w).charCodeAt(String(w).length - 1);
    return `${w}${c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? a : b}`;
  };
  // 숫자 뒤 조사: 끝자리 읽기(영·일·삼·육·칠·팔은 받침 있음)
  const numJo = (n, a, b) => `${n}${/[013678]$/.test(String(n)) ? a : b}`;
  const pctOf = (a, b) => (b ? (a / b) * 100 : 0);
  const withRef = (text, ref) => (text ? text.replace(/\.$/, `(${ref}).`) : "");
  const p1 = (v) => fmt(v, 1);

  // ---------- 그래프(HTML 막대·SVG 선) ----------
  const legend = (keys) => `<div class="rc-legend">${keys.map((k) => `<span><i style="background:${SERIES[k][1]}"></i>${SERIES[k][0]}</span>`).join("")}</div>`;
  // 가로 막대(한 계열). rows: [{ label, v, color? }]
  const hbars = (rows, o = {}) => {
    const max = o.max || Math.max(...rows.map((r) => r.v), 1e-9), d = o.d ?? 1, u = o.unit || "";
    return `<div class="rc-hbars">${rows.map((r) => `<div class="rc-row" title="${esc(r.label)}: ${fmt(r.v, d)}${u}">
      <span class="rc-l">${esc(r.label)}</span><span class="rc-t"><i style="width:${((r.v / max) * 100).toFixed(2)}%;background:${r.color || "var(--s1)"}"></i></span>
      <span class="rc-v">${fmt(r.v, d)}${u}</span></div>`).join("")}</div>`;
  };
  // 가로 막대(여러 계열 묶음). rows: [{ label, vals: [계열별 값] }], keys: SERIES 키
  const gbars = (rows, keys, o = {}) => {
    const all = rows.flatMap((r) => r.vals).filter((v) => v != null);
    const max = o.max || Math.max(...all, 1e-9), d = o.d ?? 1, u = o.unit || "";
    return `${legend(keys)}<div class="rc-hbars">${rows.map((r) => `<div class="rc-row g"><span class="rc-l">${esc(r.label)}</span><span class="rc-gs">${keys.map((k, i) => (r.vals[i] == null ? "" : `
      <span class="rc-g" title="${esc(r.label)} · ${SERIES[k][0]}: ${fmt(r.vals[i], d)}${u}"><span class="rc-t"><i style="width:${((r.vals[i] / max) * 100).toFixed(2)}%;background:${SERIES[k][1]}"></i></span>
      <span class="rc-v">${fmt(r.vals[i], d)}${u}</span></span>`)).join("")}</span></div>`).join("")}</div>`;
  };
  // 반응곡선 하나(SVG). 띠 = 출현 칸 값의 10–90% 범위
  const respChart = (k, r, e, imp) => {
    const W = 320, H = 196, m = { l: 34, r: 12, t: 10, b: 30 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
    const xs = r.x.map((x) => vNum(k, x)), ys = r.y;
    const x0 = xs[0], x1 = xs[xs.length - 1] > x0 ? xs[xs.length - 1] : x0 + 1, d = (V[k] || [])[2] ?? 2;
    const X = (x) => m.l + ((x - x0) / (x1 - x0)) * iw, Y = (y) => m.t + (1 - y) * ih;
    const pts = xs.map((x, i) => `${X(x).toFixed(1)},${Y(ys[i]).toFixed(1)}`);
    const band = e && e.recP10 != null ? [Math.max(x0, vNum(k, e.recP10)), Math.min(x1, vNum(k, e.recP90))] : null;
    const u = (V[k] || [])[1] || "";
    return `<div class="rc-resp"><div class="rc-sub"><b>${esc(vName(k))}</b> <span class="muted">${u && u !== "%" ? `(${esc(u)}) ` : u === "%" ? "(%) " : ""}· 기여 ${p1(imp || 0)}%</span></div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(vName(k))} 반응곡선">
        ${band && band[1] > band[0] ? `<rect x="${X(band[0]).toFixed(1)}" y="${m.t}" width="${(X(band[1]) - X(band[0])).toFixed(1)}" height="${ih}" fill="var(--s2)" opacity=".14"><title>출현 칸 10–90%: ${fmt(band[0], d)}–${fmt(band[1], d)}</title></rect>` : ""}
        ${[0, 0.5, 1].map((y) => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(y)}" y2="${Y(y)}" class="rc-grid"/><text x="${m.l - 6}" y="${Y(y) + 4}" text-anchor="end" class="rc-ax">${y}</text>`).join("")}
        <path d="M${pts.join("L")}L${X(xs[xs.length - 1]).toFixed(1)},${Y(0)}L${X(xs[0]).toFixed(1)},${Y(0)}Z" fill="var(--s1)" opacity=".1"/>
        <path d="M${pts.join("L")}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${[x0, (x0 + x1) / 2, x1].map((x, i) => `<text x="${X(x)}" y="${H - 10}" text-anchor="${["start", "middle", "end"][i]}" class="rc-ax">${fmt(x, d)}</text>`).join("")}
        ${xs.map((x, i) => `<circle cx="${X(x).toFixed(1)}" cy="${Y(ys[i]).toFixed(1)}" r="7" fill="transparent"><title>${esc(vName(k))} ${fmt(x, d)} → ${ys[i].toFixed(2)}</title></circle>`).join("")}
      </svg></div>`;
  };
  // 반응곡선 모양을 말로: 증가·감소·중간 값에서 가장 높음
  const shape = (k, r) => {
    const i = r.y.indexOf(Math.max(...r.y)), n = r.y.length, d = (V[k] || [])[2] ?? 2, u = (V[k] || [])[1];
    const lo = r.y.indexOf(Math.min(...r.y));
    const at = (j) => `${fmt(vNum(k, r.x[j]), d)}${u === "%" ? "%" : SUFFIX.has(u) ? ` ${u}` : ""}`;
    if (lo > n * 0.15 && lo < n * 0.85 && r.y[0] - r.y[lo] > 0.15 && r.y[n - 1] - r.y[lo] > 0.15) return `${vName(k)} 약 ${at(lo)}에서 가장 낮고 양쪽 끝에서 높은 U자형`;
    if (i <= n * 0.12) return `${jo(vName(k), "이", "가")} 낮을수록 높아지는 경향`;
    if (i >= n * 0.88) return `${jo(vName(k), "이", "가")} 높을수록 높아지는 경향`;
    return `${vName(k)} 약 ${at(i)}에서 가장 높은 단봉형`;
  };

  // ---------- 리포트 ----------
  const R0 = { cur: null, map: null, data: new Map() };
  const loadReport = (id) => {
    if (!R0.data.has(id)) R0.data.set(id, fetch(`data/report/${id}.json`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .catch((err) => { R0.data.delete(id); throw err; }));
    return R0.data.get(id);
  };

  const build = (sp, R, P) => {
    const M = R.model || {}, maxent = M.method === "maxent";
    const T = { lo: M.tLo, t: M.threshold, hi: M.tHi };
    const suitKm2 = (R.classKm2[1] || 0) + (R.classKm2[2] || 0);
    const status = [sp.grade ? GRADE[sp.grade] : "", sp.nm ? `천연기념물(${sp.nm})` : ""].filter(Boolean).join(", ");
    const prof = P || {};
    const pRefs = prof.refs || [];
    // 참고문헌 번호: 문헌 프로필 1…n, 방법 문헌은 처음 인용될 때 이어서
    const used = [];
    const cite = (...keys) => `[${keys.map((k) => { if (!used.includes(k)) used.push(k); return pRefs.length + used.indexOf(k) + 1; }).join(", ")}]`;
    const pCite = pRefs.length ? `[${pRefs.length > 2 ? `1–${pRefs.length}` : pRefs.map((_, i) => i + 1).join(", ")}]` : "";
    // 표·그림 번호
    const env = R.env || {};
    const resp = R.response || {};
    const imp = Object.entries(M.importance || {});
    const layers = (prof.layers || []).filter((L) => L.groups);
    const has = { layers: layers.length > 0, imp: maxent && imp.length > 0, resp: Object.keys(resp).length > 0, suit: suitKm2 > 0, rec: (M.cells || 0) > 0 };
    const nums = (list) => Object.fromEntries(list.filter(Boolean).map((k, i) => [k, i + 1]));
    const TB = nums(["eco", "rec", "vars", has.layers && "layers", "thr", "model", "area", has.suit && "sido", (has.suit || has.rec) && "env", has.suit && "patch", has.suit && R.protected && "pa"]);
    const FG = nums([has.imp && "imp", has.resp && "resp", "map", "area", has.suit && "sido", has.suit && "elev", has.suit && "lc", has.suit && R.patches && "patch", has.suit && R.protected && "pa"]);
    const tcap = (k, text) => `<caption><b>표 ${TB[k]}.</b> ${text}</caption>`;
    const fcap = (k, text) => `<figcaption><b>그림 ${FG[k]}.</b> ${text}</figcaption>`;

    // 주요 수치
    const sidoRows = (R.sido || []).filter((r) => r.km2 > 0).sort((a, b) => b.km2 - a.km2);
    const sidoTot = sidoRows.reduce((a, r) => a + r.km2, 0);
    const topSido = sidoRows.filter((r) => r.name !== "기타").slice(0, 3);
    const topShare = pctOf(topSido.reduce((a, r) => a + r.km2, 0), sidoTot);
    const impTop = imp.slice(0, 3);
    const lcRows = Object.entries(R.landcover || {}).filter(([, v]) => v.suit != null);
    const lcUp = lcRows.filter(([, v]) => v.suit >= 2 && v.suit > v.land).sort((a, b) => (b[1].suit - b[1].land) - (a[1].suit - a[1].land)).slice(0, 2);
    const lcDown = lcRows.filter(([, v]) => v.land >= 5 && v.suit < v.land / 2).sort((a, b) => (a[1].suit - a[1].land) - (b[1].suit - b[1].land)).slice(0, 2);
    const pa = R.protected, paL = R.protectedLand;
    const ptc = R.patches;
    const varsUsed = maxent ? M.vars || [] : [];
    const varsRows = [...new Set([...varsUsed, ...Object.keys(env)])];
    const gradeWord = status ? `${status}인 ` : "";
    const rangeKm = (prof.range && prof.range.km) || { bird: 25, mammal: 15, fish: 10 }[sp.group] || 5;
    const areas = (prof.range && prof.range.areas) || [];

    // 요약
    const abs = [
      `${gradeWord}${sp.ko}(<i>${esc(sp.sci)}</i>)의 서식지 적합성을 남한 전역 250 m 격자(${fmt(R.landKm2)}㎢)에서 평가했다.`,
      has.rec ? `2000년 이후 공개 출현 기록 ${fmt(M.raw ?? M.cells)}칸 가운데 현재 토지이용·분포 범위와 맞지 않는 기록을 뺀 ${fmt(M.cells)}칸을 썼고,` : "분석에 쓸 수 있는 출현 칸 기록이 없어,",
      maxent ? `환경변수 ${fmt(varsUsed.length)}종으로 MaxEnt 종분포모형을 적용했다(3겹 교차검증 AUC ${M.auc.toFixed(3)}).`
        : "서식 유형별 토지피복·지형 조건으로 서식 조건 지수를 계산하고 문헌에서 정리한 서식지 층으로 범위를 좁혔다.",
      impTop.length ? `기여도가 큰 변수는 ${impTop.map(([k, v]) => `${vName(k)}(${p1(v)}%)`).join(", ")}였다.` : "",
      has.suit ? `‘적합’ 이상 서식지는 ${fmt(suitKm2, 1)}㎢로 국토의 ${pctOf(suitKm2, R.landKm2) < 0.01 ? "0.01% 미만이었고" : `${fmt(pctOf(suitKm2, R.landKm2), 2)}%였고`}${topSido.length ? `, ${topSido.map((r) => r.name).join("·")}에 ${p1(topShare)}%가 분포했다` : ""}.`
        : `‘적합’ 이상 서식지는 없었고 ‘가능’ 서식지가 ${fmt(R.classKm2[0], 1)}㎢였다.`,
      has.suit && pa ? `적합 서식지 중 보호지역 안은 ${p1(pa.any)}%로 국토 평균(${p1(paL.any)}%)보다 ${pa.any >= paL.any ? "높았다" : "낮았다"}.` : "",
      has.suit && ptc ? `적합 서식지는 ${fmt(ptc.n)}개 조각으로 나뉘었고 가장 큰 조각은 ${fmt(ptc.largest, 1)}㎢(전체의 ${p1(ptc.largestShare)}%)였다.` : "",
      M.noRecord ? "칸 단위 출현 기록이 없어 결과는 ‘가능’ 등급까지만 나타냈으며, 현지조사로 분포를 확인해야 한다." : "",
    ].filter(Boolean).join(" ");
    const keywords = [sp.ko, sp.sci, "서식지 적합성", maxent ? "MaxEnt" : "서식 조건 지수", status.split(", ")[0], "보호지역 공백 분석"].filter(Boolean);

    // 표: 출현 자료
    const recTable = `<table class="rtable">${tcap("rec", "출현 자료 정제")}
      <thead><tr><th>구분</th><th class="num">칸(250 m)</th><th>비고</th></tr></thead><tbody>
      <tr><td>2000년 이후 공개 기록</td><td class="num">${fmt(M.raw ?? M.cells)}</td><td>위치 오차 1 km 이하, 연도 확인</td></tr>
      <tr><td>현재 토지이용·분포 범위와 맞지 않아 제외</td><td class="num">${fmt((M.dropped || 0) - (M.outliers || 0))}</td><td>시가지·물 없는 칸·도심·동물원 주변 등</td></tr>
      <tr><td>외딴 기록·지역 밖 기록 제외</td><td class="num">${fmt(M.outliers || 0)}</td><td>10 km 안 다른 기록 없음, 문헌상 분포 지역 밖</td></tr>
      ${M.manual ? `<tr><td>직접 확인 기록(거르지 않고 포함)</td><td class="num">${fmt(M.manual)}건</td><td>현지에서 확인한 위치(정확한 좌표는 비공개)</td></tr>` : ""}
      <tr class="sum"><td>분석에 쓴 출현 칸</td><td class="num">${fmt(M.cells || 0)}</td><td>${M.sgg ? `그 밖에 시군구 단위 기록 ${fmt(M.sgg)}곳` : ""}</td></tr></tbody></table>`;
    // 표: 환경변수
    const varTable = `<table class="rtable">${tcap("vars", maxent ? "모형에 쓴 환경변수와 리포트에 함께 비교한 변수" : "서식 환경 비교에 쓴 환경변수")}
      <thead><tr><th>변수</th><th>단위</th><th>출처</th><th>모형</th></tr></thead><tbody>
      ${varsRows.map((k) => `<tr><td>${esc(vName(k))}</td><td>${esc((V[k] || [])[1] || "")}</td><td>${esc((V[k] || [])[3] || "")}</td><td>${varsUsed.includes(k) ? "사용" : "–"}</td></tr>`).join("")}</tbody></table>`;
    // 표: 서식지 층
    const layerTable = has.layers ? `<table class="rtable">${tcap("layers", "문헌에서 정리한 서식지 층")}
      <thead><tr><th>층</th><th>시기</th><th>토지피복</th><th>조건</th><th>근거</th></tr></thead><tbody>
      ${layers.map((L) => `<tr><td>${esc(L.name)}${L.main ? "" : " <span class='muted'>(참고)</span>"}</td><td>${esc(L.season || "")}</td><td>${esc([...new Set(L.groups.map((g) => LG[g] || LCN[g] || g))].join("·"))}</td>
        <td class="wrap">${esc(L.desc || "")}</td><td>${(L.refs || []).length ? `[${L.refs.join(", ")}]` : ""}</td></tr>`).join("")}</tbody></table>` : "";
    // 표: 등급 기준
    const thrTable = `<table class="rtable">${tcap("thr", "적합성 등급 기준")}
      <thead><tr><th>등급</th><th class="num">기준값</th><th>뜻</th></tr></thead><tbody>
      ${[[3, T.hi, maxent ? "학습 출현 칸의 절반(P50)이 이 값 이상" : "서식 조건 지수 0.85 이상"], [2, T.t, maxent ? "학습 출현 칸의 80%(P20)가 이 값 이상" : "서식 조건 지수 0.7 이상"],
        [1, T.lo, maxent ? "학습 출현 칸의 90%(P10)가 이 값 이상" : "서식 조건 지수 0.5 이상"]].map(([k, v, t]) => {
        const c = CLASSES.find((x) => x.k === k);
        return `<tr><td><i class="sw" style="background:rgb(${c.color})"></i>${c.name}</td><td class="num">${v != null ? v.toFixed(3) : "–"}</td><td>${t}</td></tr>`;
      }).join("")}</tbody></table>`;
    // 표: 모형 요약
    const modelTable = `<table class="rtable">${tcap("model", "모형 요약")}<tbody>
      <tr><th>방식</th><td>${maxent ? "MaxEnt(선형·이차·힌지, β = 1.5, cloglog)" : M.method === "rule" ? "서식 조건 지수(규칙 기반)" : "자료 부족"}</td></tr>
      <tr><th>출현 칸 / 배경점</th><td>${fmt(M.cells || 0)}칸${maxent ? " / 10,000점(target-group)" : ""}</td></tr>
      ${maxent ? `<tr><th>환경변수</th><td>${fmt(varsUsed.length)}종</td></tr>
      <tr><th>AUC(3겹 교차검증)</th><td>${M.auc.toFixed(3)}</td></tr><tr><th>AUC(학습 자료)</th><td>${M.aucTrain != null ? M.aucTrain.toFixed(3) : "–"}</td></tr>` : `<tr><th>모형을 쓰지 않은 까닭</th><td>${esc(M.reason || "")}</td></tr>`}
      <tr><th>알려진 분포 범위</th><td>출현 칸에서 ${fmt(rangeKm)} km${areas.length ? ` · 문헌상 분포 지역 ${esc(areas.join("·"))}` : ""}</td></tr>
      ${M.road ? `<tr><th>도로 영향권 최대 낮춤</th><td>${Math.round(M.road * 100)}%</td></tr>` : ""}
      ${M.aqua ? `<tr><th>서식 칸</th><td>${esc(M.aqua.map((k) => LCN[k] || k).join("·"))}이 있는 칸만(면적은 물 면적)</td></tr>` : ""}</tbody></table>`;
    // 표·그림: 등급별·층별 면적
    const areaRows = [[3, R.classKm2[2]], [2, R.classKm2[1]], [1, R.classKm2[0]]];
    const areaTable = `<table class="rtable">${tcap("area", "등급별·서식지 층별 면적")}
      <thead><tr><th>구분</th><th class="num">면적(㎢)</th><th class="num">국토 대비(%)</th></tr></thead><tbody>
      ${areaRows.map(([k, v]) => `<tr><td><i class="sw" style="background:rgb(${CLASSES.find((c) => c.k === k).color})"></i>${CLASSES.find((c) => c.k === k).name}</td><td class="num">${fmt(v, 1)}</td><td class="num">${fmt(pctOf(v, R.landKm2), 3)}</td></tr>`).join("")}
      <tr class="sum"><td>‘적합’ 이상</td><td class="num">${fmt(suitKm2, 1)}</td><td class="num">${fmt(pctOf(suitKm2, R.landKm2), 3)}</td></tr>
      ${(M.layers || []).map((L) => `<tr><td>층: ${esc(L.name)} <span class="muted">${esc(L.season || "")}</span></td><td class="num">${fmt(L.suitableKm2, 1)}</td><td class="num">${fmt(pctOf(L.suitableKm2, R.landKm2), 3)}</td></tr>`).join("")}
      </tbody></table>`;
    const areaFig = `<figure>${hbars(areaRows.map(([k, v]) => ({ label: CLASSES.find((c) => c.k === k).name, v, color: `rgb(${CLASSES.find((c) => c.k === k).color})` })), { unit: "㎢" })}
      ${fcap("area", "적합성 등급별 면적")}</figure>`;
    // 시도
    const sidoTable = has.suit ? `<table class="rtable">${tcap("sido", "시도별 ‘적합’ 이상 서식지 면적과 출현 칸")}
      <thead><tr><th>시도</th><th class="num">면적(㎢)</th><th class="num">구성비(%)</th><th class="num">시도 육지 대비(%)</th><th class="num">출현 칸</th></tr></thead><tbody>
      ${[...(R.sido || [])].sort((a, b) => b.km2 - a.km2 || b.rec - a.rec).map((r) => `<tr><td>${r.name === "기타" ? "그 밖(경계 밖 해안 등)" : esc(r.name)}</td><td class="num">${fmt(r.km2, 1)}</td>
        <td class="num">${fmt(pctOf(r.km2, sidoTot), 1)}</td><td class="num">${r.name === "기타" ? "–" : fmt(r.share, 2)}</td><td class="num">${fmt(r.rec)}</td></tr>`).join("")}</tbody></table>` : "";
    const sidoFig = has.suit ? `<figure>${hbars(sidoRows.filter((r) => r.name !== "기타").slice(0, 10).map((r) => ({ label: r.name, v: r.km2 })), { unit: "㎢" })}
      ${fcap("sido", "시도별 ‘적합’ 이상 서식지 면적(상위 10곳)")}</figure>` : "";
    // 환경 특성
    const envTable = `<table class="rtable">${tcap("env", "서식 환경 비교: 국토 평균, ‘적합’ 이상 서식지 평균(면적 가중), 출현 칸")}
      <thead><tr><th>변수</th><th class="num">국토 평균</th><th class="num">적합 서식지</th><th class="num">출현 칸 평균 ± 표준편차</th><th class="num">출현 칸 10–90%</th></tr></thead><tbody>
      ${Object.entries(env).map(([k, e]) => `<tr><td>${esc(vName(k))}</td><td class="num">${vFmt(k, e.land)}</td><td class="num">${vFmt(k, e.suit)}</td>
        <td class="num">${e.rec != null ? `${vFmt(k, e.rec, false)} ± ${vFmt(k, e.recSd)}` : "–"}</td><td class="num">${e.recP10 != null ? `${vFmt(k, e.recP10, false)}–${vFmt(k, e.recP90)}` : "–"}</td></tr>`).join("")}</tbody></table>`;
    const bins = R.elev ? R.elev.bins : [];
    const binLabel = (i) => (i === bins.length - 2 ? `${fmt(bins[i])} m 이상` : `${fmt(bins[i])}–${fmt(bins[i + 1])} m`);
    const elevKeys = ["suit", R.elev && R.elev.rec ? "rec" : null, "land"].filter(Boolean);
    const elevFig = has.suit && R.elev ? `<figure>${gbars(bins.slice(0, -1).map((_, i) => ({ label: binLabel(i), vals: elevKeys.map((k) => R.elev[k][i]) })), elevKeys, { unit: "%" })}
      ${fcap("elev", "고도 구간별 분포(각 계열의 합 = 100%)")}</figure>` : "";
    const lcShow = lcRows.filter(([, v]) => v.suit >= 0.5 || v.land >= 1);
    const lcFig = has.suit ? `<figure>${gbars(lcShow.map(([k, v]) => ({ label: LCN[k] || k, vals: [v.suit, v.land] })), ["suit", "land"], { unit: "%" })}
      ${fcap("lc", "토지피복 구성: ‘적합’ 이상 서식지(면적 가중 평균)와 국토 전체")}</figure>` : "";
    // 조각
    const sizeLabels = ["0.1㎢ 미만", "0.1–0.5㎢", "0.5–1㎢", "1–5㎢", "5–10㎢", "10–50㎢", "50㎢ 이상"];
    const patchTable = has.suit && ptc ? `<table class="rtable">${tcap("patch", "‘적합’ 이상 서식지 조각(8방향 연결)")}<tbody>
      <tr><th>조각 수</th><td class="num">${fmt(ptc.n)}</td></tr><tr><th>가장 큰 조각</th><td class="num">${fmt(ptc.largest, 2)}㎢ (전체의 ${p1(ptc.largestShare)}%)</td></tr>
      <tr><th>조각 면적 중앙값</th><td class="num">${fmt(ptc.median, 3)}㎢</td></tr><tr><th>1㎢ 이상 조각</th><td class="num">${fmt(ptc.over1)}개</td></tr></tbody></table>` : "";
    const patchFig = has.suit && ptc ? `<figure>${hbars(ptc.sizes.map((v, i) => ({ label: sizeLabels[i], v })), { d: 0, unit: "개" })}
      ${fcap("patch", "서식지 조각 면적 분포")}</figure>` : "";
    // 보호지역
    const paTable = has.suit && pa ? `<table class="rtable">${tcap("pa", "보호지역 안에 든 비율(겹친 보호지역은 한 번만)")}
      <thead><tr><th>보호지역</th><th class="num">적합 서식지(%)</th><th class="num">국토 전체(%)</th></tr></thead><tbody>
      ${PA.map(([k, n]) => `<tr${k === "any" ? " class='sum'" : ""}><td>${n}</td><td class="num">${p1(pa[k])}</td><td class="num">${p1(paL[k])}</td></tr>`).join("")}
      ${R.protectedRec != null ? `<tr><td>출현 칸 중 보호지역 안(칸의 절반 이상)</td><td class="num">${p1(R.protectedRec)}</td><td class="num">–</td></tr>` : ""}</tbody></table>` : "";
    const paFig = has.suit && pa ? `<figure>${gbars(PA.map(([k, n]) => ({ label: n.replace(/\(.*\)/, ""), vals: [pa[k], paL[k]] })), ["suit", "land"], { unit: "%" })}
      ${fcap("pa", "보호지역 포함 비율: 적합 서식지와 국토 전체")}</figure>` : "";

    // 고찰 문장
    const aucWord = (a) => (a >= 0.9 ? "매우 높은" : a >= 0.8 ? "높은" : a >= 0.7 ? "보통의" : "낮은");
    const disc1 = () => (maxent
      ? `교차검증 AUC ${numJo(M.auc.toFixed(3), "은", "는")} ${aucWord(M.auc)} 판별력에 해당한다${cite("fielding")}. 다만 출현–배경 자료의 AUC는 실제 부재 지점과의 구분이 아니라 조사된 곳 전체와의 구분을 뜻하므로, 값이 높아도 분포가 좁은 종일수록 과대평가될 수 있다${cite("phillips2009")}.`
        + (M.aucTrain != null && M.aucTrain - M.auc > 0.05 ? ` 학습 AUC(${M.aucTrain.toFixed(3)})와 교차검증 AUC의 차이가 커 과적합 가능성이 있다.` : "")
        + ((M.cells || 0) < 30 ? ` 출현 칸이 ${fmt(M.cells)}칸으로 적어 반응곡선과 경계값의 불확실성이 크다.` : "")
      : `${jo(sp.ko, "은", "는")} ${M.cells ? `출현 칸이 ${fmt(M.cells)}칸으로 통계 모형을 세우기에 부족해` : "분석에 쓸 수 있는 출현 칸 기록이 없어"}, 문헌의 서식 조건으로 계산한 지수를 썼다. 이 값은 확률이 아닌 규칙 기반 참고값이므로 지도의 ‘적합’은 서식 조건을 갖춘 곳이라는 뜻이며 실제 서식은 현지조사로 확인해야 한다.`);
    const respTop = Object.entries(resp).slice(0, 2);
    const lcList = (rows) => rows.map(([k, v]) => `${LCN[k]}(${p1(v.suit)}% 대 ${p1(v.land)}%)`).join("·");
    const disc2 = lcUp.length && lcDown.length ? `적합 서식지는 국토 평균보다 ${lcList(lcUp)} 비율이 높았고, ${lcList(lcDown)} 비율은 낮았다`
      : lcUp.length ? `적합 서식지는 국토 평균보다 ${lcList(lcUp)} 비율이 높았다`
        : lcDown.length ? `적합 서식지는 국토 평균보다 ${lcList(lcDown)} 비율이 낮았다` : "";
    const elevE = env.elev;
    const disc2b = elevE && elevE.suit != null ? `적합 서식지의 평균 고도는 ${vFmt("elev", elevE.suit)}로 국토 평균(${vFmt("elev", elevE.land)})보다 ${elevE.suit >= elevE.land ? "높았다" : "낮았다"}.` : "";
    const disc2c = respTop.length ? `반응곡선에서 서식 가능성은 ${respTop.map(([k, r]) => shape(k, r)).join(", ")}을 보였다.` : "";
    const disc3 = () => (has.suit ? [
      topSido.length ? `‘적합’ 이상 서식지의 ${p1(topShare)}%가 ${topSido.map((r) => r.name).join("·")}에 있어${topShare >= 70 ? " 분포가 일부 지역에 몰려 있었다" : " 여러 지역에 나뉘어 있었다"}.` : "",
      pa ? `보호지역 안에 든 비율은 ${p1(pa.any)}%로 국토 전체(${p1(paL.any)}%)보다 ${pa.any >= paL.any ? `높아 기존 보호지역이 서식지를 일부 포괄하고 있었다` : `낮아 서식지 상당 부분이 보호지역 밖에 있었다`}${cite("scott")}.` : "",
      ptc ? `서식지 조각은 ${fmt(ptc.n)}개이고 조각 면적 중앙값이 ${fmt(ptc.median, 3)}㎢여서${ptc.median < 0.1 ? " 작은 조각이 많은 단절된 분포였다" : " 비교적 큰 덩어리로 이어져 있었다"}. 가장 큰 조각(${fmt(ptc.largest, 1)}㎢)이 전체의 ${p1(ptc.largestShare)}%를 차지했다.` : "",
      R.roadZone != null ? `적합 서식지의 ${p1(R.roadZone)}%는 도로 영향권 안에 있었다.` : "",
    ].filter(Boolean).join(" ") : "");
    const limits = [
      "출현 기록은 공개된 GBIF·iNaturalist 자료만 썼고, 위치를 흐린 기록과 비공개 조사 자료는 빠져 있어 실제 분포보다 좁게 나타날 수 있다.",
      "조사가 많이 된 곳에 기록이 몰리는 편향은 target-group 배경으로 줄였지만 완전히 없앨 수는 없다.",
      "250 m 칸 평균값을 쓰므로 작은 하천·습지·암벽 같은 미세 서식지와 산 정상부 고도는 실제와 다를 수 있다.",
      "토지피복은 2025년, 기후는 1981–2010년 평년값이어서 이후의 개발과 기후 변화는 반영되지 않았다.",
      "결과는 잠재 서식지이며 현지조사를 대신하지 않는다.",
    ];
    // 보전 제언(자료 기반)
    const recs = [
      has.suit && pa && pa.any < paL.any ? `보호지역 밖 적합 서식지(${p1(100 - pa.any)}%)는 개발 사업의 환경성 검토 때 우선 확인 대상으로 두고, 기록이 모인 곳은 야생생물 보호구역 지정을 검토한다.` : "",
      has.suit && ptc && ptc.largest >= 1 ? `가장 큰 서식지 조각(약 ${fmt(ptc.largest, 1)}㎢)은 핵심 서식지로 보고 훼손을 피하며, 주변 조각과의 연결을 유지한다.` : "",
      has.suit && R.roadZone >= 20 ? `적합 서식지의 ${p1(R.roadZone)}%가 도로 영향권 안에 있어, 도로 신설·확장 때 생태통로와 유도 울타리, 야간 조명 관리가 필요하다.` : "",
      M.noRecord || !maxent ? "기록이 적어 정밀 현지조사로 실제 분포를 확인하고, 확인된 지점을 반영해 결과를 다시 계산한다." : "",
    ].filter(Boolean);

    const P_ = (t) => (t ? `<p>${t}</p>` : "");
    const sec = (n, title, body) => `<section><h2><span class="no">${n}</span>${title}</h2>${body}</section>`;
    const sub = (n, title, body) => (body ? `<h3><span class="no">${n}</span>${title}</h3>${body}` : "");
    const counter = (p) => { let i = 0; return () => `${p}.${++i}`; };
    const n2 = counter(2), n3 = counter(3), n4 = counter(4);
    const se = window.Measures.season(sp.season);
    const ecoTable = `<table class="rtable">${tcap("eco", "생태 특성 요약")}<tbody>
      <tr><th>분류</th><td>${esc(GROUPS[sp.group] || sp.group)}${sp.family ? ` · ${esc(sp.family)}` : ""}</td></tr>
      <tr><th>보전 등급</th><td>${esc(status || "–")}</td></tr>
      <tr><th>서식 유형</th><td>${esc((sp.habitat || []).join(", ") || "–")}</td></tr>
      ${se ? `<tr><th>민감 시기</th><td>${esc(se.text)}</td></tr>` : ""}
      <tr><th>주요 위협</th><td>${esc((sp.stress || []).map((k) => STRESS[k] || k).join(", ") || "–")}</td></tr></tbody></table>`;

    const body = `
      <header class="rp-head">
        <div class="rp-kicker">서식지 적합성 분석 보고서</div>
        <h1>${esc(sp.ko)}(<i>${esc(sp.sci)}</i>)의 서식지 적합성 분석</h1>
        <div class="rp-meta">${esc(GROUPS[sp.group] || "")}${status ? ` · ${esc(status)}` : ""} · 분석 격자 250 m · 자료 기준일 ${esc(S.at || "")}</div>
        ${sp.photo ? `<figure class="rp-photo"><img src="${photoUrl(sp.photo, "medium")}" alt="${esc(sp.ko)} 사진"><figcaption>${esc((sp.photoBy || "").trim())} · iNaturalist</figcaption></figure>` : ""}
      </header>
      <section class="rp-abstract"><h2>요약</h2><p>${abs}</p><p class="kw"><b>주제어</b> ${keywords.map(esc).join(", ")}</p></section>
      ${sec(1, "서론", `${P_(prof.summary ? `${esc(prof.summary)} ${pCite}` : esc(sp.note || ""))}
        ${P_(`${jo(sp.ko, "은", "는")} ${status ? `${esc(jo(status, "으로", "로"))} 지정되어 법적으로 보호된다` : "보호 대상 종이다"}. 이 보고서는 공개 출현 기록과 국가 공간자료로 이 종의 잠재 서식지를 추정하고, 그 공간 분포·환경 특성·보호 현황을 정리해 서식지 보전과 개발 사업의 환경성 검토에 쓸 기초 자료를 제공하는 것을 목적으로 한다.`)}`)}
      ${sec(2, "생태적 특징", `${prof.distribution ? sub(n2(), "국내 분포", P_(esc(prof.distribution))) : ""}${prof.habitat ? sub(n2(), "서식지", P_(esc(prof.habitat))) : ""}
        ${prof.life ? sub(n2(), "생활사·번식", P_(esc(prof.life))) : ""}${prof.diet ? sub(n2(), "먹이", P_(esc(prof.diet))) : ""}${prof.threats ? sub(n2(), "위협 요인", P_(esc(prof.threats))) : ""}
        ${pRefs.length ? `<p class="muted small">2장은 참고문헌 ${pCite} 등 공개 자료를 요약했다.</p>` : ""}${ecoTable}`)}
      ${sec(3, "재료 및 방법", `
        ${sub(n3(), "연구 범위와 분석 단위", P_(`남한 육지 전역(${fmt(R.landKm2)}㎢)을 UTM-K(EPSG:5179) 250 m 격자 약 ${fmt(R.landKm2 / 0.0625 / 10000, 1)}만 칸으로 나누어 분석했다. 지도를 확대해 볼 때는 10 m 토지피복으로 칸 안의 비서식지(건물·도로 등)를 지워 보였다.`))}
        ${sub(n3(), "출현 자료", P_(`GBIF${cite("gbif")}와 iNaturalist${cite("inat")}의 공개 기록 가운데 2000년 이후, 위치 오차 1 km 이하인 기록만 250 m 칸으로 모았다. 현재 토지이용과 맞지 않는 기록(땅에 사는 종은 시가지·도로·나대지가 80% 이상인 칸, 물에 사는 종은 주변에 그 물이 없는 칸, 바다 종은 해안에서 2 km 넘는 칸), 대도시 한가운데와 동물원 주변 1.5 km 기록, 기록이 20칸 이상인 종의 외딴 기록(10 km 안에 다른 기록 없음)은 뺐다(표 ${TB.rec}).`) + recTable)}
        ${sub(n3(), "환경변수", P_(`토지피복은 기후에너지환경부 세분류 토지피복지도(2025)${cite("lc")}를 10 m로 읽어 칸별 비율로 만들었고, 접경지역처럼 자료가 없는 곳은 ESA WorldCover${cite("wc")}로 채웠다. 고도·경사는 Copernicus DEM GLO-90${cite("dem")}, 기후는 CHELSA V2.1${cite("chelsa")}의 1981–2010년 평년값을 썼다. ${maxent ? "종마다 문헌의 서식 특성에 맞는 변수만 골라 모형에 넣었다" : "서식 환경 비교에는 주요 변수를 함께 정리했다"}(표 ${TB.vars}).`) + varTable)}
        ${sub(n3(), "서식지 적합성 모형", maxent
          ? P_(`출현 칸이 15칸 이상이어서 최대 엔트로피 모형(MaxEnt)${cite("phillips2006")}을 적용했다. 선형·이차·힌지 특징과 정규화 계수 β = 1.5를 쓰고 출력은 cloglog로 변환했다${cite("phillips2017", "elapid")}. 배경점 10,000개는 모든 대상 종의 출현 칸(조사가 이루어진 곳)에서 뽑아 조사 편향을 줄였다(target-group background)${cite("phillips2009")}. 예측력은 3겹 층화 교차검증 AUC로 평가했고${cite("fielding")}, 변수 기여도는 학습 자료에서 한 변수의 값을 무작위로 섞었을 때 AUC가 줄어드는 정도(순열 중요도)로 계산했다. 반응곡선은 다른 변수를 출현 칸 중앙값으로 고정하고 한 변수만 바꿔 그렸다.`)
          : P_(`출현 칸이 15칸 미만${M.reason && M.reason.includes("해양") ? "이거나 바다 종이어서" : "이어서"} 통계 모형 대신, 생태 특성표의 서식 유형(${esc((sp.habitat || []).join(", "))})별로 토지피복 비율·지형·물과의 거리를 조합한 서식 조건 지수(0–1)를 계산했다.`))}
        ${has.layers ? sub(n3(), "서식지 층", P_(`문헌에서 정리한 서식지 층(표 ${TB.layers})마다 그 토지피복이 있고 조건(가까운 물·숲까지 거리, 고도, 경사, 해안 거리)을 만족하는 칸만 남겼다. 대표 지도는 주 서식지 층들의 최댓값이다.`) + layerTable) : ""}
        ${sub(n3(), "보정", `<ul class="plain">
          <li>알려진 분포 범위: 출현 칸에서 ${fmt(rangeKm)} km 안은 그대로 두고 그 밖은 같은 거리에 걸쳐 0까지 낮췄다.${areas.length ? ` 문헌상 분포 지역(${esc(areas.join("·"))})은 기록과 멀어도 ‘가능’까지 두었다.` : ""}${M.noRecord ? " 칸 단위 기록이 없어 ‘가능’까지만 나타냈다." : ""}</li>
          <li>시가지·도로·나대지는 서식지가 아니므로 칸 안 그 비율만큼 적합도와 면적을 뺐다.${M.aqua ? ` 물에 사는 종이어서 ${esc(M.aqua.map((k) => LCN[k] || k).join("·"))}이 있는 칸만 남기고 면적은 물 면적으로 셌다.` : ""}</li>
          ${M.road ? `<li>도로 영향권: 표준노드링크${cite("its")}의 도로 등급별 거리(고속도로 500 m~시군도 100 m) 안은 도로에 가까울수록 최대 ${Math.round(M.road * 100)}%까지 낮췄다.</li>` : ""}
          <li>대도시·도심: 주변 1 km·5 km의 개발 비율로 만든 도시 지수가 12%를 넘으면 낮추기 시작해 35% 이상이면 0으로 보았다.</li>
          ${M.manual ? `<li>직접 확인 기록(${fmt(M.manual)}건)이 있는 칸은 서식지가 있으면 위 낮춤과 관계없이 최소 ‘적합’으로 두었다.</li>` : ""}</ul>`)}
        ${sub(n3(), "등급 기준", P_(`적합성 값은 표 ${TB.thr}의 기준으로 ‘가능’·‘적합’·‘매우 적합’으로 나누었고, 면적은 ‘적합’ 이상을 기준으로 셌다.`) + thrTable)}
        ${sub(n3(), "추가 분석", P_(`‘적합’ 이상 칸을 8방향으로 이어 서식지 조각을 나누었다. 보호 현황은 한국보호지역통합DB${cite("kdpa")}의 보호지역 1,767곳을 50 m로 그려 칸별 비율로 만들고, 적합 서식지 중 보호지역 안의 비율을 국토 전체 비율과 비교했다(공백 분석)${cite("scott")}. 도로 영향권 안 비율도 함께 셌다.`))}`)}
      ${sec(4, "결과", `
        ${sub(n4(), "모형 성능", P_(maxent ? `학습 자료 AUC는 ${M.aucTrain != null ? M.aucTrain.toFixed(3) : "–"}, 3겹 교차검증 AUC는 ${numJo(M.auc.toFixed(3), "이었다", "였다")}(표 ${TB.model}).` : `서식 조건 지수로 계산했다(표 ${TB.model}).`) + modelTable)}
        ${has.imp ? sub(n4(), "환경변수 기여도", P_(`기여도는 ${imp.slice(0, 5).map(([k, v]) => `${vName(k)} ${p1(v)}%`).join(", ")} 순이었다(그림 ${FG.imp}).`)
          + `<figure>${hbars(imp.map(([k, v]) => ({ label: vName(k), v })), { unit: "%" })}${fcap("imp", "환경변수 기여도(순열 중요도, 합 = 100%)")}</figure>`) : ""}
        ${has.resp ? sub(n4(), "반응곡선", P_(withRef(disc2c, `그림 ${FG.resp}`))
          + `<figure><div class="rc-resps">${Object.entries(resp).map(([k, r]) => respChart(k, r, env[k], (M.importance || {})[k])).join("")}</div>
            <div class="rc-legend"><span><i style="background:var(--s1)"></i>모형 반응(cloglog)</span><span><i style="background:var(--s2);opacity:.35"></i>출현 칸 값의 10–90% 범위</span></div>
            ${fcap("resp", "기여도가 큰 변수의 반응곡선(다른 변수는 출현 칸 중앙값으로 고정)")}</figure>`) : ""}
        ${sub(n4(), "서식지 적합성 분포", P_(`서식지 적합성 지도는 그림 ${FG.map}과 같다. 서식지 층별 지도는 종 정보 화면에서 볼 수 있다.`)
          + `<figure><div class="rp-map-wrap"><div class="rp-map" id="rp-map"></div><div class="legend" id="rp-legend">${legendHtml(sp, `<div><i class="rec"></i>출현 기록(약 250 m 칸)</div>`)}</div></div>
            ${fcap("map", `${esc(sp.ko)}의 서식지 적합성(250 m)과 분석에 쓴 출현 칸`)}</figure>`)}
        ${sub(n4(), "등급별·층별 면적", P_(`‘매우 적합’ ${fmt(R.classKm2[2], 1)}㎢, ‘적합’ ${fmt(R.classKm2[1], 1)}㎢, ‘가능’ ${fmt(R.classKm2[0], 1)}㎢였다(표 ${TB.area}, 그림 ${FG.area}).`) + areaTable + areaFig)}
        ${has.suit ? sub(n4(), "지역별 분포", P_(`${topSido.map((r) => `${r.name} ${fmt(r.km2, 1)}㎢`).join(", ")} 순으로 넓었다(표 ${TB.sido}, 그림 ${FG.sido}).`) + sidoTable + sidoFig) : ""}
        ${has.suit || has.rec ? sub(n4(), "서식 환경 특성", P_(withRef([disc2 ? `${disc2}.` : "", disc2b].filter(Boolean).join(" ") || "국토 평균, 적합 서식지, 출현 칸의 환경을 비교했다.", `표 ${TB.env}${has.suit ? `, 그림 ${FG.elev}·${FG.lc}` : ""}`)) + envTable + elevFig + lcFig) : ""}
        ${has.suit && ptc ? sub(n4(), "서식지 조각", P_(`‘적합’ 이상 서식지는 ${fmt(ptc.n)}개 조각으로 나뉘었고, 1㎢ 이상인 조각은 ${fmt(ptc.over1)}개였다(표 ${TB.patch}, 그림 ${FG.patch}).`) + patchTable + patchFig) : ""}
        ${has.suit && pa ? sub(n4(), "보호지역 포함 비율", P_(`적합 서식지 중 보호지역 안은 ${p1(pa.any)}%였고, 자연공원 ${p1(pa.park)}%, 생태·습지·야생생물 보호지역 등 ${p1(pa.eco)}%, 국가유산 ${p1(pa.heritage)}%였다(표 ${TB.pa}, 그림 ${FG.pa}).${R.roadZone != null ? ` 도로 영향권 안 비율은 ${p1(R.roadZone)}%였다.` : ""}`) + paTable + paFig) : ""}`)}
      ${sec(5, "고찰", `${P_(disc1())}${P_([disc2 ? `${disc2}.` : "", disc2b, disc2c].filter(Boolean).join(" "))}${P_(disc3())}
        ${sub("5.1", "한계", `<ul class="plain">${limits.map((t) => `<li>${t}</li>`).join("")}</ul>`)}`)}
      ${sec(6, "보전·관리 제언", `${P_(esc(prof.conservation || ""))}${recs.length ? `<ul class="plain">${recs.map((t) => `<li>${t}</li>`).join("")}</ul>` : ""}
        <h3>사업 시 일반 저감방안</h3>${window.Measures.html(window.Measures.list(sp), esc)}`)}
      <section><h2>참고문헌</h2><ol class="refs">
        ${pRefs.map((r) => `<li>${esc(r.text)}${r.url ? ` <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url.replace(/^https?:\/\/(dx\.)?doi\.org\//, "doi:"))}</a>` : ""}</li>`).join("")}
        ${used.map((k) => `<li>${esc(MREF[k][0])}${MREF[k][1] ? ` <a href="${esc(MREF[k][1])}" target="_blank" rel="noopener">${esc(MREF[k][1].replace(/^https?:\/\/(dx\.)?doi\.org\//, "doi:"))}</a>` : ""}</li>`).join("")}</ol></section>
      <section class="rp-cite small"><b>인용</b> 멸종위기종 서식지 분석 (${esc((S.at || "").slice(0, 4))}) ${esc(sp.ko)}(${esc(sp.sci)})의 서식지 적합성 분석 보고서. ${esc(location.origin)}/#report/${esc(sp.id)} (자료 기준일 ${esc(S.at || "")})</section>`;
    return body;
  };

  // 지도(그림): 적합성 층과 분석에 쓴 출현 칸. 기록이 있으면 그 범위로 맞춤
  const drawMap = async (sp) => {
    if (R0.map) { R0.map.remove(); R0.map = null; }
    const el = $("#rp-map");
    if (!el) return;
    const map = R0.map = makeMap(el, { scrollWheelZoom: false });
    try {
      const [R, occ] = await Promise.all([suitOf(sp.id), loadOcc()]);
      if (R0.map !== map) return;
      new SuitLayer(rasterGet(R), thrsOf(sp), {}, sp, null).addTo(map);
      const canvas = L.canvas({ padding: 0.3 });
      const cells = occ[sp.id] || [];
      const g = L.featureGroup(cells.map((c) => L.polygon(occCellLatLngs(c), { ...REC_STYLE, renderer: canvas }))).addTo(map);
      if (cells.length) map.fitBounds(g.getBounds().pad(0.25), { maxZoom: 10 });
    } catch (err) {
      console.warn(err);
      toast("지도 자료를 불러오지 못했습니다.", 4000);
    }
  };

  // 표를 CSV로(표마다 제목 줄 + 머리글 + 행)
  const toCsv = () => {
    const q = (v) => `"${String(v).replace(/"/g, '""').trim()}"`;
    return Array.from($("#rp-doc").querySelectorAll("table.rtable")).map((t) => [q(t.caption ? t.caption.textContent : ""),
      ...Array.from(t.rows).map((r) => Array.from(r.cells).map((c) => q(c.textContent)).join(","))].join("\r\n")).join("\r\n\r\n");
  };

  const fillSelect = () => {
    const sel = $("#rp-sel");
    if (sel.options.length) return;
    sel.innerHTML = `<option value="">종을 고르세요</option>` + Object.entries(GROUPS).map(([g, name]) => {
      const list = S.cat.filter((s) => s.group === g).sort((a, b) => a.ko.localeCompare(b.ko, "ko"));
      return list.length ? `<optgroup label="${esc(name)}">${list.map((s) => `<option value="${esc(s.id)}">${esc(s.ko)} (${esc(s.sci)})</option>`).join("")}</optgroup>` : "";
    }).join("");
    sel.onchange = () => { if (sel.value) location.hash = `#report/${sel.value}`; };
    $("#rp-print").onclick = () => window.print();
    $("#rp-csv").onclick = () => {
      const sp = S.byId.get(R0.cur);
      if (!sp) return;
      saveBlob(new Blob([`﻿${toCsv()}`], { type: "text/csv;charset=utf-8" }), `${sp.ko}_서식지분석리포트_표.csv`);
    };
  };

  const show = async (id) => {
    fillSelect();
    const sp = S.byId.get(id);
    R0.cur = sp ? id : null;
    $("#rp-sel").value = sp ? id : "";
    $("#rp-csv").disabled = !sp;
    $("#rp-print").disabled = !sp;
    const doc = $("#rp-doc");
    if (R0.map) { R0.map.remove(); R0.map = null; }
    if (!sp) {
      doc.innerHTML = `<div class="rp-empty"><h1>종별 분석리포트</h1><p>위에서 종을 고르면 연구 보고서 형식의 서식지 적합성 분석 결과를 볼 수 있습니다.</p>
        <p class="muted">요약, 생태적 특징, 재료 및 방법(출현 자료·환경변수·모형·서식지 층·보정), 결과(모형 성능·변수 기여도·반응곡선·지도·등급별·시도별 면적·서식 환경·서식지 조각·보호지역 포함 비율), 고찰, 보전·관리 제언, 참고문헌으로 구성됩니다. 인쇄하거나 PDF로 저장할 수 있고 표는 CSV로 받을 수 있습니다.</p></div>`;
      return;
    }
    doc.innerHTML = `<p class="muted">리포트를 만드는 중…</p>`;
    try {
      const [R, all] = await Promise.all([loadReport(id), loadProfiles()]);
      if (R0.cur !== id) return;
      doc.innerHTML = build(sp, R, all[id]);
      $("#rp-wrap").scrollTop = 0;
      document.title = `${sp.ko} 서식지 분석리포트 · 멸종위기종 서식지 분석`;
      drawMap(sp);
    } catch (err) {
      console.warn(err);
      doc.innerHTML = `<p class="muted">리포트 자료를 불러오지 못했습니다. 잠시 뒤 다시 열어 보세요.</p>`;
    }
  };

  const hide = () => { document.title = "멸종위기종 서식지 분석"; };
  return { show, hide };
})();
