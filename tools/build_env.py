"""남한 250 m 격자 환경 변수 만들기 — 종분포모형(MaxEnt) 입력.

    python tools/build_env.py

- 격자: EPSG:5179(UTM-K) 250 m, 시군구 경계(브이월드 LT_C_ADSIGG_INFO, work/admin-sigg.geojson) 범위 + 5 km
- 변수(15)
  · 고도·경사: Copernicus DEM GLO-90(90 m)을 격자 평균으로
  · 토지피복 비율 7종: ESA WorldCover 2021(10 m)의 40 m 개관 영상으로 칸마다 비율을 셈
    (산림 10, 관목·초지 20·30, 농경지 40, 시가지 50, 나지 60·70·100, 수역 80, 습지 90·95)
  · 물까지 거리·해안까지 거리(km)
  · 기후 4종: CHELSA V2.1 1981–2010 — 연평균기온(bio1), 기온계절성(bio4), 연강수량(bio12), 강수계절성(bio15)
- 원격 자료는 COG라 한국 범위만 읽음(/vsicurl). 결과: work/env/env.npz(변수·육지·시군구 번호), work/env/grid.json
"""
import json
import math
import sys
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from rasterio.windows import Window, from_bounds
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "work" / "env"
RES = 250
CRS = "EPSG:5179"
LONLAT = (123.8, 32.8, 132.2, 39.0)   # 원격 자료에서 읽을 범위(경위도)
CHELSA = "/vsicurl/https://os.zhdk.cloud.switch.ch/chelsav2/GLOBAL/climatologies/1981-2010/bio/CHELSA_{v}_1981-2010_V.2.1.tif"
DEM = "/vsicurl/https://copernicus-dem-90m.s3.amazonaws.com/Copernicus_DSM_COG_30_{ns}{lat:02d}_00_E{lon:03d}_00_DEM/Copernicus_DSM_COG_30_{ns}{lat:02d}_00_E{lon:03d}_00_DEM.tif"
WC = "/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N{lat:02d}E{lon:03d}_Map.tif"
WC_TILES = [(33, 123), (33, 126), (33, 129), (36, 123), (36, 126), (36, 129)]
LC = {"tree": [10], "grass": [20, 30], "crop": [40], "built": [50], "bare": [60, 70, 100], "water": [80], "wetland": [90, 95]}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def warp(src_path, grid, resampling, band=1, overview=None, prep=None):
    """원격 래스터의 한국 범위를 읽어 격자로 옮김(없는 곳은 NaN)"""
    dst = np.full((grid["H"], grid["W"]), np.nan, dtype="float32")
    kw = {"overview_level": overview} if overview is not None else {}
    with rasterio.open(src_path, **kw) as r:
        win = from_bounds(*LONLAT, r.transform).round_offsets().round_lengths()
        win = win.intersection(Window(0, 0, r.width, r.height))
        arr = r.read(band, window=win).astype("float32")
        if r.nodata is not None:
            arr[arr == r.nodata] = np.nan
        tr, crs = r.window_transform(win), r.crs
    if prep:
        arr = prep(arr)
    reproject(arr, dst, src_transform=tr, src_crs=crs, dst_transform=grid["transform"], dst_crs=CRS,
              resampling=resampling, src_nodata=np.nan, dst_nodata=np.nan)
    return dst


def fill(dst, part):
    m = np.isnan(dst) & ~np.isnan(part)
    dst[m] = part[m]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(parents=True, exist_ok=True)
    admin = gpd.read_file(ROOT / "work" / "admin-sigg.geojson", engine="pyogrio").set_crs(4326, allow_override=True).to_crs(CRS)
    x0, y0, x1, y1 = admin.total_bounds
    x0, y0 = math.floor((x0 - 5000) / RES) * RES, math.floor((y0 - 5000) / RES) * RES
    x1, y1 = math.ceil((x1 + 5000) / RES) * RES, math.ceil((y1 + 5000) / RES) * RES
    W, H = int((x1 - x0) / RES), int((y1 - y0) / RES)
    grid = {"W": W, "H": H, "transform": from_origin(x0, y1, RES, RES)}
    log(f"격자 {W}×{H} ({W * H:,}칸)")

    # 육지와 시군구 번호
    sgg = rasterize(((g, i + 1) for i, g in enumerate(admin.geometry)), out_shape=(H, W), transform=grid["transform"], fill=0, dtype="int16")
    land = sgg > 0
    log(f"육지 {land.sum():,}칸")
    env = {}

    # 기후
    for v, name in (("bio1", "bio1"), ("bio4", "bio4"), ("bio12", "bio12"), ("bio15", "bio15")):
        t = time.time()
        a = warp(CHELSA.format(v=v), grid, Resampling.bilinear)
        if v == "bio1":
            a = a * 0.1 - 273.15     # 0.1 K → ℃
        elif v in ("bio4", "bio12"):
            a = a * 0.1              # CHELSA 척도
        env[name] = a
        log(f"기후 {v} {np.nanmin(a[land]):.1f}~{np.nanmax(a[land]):.1f} · {time.time() - t:.0f}s")

    # 고도
    elev = np.full((H, W), np.nan, dtype="float32")
    for lat in range(33, 39):
        for lon in range(124, 132):
            try:
                fill(elev, warp(DEM.format(ns="N", lat=lat, lon=lon), grid, Resampling.average))
            except rasterio.errors.RasterioIOError:
                pass   # 바다뿐인 칸은 타일이 없음
    elev[np.isnan(elev) & land] = 0
    env["elev"] = elev
    gy, gx = np.gradient(np.nan_to_num(elev), RES)
    env["slope"] = np.degrees(np.arctan(np.hypot(gx, gy))).astype("float32")
    log(f"고도 {np.nanmax(elev[land]):.0f} m, 경사 최대 {env['slope'][land].max():.1f}°")

    # 토지피복 비율
    lc = {k: np.full((H, W), np.nan, dtype="float32") for k in LC}
    for lat, lon in WC_TILES:
        t = time.time()
        path = WC.format(lat=lat, lon=lon)
        try:
            with rasterio.open(path, overview_level=1) as r:   # 40 m 개관 영상
                win = from_bounds(*LONLAT, r.transform).round_offsets().round_lengths().intersection(Window(0, 0, r.width, r.height))
                cls = r.read(1, window=win)
                tr, crs = r.window_transform(win), r.crs
        except rasterio.errors.RasterioIOError:
            continue
        valid = cls > 0
        for k, codes in LC.items():
            b = np.isin(cls, codes).astype("float32")
            b[~valid] = np.nan
            part = np.full((H, W), np.nan, dtype="float32")
            reproject(b, part, src_transform=tr, src_crs=crs, dst_transform=grid["transform"], dst_crs=CRS,
                      resampling=Resampling.average, src_nodata=np.nan, dst_nodata=np.nan)
            fill(lc[k], part)
        log(f"토지피복 N{lat}E{lon} · {time.time() - t:.0f}s")
    for k in LC:
        lc[k][np.isnan(lc[k])] = 0
        env[k] = lc[k]

    # 물·해안까지 거리(km)
    water = (env["water"] + env["wetland"]) >= 0.25
    env["dist_water"] = (ndimage.distance_transform_edt(~water) * RES / 1000).astype("float32")
    env["dist_coast"] = (ndimage.distance_transform_edt(land) * RES / 1000).astype("float32")
    log("거리 변수 완료")

    names = ["elev", "slope", "tree", "grass", "crop", "built", "bare", "water", "wetland", "dist_water", "dist_coast",
             "bio1", "bio4", "bio12", "bio15"]
    for n in names:
        a = env[n]
        a[~land] = np.nan
        if np.isnan(a[land]).any():   # 기후 자료가 빈 해안·섬 칸은 가까운 값으로
            idx = ndimage.distance_transform_edt(np.isnan(a), return_distances=False, return_indices=True)
            a[land] = a[tuple(idx)][land]
    np.savez_compressed(OUT / "env.npz", **{n: env[n] for n in names}, land=land, sgg=sgg)
    t = grid["transform"]
    (OUT / "grid.json").write_text(json.dumps({
        "crs": CRS, "res": RES, "W": W, "H": H, "x0": t.c, "y1": t.f, "names": names,
        "sgg": [{"code": c, "name": n} for c, n in zip(admin["sig_cd"], admin["full_nm"])],
        "units": {"elev": "m", "slope": "°", "dist_water": "km", "dist_coast": "km", "bio1": "℃", "bio4": "℃×100(표준편차)",
                  "bio12": "mm", "bio15": "%", "tree": "비율", "grass": "비율", "crop": "비율", "built": "비율",
                  "bare": "비율", "water": "비율", "wetland": "비율"},
        "sources": {"DEM": "Copernicus DEM GLO-90", "landcover": "ESA WorldCover 2021 v200", "climate": "CHELSA V2.1 1981-2010",
                    "admin": "브이월드 시군구 경계"},
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"저장: {OUT / 'env.npz'} ({(OUT / 'env.npz').stat().st_size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
