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
- 물에 사는 종(서식 태그가 모두 하천·계곡·호소·습지·논습지·하구·갯벌·해양): 그 물이 있는 칸에서만 서식 가능,
  적합 면적은 칸 안의 물 면적(환경부 세분류 토지피복 비율)으로 셈
  가능 0.5, 적합 0.7, 매우 적합 0.85
- 알려진 분포 범위: 출현 칸에서 R km(조류 25, 포유류 15, 그 밖 5) 안과 기록이 있는 시군구(위치를 흐린 기록 포함, +2 km)는
  그대로, 그 밖은 R km에 걸쳐 0으로 낮춤. 칸·시군구 기록이 모두 없는 종은 ‘가능’까지만
- 결과: data/suit/<id>.webp(무손실 회색조, 0–100 = 적합성×100을 5 단위로, 255 = 분석 범위 밖), data/models.json
"""
import json
import sys
import time
from pathlib import Path

import elapid
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
SENSITIVE = {"로드킬", "소음", "교란", "단절"}


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
    names = grid["names"]
    idx = np.flatnonzero(land.ravel())
    X = np.column_stack([z[n].ravel()[idx] for n in names]).astype("float32")   # 육지 칸 × 변수
    E = {n: z[n].ravel()[idx] for n in names + grid.get("extra", [])}
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

    # 시군구(GADM 코드) 격자 — 기록이 있는 시군구를 분포 범위로 쓰기 위해
    sg = gpd.read_file(ENV / "sgg_gadm.geojson").set_crs(4326, allow_override=True).to_crs(grid["crs"])
    gid_idx = {g: i + 1 for i, g in enumerate(sg["gid"])}
    sgg_r = rasterize(((geom, i + 1) for i, geom in enumerate(sg.geometry)), out_shape=land.shape,
                      transform=from_origin(grid["x0"], grid["y1"], grid["res"], grid["res"]), fill=0, dtype="int16")

    def range_weight(group, pres, gids):
        """알려진 분포 범위 가중치(0–1): 출현 칸에서 R km 안과 기록 시군구(+2 km)는 1, 그 밖은 R km에 걸쳐 0으로. 기록이 없으면 None"""
        if not pres.size and not gids:
            return None
        R = RANGE_KM.get(group, 5)
        seen = np.zeros(land.size, dtype=bool)
        seen[idx[pres]] = True
        d_cell = ndimage.distance_transform_edt(~seen.reshape(land.shape)) * grid["res"] / 1000
        known = d_cell <= R
        if gids:
            in_sgg = np.isin(sgg_r, [gid_idx[g] for g in gids if g in gid_idx])
            known |= ndimage.distance_transform_edt(~in_sgg) * grid["res"] / 1000 <= 2
        d = ndimage.distance_transform_edt(~known) * grid["res"] / 1000
        return np.clip(1 - d / R, 0, 1).ravel()[idx]

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
        pres = occ_rows(s["id"])
        marine = bool(tr["habitat"]) and set(tr["habitat"]) <= MARINE | {"섬", "해안"} and "해양" in tr["habitat"]
        info = {"cells": int(pres.size), "habitat": tr["habitat"]}
        if pres.size >= MIN_CELLS and not marine:
            bg_pool = np.setdiff1d(effort, pres)
            if bg_pool.size < N_BG:   # 조사 노력 칸이 모자라면 육지 무작위로 채움
                bg_pool = np.union1d(bg_pool, RNG.choice(idx.size, N_BG, replace=False))
            bg = RNG.choice(bg_pool, min(N_BG, bg_pool.size), replace=False)
            xi = np.concatenate([pres, bg])
            y = np.concatenate([np.ones(pres.size), np.zeros(bg.size)])
            Xt = X[xi]
            mk = lambda: elapid.MaxentModel(feature_types=["linear", "quadratic", "hinge"], beta_multiplier=1.5, transform="cloglog")  # noqa: E731
            aucs = []
            for a, b in StratifiedKFold(3, shuffle=True, random_state=1).split(Xt, y):
                m = mk().fit(Xt[a], y[a])
                aucs.append(roc_auc_score(y[b], m.predict(Xt[b])))
            m = mk().fit(Xt, y)
            p_tr = m.predict(Xt)
            base = roc_auc_score(y, p_tr)
            imp = {}
            for j, n in enumerate(names):
                Xp = Xt.copy()
                Xp[:, j] = RNG.permutation(Xp[:, j])
                imp[n] = max(0.0, base - roc_auc_score(y, m.predict(Xp)))
            tot = sum(imp.values()) or 1
            pred = np.concatenate([m.predict(X[k:k + 100000]) for k in range(0, X.shape[0], 100000)])
            info.update({"method": "maxent", "auc": round(float(np.mean(aucs)), 3), "aucTrain": round(float(base), 3),
                         "tLo": round(float(np.percentile(p_tr[:pres.size], 10)), 3), "threshold": round(float(np.percentile(p_tr[:pres.size], 20)), 3),
                         "tHi": round(float(np.percentile(p_tr[:pres.size], 50)), 3), "importance": {k: round(v / tot * 100, 1) for k, v in sorted(imp.items(), key=lambda x: -x[1]) if v > 0}})
        else:
            pred = rule_score(tr["habitat"], E) if tr["habitat"] else np.zeros(idx.size, dtype="float32")
            info.update({"method": "rule" if tr["habitat"] else "none", "tLo": RULE_T[0], "threshold": RULE_T[1], "tHi": RULE_T[2],
                         "reason": "해양 종" if marine else f"출현 칸 {pres.size}개(모형에는 {MIN_CELLS}개 이상 필요)"})
        # 알려진 분포 범위 밖은 환경이 비슷해도 낮춤(바다 종 제외). 칸·시군구 기록이 모두 없으면 ‘가능’까지만
        gids = json.loads((OCC_SGG / f"{s['id']}.json").read_text(encoding="utf-8")) if (OCC_SGG / f"{s['id']}.json").exists() else []
        if not marine:
            wgt = range_weight(s["group"], pres, gids)
            if wgt is None:
                pred = np.minimum(pred, info["threshold"] - 0.05)
                info["noRecord"] = True
            else:
                pred = pred * wgt
        info["sgg"] = len(gids)
        aq = aqua_classes(tr["habitat"])
        area = np.ones(idx.size, dtype="float32")
        if aq:   # 물에 사는 종: 그 물이 없는 칸은 0, 면적은 칸 안의 물 면적만
            area = np.clip(sum(E[k] for k in aq), 0, 1)
            pred = np.where(area > 0.001, pred, 0)
            info["aqua"] = aq
        elif "도시" not in tr["habitat"]:   # 시가지(마을 등)·도로·나대지는 서식지가 아님: 적합도와 면적을 그 비율만큼 뺌
            area = np.clip(1 - E["built"] - E["road"] - E["artbare"], 0, 1)
            pred = pred * area
        else:
            info["urban"] = True
        alpha = 0.0 if info.get("urban") else road_alpha(s["group"], GROUP_STRESS.get(s["group"], []) + tr["extra"], aq)
        if alpha:   # 도로 영향권(소음·불빛·로드킬·단절): 도로 가까이일수록 낮춤
            pred = pred * (1 - alpha * E["road_eff"])
            info["road"] = alpha
        vals = np.zeros(land.shape, dtype="float32")
        vals.ravel()[idx] = pred
        to_img(SUIT / f"{s['id']}.webp", vals[land], land)
        p_hi = pred >= info["threshold"]
        info["suitableKm2"] = round(float(area[p_hi].sum()) * (grid["res"] / 1000) ** 2, 1)
        models[s["id"]] = info
        log(f"{s['ko']}: {info['method']} 칸 {pres.size} AUC {info.get('auc', '-')} 적합 {info['suitableKm2']:,}㎢ · {time.time() - t0:.0f}s")
        models_path.write_text(json.dumps(models, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
