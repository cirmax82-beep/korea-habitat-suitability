"""환경부 세분류 토지피복지도(2025년 전국 현행화)를 분석 격자(UTM-K 250 m) 칸별 비율로.

    python tools/fetch_landcover.py

- 기후에너지환경부 환경공간정보서비스 토지피복지도 맵 서비스(WMS, 인증키 없음) EGIS:lv3_2025y를
  20 km 사방(10 m 해상도, 2000×2000) 그림으로 받아, 범례의 분류별 고유 색으로 분류를 되살림(테두리 흐림 끔)
- 칸마다 625개 표본(10 m)으로 묶음별 비율을 셈. 흰색(분류 없음)은 분모에서 뺌
- 받은 조각은 work/lc/<열>_<행>.npz로 남겨 끊겨도 이어 받음. 결과: work/env/lc_egis.npz
"""
import io
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / "work" / "env"
TILES = ROOT / "work" / "lc"
WMS = "https://api.mcee.go.kr/geoserver/wms"
LAYER = "lv3_2025y"
PX = 10                 # 표본 간격(m)
CELLS = 80              # 조각 한 변의 칸 수(80 × 250 m = 20 km)
N = CELLS * 250 // PX   # 조각 한 변의 화소 수(2000)
# 묶음 → 세분류 코드
GROUPS = {
    "built": ["111", "112", "121", "131", "132", "141", "151", "152", "153", "154", "155", "161", "162", "163"],
    "paddy": ["211", "212"],
    "field": ["221", "222", "231", "241", "251", "252"],
    "broad": ["311"], "conifer": ["321"], "mixed": ["331"],
    "grass": ["411", "421", "422", "423"],
    "wetland": ["511"],
    "tidal": ["521", "522"],
    "bare": ["611", "612", "621", "622", "623"],
    "rock": ["613"],
    "river": ["711"],
    "lake": ["712"],
    "sea": ["721"],
}
UA = {"User-Agent": "habitat.biogrideia.com landcover build (cirmax82-beep)"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def get(url, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
                return r.read()
        except Exception:   # noqa: BLE001 — 잠깐 끊기면 다시
            if i == tries - 1:
                raise
            time.sleep(5 * (i + 1))


def legend():
    url = f"{WMS}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetLegendGraphic&LAYER=EGIS:{LAYER}&FORMAT=application/json"
    rules = json.loads(get(url).decode("utf-8"))["Legend"][0]["rules"]
    code_of = {}
    for r in rules:
        fill = r["symbolizers"][0]["Polygon"]["fill"].lstrip("#")
        code = r["filter"].split("'")[1]
        code_of[int(fill, 16)] = code
    assert len(code_of) == len(rules), "범례 색이 겹침"
    return code_of


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    TILES.mkdir(parents=True, exist_ok=True)
    grid = json.loads((ENV / "grid.json").read_text(encoding="utf-8"))
    land = np.load(ENV / "base.npz")["land"]   # build_env.py가 먼저 만듦
    H, W, x0, y1 = grid["H"], grid["W"], grid["x0"], grid["y1"]
    code_of = legend()
    names = list(GROUPS)
    gi = {c: names.index(g) for g, cs in GROUPS.items() for c in cs}
    lut = {rgb: gi.get(code, -1) for rgb, code in code_of.items()}   # 색 → 묶음 번호(-1 = 묶음 밖)
    jobs = [(tx, ty) for ty in range(-(-H // CELLS)) for tx in range(-(-W // CELLS))
            if land[ty * CELLS:(ty + 1) * CELLS, tx * CELLS:(tx + 1) * CELLS].any()]
    todo = [j for j in jobs if not (TILES / f"{j[0]}_{j[1]}.npz").exists()]
    log(f"조각 {len(jobs)}개 중 받을 것 {len(todo)}개")

    def work(j):
        tx, ty = j
        bx0, by1 = x0 + tx * CELLS * 250, y1 - ty * CELLS * 250
        url = (f"{WMS}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=EGIS:{LAYER}&STYLES=&SRS=EPSG:5179"
               f"&BBOX={bx0},{by1 - CELLS * 250},{bx0 + CELLS * 250},{by1}&WIDTH={N}&HEIGHT={N}&FORMAT=image/png&format_options=antialias:none")
        a = np.asarray(Image.open(io.BytesIO(get(url))).convert("RGB")).astype(np.int32)
        rgb = (a[..., 0] << 16) | (a[..., 1] << 8) | a[..., 2]
        idx = np.full(rgb.shape, -2, dtype=np.int16)   # -2 = 분류 없음(흰색 등)
        for col, g in lut.items():
            idx[rgb == col] = g
        k = N // CELLS
        blocks = idx.reshape(CELLS, k, CELLS, k).transpose(0, 2, 1, 3).reshape(CELLS, CELLS, k * k)
        counts = np.stack([(blocks == g).sum(-1) for g in range(len(names))]).astype(np.uint16)   # 묶음 × 칸 × 칸
        valid = (blocks >= -1).sum(-1).astype(np.uint16)
        np.savez_compressed(TILES / f"{tx}_{ty}.npz", counts=counts, valid=valid)
        return j

    done = 0
    with ThreadPoolExecutor(max_workers=4) as ex:
        for _ in ex.map(work, todo):
            done += 1
            if done % 20 == 0 or done == len(todo):
                log(f"  {done}/{len(todo)}")

    # 합치기
    frac = np.zeros((len(names), H, W), dtype=np.float32)
    valid_all = np.zeros((H, W), dtype=np.float32)
    for tx, ty in jobs:
        z = np.load(TILES / f"{tx}_{ty}.npz")
        h, w = min(CELLS, H - ty * CELLS), min(CELLS, W - tx * CELLS)
        v = z["valid"][:h, :w].astype(np.float32)
        frac[:, ty * CELLS:ty * CELLS + h, tx * CELLS:tx * CELLS + w] = z["counts"][:, :h, :w] / np.maximum(v, 1)
        valid_all[ty * CELLS:ty * CELLS + h, tx * CELLS:tx * CELLS + w] = v / (N // CELLS) ** 2
    np.savez_compressed(ENV / "lc_egis.npz", names=np.array(names), frac=frac, valid=valid_all)
    lm = land & (valid_all > 0)
    log(f"저장: lc_egis.npz · 육지 칸 중 분류 자료 있음 {lm.sum() / land.sum() * 100:.1f}%")
    for n, f in zip(names, frac):
        log(f"  {n}: 육지 평균 {f[land].mean() * 100:.2f}%")


if __name__ == "__main__":
    main()
