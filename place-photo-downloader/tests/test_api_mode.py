"""공식 API 방식 흐름 (네트워크 없이 가짜 응답)."""
import hashlib
import io
import json
import os
import sys
from datetime import date

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image

from ppd.job import Job, JobOptions
from ppd.naver_api import ApiError, BlogSearch, parse_postdate, strip_tags
from ppd.place_info import area_tokens, extract_apollo_state

PID = "20869021"
STATE = {
    f"PlaceDetailBase:{PID}": {"id": PID, "name": "아우성황소곱창", "roadAddress": "서울 은평구 연서로29길 14-12"},
    "FsasReview:blog_a": {"__typename": "FsasReview", "type": "blog",
                          "url": "https://m.blog.naver.com/verified1/1001", "title": "확실한 리뷰", "date": "2026.09.20."},
}
PLACE_HTML = "<html><script>window.__APOLLO_STATE__ = %s;</script></html>" % json.dumps(STATE, ensure_ascii=False)


def api_item(link, title, day, desc=""):
    return {"link": link, "title": title, "description": desc, "bloggername": "블로거", "postdate": day}


API_PAGES = {
    "아우성황소곱창": [
        api_item("https://blog.naver.com/bymap/2001", "연신내 곱창 맛집", "20260925"),      # 본문에 지도(플레이스ID)
        api_item("https://blog.naver.com/bytitle/2002", "<b>아우성황소곱창</b> 후기", "20260910"),
        api_item("https://blog.naver.com/other/2003", "다른 지점 아우성 곱창", "20260905"),  # 다른 가게
        api_item("https://blog.naver.com/future/2004", "미래 글", "20261005"),              # 종료일 이후
        api_item("https://blog.naver.com/old/2005", "옛날 글", "20250101"),                 # 시작일 이전 → 검색 중단
        api_item("https://blog.naver.com/never/2006", "도달하면 안 됨", "20260915"),
    ],
}


def post_html(day, body, n=1):
    imgs = "".join(f'<img src="https://postfiles.pstatic.net/{day}/{body[:3]}{i}.jpg?type=w80">' for i in range(n))
    return f'<p class="blog_date">{day}</p><div class="se-main-container"><p>{body}</p>{imgs}</div>'


BLOGS = {
    "https://m.blog.naver.com/verified1/1001": post_html("2026. 9. 20.", "리뷰 본문"),
    "https://m.blog.naver.com/bymap/2001": post_html("2026. 9. 25.", f'지도 <div class="se-placesMap" data-linkdata=\'{{"placeId":"{PID}"}}\'></div>', 2),
    "https://m.blog.naver.com/bytitle/2002": post_html("2026. 9. 10.", "맛있었어요"),
    "https://m.blog.naver.com/other/2003": post_html("2026. 9. 5.", "아우성황소곱창 일산점 다녀옴 (일산동구 중앙로)"),
}


class R:
    def __init__(self, status=200, text="", content=b"", ctype="text/html", js=None):
        # 실제 requests처럼: charset 없는 응답은 text 가 latin-1 로 깨져 보인다
        self.content = content or text.encode("utf-8")
        self.text = self.content.decode("latin-1") if text else ""
        self.encoding = "ISO-8859-1"
        self.status_code, self._js = status, js
        self.headers = {"Content-Type": ctype}

    def json(self):
        return self._js


class FakeHttp:
    def __init__(self):
        self.headers, self.calls = {}, []

    def get(self, url, headers=None, timeout=None, allow_redirects=True, params=None):
        self.calls.append(url)
        if url == "https://naver.me/test":
            return R(307, text="", ctype="text/html") if False else _redirect()
        if url.startswith(f"https://m.place.naver.com/place/{PID}/"):
            return R(200, PLACE_HTML)
        if url == "https://openapi.naver.com/v1/search/blog.json":
            items = API_PAGES.get(params["query"], [])
            return R(200, js={"items": items[params["start"] - 1: params["start"] - 1 + params["display"]]})
        if url in BLOGS:
            return R(200, BLOGS[url])
        if "pstatic.net" in url and "?" not in url:
            buf = io.BytesIO()
            Image.new("RGB", (800, 600), tuple(hashlib.md5(url.encode()).digest()[:3])).save(buf, "JPEG")
            return R(200, content=buf.getvalue(), ctype="image/jpeg")
        return R(404)


def _redirect():
    r = R(307)
    r.headers["Location"] = f"https://map.naver.com/p/entry/place/{PID}?c=15"
    return r


def make_job(tmp_path, **kw):
    opts = JobOptions(link="https://naver.me/test", start=date(2026, 7, 1), end=date(2026, 9, 30),
                      out_dir=str(tmp_path), client_id="id", client_secret="secret", **kw)
    job = Job(opts, log=print)
    job.http = job.store_session = job.api_session = FakeHttp()
    return job


def test_api_mode_flow(tmp_path):
    job = make_job(tmp_path)
    folder = job.run()
    assert os.path.basename(folder) == "아우성황소곱창"
    files = sorted(f for f in os.listdir(folder) if f.endswith(".jpg"))
    assert files == ["2026-09-10_bytitle_01.jpg", "2026-09-20_verified1_01.jpg",
                     "2026-09-25_bymap_01.jpg", "2026-09-25_bymap_02.jpg"]
    assert job.stats["other"] == 1                       # 일산점 글 제외
    calls = job.http.calls
    assert not any("future" in c or "never" in c or "/old/" in c for c in calls)


def test_api_mode_needs_keys(tmp_path):
    job = make_job(tmp_path)
    job.o.client_id = ""
    with pytest.raises(ApiError):
        job.run()


def test_manual_place_name_without_link(tmp_path):
    job = make_job(tmp_path, place_name="아우성황소곱창")
    job.o.link = ""
    job.run()
    # 링크가 없으면 플레이스ID·주소를 몰라 지도/동네 확인 불가 → 제목에 상호명이 있는 글만 인정
    assert job.stats["saved"] == 1 and job.stats["other"] == 2


def test_helpers():
    assert strip_tags("<b>아우성</b> &amp; 곱창") == "아우성 & 곱창"
    assert parse_postdate("20260930") == date(2026, 9, 30) and parse_postdate("") is None
    assert "은평구" in area_tokens("서울 은평구 연서로29길 14-12")
    assert extract_apollo_state(PLACE_HTML)[f"PlaceDetailBase:{PID}"]["name"] == "아우성황소곱창"
