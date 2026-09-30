"""_진단 폴더 요약 (라이브 테스트 로그용)."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

d = sys.argv[1] if len(sys.argv) > 1 else "output/_진단"
if not os.path.isdir(d):
    print("진단 폴더 없음"); sys.exit(0)
for name in sorted(os.listdir(d)):
    path = os.path.join(d, name)
    print(f"===== {name} ({os.path.getsize(path)} bytes)")
    text = open(path, encoding="utf-8").read()
    if name.endswith(".json"):
        data = json.loads(text)
        for i, obj in enumerate(data):
            if isinstance(obj, dict):
                print(f"-- dump[{i}] keys:", list(obj.keys())[:60])
        from ppd.reviews import extract_blog_reviews, extract_visitor_reviews
        for i, obj in enumerate(data):
            if not isinstance(obj, dict):
                continue
            for k, v in obj.items():
                if k.startswith(("FsasReview", "VisitorReview:", "ROOT_QUERY")):
                    print(f"## {k}")
                    print(json.dumps(v, ensure_ascii=False)[:2500])
            refs = obj
            print("-- extract_blog_reviews:", json.dumps(extract_blog_reviews(obj, refs), ensure_ascii=False)[:3000])
            print("-- extract_visitor_reviews:", json.dumps(extract_visitor_reviews(obj, refs), ensure_ascii=False)[:1500])
        hits = []

        def walk(o, path):
            if isinstance(o, dict):
                if any(isinstance(v, str) and ("blog.naver.com" in v or "pstatic.net" in v) for v in o.values()):
                    hits.append((path, o))
                for k, v in o.items():
                    walk(v, f"{path}.{k}")
            elif isinstance(o, list):
                for i, v in enumerate(o):
                    walk(v, f"{path}[{i}]")
        walk(data, "$")
        print(f"-- blog/pstatic 포함 객체 {len(hits)}개. 앞 4개:")
        for p, o in hits[:0]:
            print(p); print(json.dumps(o, ensure_ascii=False)[:1500])
    else:
        body = re.sub(r"<script.*?</script>|<style.*?</style>", "", text, flags=re.S)
        body = re.sub(r"<[^>]+>", " ", body)
        print(re.sub(r"\s+", " ", body)[:2500])
        print("-- blog 링크:", re.findall(r'https?://(?:m\.)?blog\.naver\.com/[^"\'\s<>]+', text)[:10])
        print("-- __APOLLO_STATE__ 존재:", "__APOLLO_STATE__" in text)
