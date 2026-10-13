"""블로그 사진 주소 형식별로 실제 받아지는 해상도를 비교 (원본 화질 확인용)."""
import io
import sys

import requests
from PIL import Image

sys.path.insert(0, ".")
from ppd.blog_parser import parse_blog_html  # noqa: E402
from ppd.downloader import UA_MOBILE  # noqa: E402

POSTS = sys.argv[1:] or ["coygpwjd/223712854368", "rwsr0621/223919798983"]
s = requests.Session()
s.headers["User-Agent"] = UA_MOBILE


def variants(url):
    base = url.split("?")[0]
    path = base.split(".net", 1)[1]
    out = [("쿼리없음", base)]
    for t in ("w2", "w1", "w3840", "w1600", "w966"):
        out.append((f"type={t}", f"{base}?type={t}"))
    for host in ("https://blogfiles.pstatic.net", "http://blogfiles.naver.net", "https://postfiles.naver.net"):
        out.append((host.split("//")[1], host + path))
    return out


for post in POSTS:
    html = s.get(f"https://m.blog.naver.com/{post}", timeout=20).content.decode("utf-8", "replace")
    photos = [p for p in parse_blog_html(html).photos if not p.is_video][:3]
    print(f"== {post}: 사진 {len(photos)}장 비교")
    for ph in photos:
        print("  본문 주소:", ph.raw_url[:120])
        for label, u in variants(ph.url):
            try:
                r = s.get(u, headers={"Referer": "https://m.blog.naver.com/"}, timeout=20)
                size = Image.open(io.BytesIO(r.content)).size if r.status_code == 200 else None
                print(f"    {label:28} {r.status_code} {size} {len(r.content)}B")
            except Exception as e:  # noqa: BLE001
                print(f"    {label:28} 오류 {str(e)[:60]}")
