"""종 프로필의 참고문헌 고르기 — work/lit/<학명>.json(문헌 검색 결과)에서 서식·분포·번식·생태를 다룬 국내 연구를 우선으로.

    python tools/pick_refs.py 20_조류.json            # 고른 후보를 보여 줌
    python tools/pick_refs.py 20_조류.json --write    # refs가 비어 있는 종에 넣음(빼고 싶은 것은 --skip "국명:번호,번호")

유전체·질병·오염 같은 서식지와 관계없는 연구는 뺌. IUCN 적색목록 평가가 있으면 하나 넣음
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ECO = re.compile(r"habitat|distribut|breed|winter|population|ecolog|status|survey|nest|forag|diet|food|migrat|stopover|occurren|abundan|"
                 r"home range|roost|spawn|reproduct|growth|vegetat|community|conserv|restor|서식|분포|번식|월동|생태|개체|현황|먹이|이동|산란|"
                 r"자생지|군락|생육|복원|보전|조사", re.I)
BAD = re.compile(r"genom|mitochond|transcript|virus|parasit|infect|pathogen|sequenc|phylogen|\bDNA\b|toxic|mercury|metal|veterin|disease|"
                 r"antibod|microsat|marker|bacteri|cancer|extract|pharmac|antioxid|medicin|cell|protein|enzyme|food chem|occurrence download|"
                 r"유전|질병|감염|바이러스|추출|약리", re.I)
KR = re.compile(r"korea|한국|국내|dmz|jeju|제주|seoul|gangwon|강원|gyeong|경기|경상|전라|충청|nakdong|낙동|geum|금강|han river|한강|"
                r"saemangeum|새만금|suncheon|순천|cheorwon|철원|jirisan|지리산|ulleung|울릉", re.I)


def pick(sci, n=4):
    f = ROOT / "work" / "lit" / f"{sci.replace(' ', '_')}.json"
    if not f.exists():
        return []
    res = json.loads(f.read_text(encoding="utf-8"))
    nm = re.sub(r"\s*\(.*?\)", "", sci).split()
    g = nm[0].lower()
    ep = nm[1].lower() if len(nm) > 1 else g
    ok = [r for r in res if r.get("title") and g in (r["title"] + r["abstract"]).lower() and ep in (r["title"] + r["abstract"]).lower()
          and not BAD.search(r["title"]) and not re.search(r"retract", r["title"], re.I)]
    iucn = [r for r in ok if "iucn red list" in (r["venue"] or "").lower() and f"{g} {ep}" in r["title"].lower()]
    rest = [r for r in ok if r not in iucn]
    score = lambda r: (2 if KR.search(r["title"] + " " + r["abstract"] + " " + (r["venue"] or "")) else 0) + (1 if ECO.search(r["title"] + " " + r["abstract"][:400]) else 0)  # noqa: E731
    top = sorted([r for r in rest if score(r) >= 2 or (score(r) >= 1 and r.get("cited", 0) >= 20)], key=lambda r: (-score(r), -(r.get("cited") or 0)))[:n]
    if iucn:
        top.append(sorted(iucn, key=lambda r: -(r["year"] or 0))[0])
    return top


def cite(r):
    au = r["authors"]
    who = (au[0] + (" 외" if len(au) > 1 else "")) if au else ""
    return {"text": f"{who} ({r['year']}) {r['title']}. {r['venue']}".replace("  ", " ").strip(), "url": r.get("doi") or ""}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    fname = sys.argv[1]
    write = "--write" in sys.argv
    skip = {}
    if "--skip" in sys.argv:
        for part in sys.argv[sys.argv.index("--skip") + 1].split(";"):
            if ":" in part:
                k, v = part.split(":", 1)
                skip[k.strip()] = {int(x) for x in v.split(",") if x.strip()}
    path = ROOT / "tools" / "profiles" / fname
    prof = json.loads(path.read_text(encoding="utf-8"))
    species = {s["ko"]: s for s in json.loads((ROOT / "data" / "species.json").read_text(encoding="utf-8"))["species"]}
    for ko, P in prof.items():
        if ko.startswith("_") or P.get("refs") or ko not in species:
            continue
        cands = pick(species[ko]["sci"])
        if not write:
            print(f"## {ko} ({species[ko]['sci']})")
            for i, r in enumerate(cands, 1):
                print(f"  {i}. [{r['year']}] {r['title'][:110]} · {r['venue'][:35]}")
            continue
        P["refs"] = [cite(r) for i, r in enumerate(cands, 1) if i not in skip.get(ko, set())]
        for Ly in P.get("layers", []):
            Ly.setdefault("refs", list(range(1, len(P["refs"]) + 1))[:3])
    if write:
        path.write_text(json.dumps(prof, ensure_ascii=False, indent=1), encoding="utf-8")
        print("저장", fname)


if __name__ == "__main__":
    main()
