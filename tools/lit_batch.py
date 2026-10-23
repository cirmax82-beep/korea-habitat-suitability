"""모든 대상 종의 문헌을 OpenAlex에서 한꺼번에 찾아 work/lit/<학명>.json에 남김(이미 있으면 건너뜀).

    python tools/lit_batch.py
"""
import json
import sys
import time
from pathlib import Path

import lit_search

ROOT = Path(__file__).resolve().parent.parent


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    species = json.loads((ROOT / "data" / "species.json").read_text(encoding="utf-8"))["species"]
    lit_search.OUT.mkdir(parents=True, exist_ok=True)
    for i, s in enumerate(species):
        f = lit_search.OUT / f"{s['sci'].replace(' ', '_')}.json"
        if f.exists():
            continue
        seen, res = set(), []
        for q in [s["sci"], f"{s['sci']} Korea", s["ko"]]:
            try:
                for r in lit_search.search(q):
                    k = (r["title"] or "").lower()
                    if k and k not in seen:
                        seen.add(k)
                        res.append(r)
            except Exception as e:   # noqa: BLE001
                print("  실패", s["ko"], q, e, flush=True)
            time.sleep(0.2)
        f.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{i + 1}/{len(species)} {s['ko']} {len(res)}건", flush=True)


if __name__ == "__main__":
    main()
