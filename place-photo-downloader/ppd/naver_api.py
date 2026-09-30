"""네이버 공식 검색 API (블로그). https://developers.naver.com/docs/serviceapi/search/blog/blog.md"""
import html
import re
from datetime import date

import requests

BLOG_API_URL = "https://openapi.naver.com/v1/search/blog.json"
MAX_START = 1000   # API 제한: start 최대 1000
PAGE_SIZE = 100    # API 제한: display 최대 100


class ApiError(RuntimeError):
    pass


def strip_tags(text):
    return html.unescape(re.sub(r"<[^>]+>", "", text or "")).strip()


def parse_postdate(s):
    s = str(s or "")
    if re.fullmatch(r"\d{8}", s):
        try:
            return date(int(s[:4]), int(s[4:6]), int(s[6:]))
        except ValueError:
            return None
    return None


class BlogSearch:
    def __init__(self, client_id, client_secret, session=None):
        if not client_id or not client_secret:
            raise ApiError("네이버 API Client ID / Secret 을 입력하세요.")
        self.session = session or requests.Session()
        self.headers = {"X-Naver-Client-Id": client_id, "X-Naver-Client-Secret": client_secret}
        self.calls = 0

    def page(self, query, start=1, display=PAGE_SIZE, sort="date"):
        r = self.session.get(BLOG_API_URL, params={"query": query, "display": display, "start": start, "sort": sort},
                             headers=self.headers, timeout=20)
        self.calls += 1
        if r.status_code == 401:
            raise ApiError("네이버 API 인증 실패 — Client ID/Secret 을 확인하세요. (검색 API 사용 설정 필요)")
        if r.status_code == 429:
            raise ApiError("네이버 API 하루 호출 한도를 넘었습니다. 내일 다시 시도하세요.")
        if r.status_code != 200:
            raise ApiError(f"네이버 API 오류 {r.status_code}: {r.text[:200]}")
        return r.json()

    def iter_recent(self, query, since, max_results=MAX_START):
        """최신순으로 넘기다가 since 보다 오래된 글이 나오면 멈춘다."""
        start = 1
        while start <= min(max_results, MAX_START):
            data = self.page(query, start=start)
            items = data.get("items") or []
            for it in items:
                d = parse_postdate(it.get("postdate"))
                if d is not None and d < since:
                    return
                yield {
                    "link": it.get("link", ""),
                    "title": strip_tags(it.get("title")),
                    "description": strip_tags(it.get("description")),
                    "blogger": strip_tags(it.get("bloggername")),
                    "postdate": d,
                }
            if len(items) < PAGE_SIZE:
                return
            start += PAGE_SIZE
