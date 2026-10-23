"""남한 250 m 격자 환경 변수 만들기 — 종분포모형(MaxEnt) 입력.

    python tools/build_env.py

- 격자: EPSG:5179(UTM-K) 250 m, 시군구 경계(브이월드 LT_C_ADSIGG_INFO, work/admin-sigg.geojson) 범위 + 5 km
- 지형·기후(work/env/base.npz에 한 번 만들어 둠)
  · 고도·경사: Copernicus DEM GLO-90(90 m)을 격자 평균으로
  · 기후 4종: CHELSA V2.1 1981–2010 — 연평균기온(bio1), 기온계절성(bio4), 연강수량(bio12), 강수계절성(bio15)
  · 해안까지 거리(km)
- 토지피복: 환경부 세분류 토지피복지도 2025년(tools/fetch_landcover.py → work/env/lc_egis.npz)의 칸별 비율
  산림·침엽수림·초지·논·밭(과수·시설재배 포함)·시가지·나대지(채광·운동장·기타나지)·자연 나지(해변·강기슭)·암벽·내륙습지·갯벌·하천·호소(·바다),
  하천·호소까지 거리
  분류 자료가 없는 칸(일부 섬·접경지)은 가장 가까운 칸 값으로 채움
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
WC_LC = {"tree": [10], "grass": [20, 30], "crop": [40], "built": [50], "bare": [60, 70, 100], "water": [80], "wetland": [90, 95]}
NAMES = ["elev", "slope", "tree", "conifer", "grass", "paddy", "field", "built", "artbare", "bare", "rock", "wetland", "tidal", "river", "lake",
         "dist_river", "dist_lake", "dist_coast", "bio1", "bio4", "bio12", "bio15"]   # 모형 변수
EXTRA = ["sea"]   # 모형에는 안 쓰고 바다 종 서식 칸 판정에만


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


def base_layers(grid, land, H, W):
    """지형·기후(원격 COG에서 읽음, 오래 걸려 base.npz에 남김)"""
    env = {}
    for v in ("bio1", "bio4", "bio12", "bio15"):
        t = time.time()
        a = warp(CHELSA.format(v=v), grid, Resampling.bilinear)
        if v == "bio1":
            a = a * 0.1 - 273.15     # 0.1 K → ℃
        elif v in ("bio4", "bio12"):
            a = a * 0.1              # CHELSA 척도
        env[v] = a
        log(f"기후 {v} {np.nanmin(a[land]):.1f}~{np.nanmax(a[land]):.1f} · {time.time() - t:.0f}s")
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
    env["dist_coast"] = (ndimage.distance_transform_edt(land) * RES / 1000).astype("float32")
    log(f"고도 {np.nanmax(elev[land]):.0f} m, 경사 최대 {env['slope'][land].max():.1f}°")
    return env


def worldcover(grid, H, W):
    """ESA WorldCover 2021 칸별 비율(환경부 토지피복이 비공개인 접경지역만 채우는 데 씀). work/env/wc.npz에 남김"""
    path = OUT / "wc.npz"
    if path.exists():
        z = np.load(path)
        return {k: z[k] for k in z.files}
    lc = {k: np.full((H, W), np.nan, dtype="float32") for k in WC_LC}
    for lat, lon in WC_TILES:
        try:
            with rasterio.open(WC.format(lat=lat, lon=lon), overview_level=1) as r:   # 40 m 개관 영상
                win = from_bounds(*LONLAT, r.transform).round_offsets().round_lengths().intersection(Window(0, 0, r.width, r.height))
                cls = r.read(1, window=win)
                tr, crs = r.window_transform(win), r.crs
        except rasterio.errors.RasterioIOError:
            continue
        for k, codes in WC_LC.items():
            b = np.isin(cls, codes).astype("float32")
            b[cls == 0] = np.nan
            part = np.full((H, W), np.nan, dtype="float32")
            reproject(b, part, src_transform=tr, src_crs=crs, dst_transform=grid["transform"], dst_crs=CRS,
                      resampling=Resampling.average, src_nodata=np.nan, dst_nodata=np.nan)
            fill(lc[k], part)
        log(f"WorldCover N{lat}E{lon}")
    lc = {k: np.nan_to_num(v) for k, v in lc.items()}
    np.savez_compressed(path, **lc)
    return lc


def share(a, b, have):
    """a / (a + b)를 환경부 자료가 있는 칸에서 넓게(약 10 km) 평균 내고, 없는 칸은 가까운 값"""
    sa = ndimage.gaussian_filter(np.where(have, a, 0), 40)
    sb = ndimage.gaussian_filter(np.where(have, b, 0), 40)
    r = np.where(sa + sb > 1e-4, sa / np.maximum(sa + sb, 1e-9), np.nan)
    return nearest_fill(r, np.isnan(r))


def nearest_fill(a, missing):
    idx = ndimage.distance_transform_edt(missing, return_distances=False, return_indices=True)
    return a[tuple(idx)]


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
    sgg = rasterize(((g, i + 1) for i, g in enumerate(admin.geometry)), out_shape=(H, W), transform=grid["transform"], fill=0, dtype="int16")
    land = sgg > 0
    log(f"육지 {land.sum():,}칸")
    t = grid["transform"]
    (OUT / "grid.json").write_text(json.dumps({
        "crs": CRS, "res": RES, "W": W, "H": H, "x0": t.c, "y1": t.f, "names": NAMES, "extra": EXTRA,
        "sgg": [{"code": c, "name": n} for c, n in zip(admin["sig_cd"], admin["full_nm"])],
        "units": {"elev": "m", "slope": "°", "dist_river": "km", "dist_lake": "km", "dist_coast": "km", "bio1": "℃", "bio4": "℃×100(표준편차)",
                  "bio12": "mm", "bio15": "%"},
        "sources": {"DEM": "Copernicus DEM GLO-90", "landcover": "환경부 세분류 토지피복지도 2025년(환경공간정보서비스)",
                    "climate": "CHELSA V2.1 1981-2010", "admin": "브이월드 시군구 경계"},
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    base_path = OUT / "base.npz"
    if base_path.exists():
        z = np.load(base_path)
        env = {k: z[k] for k in z.files if k not in ("land", "sgg")}
        log("지형·기후: base.npz")
    else:
        env = base_layers(grid, land, H, W)
        np.savez_compressed(base_path, **env, land=land, sgg=sgg)

    # 토지피복(환경부 세분류)
    if not (OUT / "lc_egis.npz").exists():
        import fetch_landcover
        fetch_landcover.main()
    z = np.load(OUT / "lc_egis.npz")
    lc = dict(zip([str(n) for n in z["names"]], z["frac"]))
    have = z["valid"] > 0.05
    miss = land & ~have
    # 환경부 자료가 비공개인 접경지역(민통선 일대·백령도 등): 위성 토지피복(ESA WorldCover)으로 채움.
    # WorldCover가 가르지 못하는 논/밭, 하천/호소, 침엽/활엽은 주변 환경부 자료의 비율로 나눔
    log(f"환경부 토지피복이 없는 육지 칸 {miss.sum():,}개 → ESA WorldCover로 채움")
    wc = worldcover(grid, H, W)
    tree_all = lc["broad"] + lc["conifer"] + lc["mixed"]
    p_paddy = share(lc["paddy"], lc["field"], have)
    p_river = share(lc["river"], lc["lake"], have)
    p_con = share(lc["conifer"], lc["broad"] + lc["mixed"], have)
    p_art = share(lc["artbare"], lc["bare"], have)
    fb = {"tree": wc["tree"], "conifer": wc["tree"] * p_con, "grass": wc["grass"], "paddy": wc["crop"] * p_paddy,
          "field": wc["crop"] * (1 - p_paddy), "built": wc["built"], "artbare": wc["bare"] * p_art, "bare": wc["bare"] * (1 - p_art), "rock": 0 * wc["bare"],
          "wetland": wc["wetland"], "tidal": 0 * wc["bare"], "river": wc["water"] * p_river, "lake": wc["water"] * (1 - p_river),
          "sea": 0 * wc["bare"]}
    lc["tree"] = tree_all
    for k, v in fb.items():
        lc[k] = np.where(miss, v, lc[k]).astype("float32")
    env["tree"] = lc["tree"]
    for k in ("conifer", "grass", "paddy", "field", "built", "artbare", "bare", "rock", "wetland", "tidal", "river", "lake", "sea"):
        env[k] = lc[k]
    env["dist_river"] = (ndimage.distance_transform_edt(~(env["river"] >= 0.005)) * RES / 1000).astype("float32")   # 폭 약 1 m 넘는 물줄기
    env["dist_lake"] = (ndimage.distance_transform_edt(~((env["lake"] + env["wetland"]) >= 0.02)) * RES / 1000).astype("float32")
    log("토지피복·거리 변수 완료")

    for n in NAMES + EXTRA:
        a = env[n].astype("float32")
        a[~land] = np.nan
        if np.isnan(a[land]).any():   # 기후 자료가 빈 해안·섬 칸은 가까운 값으로
            a[land] = nearest_fill(a, np.isnan(a))[land]
        env[n] = a
    np.savez_compressed(OUT / "env.npz", **{n: env[n] for n in NAMES + EXTRA}, land=land, sgg=sgg)
    log(f"저장: {OUT / 'env.npz'} ({(OUT / 'env.npz').stat().st_size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
