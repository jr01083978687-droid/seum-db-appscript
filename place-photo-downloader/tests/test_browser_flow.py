"""가짜 네이버 페이지로 브라우저 수집 흐름 전체를 검증한다 (실제 네이버 접속 없음)."""
import io
import json
import os
import sys
import threading
from datetime import date

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image

from ppd.job import Job, JobOptions

CHROME = "/opt/pw-browsers/chromium"
pytestmark = pytest.mark.skipif(not os.path.exists(CHROME), reason="로컬 chromium 없음")

APOLLO = {
    "PlaceDetailBase:1234567": {"id": "1234567", "name": "스움식당 성수점"},
    "ROOT_QUERY": {"fsasReviews({})": {"items": [
        {"type": "blog", "url": "https://blog.naver.com/aaa/1001", "title": "새 글", "date": "2026.09.20."},
        {"type": "blog", "url": "https://blog.naver.com/bbb/1002", "title": "옛날 글", "date": "2025.01.02."},
    ]}},
}
PAGE2 = {"data": {"fsasReviews": {"items": [
    {"type": "blog", "url": "https://blog.naver.com/ccc/1003", "title": "2페이지 글", "date": "2026.08.01."},
    {"type": "cafe", "url": "https://cafe.naver.com/zzz/1"},
]}}}
VISITOR = {"data": {"visitorReviews": {"items": [
    {"id": "v1", "created": "9.21.일", "author": {"nickname": "리뷰왕"},
     "media": [{"type": "image", "thumbnail": "https://pup-review-phinf.pstatic.net/v1.jpg?type=w560"}]},
]}}}

UGC_HTML = """<html><head><title>스움식당 성수점 : 네이버</title></head><body>
<script>window.__APOLLO_STATE__ = %s;</script>
<ul id="list">
  <li>리뷰 본문 <a href="#" onclick="return false">더보기</a></li>
</ul>
<a id="more" href="#" onclick="loadMore();return false;"><span>더보기</span></a>
<script>
async function loadMore() {
  const r = await fetch('https://pcmap-api.place.naver.com/graphql', {method: 'POST', body: '[]'});
  const j = await r.json();
  document.getElementById('more').remove();
}
</script></body></html>""" % json.dumps(APOLLO)

VISITOR_HTML = """<html><body><script>
fetch('https://api.place.naver.com/graphql', {method: 'POST', body: '[]'});
</script></body></html>"""


def blog_html(day, n_photos):
    imgs = "".join(f'<div class="se-image"><img src="https://postfiles.pstatic.net/{day}/{i}.jpg?type=w80_blur"></div>'
                   for i in range(n_photos))
    return (f'<p class="blog_date">{day}</p><div class="se-main-container">{imgs}'
            '<div class="se-sticker"><img src="https://storep-phinf.pstatic.net/s.png"></div></div>')


BLOGS = {
    "https://m.blog.naver.com/aaa/1001": blog_html("2026. 9. 20. 10:00", 2),
    "https://m.blog.naver.com/ccc/1003": blog_html("2026. 8. 1. 10:00", 1),
}


class R:
    def __init__(self, status, text="", content=b"", ctype="text/html"):
        self.status_code, self.text, self.content = status, text, content
        self.headers = {"Content-Type": ctype}


class FakeHttp:
    def __init__(self):
        self.headers, self.calls = {}, []

    def get(self, url, headers=None, timeout=None):
        self.calls.append(url)
        if url in BLOGS:
            return R(200, BLOGS[url])
        if "pstatic.net" in url and "?" not in url:
            buf = io.BytesIO()
            Image.new("RGB", (900, 600), (hash(url) % 255, 10, 10)).save(buf, "JPEG")
            return R(200, content=buf.getvalue(), ctype="image/jpeg")
        return R(404)


def test_full_flow(tmp_path):
    def hook(ctx):
        ctx.route("https://naver.me/**", lambda r: r.fulfill(
            body="<script>setTimeout(()=>location.href='https://map.naver.com/p/entry/place/1234567?c=15',300)</script>",
            content_type="text/html; charset=utf-8"))
        ctx.route("https://map.naver.com/**", lambda r: r.fulfill(body="<html>map</html>", content_type="text/html; charset=utf-8"))
        ctx.route("https://m.place.naver.com/**/review/ugc*", lambda r: r.fulfill(body=UGC_HTML, content_type="text/html; charset=utf-8"))
        ctx.route("https://m.place.naver.com/**/review/visitor*", lambda r: r.fulfill(body=VISITOR_HTML, content_type="text/html; charset=utf-8"))
        ctx.route("https://pcmap-api.place.naver.com/graphql", lambda r: r.fulfill(json=PAGE2))
        ctx.route("https://api.place.naver.com/graphql", lambda r: r.fulfill(json=VISITOR))

    logs = []
    opts = JobOptions(link="https://naver.me/xa5WfSO3", start=date(2026, 7, 1), end=date(2026, 9, 30),
                      out_dir=str(tmp_path), include_visitor=True, headless=True, max_reviews=50)
    job = Job(opts, log=logs.append, stop_event=threading.Event())
    job.context_hook = hook
    job.http = FakeHttp()
    job.store_session = job.http
    job._launch = lambda pw: pw.chromium.launch(executable_path=CHROME, headless=True)

    folder = job.run()
    print("\n".join(logs))
    assert os.path.basename(folder) == "스움식당 성수점"
    files = sorted(f for f in os.listdir(folder) if f.endswith(".jpg"))
    assert files == ["2026-08-01_ccc_01.jpg", "2026-09-20_aaa_01.jpg", "2026-09-20_aaa_02.jpg",
                     "2026-09-21_방문자_리뷰왕_01.jpg"]
    # 기간 밖(2025년) 블로그는 본문을 열지도 않는다
    assert not any("bbb" in c for c in job.http.calls)

    # 재실행: 새로 저장 0장
    job2 = Job(opts, log=logs.append)
    job2.context_hook, job2.http, job2.store_session = hook, FakeHttp(), None
    job2.store_session = job2.http
    job2._launch = job._launch
    job2.run()
    assert job2.stats["saved"] == 0 and job2.stats["exists"] == 4
