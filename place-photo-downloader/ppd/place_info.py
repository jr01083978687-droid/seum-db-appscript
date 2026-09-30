"""플레이스 ID → 상호명/주소, 첫 화면 블로그리뷰 (브라우저 없이 일반 요청)."""
import json
import re

from .reviews import extract_blog_reviews, find_place_name, walk_dicts

UA_DESKTOP = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0")


def extract_apollo_state(html):
    """페이지 HTML의 window.__APOLLO_STATE__ = {...}; 를 dict로."""
    m = re.search(r"window\.__APOLLO_STATE__\s*=\s*", html or "")
    if not m:
        return None
    try:
        obj, _ = json.JSONDecoder().raw_decode(html, m.end())
        return obj if isinstance(obj, dict) else None
    except ValueError:
        return None


def find_address(state, place_id):
    for d in walk_dicts(state, state):
        if str(d.get("id")) == str(place_id):
            for k in ("roadAddress", "address", "fullAddress"):
                if isinstance(d.get(k), str) and d[k].strip():
                    return d[k].strip()
    return ""


def og_title_name(html):
    m = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]+)"', html or "")
    if not m:
        return ""
    return re.split(r"\s*[:|-]\s*네이버", m.group(1))[0].strip()


def fetch_place(session, ptype, pid, log):
    """반환: {"name", "address", "blog_items"} — 실패한 항목은 빈 값."""
    info = {"name": "", "address": "", "blog_items": []}
    for path in ("home", "review/ugc"):
        url = f"https://m.place.naver.com/{ptype}/{pid}/{path}"
        try:
            r = session.get(url, headers={"User-Agent": UA_DESKTOP, "Accept-Language": "ko-KR,ko;q=0.9"}, timeout=20)
        except Exception as e:  # noqa: BLE001
            log(f"플레이스 정보 요청 실패: {e}")
            continue
        if r.status_code != 200:
            log(f"플레이스 정보 응답 {r.status_code}: {url}")
            continue
        # 응답 헤더에 charset이 없으면 requests가 latin-1로 읽어 한글이 깨진다 → UTF-8로 직접 디코딩
        text = r.content.decode("utf-8", "replace")
        state = extract_apollo_state(text)
        if state:
            info["name"] = info["name"] or find_place_name(state, state, pid)
            info["address"] = info["address"] or find_address(state, pid)
            if path == "review/ugc":
                info["blog_items"] = extract_blog_reviews(state, state)
        info["name"] = info["name"] or og_title_name(text)
    return info


def area_tokens(address):
    """주소에서 동네 단서(…구, …동, …로/길)를 뽑는다."""
    toks = re.findall(r"[가-힣0-9]+(?:구|동|읍|면|로|길)(?=\s|$)", address or "")
    return [t for t in toks if len(t) >= 2]


def norm(text):
    return re.sub(r"[\s\W_]+", "", (text or "").lower())
