"""대상 종 목록과 출현 칸 만들기.

    python tools/build_species.py

- 멸종위기 야생생물 Ⅰ·Ⅱ급 282종: 멸종위기종 종합관리 사이트(../멸종위기종 종합관리)의 종 목록·출현 격자를 그대로 씀
  (GBIF 약 250 m 격자 건수 heat-gbif.json + iNaturalist 관찰 격자 inat-snapshot.json)
- 천연기념물(종 단위 지정): 국가유산청 국가유산 검색 오픈API(천연기념물, 지정 해제 제외)에서 지역 구분이 ‘기타’인 종과
  지역을 붙여 종으로 지정한 것(황쏘가리·어름치·한란). 가축 품종·장소 지정(노거수·숲·동굴)은 뺌.
  멸종위기종과 겹치면 그 종에 천연기념물 번호를 붙이고, 아닌 종은 GBIF에서 국내 기록을 받음
- 결과: data/species.json(공개), work/occ/<종 id>.json(분석 격자 UTM-K 250 m의 출현 칸),
  work/occ_geo/<종 id>.json(원래 경위도 약 250 m 칸 번호 — 멸종위기종 종합관리 열지도와 같은 칸, 사이트 표시·거리 계산용)
- 위치 오차가 1 km를 넘는 기록과 iNaturalist가 위치를 흐린 관찰은 뺌(멸종위기종 종합관리와 같은 기준)
"""
import json
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
END = ROOT.parent / "멸종위기종 종합관리"
OCC = ROOT / "work" / "occ"
OCC_GEO = ROOT / "work" / "occ_geo"
MAX_UNC = 1000   # 위치 오차 한도(m)
NM_API = "https://www.khs.go.kr/cha/SearchKindOpenapiList.do?ccbaKdcd=16&pageUnit=2000&pageIndex=1"
NM_REGIONAL = {"한강의 황쏘가리": "황쏘가리", "금강의 어름치": "어름치", "제주의 한란": "한란"}   # 지역을 붙인 종 지정
NM_ALIAS = {"점박이물범": "물범", "느시(들칠면조)": "느시", "붉은박쥐(오렌지윗수염박쥐)": "붉은박쥐", "까막딱따구리": "까막딱다구리"}   # 천연기념물 이름 → 멸종위기종 목록 이름
# 멸종위기종이 아닌 천연기념물 종의 학명(GBIF 이름 맞추기용)
NM_SCI = {
    "원앙": "Aix galericulata", "소쩍새": "Otus sunia", "큰소쩍새": "Otus semitorques", "솔부엉이": "Ninox japonica",
    "쇠부엉이": "Asio flammeus", "칡부엉이": "Asio otus", "황조롱이": "Falco tinnunculus", "두견": "Cuculus poliocephalus",
    "개구리매": "Circus spilonotus", "알락개구리매": "Circus melanoleucos", "새매": "Accipiter nisus", "참매": "Accipiter gentilis",
    "붉은배새매": "Accipiter soloensis", "잿빛개구리매": "Circus cyaneus", "올빼미": "Strix aluco", "수리부엉이": "Bubo bubo",
    "고니": "Cygnus columbianus", "큰고니": "Cygnus cygnus", "혹고니": "Cygnus olor", "독수리": "Aegypius monachus",
    "검은목두루미": "Grus grus", "호사도요": "Rostratula benghalensis", "뜸부기": "Gallicrex cinerea", "황쏘가리": "Siniperca scherzeri",
    "한란": "Cymbidium kanran", "긴가지해송": "Myriopathes lata", "해송": "Myriopathes japonica", "매": "Falco peregrinus",
}
NM_GROUP = {"원앙": "bird", "황쏘가리": "fish", "한란": "plant", "긴가지해송": "invert", "해송": "invert"}
UA = {"User-Agent": "habitat.biogrideia.com species build (cirmax82-beep)"}


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read().decode("utf-8")
        except Exception:   # noqa: BLE001 — 잠깐 끊기면 다시
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def natural_monuments():
    t = get(NM_API)
    out = []
    for it in re.findall(r"<item>(.*?)</item>", t, re.S):
        g = lambda k: (re.search(rf"<{k}>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</{k}>", it, re.S) or [None, ""])[1].strip()  # noqa: E731
        if g("ccbaCncl") == "Y":
            continue
        name, region, asno = g("ccbaMnm1"), g("ccbaCtcdNm"), g("ccbaAsno")
        if any(w in name for w in ("해면", "도래지", "번식지", "서식지")):   # 장소 지정
            continue
        if region == "기타" or name in NM_REGIONAL:
            no = int(asno[:7]) if asno[:7].isdigit() else 0
            sub = int(asno[7:9]) if asno[7:9].isdigit() else 0
            out.append({"name": NM_REGIONAL.get(name, name), "title": name, "no": f"제{no // 10}호" + (f"-{sub}" if sub else "")})
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    OCC.mkdir(parents=True, exist_ok=True)
    OCC_GEO.mkdir(parents=True, exist_ok=True)
    grid = json.loads((ROOT / "work" / "env" / "grid.json").read_text(encoding="utf-8"))
    to5179 = Transformer.from_crs(4326, 5179, always_xy=True)

    def cells(lons, lats):
        x, y = to5179.transform(np.asarray(lons, float), np.asarray(lats, float))
        c = np.floor((x - grid["x0"]) / grid["res"]).astype(int)
        r = np.floor((grid["y1"] - y) / grid["res"]).astype(int)
        ok = (c >= 0) & (c < grid["W"]) & (r >= 0) & (r < grid["H"])
        return sorted({(int(a), int(b)) for a, b in zip(r[ok], c[ok])})

    # 멸종위기종 목록·출현 격자
    js = subprocess.run(["node", "-e", "global.window={};require(process.argv[1]);process.stdout.write(JSON.stringify(window.SPECIES_CATALOG))",
                         str(END / "js" / "data-species.js")], capture_output=True, text=True, encoding="utf-8", check=True).stdout
    cat = json.loads(js)
    heat = json.loads((END / "data" / "heat-gbif.json").read_text(encoding="utf-8"))
    inat = json.loads((END / "data" / "inat-snapshot.json").read_text(encoding="utf-8"))
    g = heat["grid"]

    (OCC_GEO / "_grid.json").write_text(json.dumps(g), encoding="utf-8")

    def center(cell):
        i, j = divmod(cell, g["w"])
        return g["lng0"] + (j + 0.5) * g["dlng"], g["lat0"] + (i + 0.5) * g["dlat"]

    def geo_cell(lng, lat):
        i, j = int((lat - g["lat0"]) // g["dlat"]), int((lng - g["lng0"]) // g["dlng"])
        return i * g["w"] + j if i >= 0 and 0 <= j < g["w"] else None

    species = []
    for s in cat:
        flat = heat["species"].get(s["id"], [])
        hc = [flat[k] for k in range(0, len(flat), 3)]
        ic = [o[-1] for o in inat["obs"].get(s["id"], []) if o[-1] is not None and o[-1] >= 0]
        geo = sorted(set(hc) | set(ic))
        pts = [center(c) for c in geo]
        occ = cells([p[0] for p in pts], [p[1] for p in pts]) if pts else []
        (OCC / f"{s['id']}.json").write_text(json.dumps(occ), encoding="utf-8")
        (OCC_GEO / f"{s['id']}.json").write_text(json.dumps(geo), encoding="utf-8")
        photo = inat["taxa"].get(s["id"], {})
        species.append({"id": s["id"], "ko": s["name"], "sci": s["sci"], "group": s["group"], "grade": s["grade"], "family": s.get("family", ""),
                        "nm": "", "gbif": s.get("gbif"), "note": s.get("note", ""), "cells": len(occ),
                        "photo": photo.get("photo", ""), "photoBy": photo.get("by", ""), "inat": s.get("inat")})
    by_ko = {s["ko"]: s for s in species}

    # 천연기념물(종)
    extra = []
    for n in natural_monuments():
        ko = NM_ALIAS.get(n["name"], n["name"])
        if ko in by_ko:
            by_ko[ko]["nm"] = (by_ko[ko]["nm"] + ", " if by_ko[ko]["nm"] else "") + n["no"]
            continue
        sci = NM_SCI.get(n["name"])
        if not sci:
            print("  학명 없음(건너뜀):", n)
            continue
        extra.append((n, sci))
    for n, sci in extra:
        m = json.loads(get("https://api.gbif.org/v1/species/match?" + urllib.parse.urlencode({"name": sci, "kingdom": "Animalia" if n["name"] != "한란" else "Plantae"})))
        key = m.get("usageKey")
        lons, lats, uncs = [], [], []
        cache = ROOT / "work" / "gbif" / f"{key}-unc.json"   # [경도, 위도, 위치 오차(m, 없으면 -1)]
        if key and cache.exists():
            lons, lats, uncs = json.loads(cache.read_text(encoding="utf-8"))
        elif key:
            for off in range(0, 6000, 300):
                d = json.loads(get("https://api.gbif.org/v1/occurrence/search?" + urllib.parse.urlencode(
                    {"taxonKey": key, "country": "KR", "hasCoordinate": "true", "hasGeospatialIssue": "false", "limit": 300, "offset": off})))
                for r in d["results"]:
                    u = r.get("coordinateUncertaintyInMeters")
                    lons.append(r["decimalLongitude"]); lats.append(r["decimalLatitude"]); uncs.append(-1 if u is None else u)
                if d.get("endOfRecords"):
                    break
            cache.parent.mkdir(exist_ok=True)
            cache.write_text(json.dumps([lons, lats, uncs]), encoding="utf-8")
        keep = [k for k, u in enumerate(uncs) if u <= MAX_UNC]
        lons, lats = [lons[k] for k in keep], [lats[k] for k in keep]
        # iNaturalist 대표 사진(공개 이용 허락이 있는 것만)
        photo, photo_by, inat_id = "", "", None
        try:
            t = json.loads(get("https://api.inaturalist.org/v1/taxa?" + urllib.parse.urlencode({"q": sci, "rank": "species", "per_page": 3})))
            r = next((x for x in t.get("results", []) if x.get("name") == sci), None)
            ph = (r or {}).get("default_photo") or {}
            m = re.search(r"//(inaturalist-open-data\.s3\.amazonaws\.com|static\.inaturalist\.org)/photos/(\d+)/square\.(\w+)", ph.get("square_url") or "")
            if r:
                inat_id = r["id"]
            if m and ph.get("license_code"):
                photo, photo_by = f"{'o' if m.group(1).startswith('inaturalist-open-data') else 's'}{m.group(2)}.{m.group(3)}", ph.get("attribution", "")
        except Exception as e:   # noqa: BLE001 — 사진은 없어도 됨
            print("  사진 못 받음:", sci, e)
        sid = re.sub(r"[^a-z0-9]+", "-", sci.lower()).strip("-")
        occ = cells(lons, lats) if lons else []
        (OCC / f"{sid}.json").write_text(json.dumps(occ), encoding="utf-8")
        geo = sorted({c for c in (geo_cell(x, y) for x, y in zip(lons, lats)) if c is not None})
        (OCC_GEO / f"{sid}.json").write_text(json.dumps(geo), encoding="utf-8")
        species.append({"id": sid, "ko": n["name"], "sci": sci, "group": NM_GROUP.get(n["name"], "bird"), "grade": "", "family": "",
                        "nm": n["no"], "gbif": key, "note": "", "cells": len(occ), "photo": photo, "photoBy": photo_by, "inat": inat_id})
        print(f"  천연기념물 {n['name']}({sci}) {n['no']} · GBIF {key} · 칸 {len(occ)}", flush=True)

    (ROOT / "data").mkdir(exist_ok=True)
    (ROOT / "data" / "species.json").write_text(json.dumps({"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "species": species},
                                                           ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    nm = sum(1 for s in species if s["nm"])
    print(f"종 {len(species)}(멸종위기 {sum(1 for s in species if s['grade'])}, 천연기념물 {nm}) · 출현 칸 있는 종 {sum(1 for s in species if s['cells'])}")


if __name__ == "__main__":
    main()
