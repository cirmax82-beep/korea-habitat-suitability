@echo off
chcp 65001 >nul
rem 서식지 분석 자료 갱신: 종 목록 → 적합성 모형 → 사이트 자료 → 올리기 (약 1시간)
cd /d "%~dp0"
"C:\Program Files\Git\bin\bash.exe" tools/update.sh
echo.
pause
