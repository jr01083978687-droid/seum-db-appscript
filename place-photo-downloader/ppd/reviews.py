"""플레이스 페이지가 받아온 JSON(Apollo 초기상태, GraphQL 응답)에서 리뷰를 찾는다.

네이버 응답 스키마는 예고 없이 바뀌므로, 정확한 경로 대신
"블로그 글 URL을 가진 객체", "media 목록을 가진 방문자리뷰 객체"를 전체 트리에서 찾는다.
"""
from .links import parse_blog_url

URL_KEYS = ("url", "link", "postUrl", "mobileUrl", "blogUrl", "href")
DATE_KEYS = ("date", "createdString", "created", "postDate", "writtenDate", "createdAt", "visited")
TITLE_KEYS = ("title", "postTitle")
AUTHOR_KEYS = ("authorName", "blogName", "nickname", "profileName", "writer", "name")


def walk_dicts(obj, refs=None):
    """모든 dict를 순회. Apollo {"__ref": key}는 refs에서 찾아 펼친다."""
    stack, seen = [obj], set()
    while stack:
        o = stack.pop()
        if isinstance(o, dict):
            if "__ref" in o and refs is not None and len(o) == 1:
                o = refs.get(o["__ref"])
                if o is None:
                    continue
            if id(o) in seen:
                continue
            seen.add(id(o))
            yield o
            stack.extend(o.values())
        elif isinstance(o, list):
            stack.extend(o)


def _deref(v, refs):
    if isinstance(v, dict) and "__ref" in v and refs is not None:
        return refs.get(v["__ref"], {})
    return v


def _first_str(d, keys):
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def extract_blog_reviews(obj, refs=None):
    out = {}
    for d in walk_dicts(obj, refs):
        kind = str(d.get("type", "")).lower()
        if kind != "blog" and "review" not in str(d.get("__typename", "")).lower():
            continue  # 리뷰가 아닌 링크(가게 공식 블로그 등)는 제외
        for k in URL_KEYS:
            v = d.get(k)
            if isinstance(v, str) and "blog.naver.com" in v:
                blog_id, log_no = parse_blog_url(v)
                if blog_id and log_no:
                    key = f"{blog_id}/{log_no}"
                    item = out.setdefault(key, {"key": key, "blog_id": blog_id, "log_no": log_no,
                                                "url": v, "title": "", "author": "", "date_text": ""})
                    item["title"] = item["title"] or _first_str(d, TITLE_KEYS)
                    item["author"] = item["author"] or _first_str(d, AUTHOR_KEYS[:-1])
                    item["date_text"] = item["date_text"] or _first_str(d, DATE_KEYS)
                    thumbs = d.get("thumbnailUrlList")
                    if isinstance(thumbs, list) and not item.get("thumbs"):
                        item["thumbs"] = [t.split("#")[0] for t in thumbs if isinstance(t, str) and t.startswith("http")]
                break
    return list(out.values())


def extract_visitor_reviews(obj, refs=None):
    out = {}
    for d in walk_dicts(obj, refs):
        media = _deref(d.get("media"), refs)
        if not isinstance(media, list) or not ("visited" in d or "created" in d):
            continue
        photos = []
        for m in media:
            m = _deref(m, refs)
            if not isinstance(m, dict):
                continue
            url = m.get("thumbnail") or m.get("url") or m.get("imageUrl") or ""
            if isinstance(url, str) and url.startswith(("http", "//")):
                photos.append({"url": url, "is_video": str(m.get("type", "")).lower() == "video"})
        if not photos:
            continue
        author = _deref(d.get("author"), refs)
        nickname = author.get("nickname", "") if isinstance(author, dict) else ""
        rid = str(d.get("id") or d.get("reviewId") or "")
        key = rid or photos[0]["url"]
        out[key] = {"key": key, "id": rid, "author": nickname,
                    "date_text": str(d.get("created") or d.get("visited") or ""),
                    "photos": photos}
    return list(out.values())


def find_place_name(obj, refs=None, place_id=None):
    """PlaceDetailBase 같은 객체에서 상호명을 찾는다."""
    for d in walk_dicts(obj, refs):
        if place_id and str(d.get("id")) == str(place_id) and isinstance(d.get("name"), str):
            return d["name"]
    return ""
