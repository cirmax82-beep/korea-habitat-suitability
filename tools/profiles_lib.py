"""종 프로필 읽기 — tools/profiles/*.json(분류군별 파일)을 합쳐 국명 → 프로필로.

프로필 항목: summary·distribution·habitat·life·diet·threats·conservation(문헌 요약), refs(참고문헌),
layers(서식지 층: groups 토지피복 묶음, near 가까이 있어야 할 것, elev 고도, slope 경사(°), coast_km 해안까지 거리, cell_min 칸 안 비율 하한, main 대표 지도 포함),
vars(모형에 쓸 환경변수 — 종 특성에 맞게 고름), min_year(이 해 이후 기록만), range({km, sgg}: 분포 범위 조정).
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_profiles():
    out = {}
    for f in sorted((ROOT / "tools" / "profiles").glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        out.update({k: v for k, v in d.items() if not k.startswith("_")})
    return out
