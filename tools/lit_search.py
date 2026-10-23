"""종별 문헌 찾기 — OpenAlex(학술 문헌 데이터베이스, 하루 사용량이 막히면 Crossref)에서 학명·국명으로 검색해 제목·저자·연도·학술지·DOI·초록을 모음.

    python tools/lit_search.py "Halcyon pileata" [추가 검색어 …]

- 결과는 work/lit/<학명>.json에 남김(다시 부르면 그대로 씀). 화면에는 인용 횟수·연도 순으로 요약을 찍음
- 초록은 OpenAlex의 역색인을 풀어 원문 그대로 둠(사이트에는 요약만 쓰고 원문을 옮기지 않음)
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "work" / "lit"
UA = {"User-Agent": "habitat.biogrideia.com literature (mailto:225184823+cirmax82-beep@users.noreply.github.com)"}


def get(url):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 or i == 3:   # 사용량 초과는 바로 넘김(다른 검색으로)
                raise
            time.sleep(2 * (i + 1))
        except Exception:   # noqa: BLE001
            if i == 3:
                raise
            time.sleep(2 * (i + 1))


def abstract(inv):
    if not inv:
        return ""
    pos = sorted((p, w) for w, ps in inv.items() for p in ps)
    return " ".join(w for _, w in pos)


def crossref(query, n=25):
    """Crossref(키 없이 쓰는 DOI 등록 기관 검색) — OpenAlex 하루 사용량이 막혔을 때"""
    url = "https://api.crossref.org/works?" + urllib.parse.urlencode({"query.bibliographic": query, "rows": n, "mailto": UA["User-Agent"].split("mailto:")[1].rstrip(")"),
                                                                   "select": "DOI,title,author,issued,container-title,is-referenced-by-count,abstract"})
    tag = re.compile(r"<[^>]+>")
    out = []
    for w in get(url).get("message", {}).get("items", []):
        out.append({"title": tag.sub("", (w.get("title") or [""])[0]).strip(), "year": ((w.get("issued") or {}).get("date-parts") or [[None]])[0][0],
                    "venue": (w.get("container-title") or [""])[0], "doi": f"https://doi.org/{w['DOI']}" if w.get("DOI") else "",
                    "authors": [f"{a.get('given', '')} {a.get('family', '')}".strip() for a in w.get("author", [])][:6],
                    "cited": w.get("is-referenced-by-count", 0), "abstract": tag.sub("", w.get("abstract") or "").strip()})
    return out


def search(query, n=25):
    try:
        return openalex(query, n)
    except urllib.error.HTTPError as e:
        if e.code != 429:
            raise
        return crossref(query, n)


def openalex(query, n=25):
    url = "https://api.openalex.org/works?" + urllib.parse.urlencode({"search": query, "per-page": n,
                                                                     "select": "id,doi,title,publication_year,authorships,primary_location,cited_by_count,abstract_inverted_index"})
    out = []
    for w in get(url).get("results", []):
        loc = w.get("primary_location") or {}
        src = (loc.get("source") or {}).get("display_name") or ""
        out.append({"title": w.get("title") or "", "year": w.get("publication_year"), "venue": src, "doi": w.get("doi") or "",
                    "authors": [a["author"]["display_name"] for a in w.get("authorships", [])][:6], "cited": w.get("cited_by_count", 0),
                    "abstract": abstract(w.get("abstract_inverted_index"))})
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sci, extra = sys.argv[1], sys.argv[2:]
    OUT.mkdir(parents=True, exist_ok=True)
    f = OUT / f"{sci.replace(' ', '_')}.json"
    if f.exists():
        res = json.loads(f.read_text(encoding="utf-8"))
    else:
        seen, res = set(), []
        for q in [sci, f"{sci} Korea"] + extra:
            for r in search(q):
                k = (r["title"] or "").lower()
                if k and k not in seen:
                    seen.add(k)
                    res.append(r)
        f.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    genus = sci.split()[0].lower()
    rel = [r for r in res if genus in (r["title"] + r["abstract"]).lower()]
    kr = re.compile(r"korea|한국|국내|dmz|demilitar|cheorwon|철원|gyeonggi|gangwon|jeju|nakdong|geum|han river|seoul", re.I)
    korea = [r for r in rel if kr.search(r["title"] + " " + r["abstract"] + " " + r["venue"])]
    other = [r for r in rel if r not in korea]
    for head, rows, n, ab in (("국내", korea, 12, 300), ("국외(인용 많은 순)", sorted(other, key=lambda r: -(r["cited"] or 0)), 4, 0)):
        print(f"--- {head} {len(rows)}건")
        for r in rows[:n]:
            print(f"[{r['year']}] {r['title']} — {', '.join(r['authors'][:3])} · {r['venue']} · 인용 {r['cited']} · {r['doi']}")
            if r["abstract"] and ab:
                print("   ", r["abstract"][:ab])


if __name__ == "__main__":
    main()
