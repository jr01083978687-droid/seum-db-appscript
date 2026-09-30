"""네이버 블로그 글 HTML에서 본문 사진/동영상 썸네일/작성일을 뽑는다.

스마트에디터 ONE(se-*), 스마트에디터 2(se_*), 구버전(#postViewArea)을 모두 본다.
스티커·지도·링크 미리보기 카드는 제외한다.
"""
import json
import re
from dataclasses import dataclass
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from .dates import parse_kr_date

# 블로그 본문 사진이 올라가는 호스트
PHOTO_HOSTS = (
    "postfiles.pstatic.net",
    "blogfiles.pstatic.net",
    "mblogthumb-phinf.pstatic.net",
    "blogthumb.pstatic.net",
)
# 동영상 썸네일 호스트 (phinf 계열 전반)
VIDEO_THUMB_HOST_SUFFIX = ".pstatic.net"

# 이 클래스가 조상에 있으면 제외
EXCLUDE_CLASS_PARTS = ("sticker", "map", "oglink", "og_", "profile", "emoticon", "comment")
# 이 문자열이 URL에 있으면 제외
EXCLUDE_URL_PARTS = ("storep-phinf", "static.map", "map.pstatic.net", "simg.pstatic.net/static",
                     "/sticker/", "emoticon", "dthumb-phinf")

BODY_SELECTORS = ("div.se-main-container", "div#viewTypeSelector", "div.se_component_wrap",
                  "div#postViewArea", "div.post_ct")


@dataclass
class BlogPhoto:
    url: str          # 원본에 가까운 URL (축소 파라미터 제거)
    is_video: bool = False
    raw_url: str = ""  # 본문에 적혀 있던 URL (원본 요청 실패 시 대체)

    def candidates(self):
        """다운로드 시도 순서: 원본 → w966 → 본문 URL."""
        out = [self.url, self.url + "?type=w966"]
        if self.raw_url and self.raw_url not in out:
            out.append(self.raw_url)
        return out


@dataclass
class BlogPost:
    title: str
    date: object      # datetime.date | None
    photos: list


def parse_blog_html(html):
    soup = BeautifulSoup(html, "html.parser")
    body = None
    for sel in BODY_SELECTORS:
        body = soup.select_one(sel)
        if body:
            break
    if body is None:
        body = soup

    photos, seen = [], set()

    def add(raw, is_video=False):
        url = normalize_image_url(raw)
        if not url:
            return
        key = url.split("?")[0]
        if key in seen:
            return
        seen.add(key)
        raw_full = raw if raw.startswith("http") else "https:" + raw
        photos.append(BlogPhoto(url, is_video, raw_full))

    # 1) 동영상 모듈: data-module JSON / 스크립트 JSON의 thumbnail
    for el in body.select('[class*="se-video"], [class*="se-module-video"], [class*="_video"]'):
        for thumb in _video_thumbs(el):
            if _is_video_thumb_host(thumb):
                add(thumb, True)
    for script in body.select("script.__se_module_data, script[data-module]"):
        data = script.get("data-module") or script.string or ""
        if "video" in data:
            for thumb in _json_thumbnails(data):
                if _is_video_thumb_host(thumb):
                    add(thumb, True)

    # 2) 본문 이미지
    for img in body.find_all("img"):
        src = img.get("data-lazy-src") or img.get("data-src") or img.get("src") or ""
        if not src or src.startswith("data:"):
            continue
        if _excluded_by_ancestor(img):
            continue
        if any(p in src for p in EXCLUDE_URL_PARTS):
            continue
        host = urlparse(src).netloc
        if host in PHOTO_HOSTS:
            add(src, _inside_video(img))
        elif _inside_video(img) and _is_video_thumb_host(src):
            add(src, True)

    return BlogPost(title=_title(soup), date=_post_date(soup), photos=photos)


def normalize_image_url(url):
    """?type=w80_blur 같은 축소 파라미터를 떼어 원본을 요청한다."""
    if not url:
        return None
    url = url.strip()
    if url.startswith("//"):
        url = "https:" + url
    if not url.startswith("http"):
        return None
    return url.split("?")[0]


def _excluded_by_ancestor(tag):
    for parent in [tag] + list(tag.parents):
        classes = parent.get("class") if hasattr(parent, "get") else None
        if not classes:
            continue
        joined = " ".join(classes).lower()
        if any(part in joined for part in EXCLUDE_CLASS_PARTS):
            return True
    return False


def _inside_video(tag):
    for parent in tag.parents:
        classes = parent.get("class") if hasattr(parent, "get") else None
        if classes and "video" in " ".join(classes).lower():
            return True
    return False


def _is_video_thumb_host(url):
    host = urlparse(url if url.startswith("http") else "https:" + url).netloc
    return host.endswith(VIDEO_THUMB_HOST_SUFFIX) and not any(p in url for p in EXCLUDE_URL_PARTS)


def _video_thumbs(el):
    out = []
    raw = el.get("data-module") or el.get("data-video") or ""
    if raw:
        out += _json_thumbnails(raw)
    for script in el.find_all("script"):
        out += _json_thumbnails(script.get("data-module") or script.string or "")
    return out


def _json_thumbnails(raw):
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return re.findall(r'"thumbnail"\s*:\s*"([^"]+)"', raw or "")
    found = []

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k in ("thumbnail", "thumbnailUrl", "thumb") and isinstance(v, str):
                    found.append(v)
                else:
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(data)
    return found


def _title(soup):
    for sel in (".se-title-text", ".se_title .se_textarea", ".tit_h3", "h3.se_textarea"):
        el = soup.select_one(sel)
        if el and el.get_text(strip=True):
            return el.get_text(" ", strip=True)
    og = soup.find("meta", property="og:title")
    if og and og.get("content"):
        return og["content"].strip()
    return soup.title.get_text(strip=True) if soup.title else ""


def _post_date(soup):
    for sel in ("p.blog_date", "span.se_publishDate", "p.date", "span.date", ".blog2_container .se_publishDate"):
        el = soup.select_one(sel)
        if el:
            d = parse_kr_date(el.get_text(" ", strip=True))
            if d:
                return d
    meta = soup.find("meta", property="article:published_time") or soup.find("meta", attrs={"name": "date"})
    if meta and meta.get("content"):
        return parse_kr_date(meta["content"])
    return None
