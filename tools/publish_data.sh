#!/usr/bin/env bash
# 적합성 격자·분석리포트 통계·10 m 토지피복 분류 그림을 zip으로 묶어 GitHub 릴리스(data-latest)에 올리고, 작은 자료는 커밋해 배포를 다시 돌림
set -euo pipefail
cd "$(dirname "$0")/.."
rm -f work/site-data.zip
(cd data && python -c "import zipfile,pathlib;z=zipfile.ZipFile('../work/site-data.zip','w',zipfile.ZIP_STORED);[z.write(p,p.as_posix()) for d,g in (('suit','*.webp'),('lc10','*.webp'),('report','*.json')) for p in sorted(pathlib.Path(d).glob(g))];z.write('lc10/index.json');z.close()")
ls -la work/site-data.zip
gh release view data-latest >/dev/null 2>&1 || gh release create data-latest --title "사이트 자료" --notes "종별 서식지 적합성 격자·분석리포트 통계·10 m 토지피복(배포 때 받아 씀)"
gh release upload data-latest work/site-data.zip --clobber
