"""사이트에서 쓰는 자료 만들기(build_species.py·build_models.py 다음에 실행).

    python tools/build_site_data.py

- data/catalog.json: 종 목록 + 생태 특성(traits.tsv) + 모형 요약(서식지 층 포함)
- data/profiles.json: 문헌 프로필(tools/profiles/*.json)을 종 id 기준으로
- data/grid.json: 분석 격자 정보
- data/occ.json: 출현 기록 칸(경위도 약 250 m 칸 번호, 멸종위기종 종합관리 열지도와 같은 칸) — 기록마다의 좌표는 공개하지 않음
- 종별 분석리포트 통계(data/report/<id>.json)는 build_models.py가 만듦
"""
import json
import sys
import time
from pathlib import Path

from profiles_lib import load_profiles


ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / "work" / "env"
DATA = ROOT / "data"
GROUP_STRESS = {   # 분류군 기본 위협 요인(traits.tsv의 ‘민감’에 더함)
    "mammal": ["훼손", "소음", "로드킬", "단절"],
    "bird": ["훼손", "소음", "교란"],
    "herp": ["훼손", "로드킬", "수질", "단절"],
    "fish": ["수질", "단절", "수위"],
    "insect": ["훼손", "조명"],
    "invert": ["수질", "훼손"],
    "plant": ["훼손", "채집"],
    "algae": ["수질"],
    "fungi": ["훼손"],
}
ABSENT = {"호랑이", "표범", "늑대", "스라소니", "대륙사슴", "크낙새", "큰바다사자"}   # 남한에서 최근 야생 확인 기록이 없는 종


def load_traits():
    out = {}
    for line in (ROOT / "tools" / "traits.tsv").read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        p = (line.split("\t") + [""] * 5)[:5]
        out[p[0]] = {"habitat": [t for t in p[1].split(",") if t], "season": p[2], "extra": [t for t in p[3].split(",") if t], "note": p[4]}
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    grid = json.loads((ENV / "grid.json").read_text(encoding="utf-8"))
    W, H = grid["W"], grid["H"]
    species = json.loads((DATA / "species.json").read_text(encoding="utf-8"))["species"]
    models = json.loads((DATA / "models.json").read_text(encoding="utf-8"))
    traits = load_traits()

    # 종 카탈로그
    cat = []
    for s in species:
        tr = traits.get(s["ko"], {"habitat": [], "season": "", "extra": [], "note": ""})
        m = models.get(s["id"], {})
        stress = list(dict.fromkeys(GROUP_STRESS.get(s["group"], []) + tr["extra"]))
        cat.append({k: v for k, v in {
            "id": s["id"], "ko": s["ko"], "sci": s["sci"], "group": s["group"], "grade": s["grade"], "nm": s["nm"], "family": s["family"],
            "photo": s["photo"], "photoBy": s["photoBy"], "inat": s["inat"], "gbif": s["gbif"],
            "habitat": tr["habitat"], "season": tr["season"], "stress": stress, "note": tr["note"], "remark": s["note"],
            "absent": s["ko"] in ABSENT or None,
            "aqua": m.get("aqua"), "urban": m.get("urban"), "road": m.get("road"), "profile": m.get("profile"),
            "layers": m.get("layers"), "hab": sorted({g for L in (m.get("layers") or []) if L.get("main") for g in L["groups"]}) or None,
            "model": {k: m.get(k) for k in ("method", "auc", "tLo", "threshold", "tHi", "importance", "vars", "suitableKm2", "cells", "sgg", "noRecord", "reason") if m.get(k) is not None},
        }.items() if v not in (None, "", [])})
    profiles = load_profiles()
    by_ko = {s["ko"]: s["id"] for s in species}
    (DATA / "profiles.json").write_text(json.dumps({by_ko[k]: v for k, v in profiles.items() if k in by_ko}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (DATA / "catalog.json").write_text(json.dumps({"generatedAt": time.strftime("%Y-%m-%d"), "species": cat}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"catalog {len(cat)}종")

    # 출현 기록 칸(경위도 약 250 m)
    geo_dir = ROOT / "work" / "occ_geo"
    ok_dir = ROOT / "work" / "occ_geo_ok"   # build_models.py가 현재 토지이용과 맞지 않는 기록을 거른 것
    occ = {}
    for s in species:
        p = ok_dir / f"{s['id']}.json"
        if not p.exists():
            p = geo_dir / f"{s['id']}.json"
        cells = json.loads(p.read_text(encoding="utf-8")) if p.exists() else []
        if cells:
            occ[s["id"]] = cells
    geo_grid = json.loads((geo_dir / "_grid.json").read_text(encoding="utf-8"))
    (DATA / "occ.json").write_text(json.dumps({"grid": geo_grid, "species": occ}, separators=(",", ":")), encoding="utf-8")
    print(f"출현 칸 {sum(len(v) for v in occ.values()):,}개({len(occ)}종)")
    (DATA / "grid.json").write_text(json.dumps({
        "crs": grid["crs"], "proj": "+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs",
        "res": grid["res"], "W": W, "H": H, "x0": grid["x0"], "y1": grid["y1"], "sources": grid["sources"],
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
