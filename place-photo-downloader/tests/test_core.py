import io
import json
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image

from ppd.blog_parser import parse_blog_html
from ppd.dates import parse_input_date, parse_kr_date
from ppd.downloader import PhotoStore
from ppd.links import parse_blog_url, parse_place_url
from ppd.reviews import extract_blog_reviews, extract_visitor_reviews, find_place_name

TODAY = date(2026, 9, 30)

SE_ONE_HTML = """
<html><head><meta property="og:title" content="성수 맛집 후기"></head><body>
<div class="se-title-text">성수 스움식당 솔직후기</div>
<p class="blog_date">2026. 9. 12. 14:22</p>
<div class="se-main-container">
  <div class="se-component se-image"><img class="se-image-resource"
     src="https://postfiles.pstatic.net/A/1.jpg?type=w80_blur" data-lazy-src="https://postfiles.pstatic.net/A/1.jpg?type=w773"></div>
  <div class="se-component se-imageStrip"><img src="https://postfiles.pstatic.net/A/2.jpg?type=w386"></div>
  <div class="se-component se-sticker"><img class="se-sticker-image" src="https://storep-phinf.pstatic.net/x/1.png"></div>
  <div class="se-component se-placesMap"><img src="https://simg.pstatic.net/static.map/v2/map/staticmap.bin?x=1"></div>
  <div class="se-component se-oglink"><img src="https://dthumb-phinf.pstatic.net/?src=abc"></div>
  <div class="se-component se-video">
    <script type="text/data" class="__se_module_data" data-module='{"type":"v2_video","data":{"thumbnail":"https://phinf.pstatic.net/image.nmv/v/1.jpg"}}'></script>
  </div>
  <div class="se-component se-image"><img src="https://postfiles.pstatic.net/A/1.jpg?type=w966"></div>
</div></body></html>
"""


def test_blog_parser_filters():
    post = parse_blog_html(SE_ONE_HTML)
    urls = [p.url for p in post.photos]
    assert post.title == "성수 스움식당 솔직후기"
    assert post.date == date(2026, 9, 12)
    assert "https://postfiles.pstatic.net/A/1.jpg" in urls
    assert "https://postfiles.pstatic.net/A/2.jpg" in urls
    assert urls.count("https://postfiles.pstatic.net/A/1.jpg") == 1  # 같은 사진 중복 제거
    assert not any("storep" in u or "static.map" in u or "dthumb" in u for u in urls)
    videos = [p for p in post.photos if p.is_video]
    assert [v.url for v in videos] == ["https://phinf.pstatic.net/image.nmv/v/1.jpg"]
    assert post.photos[1].candidates()[0].endswith(".jpg")


def test_old_editor():
    html = ('<div id="postViewArea"><span class="se_publishDate">2025. 1. 3. 9:00</span>'
            '<img src="https://blogfiles.pstatic.net/B/a.JPG"><img src="https://ssl.pstatic.net/static/icon.gif"></div>')
    post = parse_blog_html(html)
    assert [p.url for p in post.photos] == ["https://blogfiles.pstatic.net/B/a.JPG"]
    assert post.date == date(2025, 1, 3)


def test_dates():
    assert parse_kr_date("2026.03.15.", TODAY) == date(2026, 3, 15)
    assert parse_kr_date("24.3.5.", TODAY) == date(2024, 3, 5)
    assert parse_kr_date("9.12.금", TODAY) == date(2026, 9, 12)
    assert parse_kr_date("12.24.수", TODAY) == date(2025, 12, 24)  # 미래면 작년
    assert parse_kr_date("3일 전", TODAY) == date(2026, 9, 27)
    assert parse_kr_date("5시간 전", TODAY) == TODAY
    assert parse_kr_date("어제", TODAY) == date(2026, 9, 29)
    assert parse_kr_date("2026-09-01T10:00:00+09:00", TODAY) == date(2026, 9, 1)
    assert parse_kr_date("", TODAY) is None
    assert parse_input_date("20260131") == date(2026, 1, 31)
    assert parse_input_date("2026.1.31") == date(2026, 1, 31)


def test_links():
    assert parse_place_url("https://m.place.naver.com/restaurant/1234567/home") == ("restaurant", "1234567")
    assert parse_place_url("https://map.naver.com/p/entry/place/1234567?c=15") == ("place", "1234567")
    assert parse_place_url("https://map.naver.com/p/search/성수/place/7654321") == ("place", "7654321")
    assert parse_place_url("https://naver.me/xa5WfSO3") == (None, None)
    assert parse_blog_url("https://blog.naver.com/abc/223456789") == ("abc", "223456789")
    assert parse_blog_url("https://m.blog.naver.com/PostView.naver?blogId=abc&logNo=22") == ("abc", "22")
    assert parse_blog_url("https://cafe.naver.com/abc/1") == (None, None)


def test_extract_reviews_schema_agnostic():
    apollo = {
        "PlaceDetailBase:1234": {"id": "1234", "name": "스움식당"},
        "ROOT_QUERY": {"fsasReviews": {"items": [
            {"type": "blog", "url": "https://blog.naver.com/abc/111", "title": "후기", "authorName": "먹보",
             "date": "2026.09.01."},
            {"type": "cafe", "url": "https://cafe.naver.com/x/1"},
        ]}},
    }
    blogs = extract_blog_reviews(apollo, apollo)
    assert len(blogs) == 1 and blogs[0]["blog_id"] == "abc" and blogs[0]["date_text"] == "2026.09.01."
    assert find_place_name(apollo, apollo, "1234") == "스움식당"

    gql = [{"data": {"visitorReviews": {"items": [
        {"id": "r1", "created": "9.20.토", "visited": "9.19.금", "author": {"__ref": "A:1"},
         "media": [{"type": "image", "thumbnail": "https://pup-review-phinf.pstatic.net/a.jpg?type=w560"},
                   {"type": "video", "thumbnail": "https://video-phinf.pstatic.net/v.jpg"}]},
        {"id": "r2", "created": "9.18.목", "media": []},
    ]}}}]
    refs = {"A:1": {"nickname": "리뷰왕"}}
    vis = extract_visitor_reviews(gql, refs)
    assert len(vis) == 1 and vis[0]["author"] == "리뷰왕" and vis[0]["photos"][1]["is_video"]


class FakeResp:
    def __init__(self, content, status=200):
        self.content, self.status_code = content, status
        self.headers = {"Content-Type": "image/jpeg"}


class FakeSession:
    def __init__(self, table):
        self.table, self.headers, self.calls = table, {}, []

    def get(self, url, headers=None, timeout=None):
        self.calls.append(url)
        return self.table.get(url, FakeResp(b"", 404))


def _jpeg(w, h, color):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "JPEG")
    return buf.getvalue()


def test_store_dedup_small_and_rerun(tmp_path):
    big, small = _jpeg(800, 600, "red"), _jpeg(100, 100, "blue")
    sess = FakeSession({"u1": FakeResp(big), "u2?type=w966": FakeResp(big), "u3": FakeResp(small)})
    store = PhotoStore(str(tmp_path), min_width=300, session=sess)
    assert store.save("u1", ["u1"], "2026-09-12_abc_01", "r")[0] == "saved"
    assert store.save("u2", ["u2", "u2?type=w966"], "2026-09-12_abc_02", "r")[0] == "dup"  # 같은 내용
    assert store.save("u3", ["u3"], "2026-09-12_abc_03", "r")[0] == "small"
    store.flush()
    assert sorted(os.listdir(tmp_path)) == ["2026-09-12_abc_01.jpg", "_다운로드기록.json"]

    sess2 = FakeSession({})
    store2 = PhotoStore(str(tmp_path), min_width=300, session=sess2)
    assert store2.save("u1", ["u1"], "x", "r")[0] == "exists"
    assert store2.save("u3", ["u3"], "x", "r")[0] == "exists"
    assert sess2.calls == []  # 재실행 시 네트워크 요청 없음


def test_real_shaped_fsas_state():
    """2026-09 실제 m.place 응답 모양 (라이브 테스트에서 확인)."""
    state = {
        "PlaceDetailBase:20869021": {"id": "20869021", "name": "아우성황소곱창",
                                     "homepages": {"etc": [{"url": "https://blog.naver.com/gusfo_official/224264167819"}]}},
        "FsasReview:blog_쿠키댕댕_224423272854_x": {
            "__typename": "FsasReview", "name": "쿠키댕댕", "type": "blog",
            "url": "https://m.blog.naver.com/vzpf896g/224423272854", "title": "직접 겪은 소대창구이",
            "date": "4일 전", "authorName": "쿠키댕댕", "createdString": "26.9.26.금",
            "thumbnailUrlList": ["http://blogfiles.naver.net/A/_rmt_0.jpg#1500x1877",
                                 "http://blogfiles.naver.net/A/_rmt_1.jpg#1500x2000"]},
        "FsasReview:cafe_x_4440_y": {
            "__typename": "FsasReview", "type": "cafe", "url": "https://m.cafe.naver.com/wnahdskfk/4440"},
    }
    blogs = extract_blog_reviews(state, state)
    assert [b["key"] for b in blogs] == ["vzpf896g/224423272854"]  # 공식 블로그·카페 제외
    assert blogs[0]["thumbs"] == ["http://blogfiles.naver.net/A/_rmt_0.jpg", "http://blogfiles.naver.net/A/_rmt_1.jpg"]
    assert parse_kr_date(blogs[0]["date_text"], TODAY) == date(2026, 9, 26)
    assert find_place_name(state, state, "20869021") == "아우성황소곱창"
