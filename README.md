# 멸종위기종 서식지 분석

멸종위기 야생생물(Ⅰ·Ⅱ급 282종)과 천연기념물(종 단위 지정)의 생태적 특징, 서식지 적합성 지도, 종별 분석리포트, 저감방안을 보는 공개 사이트입니다.

- 주소: https://habitat.biogrideia.com/
- 출현 기록·종 목록은 멸종위기종 종합관리(https://endangered.biogrideia.com/)와 같은 자료를 씁니다.
- 새 주소는 호스팅케이알 DNS의 CNAME 레코드(`habitat` → `cirmax82-beep.github.io`)로 연결됩니다.

## 화면

- 종 정보(`#species/<종 id>`): 생태적 특징(서식 환경·민감 시기·위협 요인), 서식지 적합성 지도(250 m), 모형 정보, 일반 저감방안
  · 내 기록: 직접 아는 위치를 지도에 찍거나 주소·좌표로 넣음(브라우저에만 저장). CSV로 받아 `work/manual/`에 두면 다음 계산 때 출현 기록으로 반영(토지이용·외딴 기록 거르기 제외, 공개 지도에는 약 250 m 칸으로만)
- 분석리포트(`#report/<종 id>`): 연구 보고서 형식 — 요약, 생태적 특징, 재료·방법(출현 자료 정제, 환경변수, 모형, 서식지 층, 보정), 결과(모형 성능, 변수 기여도, 반응곡선, 적합성 지도, 등급·층·시도별 면적, 환경 특성, 고도·토지피복 구성, 서식지 조각, 보호지역 포함 비율), 고찰, 보전·관리 제언, 참고문헌. 인쇄·PDF 저장과 표 CSV 받기
- 자료·방법(`#about`)

## 자료 만들기

```
python tools/build_env.py         # 환경 변수 250 m 격자(work/env) — 원격 COG에서 한국 범위만 읽음
python tools/build_species.py     # 종 목록·출현 칸(data/species.json, work/occ)
python tools/build_pa.py          # 국가 보호지역(KDPA, work/kdpa.gpkg) → 칸별 비율(work/env/pa.npz)
python tools/build_models.py      # 종별 적합성(data/suit/*.webp, data/models.json)·분석리포트 통계(data/report/*.json)
python tools/build_site_data.py   # 사이트 자료(data/catalog.json·grid.json·occ.json·profiles.json)
bash tools/publish_data.sh        # data/suit·data/report·data/lc10을 릴리스(data-latest)의 site-data.zip으로 올림
```

- 환경 변수: 환경부 세분류 토지피복지도 2025년(환경공간정보서비스 WMS, `tools/fetch_landcover.py` — 칸별 토지피복 비율 12종, 하천·호소까지 거리), Copernicus DEM GLO-90(고도·경사), 해안까지 거리, CHELSA V2.1 1981–2010(bio1·bio4·bio12·bio15)
- 시가지·도로·철도·나대지(채광지·운동장·기타나지)는 서식지가 아님: 적합도·면적에서 칸 안 그 비율만큼 뺌
- 도로 영향권: 국가교통정보센터 표준노드링크 도로 등급별 거리(고속도로 500 m·국도 300 m·지방도 200 m·시군도 100~150 m, `tools/build_roads.py`)로 적합도를 낮춤(민감한 포유류·조류·양서파충류 최대 60%, 그 밖의 동물 30%, 육상식물 20%, 어류·수생 0%)
- 기록: 2000년 이후·위치 오차 1 km 이하만, 대도시 한가운데·동물원 주변 기록과 현재 토지이용과 맞지 않는 기록(시가지 80% 이상 칸의 땅 종, 물 없는 칸의 물 종, 내륙의 바다 종) 제외
- 대도시·도심: 도시 지수(주변 1 km·5 km 개발 비율) 15~45%에 걸쳐 모든 종의 적합도를 0까지 낮춤. 바다 종은 실제 해안 1 km 안만
- 10 m 표현: 확대 지도는 10 m 토지피복 분류 그림(data/lc10, `tools/fetch_landcover.py`)으로 칸 안 비서식지를 뺌
- 물에 사는 종(서식 태그가 모두 물 유형): 그 물이 있는 칸에서만 서식 가능, 면적은 칸 안의 물 면적
- 적합성: 출현 칸 15개 이상은 MaxEnt(elapid, target-group background, 3겹 교차검증 AUC, 등급 기준은 학습 출현 칸 예측값의 분위수: 가능 P10·적합 P20·매우 적합 P50), 나머지는 `tools/traits.tsv`의 서식 태그로 만든 서식 조건 지수(가능 0.5·적합 0.7·매우 적합 0.85)
- 알려진 분포 범위: 출현 칸에서 조류 25 km·포유류 15 km·그 밖 5 km 안과 기록 시군구(+2 km)는 그대로, 그 밖은 같은 거리에 걸쳐 0으로. 조류·포유류가 아닌 종은 출현 칸이 있으면 시군구 기록으로 넓히지 않음. 프로필의 `range.areas`(문헌상 분포 시도·시군구)는 기록과 멀어도 ‘가능’까지 두고, `range.only`면 그 밖의 기록(수목원 식재·오동정)은 뺌. 칸·시군구 기록이 모두 없는 종과, 조류·포유류가 아니면서 칸 기록 없이 시군구 기록만 있는 종은 ‘가능’까지만. 어류는 범위 거리 10 km
- 생태적 특징: `tools/traits.tsv`(공개 자료 요약). 저감방안 규칙은 `js/measures.js`
- 분석리포트 추가 분석: 서식지 조각(적합 이상 칸의 8방향 연결), 보호지역 포함 비율(한국보호지역통합DB 2025, 자연공원·생태 보호지역·국가유산·그 밖), 도로 영향권 안 비율, MaxEnt 반응곡선(다른 변수는 출현 칸 중앙값)
- 큰 파일(data/suit, data/report, data/lc10)은 저장소에 넣지 않고 배포 때 릴리스에서 받아 넣습니다(`.github/workflows/pages.yml`).
