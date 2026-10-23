// 내 기록 — 직접 아는 법정보호종 위치를 종 지도에 찍거나 주소·좌표로 넣음. 이 브라우저(localStorage)에만 저장하고,
// CSV로 받아 관리자에게 보내면 다음 계산 때 출현 기록으로 모형에 반영(공개 지도에는 약 250 m 칸으로만)
window.MyRec = (() => {
  const { S, esc, fmt, toast, saveBlob } = window.H;
  const KEY = "habitat.myRecords.v1";
  const STYLE = { radius: 7, color: "#fff", weight: 2, fillColor: "#1971c2", fillOpacity: 0.95 };
  const KOREA = { lat: [33, 39], lng: [124, 132] };

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (_) { return []; } };
  const store = (list) => {
    try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch (_) { toast("이 브라우저에 저장하지 못했습니다(사생활 보호 모드 등).", 4000); return false; }
  };
  const today = () => new Date().toLocaleDateString("sv-SE");   // 이 컴퓨터 시간대의 YYYY-MM-DD
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  const inKorea = (lat, lng) => lat >= KOREA.lat[0] && lat <= KOREA.lat[1] && lng >= KOREA.lng[0] && lng <= KOREA.lng[1];
  // ‘35.1234, 128.5678’ 또는 ‘128.5678 35.1234’(경도 먼저)도 받음
  const parseLatLng = (t) => {
    const n = (t.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (n.length !== 2) return null;
    if (inKorea(n[0], n[1])) return { lat: n[0], lng: n[1] };
    if (inKorea(n[1], n[0])) return { lat: n[1], lng: n[0] };
    return null;
  };

  const CSV_HEAD = ["종id", "국명", "학명", "위도", "경도", "날짜", "메모", "입력일시"];
  const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const toCsv = (list) => [CSV_HEAD.join(","), ...list.map((r) => [r.sp, r.ko, r.sci, r.lat, r.lng, r.date, r.note, r.added].map(csvCell).join(","))].join("\r\n");
  const parseCsv = (text) => {
    const rows = [];
    let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim()));
  };

  let state = null;   // { map, sp, layer, box, picking }

  const add = (lat, lng, note = "") => {
    const { sp } = state;
    const list = load();
    list.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, sp: sp.id, ko: sp.ko, sci: sp.sci,
      lat: r6(lat), lng: r6(lng), date: today(), note, added: new Date().toISOString() });
    if (store(list)) { draw(); toast(`${sp.ko} 기록을 추가했습니다.`); }
  };
  const update = (id, patch) => {
    const list = load();
    const r = list.find((x) => x.id === id);
    if (r) { Object.assign(r, patch); store(list); }
  };
  const remove = (id) => { store(load().filter((x) => x.id !== id)); draw(); };

  const popup = (r) => {
    const el = document.createElement("div");
    el.className = "myrec-pop";
    el.innerHTML = `<b>${esc(r.ko)}</b> <span class="muted small">내 기록</span>
      <div class="small muted">${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</div>
      <label>날짜 <input type="date" class="input" value="${esc(r.date)}" data-k="date"></label>
      <label>메모 <input type="text" class="input" value="${esc(r.note)}" maxlength="100" placeholder="개체 수·출처 등" data-k="note"></label>
      <button class="btn btn-light btn-sm" type="button">이 기록 지우기</button>`;
    el.querySelectorAll("input").forEach((inp) => { inp.onchange = () => update(r.id, { [inp.dataset.k]: inp.value.trim() }); });
    el.querySelector("button").onclick = () => { state.map.closePopup(); remove(r.id); };
    return el;
  };

  const draw = () => {
    if (!state) return;
    const { sp, layer, box } = state;
    const all = load(), mine = all.filter((r) => r.sp === sp.id);
    layer.clearLayers();
    mine.forEach((r) => L.circleMarker([r.lat, r.lng], STYLE).bindPopup(() => popup(r)).addTo(layer));
    box.querySelector(".myrec-count").textContent = `이 종 ${fmt(mine.length)}건 · 전체 ${fmt(all.length)}건`;
    box.querySelector("[data-act=csv]").disabled = !all.length;
    box.querySelector("[data-act=clear]").disabled = !mine.length;
  };

  const setPicking = (on) => {
    state.picking = on;
    state.map.getContainer().classList.toggle("picking", on);
    const b = state.box.querySelector("[data-act=pick]");
    b.classList.toggle("on", on);
    b.textContent = on ? "찍기 끝내기" : "지도에 찍기";
  };

  // 주소·장소 찾기(오픈스트리트맵 Nominatim)
  const search = async (q) => {
    const res = state.box.querySelector(".myrec-res");
    const ll = parseLatLng(q);
    if (ll) {
      add(ll.lat, ll.lng);
      state.map.setView([ll.lat, ll.lng], Math.max(state.map.getZoom(), 15));
      res.hidden = true;
      state.box.querySelector(".myrec-form input").value = "";
      return;
    }
    res.hidden = false;
    res.innerHTML = `<div class="small muted pad">찾는 중…</div>`;
    try {
      const u = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ format: "jsonv2", q, countrycodes: "kr", limit: "6", "accept-language": "ko" })}`;
      const list = await fetch(u).then((r) => r.json());
      res.innerHTML = list.length ? list.map((p, i) => `<button type="button" data-i="${i}">${esc(p.display_name)}</button>`).join("") : `<div class="small muted pad">찾지 못했습니다. ‘위도, 경도’로 넣어 보세요.</div>`;
      res.querySelectorAll("button").forEach((b) => {
        b.onclick = () => {
          const p = list[+b.dataset.i];
          res.hidden = true;
          state.map.setView([+p.lat, +p.lon], 16);
          setPicking(true);
          toast("지도에서 정확한 위치를 눌러 추가하세요.", 3500);
        };
      });
    } catch (err) {
      console.warn(err);
      res.innerHTML = `<div class="small muted pad">주소 검색에 실패했습니다.</div>`;
    }
  };

  const importCsv = async (file) => {
    const rows = parseCsv((await file.text()).replace(/^﻿/, ""));
    const head = rows.shift() || [];
    const at = (n) => head.indexOf(n);
    const list = load(), seen = new Set(list.map((r) => `${r.sp}|${r.lat}|${r.lng}|${r.date}`));
    let n = 0;
    rows.forEach((c) => {
      const sp = S.byId.get(c[at("종id")]) || S.cat.find((s) => s.ko === c[at("국명")]);
      const lat = +c[at("위도")], lng = +c[at("경도")];
      if (!sp || !inKorea(lat, lng)) return;
      const r = { id: `${Date.now().toString(36)}${n}`, sp: sp.id, ko: sp.ko, sci: sp.sci, lat: r6(lat), lng: r6(lng), date: c[at("날짜")] || "", note: c[at("메모")] || "", added: c[at("입력일시")] || new Date().toISOString() };
      const k = `${r.sp}|${r.lat}|${r.lng}|${r.date}`;
      if (!seen.has(k)) { seen.add(k); list.push(r); n++; }
    });
    if (store(list)) { draw(); toast(`${fmt(n)}건을 불러왔습니다.`); }
  };

  // 종 지도에 붙이기
  const attach = (map, sp, box) => {
    state = { map, sp, box, layer: L.featureGroup().addTo(map), picking: false };
    box.innerHTML = `
      <div class="myrec-head"><b>내 기록</b> <span class="small muted myrec-count"></span></div>
      <div class="row">
        <button class="btn btn-light btn-sm" type="button" data-act="pick">지도에 찍기</button>
        <form class="row grow myrec-form"><input class="input grow" type="search" placeholder="주소·장소 또는 위도, 경도" autocomplete="off"><button class="btn btn-light btn-sm">찾기</button></form>
      </div>
      <div class="myrec-res search-results" hidden></div>
      <div class="row">
        <button class="btn btn-light btn-sm" type="button" data-act="csv">CSV 받기</button>
        <label class="btn btn-light btn-sm">CSV 불러오기<input type="file" accept=".csv,text/csv" hidden></label>
        <button class="btn btn-light btn-sm" type="button" data-act="clear">이 종 기록 지우기</button>
      </div>
      <p class="small muted">이 브라우저에만 저장됩니다. CSV를 받아 보내 주시면 다음 계산 때 출현 기록으로 반영되고, 공개 지도에는 약 250 m 칸으로만 표시됩니다.</p>`;
    box.querySelector("[data-act=pick]").onclick = () => setPicking(!state.picking);
    box.querySelector(".myrec-form").onsubmit = (e) => { e.preventDefault(); const q = e.target.querySelector("input").value.trim(); if (q) search(q); };
    box.querySelector("[data-act=csv]").onclick = () => saveBlob(new Blob([`﻿${toCsv(load())}`], { type: "text/csv;charset=utf-8" }), `내기록_법정보호종_${today()}.csv`);
    box.querySelector("input[type=file]").onchange = (e) => { if (e.target.files[0]) importCsv(e.target.files[0]); e.target.value = ""; };
    box.querySelector("[data-act=clear]").onclick = () => {
      const n = load().filter((r) => r.sp === sp.id).length;
      if (n && window.confirm(`${sp.ko} 내 기록 ${n}건을 지울까요?`)) { store(load().filter((r) => r.sp !== sp.id)); draw(); }
    };
    map.on("click", (e) => { if (state && state.map === map && state.picking) add(e.latlng.lat, e.latlng.lng); });
    draw();
  };
  const detach = () => { state = null; };
  return { attach, detach };
})();
