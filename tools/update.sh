#!/usr/bin/env bash
# 자료 갱신: 종 목록·출현 칸(멸종위기종 종합관리 자료) → 종별 적합성 → 사이트 자료 → 릴리스·저장소에 올리기
# 환경 격자(work/env)와 보호지역 비율(work/env/pa.npz)은 한 번 만들어 두면 다시 만들 필요가 없습니다(tools/build_env.py·build_pa.py).
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONIOENCODING=utf-8
git -C "../멸종위기종 종합관리" pull -q || echo "멸종위기종 종합관리 자료를 새로 받지 못해 있는 자료로 진행"
python tools/build_species.py
python tools/build_models.py
python tools/build_site_data.py
bash tools/publish_data.sh   # 큰 파일을 먼저 올려야 배포 때 새 파일을 받음
git add data README.md
if git diff --cached --quiet; then
  git commit -q --allow-empty -m "자료 갱신 $(date +%Y-%m-%d)"
else
  git commit -q -m "자료 갱신 $(date +%Y-%m-%d)"
fi
git push -q
echo "갱신 끝"
