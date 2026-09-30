"""플레이스/블로그 URL 해석."""
import re
from urllib.parse import parse_qs, urlparse

# m.place.naver.com/restaurant/1234, pcmap.place.naver.com/hairshop/1234 ...
_PLACE_TYPED = re.compile(r"place\.naver\.com/([a-z]+)/(\d+)")
# map.naver.com/p/entry/place/1234, map.naver.com/p/search/xx/place/1234, map.naver.com/v5/entry/place/1234
_MAP_PLACE = re.compile(r"map\.naver\.com/.*?/place/(\d+)")
_PLACE_ID_QUERY = re.compile(r"[?&](?:placeId|place_id|id)=(\d{5,})")


def parse_place_url(url):
    """URL에서 (업종타입, 플레이스ID)를 꺼낸다. 타입을 모르면 'place'."""
    if not url:
        return None, None
    m = _PLACE_TYPED.search(url)
    if m and m.group(1) not in ("my", "p"):
        return m.group(1), m.group(2)
    m = _MAP_PLACE.search(url)
    if m:
        return "place", m.group(1)
    m = _PLACE_ID_QUERY.search(url)
    if m:
        return "place", m.group(1)
    return None, None


def is_short_link(url):
    return bool(re.search(r"(^|//)(naver\.me)/", url or ""))


def parse_blog_url(url):
    """블로그 글 URL → (blogId, logNo). 블로그 글이 아니면 (None, None)."""
    if not url:
        return None, None
    u = urlparse(url if "://" in url else "https://" + url)
    if not u.netloc.endswith("blog.naver.com"):
        return None, None
    q = parse_qs(u.query)
    if "blogId" in q and "logNo" in q:
        return q["blogId"][0], q["logNo"][0]
    parts = [p for p in u.path.split("/") if p]
    if len(parts) >= 2 and parts[1].isdigit():
        return parts[0], parts[1]
    return None, None


def mobile_blog_url(blog_id, log_no):
    return f"https://m.blog.naver.com/{blog_id}/{log_no}"
