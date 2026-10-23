"""종별 서식지적합성 계산 → 적합성 격자(PNG)·모형 정보.

    python tools/build_models.py               # 모든 종
    python tools/build_models.py 종id 종id      # 일부만

- 환경: work/env/env.npz(250 m 격자 15변수), 출현: work/occ/<id>.json(격자 칸), 특성: tools/traits.tsv
- 출현 칸이 MIN_CELLS 이상인 종: MaxEnt(elapid, 선형·이차·힌지 특징, 정규화 β=1.5, cloglog 출력)
  · 배경: 모든 종의 출현 칸을 합친 ‘조사가 이루어진 곳’에서 뽑아 표본 편향을 줄임(target-group background)
  · 3겹 교차검증 AUC. 등급 기준은 학습 출현 칸 예측값의 분위수: 가능 P10(출현 칸 90%), 적합 P20(80%), 매우 적합 P50(절반)
    변수 기여는 순열 중요도(AUC 감소)
  · 서식지 유형으로 모형값을 깎는 보정(AOH)은 수역 자료에 작은 하천이 안 잡혀 실제 출현지까지 지워져 쓰지 않음
- 출현 칸이 적은 종·해양 종: traits.tsv의 서식 태그로 만든 서식 규칙 지수(통계 모형이 아님 — 사이트에 따로 표시)
- 시가지(주거·상업·공업 등)·도로·철도·나대지(채광지·운동장·기타나지)는 서식지가 아님: 적합도와 적합 면적을 칸 안 그 비율만큼 뺌
- 도로 영향권: 주변으로 번진 도로 비율(road_eff, 0–1)만큼 적합도를 낮춤. 최대 낮춤은 종 민감도에 따라
  (로드킬·소음·교란·단절에 민감한 포유류·조류·양서파충류 60%, 그 밖의 동물 30%, 육상식물 20%, 어류·물에 사는 무척추·식물 0%)
  (서식 태그에 ‘도시’가 있는 종은 빼지 않음)
- 기록 거르기: 현재 토지이용과 맞지 않는 기록은 학습·분포 범위·사이트 표시에서 뺌(대도시 한가운데(도시 지수 0.45 이상)와
  동물원 주변 1.5 km는 모든 종, 땅 종은 시가지·도로·나대지 80% 이상인 칸,
  물 종은 주변 250 m에 그 물이 없는 칸, 바다 종은 실제 해안에서 2 km 넘게 떨어진 칸)
- 대도시·도심: 도시 지수 = max(주변 1 km 개발 비율, 주변 5 km 개발 비율×0.8). 0.12~0.35에 걸쳐 적합도를 0까지 낮춤(모든 종).
- 외딴 기록: 기록 칸이 20개 이상인 종은 10 km 안에 다른 기록이 없는 칸과 기록 1건뿐인 시군구를 학습·분포 범위에서 뺌
  바다 종은 해안 1 km 안 칸만
- 물에 사는 종(서식 태그가 모두 하천·계곡·호소·습지·논습지·하구·갯벌·해양): 그 물이 있는 칸에서만 서식 가능,
  적합 면적은 칸 안의 물 면적(환경부 세분류 토지피복 비율)으로 셈
  가능 0.5, 적합 0.7, 매우 적합 0.85
- 알려진 분포 범위: 출현 칸에서 R km(조류 25, 포유류 15, 그 밖 5) 안과 기록이 있는 시군구(위치를 흐린 기록 포함, +2 km)는
  그대로, 그 밖은 R km에 걸쳐 0으로 낮춤. 칸·시군구 기록이 모두 없는 종은 ‘가능’까지만
- 문헌 프로필(tools/profiles/*.json)이 있는 종: 서식지 층(번식지·채식지 등)마다 그 토지피복·조건을 만족하는 칸만 → data/suit/<id>@<층>.webp,
  대표 지도는 main 층들의 최댓값
- 결과: data/suit/<id>.webp(무손실 회색조, 0–100 = 적합성×100을 5 단위로, 255 = 분석 범위 밖), data/models.json
"""
import json
import sys
import time
from pathlib import Path

from profiles_lib import load_profiles

import elapid
from pyproj import Transformer
from scipy.spatial import cKDTree
import geopandas as gpd
from rasterio.features import rasterize
from rasterio.transform import from_origin
import numpy as np
from PIL import Image
from sklearn.metrics import roc_auc_score
from scipy import ndimage
from sklearn.model_selection import StratifiedKFold

from build_site_data import GROUP_STRESS

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / "work" / "env"
OCC = ROOT / "work" / "occ"
SUIT = ROOT / "data" / "suit"
MIN_CELLS = 15
RANGE_KM = {"bird": 25, "mammal": 15}   # 알려진 분포(출현 칸·기록 시군구)에서 이 거리 안은 그대로, 그만큼 더 가면서 0으로. 그 밖의 분류군 5 km
RULE_T = (0.5, 0.7, 0.85)                 # 서식 조건 지수의 가능·적합·매우 적합 기준
OCC_SGG = ROOT / "work" / "occ_sgg"
N_BG = 10000
MARINE = {"해양"}
RNG = np.random.default_rng(20261023)
PROFILES = load_profiles()
SENSITIVE = {"로드킬", "소음", "교란", "단절"}
# 종 프로필에 vars가 없을 때 쓰는 환경변수(시가지·나대지는 학습 뒤 규칙으로 빼므로 넣지 않음)
DEFAULT_VARS = ["elev", "slope", "tree", "conifer", "grass", "paddy", "field", "bare", "rock", "wetland", "tidal", "river", "lake",
                "dist_river", "dist_lake", "dist_coast", "bio1", "bio4", "bio12", "bio15"]
URBAN_START, URBAN_ZERO = 0.12, 0.35   # 도시 지수(주변 1 km 개발 비율과 5 km 개발 비율×0.8 중 큰 값): 이 사이에서 적합도를 0까지 낮춤
OUTLIER = (20, 10)   # 기록 칸이 20개 이상인 종은 10 km 안에 다른 기록이 없는 외딴 기록·기록 1건뿐인 시군구를 뺌(길 잃은 개체·오동정)
ZOO_KM = 1.5   # 동물원·사육 시설에서 이 거리 안 기록은 뺌(방사·탈출·사육 개체)
ZOOS = {"서울대공원": (127.019, 37.427), "서울어린이대공원": (127.081, 37.548), "에버랜드": (127.203, 37.294), "청주동물원": (127.513, 36.651),
        "대전오월드": (127.399, 36.290), "광주우치동물원": (126.896, 35.222), "전주동물원": (127.137, 35.856), "대구달성공원": (128.580, 35.874),
        "국립백두대간수목원 호랑이숲": (128.946, 36.950), "서울동물원 과천": (127.012, 37.432)}


def road_alpha(group, stress, aq):
    """도로 영향으로 적합도를 최대 몇 할 낮출지(종 민감도). 물고기·물에 사는 무척추·식물은 0"""
    if group in ("fish", "algae") or (aq and group in ("invert", "plant", "fungi")):
        return 0.0
    if group in ("plant", "fungi"):
        return 0.2
    if group in ("mammal", "bird", "herp"):
        return 0.6 if SENSITIVE & set(stress) else 0.3
    return 0.3


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def load_traits():
    out = {}
    for line in (ROOT / "tools" / "traits.tsv").read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        p = (line.split("\t") + [""] * 5)[:5]
        out[p[0]] = {"habitat": [t for t in p[1].split(",") if t], "season": p[2], "extra": [t for t in p[3].split(",") if t], "note": p[4]}
    return out


# 물에 사는 종: 서식 태그가 모두 물 유형이면 그 물(토지피복 비율)이 있는 칸에서만 서식 가능으로 봄
AQUA = {"계곡": ["river"], "하천": ["river"], "대하천": ["river"], "호소": ["lake"], "습지": ["wetland", "lake"],
        "논습지": ["paddy", "wetland"], "하구": ["river", "tidal", "sea"], "갯벌": ["tidal"], "해양": ["sea"]}


def aqua_classes(tags):
    """모든 태그가 물 유형이면 그 토지피복 묶음들, 아니면 None"""
    if not tags or any(t not in AQUA for t in tags):
        return None
    return sorted({c for t in tags for c in AQUA[t]})


def rule_score(tags, E):
    """서식 태그별 0–1 점수 중 가장 큰 값(시가지는 깎음). 토지피복은 환경부 세분류 비율"""
    c = lambda v, a, b: np.clip((v - a) / (b - a), 0, 1)  # noqa: E731
    near_r = 1 - c(E["dist_river"], 0.1, 1.0)
    coast = 1 - c(E["dist_coast"], 0.5, 3.0)
    score = {
        "산림": E["tree"],
        "고산": c(E["elev"], 700, 1400) * np.maximum(E["tree"], E["grass"]),
        "계곡": near_r * c(E["slope"], 5, 20) * E["tree"],
        "하천": np.maximum(c(E["river"], 0, 0.05), 0.5 * near_r) * (1 - E["built"]),
        "대하천": c(E["river"], 0.03, 0.3),
        "호소": c(E["lake"] + E["wetland"], 0.02, 0.3),
        "논습지": np.maximum(c(E["paddy"], 0, 0.5), c(E["wetland"], 0, 0.2)),
        "습지": np.maximum(c(E["wetland"], 0, 0.2), 0.6 * c(E["lake"], 0, 0.3)),
        "하구": coast * np.maximum(c(E["river"], 0, 0.1), c(E["tidal"], 0, 0.2)),
        "갯벌": c(E["tidal"], 0, 0.2),
        "해안": coast,
        "섬": coast * E["tree"],
        "해양": np.maximum(c(E["sea"], 0, 0.2), 1 - c(E["dist_coast"], 0.0, 1.0)),
        "초지": E["grass"],
        "농경지": np.clip(E["paddy"] + E["field"], 0, 1),
        "암벽": np.maximum(c(E["rock"], 0, 0.05), c(E["slope"], 15, 35) * E["tree"] * 0.4),
        "동굴": c(E["slope"], 10, 30) * E["tree"] * 0.6,
        "사구": coast * np.maximum(E["bare"], E["grass"] * 0.5),
        "도시": E["built"],
    }
    s = np.zeros_like(E["tree"])
    for t in tags:
        if t in score:
            s = np.maximum(s, score[t])
    return np.clip(s, 0, 1)   # 시가지·나대지는 main()에서 칸 비율만큼 깎음


def to_img(path, vals, land):
    img = np.full(land.shape, 255, dtype=np.uint8)
    img[land] = np.clip(np.round(vals * 20) * 5, 0, 100).astype(np.uint8)   # 5% 단위(파일을 작게)
    Image.fromarray(img).save(path, lossless=True, quality=100, method=4)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    SUIT.mkdir(parents=True, exist_ok=True)
    grid = json.loads((ENV / "grid.json").read_text(encoding="utf-8"))
    z = np.load(ENV / "env.npz")
    land = z["land"]
    idx = np.flatnonzero(land.ravel())
    E = {n: z[n].ravel()[idx] for n in grid["names"] + grid.get("extra", [])}
    E["broad"] = np.clip(E["tree"] - E["conifer"], 0, 1)   # 활엽수림·혼효림(산림 − 침엽수림)
    names = grid["names"] + ["broad"]   # 모형에 쓸 수 있는 환경변수. 종 프로필의 vars로 종마다 고름
    X = np.column_stack([E[n] for n in names]).astype("float32")   # 육지 칸 × 변수
    pos = np.full(land.size, -1, dtype=np.int64)
    pos[idx] = np.arange(idx.size)
    traits = load_traits()
    species = json.loads((ROOT / "data" / "species.json").read_text(encoding="utf-8"))["species"]
    only = set(sys.argv[1:])
    W = grid["W"]

    def occ_rows(sid):
        cells = json.loads((OCC / f"{sid}.json").read_text(encoding="utf-8")) if (OCC / f"{sid}.json").exists() else []
        p = pos[[r * W + c for r, c in cells]] if cells else np.array([], dtype=np.int64)
        return np.unique(p[p >= 0])

    def write(name, pred):
        vals = np.zeros(land.shape, dtype="float32")
        vals.ravel()[idx] = pred
        to_img(SUIT / f"{name}.webp", vals[land], land)

    # 문헌 프로필의 서식지 층: 토지피복 묶음 비율(활엽·혼효 = 산림 − 침엽), 가까이 있어야 할 것까지 거리, 고도
    def group_frac(groups):
        g, f = set(groups), np.zeros(idx.size, dtype="float32")
        if g & {"broad", "mixed"}:
            f += np.clip(E["tree"] - E["conifer"], 0, 1)
        if "conifer" in g:
            f += E["conifer"]
        for k in g - {"broad", "mixed", "conifer"}:
            f += E[k]
        return np.clip(f, 0, 1)

    def layer_mask(L):
        frac = group_frac(L["groups"])
        m = frac > max(0.001, L.get("cell_min", 0))
        for nr in L.get("near", []):
            src = full(group_frac(nr["groups"])) >= nr.get("min", 0.01)
            m &= (ndimage.distance_transform_edt(~src) * grid["res"] / 1000).ravel()[idx] <= nr["km"]
        if "elev" in L:
            m &= (E["elev"] >= L["elev"][0]) & (E["elev"] <= L["elev"][1])
        if "slope" in L:   # 경사(°) 범위 — 산양처럼 급경사 암벽이 필요한 종
            m &= (E["slope"] >= L["slope"][0]) & (E["slope"] <= L["slope"][1])
        if "coast_km" in L:   # 실제 해안에서 이 거리 안(바다 종·해안 종)
            m &= E["dist_coast"] <= L["coast_km"]
        return m, frac

    # 시군구(GADM 코드) 격자 — 기록이 있는 시군구를 분포 범위로 쓰기 위해
    sg = gpd.read_file(ENV / "sgg_gadm.geojson").set_crs(4326, allow_override=True).to_crs(grid["crs"])
    gid_idx = {g: i + 1 for i, g in enumerate(sg["gid"])}
    sgg_r = rasterize(((geom, i + 1) for i, geom in enumerate(sg.geometry)), out_shape=land.shape,
                      transform=from_origin(grid["x0"], grid["y1"], grid["res"], grid["res"]), fill=0, dtype="int16")

    def range_weight(group, pres, gids, rng=None):
        """알려진 분포 범위 가중치(0–1): 출현 칸에서 R km 안과 기록 시군구(+2 km)는 1, 그 밖은 R km에 걸쳐 0으로. 기록이 없으면 None
        rng: 문헌 프로필의 범위 조정 {"km": R, "sgg": 시군구 기록을 쓸지}"""
        if rng and rng.get("sgg") is False:
            gids = []
        if not pres.size and not gids:
            return None
        R = (rng or {}).get("km", RANGE_KM.get(group, 5))
        seen = np.zeros(land.size, dtype=bool)
        seen[idx[pres]] = True
        d_cell = ndimage.distance_transform_edt(~seen.reshape(land.shape)) * grid["res"] / 1000
        known = d_cell <= R
        if gids:
            in_sgg = np.isin(sgg_r, [gid_idx[g] for g in gids if g in gid_idx])
            known |= ndimage.distance_transform_edt(~in_sgg) * grid["res"] / 1000 <= 2
        d = ndimage.distance_transform_edt(~known) * grid["res"] / 1000
        return np.clip(1 - d / R, 0, 1).ravel()[idx]

    to5179 = Transformer.from_crs(4326, grid["crs"], always_xy=True)

    # 현재 토지이용과 맞지 않는 기록 거르기(땅 종: 시가지·도로·나대지 80% 이상인 칸, 물 종: 주변 250 m에 그 물이 없는 칸,
    # 바다 종: 실제 해안에서 2 km 넘게 떨어진 칸)
    def full(a):
        out = np.zeros(land.size, dtype="float32")
        out[idx] = a
        return out.reshape(land.shape)

    urban_idx = np.maximum(E["urban_ctx"], 0.8 * E["urban_reg"])
    zx, zy = to5179.transform([v[0] for v in ZOOS.values()], [v[1] for v in ZOOS.values()])
    zoo = np.zeros(land.shape, dtype=bool)
    for x, y in zip(zx, zy):
        zoo[int((grid["y1"] - y) // grid["res"]), int((x - grid["x0"]) // grid["res"])] = True
    near_zoo = (ndimage.distance_transform_edt(~zoo) * grid["res"] / 1000 <= ZOO_KM).ravel()[idx]

    def record_ok(tags, aq):
        common = (urban_idx < URBAN_ZERO) & ~near_zoo   # 대도시 한가운데·동물원 주변 기록은 모든 종에서 뺌
        if "해양" in tags:
            return common & (E["dist_coast"] <= 2)
        if aq:
            return common & (ndimage.maximum_filter(full(sum(E[k] for k in aq)), size=3).ravel()[idx] > 0.001)
        return common & ((1 - E["built"] - E["road"] - E["artbare"]) >= 0.2)

    # 사이트에 보여 줄 기록 칸(경위도 약 250 m)도 같은 기준으로 거름
    geo_grid = json.loads((ROOT / "work" / "occ_geo" / "_grid.json").read_text(encoding="utf-8"))
    OK_GEO = ROOT / "work" / "occ_geo_ok"
    OK_GEO.mkdir(exist_ok=True)

    def filter_geo(sid, ok, keep_sea):
        f = ROOT / "work" / "occ_geo" / f"{sid}.json"
        cells = np.array(json.loads(f.read_text(encoding="utf-8")) if f.exists() else [], dtype=np.int64)
        if cells.size:
            i, j = np.divmod(cells, geo_grid["w"])
            x, y = to5179.transform(geo_grid["lng0"] + (j + 0.5) * geo_grid["dlng"], geo_grid["lat0"] + (i + 0.5) * geo_grid["dlat"])
            r, c = np.floor((grid["y1"] - y) / grid["res"]).astype(int), np.floor((x - grid["x0"]) / grid["res"]).astype(int)
            inside = (r >= 0) & (r < land.shape[0]) & (c >= 0) & (c < land.shape[1])
            pp = np.full(cells.size, -1)
            pp[inside] = pos[r[inside] * W + c[inside]]
            keep = np.where(pp >= 0, ok[np.maximum(pp, 0)], keep_sea)
            cells = cells[keep]
        (OK_GEO / f"{sid}.json").write_text(json.dumps(cells.tolist()), encoding="utf-8")

    # 조사 노력(모든 종의 출현 칸) 배경
    effort = np.unique(np.concatenate([occ_rows(s["id"]) for s in species] or [np.array([], dtype=np.int64)]))
    log(f"육지 {idx.size:,}칸 · 조사 노력 칸 {effort.size:,}")
    models_path = ROOT / "data" / "models.json"
    models = json.loads(models_path.read_text(encoding="utf-8")) if models_path.exists() and only else {}

    for s in species:
        if only and s["id"] not in only:
            continue
        t0 = time.time()
        tr = traits.get(s["ko"], {"habitat": [], "season": "", "extra": [], "note": ""})
        aq = aqua_classes(tr["habitat"])
        ok = record_ok(tr["habitat"], aq)
        pres_all = occ_rows(s["id"])
        pres = pres_all[ok[pres_all]]
        gids = json.loads((OCC_SGG / f"{s['id']}.json").read_text(encoding="utf-8")) if (OCC_SGG / f"{s['id']}.json").exists() else {}
        if pres.size >= OUTLIER[0]:   # 외딴 기록 빼기
            rr, cc = np.divmod(idx[pres], W)
            xy = np.column_stack([cc, rr]) * grid["res"] / 1000
            nb = np.array([len(v) for v in cKDTree(xy).query_ball_point(xy, OUTLIER[1])])
            info_out = int((nb < 2).sum())
            pres = pres[nb >= 2]
            gids = {g: n for g, n in gids.items() if n >= 2}
        else:
            info_out = 0
        kept = np.zeros(idx.size, dtype=bool)
        kept[pres] = True
        filter_geo(s["id"], kept, "해양" in tr["habitat"])   # 사이트에 보여 줄 기록도 학습에 쓴 칸만
        marine = bool(tr["habitat"]) and set(tr["habitat"]) <= MARINE | {"섬", "해안"} and "해양" in tr["habitat"]
        info = {"cells": int(pres.size), "habitat": tr["habitat"], "dropped": int(pres_all.size - pres.size), "outliers": info_out}
        if pres.size >= MIN_CELLS and not marine:
            bg_pool = np.setdiff1d(effort, pres)
            if bg_pool.size < N_BG:   # 조사 노력 칸이 모자라면 육지 무작위로 채움
                bg_pool = np.union1d(bg_pool, RNG.choice(idx.size, N_BG, replace=False))
            bg = RNG.choice(bg_pool, min(N_BG, bg_pool.size), replace=False)
            xi = np.concatenate([pres, bg])
            y = np.concatenate([np.ones(pres.size), np.zeros(bg.size)])
            vnames = [v for v in ((PROFILES.get(s["ko"]) or {}).get("vars") or DEFAULT_VARS) if v in names]
            cols = [names.index(v) for v in vnames]
            Xs = X[:, cols]
            Xt = Xs[xi]
            mk = lambda: elapid.MaxentModel(feature_types=["linear", "quadratic", "hinge"], beta_multiplier=1.5, transform="cloglog")  # noqa: E731
            aucs = []
            for a, b in StratifiedKFold(3, shuffle=True, random_state=1).split(Xt, y):
                m = mk().fit(Xt[a], y[a])
                aucs.append(roc_auc_score(y[b], m.predict(Xt[b])))
            m = mk().fit(Xt, y)
            p_tr = m.predict(Xt)
            base = roc_auc_score(y, p_tr)
            imp = {}
            for j, n in enumerate(vnames):
                Xp = Xt.copy()
                Xp[:, j] = RNG.permutation(Xp[:, j])
                imp[n] = max(0.0, base - roc_auc_score(y, m.predict(Xp)))
            tot = sum(imp.values()) or 1
            pred = np.concatenate([m.predict(Xs[k:k + 100000]) for k in range(0, Xs.shape[0], 100000)])
            info.update({"method": "maxent", "vars": vnames, "auc": round(float(np.mean(aucs)), 3), "aucTrain": round(float(base), 3),
                         "tLo": round(float(np.percentile(p_tr[:pres.size], 10)), 3), "threshold": round(float(np.percentile(p_tr[:pres.size], 20)), 3),
                         "tHi": round(float(np.percentile(p_tr[:pres.size], 50)), 3), "importance": {k: round(v / tot * 100, 1) for k, v in sorted(imp.items(), key=lambda x: -x[1]) if v > 0}})
        else:
            pred = rule_score(tr["habitat"], E) if tr["habitat"] else np.zeros(idx.size, dtype="float32")
            info.update({"method": "rule" if tr["habitat"] else "none", "tLo": RULE_T[0], "threshold": RULE_T[1], "tHi": RULE_T[2],
                         "reason": "해양 종" if marine else f"출현 칸 {pres.size}개(모형에는 {MIN_CELLS}개 이상 필요)"})
        # 알려진 분포 범위 밖은 환경이 비슷해도 낮춤(바다 종은 바다 기록이 시군구로 잡힘). 칸·시군구 기록이 모두 없으면 ‘가능’까지만
        wgt = range_weight(s["group"], pres, list(gids), (PROFILES.get(s["ko"]) or {}).get("range"))
        if wgt is None:
            pred = np.minimum(pred, info["threshold"] - 0.05)
            info["noRecord"] = True
        else:
            pred = pred * wgt
        info["sgg"] = len(gids)
        area = np.ones(idx.size, dtype="float32")
        if aq:   # 물에 사는 종: 그 물이 없는 칸은 0, 면적은 칸 안의 물 면적만
            area = np.clip(sum(E[k] for k in aq), 0, 1)
            pred = np.where(area > 0.001, pred, 0)
            info["aqua"] = aq
        else:   # 시가지(마을 등)·도로·나대지는 서식지가 아님: 적합도와 면적을 그 비율만큼 뺌
            area = np.clip(1 - E["built"] - E["road"] - E["artbare"], 0, 1)
            pred = pred * area
        alpha = road_alpha(s["group"], GROUP_STRESS.get(s["group"], []) + tr["extra"], aq)
        if alpha:   # 도로 영향권(소음·불빛·로드킬·단절): 도로 가까이일수록 낮춤
            pred = pred * (1 - alpha * E["road_eff"])
            info["road"] = alpha
        # 대도시·도심: 도시 지수가 15%를 넘으면 낮추기 시작해 45% 이상이면 0(모든 종)
        pred = pred * (1 - np.clip((urban_idx - URBAN_START) / (URBAN_ZERO - URBAN_START), 0, 1))
        if "해양" in tr["habitat"]:   # 바다 종: 실제 해안에서 1 km 안 칸만
            pred = np.where(E["dist_coast"] <= 1, pred, 0)
        km2 = (grid["res"] / 1000) ** 2
        prof = PROFILES.get(s["ko"])
        if prof:   # 문헌 프로필: 서식지 층마다 그 토지피복이 있고 조건(가까운 물·숲, 고도)을 만족하는 칸만. 대표 지도는 main 층들의 최댓값
            info["profile"], info["layers"] = True, []
            main_pred, main_area = np.zeros_like(pred), np.zeros_like(pred)
            for L in prof["layers"]:
                m, frac = layer_mask(L)
                pL = np.where(m, pred, 0)
                write(f"{s['id']}@{L['key']}", pL)
                info["layers"].append({k: L[k] for k in ("key", "name", "season", "main", "groups", "desc") if k in L}
                                      | {"suitableKm2": round(float(frac[pL >= info["threshold"]].sum()) * km2, 1)})
                if L.get("main"):
                    main_pred = np.maximum(main_pred, pL)
                    main_area = np.minimum(1, main_area + np.where(m, frac, 0))
            pred, area = main_pred, main_area
        write(s["id"], pred)
        p_hi = pred >= info["threshold"]
        info["suitableKm2"] = round(float(area[p_hi].sum()) * km2, 1)
        models[s["id"]] = info
        log(f"{s['ko']}: {info['method']} 칸 {pres.size} AUC {info.get('auc', '-')} 적합 {info['suitableKm2']:,}㎢ · {time.time() - t0:.0f}s")
        models_path.write_text(json.dumps(models, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
