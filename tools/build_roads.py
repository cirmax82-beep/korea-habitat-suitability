"""도로 영향권(road-effect zone) 격자 — 국가교통정보센터 표준노드링크의 도로 등급별 거리로.

    python tools/build_roads.py

- 자료: 국가교통정보센터(its.go.kr) 표준노드링크 MOCT_LINK(work/nodelink/에 풀어 둠)
- 도로 등급별 영향(0–1): 도로에서 FULL m까지는 최대(MAX), 그 뒤 ZONE m에서 0이 되도록 줄어듦
  고속도로·도시고속도로 500 m, 일반국도·광역시도 300 m, 지방도 200 m, 시군도(편도 2차로 이상 150 m, 그 밖 100 m)
- 50 m 격자에서 거리를 재고 250 m 칸 평균으로 묶음(칸 안에서 영향이 다른 부분을 고르게 반영). 등급끼리는 큰 값
- 결과: work/env/road_eff.npy(분석 격자와 같은 크기, 0–1)
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import pyogrio
from rasterio.features import rasterize
from rasterio.transform import from_origin
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / "work" / "env"
LINK = ROOT / "work" / "nodelink" / "MOCT_LINK.shp"
FINE = 50
# (이름, 조건, 최대 영향, 최대로 유지하는 거리 m, 0이 되는 거리 m)
CLASSES = [
    ("고속도로", lambda d: d["ROAD_RANK"].isin(["101", "102"]), 1.0, 100, 500),
    ("국도·광역시도", lambda d: d["ROAD_RANK"].isin(["103", "104"]), 1.0, 50, 300),
    ("지방도", lambda d: d["ROAD_RANK"].isin(["105", "106"]), 0.8, 30, 200),
    ("시군도 2차로+", lambda d: (d["ROAD_RANK"] == "107") & (d["LANES"] >= 2), 0.7, 30, 150),
    ("시군도", lambda d: (d["ROAD_RANK"] == "107") & (d["LANES"] < 2), 0.4, 0, 100),
]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    grid = json.loads((ENV / "grid.json").read_text(encoding="utf-8"))
    k = grid["res"] // FINE
    H, W = grid["H"] * k, grid["W"] * k
    tr = from_origin(grid["x0"], grid["y1"], FINE, FINE)
    df = pyogrio.read_dataframe(LINK, encoding="cp949", columns=["ROAD_RANK", "LANES"])
    df = df.set_crs("EPSG:5186", allow_override=True).to_crs(grid["crs"])   # ITRF2000 중부원점 = GRS80 중부원점
    df["LANES"] = df["LANES"].astype(int)
    log(f"도로 구간 {len(df):,}개 · 50 m 격자 {W}×{H}")
    eff = np.zeros((H, W), dtype=np.float32)
    for name, cond, mx, full, zone in CLASSES:
        sub = df[cond(df)]
        mask = rasterize(((g, 1) for g in sub.geometry), out_shape=(H, W), transform=tr, fill=0, dtype="uint8", all_touched=True)
        d = ndimage.distance_transform_edt(mask == 0) * FINE
        e = (mx * np.clip((zone - d) / max(zone - full, 1), 0, 1)).astype(np.float32)
        np.maximum(eff, e, out=eff)
        del d, e, mask
        log(f"  {name}: {len(sub):,}개")
    out = eff.reshape(grid["H"], k, grid["W"], k).mean(axis=(1, 3))
    np.save(ENV / "road_eff.npy", out.astype(np.float32))
    land = np.load(ENV / "base.npz")["land"]
    log(f"저장: road_eff.npy · 육지 중 영향 0.5 이상 {(out[land] >= 0.5).mean() * 100:.1f}%, 0.1 이상 {(out[land] >= 0.1).mean() * 100:.1f}%")


if __name__ == "__main__":
    main()
