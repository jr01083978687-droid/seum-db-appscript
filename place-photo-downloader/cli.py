"""창 없이 실행 (점검/테스트용).

python cli.py <링크> --start 2026-07-01 --end 2026-09-30 [--visitor] [--out 폴더] [--show]
"""
import argparse
import os
import sys
from datetime import date, timedelta

from ppd.dates import parse_input_date
from ppd.job import Job, JobOptions


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("link")
    ap.add_argument("--start", default=(date.today() - timedelta(days=90)).isoformat())
    ap.add_argument("--end", default=date.today().isoformat())
    ap.add_argument("--out", default="output")
    ap.add_argument("--visitor", action="store_true")
    ap.add_argument("--show", action="store_true", help="브라우저 창 보이기")
    ap.add_argument("--max-reviews", type=int, default=300)
    a = ap.parse_args()

    opts = JobOptions(link=a.link, start=parse_input_date(a.start), end=parse_input_date(a.end),
                      out_dir=os.path.abspath(a.out), include_visitor=a.visitor, headless=not a.show,
                      max_reviews=a.max_reviews)
    job = Job(opts, log=lambda m: print(m, flush=True))
    try:
        job.run()
    except Exception as e:  # noqa: BLE001
        print("오류:", e, flush=True)
        return 1
    return 0 if job.stats["saved"] + job.stats["exists"] > 0 else 2


if __name__ == "__main__":
    sys.exit(main())
