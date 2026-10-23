"""국가 보호지역(KDPA)을 분석 격자(250 m)의 칸별 면적 비율로 → work/env/pa.npz (분석리포트의 보호지역 포함 비율에 씀)

    python tools/build_pa.py

- 입력: work/kdpa.gpkg (한국 보호지역 통합 DB, 보호구역 종합포털에서 받은 것)
- 50 m로 그린 뒤 5×5를 평균해 칸 안 비율(0–1)로. 겹친 보호지역은 한 번만 셈
- 묶음: park 자연공원(국립·도립·군립), eco 생태·습지·야생생물 보호지역(생태경관·습지·야생생물·특정도서·백두대간·해양보호구역 등),
  heritage 국가유산(천연기념물·천연보호구역·명승), other 그 밖(상수원·수산자원·도시자연공원구역 등), any 하나라도
"""
import json
from pathlib import Path

import geopandas as gpd
import numpy as np
from rasterio.features import rasterize
from rasterio.transform import from_origin

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / "work" / "env"
SUB = 5   # 250 m 칸을 50 m로 5×5
PARK = {"국립공원", "도립공원", "군립공원"}
ECO = {"생태경관보전지역", "시_도생태경관보전지역", "습지보호지역", "습지보호지역-갯벌", "시_도습지보호지역", "습지보호지역-시도", "야생생물보호구역",
       "야생생물특별보호구역", "특정도서", "백두대간보호지역", "산림유전자원보호구역", "경관보호구역", "자연환경보전지역", "해양보호구역",
       "해양보호구역(해양생물)", "해양보호구역(경관)", "환경보전해역"}
HERITAGE = {"천연기념물", "천연보호구역", "명승"}


def main():
    grid = json.loads((ENV / "grid.json").read_text(encoding="utf-8"))
    H, W, res = grid["H"], grid["W"], grid["res"]
    g = gpd.read_file(ROOT / "work" / "kdpa.gpkg").to_crs(grid["crs"])
    g = g[g.geometry.notna() & ~g.geometry.is_empty]
    cat = np.where(g["DESIG"].isin(PARK), "park", np.where(g["DESIG"].isin(ECO), "eco", np.where(g["DESIG"].isin(HERITAGE), "heritage", "other")))
    tf = from_origin(grid["x0"], grid["y1"], res / SUB, res / SUB)
    out = {}
    for key in ("park", "eco", "heritage", "other", "any"):
        geoms = g.geometry if key == "any" else g.geometry[cat == key]
        fine = rasterize(((geom, 1) for geom in geoms), out_shape=(H * SUB, W * SUB), transform=tf, fill=0, dtype="uint8")
        out[key] = fine.reshape(H, SUB, W, SUB).mean(axis=(1, 3)).astype("float16")
        print(key, f"{int((cat == key).sum()) if key != 'any' else len(g)}곳", f"{float(out[key].astype('float32').sum()) * (res / 1000) ** 2:,.0f}㎢")
    np.savez_compressed(ENV / "pa.npz", **out)


if __name__ == "__main__":
    main()
