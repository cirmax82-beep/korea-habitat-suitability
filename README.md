# 멸종위기종 서식지 분석

멸종위기 야생생물(Ⅰ·Ⅱ급 282종)과 천연기념물(종 단위 지정)의 생태적 특징, 서식지 적합성 지도, 사업지 영향 예측, 저감방안, 대체서식지 후보를 보는 공개 사이트입니다.

- 주소: https://habitat.biogrideia.com/
- 출현 기록·종 목록은 멸종위기종 종합관리(https://endangered.biogrideia.com/)와 같은 자료를 씁니다.
- 새 주소는 호스팅케이알 DNS의 CNAME 레코드(`habitat` → `cirmax82-beep.github.io`)로 연결됩니다.

## 화면

- 종 정보(`#species/<종 id>`): 생태적 특징(서식 환경·민감 시기·위협 요인), 서식지 적합성 지도(250 m), 모형 정보, 일반 저감방안
- 영향 예측(`#impact`): 주소·좌표·지도 그리기·파일(SHP·GeoJSON·KML·DXF)로 사업지를 정하면 종마다 사업지 안·주변의 적합 서식지와 가까운 출현 기록으로 영향 정도(높음·보통·낮음)를 매기고, 맞춤 저감방안과 대체서식지 후보(SHP·GeoJSON·KML)를 보여 줍니다. 계산은 모두 브라우저에서 하며 올린 파일은 어디에도 보내지 않습니다.
- 자료·방법(`#about`)

## 자료 만들기

```
python tools/build_env.py         # 환경 변수 250 m 격자(work/env) — 원격 COG에서 한국 범위만 읽음
python tools/build_species.py     # 종 목록·출현 칸(data/species.json, work/occ)
python tools/build_models.py      # 종별 적합성(data/suit/*.webp, data/models.json)
python tools/build_site_data.py   # 사이트 자료(data/catalog.json·grid.json·occ.json, data/blocks)
bash tools/publish_data.sh        # data/suit·data/blocks를 릴리스(data-latest)의 site-data.zip으로 올림
```

- 환경 변수: 환경부 세분류 토지피복지도 2025년(환경공간정보서비스 WMS, `tools/fetch_landcover.py` — 칸별 토지피복 비율 12종, 하천·호소까지 거리), Copernicus DEM GLO-90(고도·경사), 해안까지 거리, CHELSA V2.1 1981–2010(bio1·bio4·bio12·bio15)
- 시가지·도로·철도·나대지(채광지·운동장·기타나지)는 서식지가 아님: 적합도·면적에서 칸 안 그 비율만큼 뺌(‘도시’ 서식 종 제외)
- 도로 영향권: 국가교통정보센터 표준노드링크 도로 등급별 거리(고속도로 500 m·국도 300 m·지방도 200 m·시군도 100~150 m, `tools/build_roads.py`)로 적합도를 낮춤(민감한 포유류·조류·양서파충류 최대 60%, 그 밖의 동물 30%, 육상식물 20%, 어류·수생 0%)
- 10 m 표현: 확대 지도와 사업지 면적은 10 m 토지피복 분류 그림(data/lc10, `tools/fetch_landcover.py`)으로 칸 안 비서식지를 뺌
- 물에 사는 종(서식 태그가 모두 물 유형): 그 물이 있는 칸에서만 서식 가능, 면적은 칸 안의 물 면적
- 적합성: 출현 칸 15개 이상은 MaxEnt(elapid, target-group background, 3겹 교차검증 AUC, 등급 기준은 학습 출현 칸 예측값의 분위수: 가능 P10·적합 P20·매우 적합 P50), 나머지는 `tools/traits.tsv`의 서식 태그로 만든 서식 조건 지수(가능 0.5·적합 0.7·매우 적합 0.85)
- 알려진 분포 범위: 출현 칸에서 조류 25 km·포유류 15 km·그 밖 5 km 안과 기록 시군구(+2 km)는 그대로, 그 밖은 같은 거리에 걸쳐 0으로. 칸·시군구 기록이 모두 없는 종은 ‘가능’까지만
- 생태적 특징: `tools/traits.tsv`(공개 자료 요약). 저감방안 규칙은 `js/measures.js`
- 큰 파일(data/suit, data/blocks)은 저장소에 넣지 않고 배포 때 릴리스에서 받아 넣습니다(`.github/workflows/pages.yml`).
- 브이월드 인증키는 저장소 비밀값 `VWORLD_KEY`로 배포 때 `js/config.js`를 만들어 넣습니다(로컬 `js/config.js`는 올라가지 않음).
