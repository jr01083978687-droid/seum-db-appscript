"""전체 작업 흐름: 링크 해석 → 리뷰 목록 수집(브라우저) → 블로그 본문 사진 추출 → 다운로드."""
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime

import requests

from . import blog_parser
from .dates import parse_kr_date
from .downloader import UA_MOBILE, PhotoStore, safe_name
from .links import is_short_link, mobile_blog_url, parse_place_url
from .reviews import extract_blog_reviews, extract_visitor_reviews, find_place_name

BROWSER_CHANNELS = ("msedge", "chrome")
CAPTCHA_WAIT_SEC = 180
OLD_STREAK_TO_STOP_BLOG = 15     # 목록 끝부분이 이만큼 연속으로 시작일보다 오래되면 그만 넘김
OLD_STREAK_TO_STOP_VISITOR = 5   # 방문자리뷰는 최신순 정렬이라 짧게

# 목록 맨 아래 "더보기"(리뷰 본문 펼치기 말고)를 찾아 누른다.
_CLICK_MORE_JS = r"""
() => {
  const els = [...document.querySelectorAll('a, button')].filter(e => {
    const t = (e.innerText || '').replace(/\s+/g, '');
    if (!t.startsWith('더보기') || t.length > 12) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!els.length) return false;
  const el = els[els.length - 1];
  el.scrollIntoView({block: 'center'});
  el.click();
  return true;
}
"""
_CLICK_TEXT_JS = r"""
(label) => {
  const el = [...document.querySelectorAll('a, button, span')]
    .find(e => (e.innerText || '').trim() === label);
  if (!el) return false;
  (el.closest('a, button') || el).click();
  return true;
}
"""
_BLOG_LINKS_JS = r"""
() => [...document.querySelectorAll('a[href*="blog.naver.com"]')].map(a => a.href)
"""


@dataclass
class JobOptions:
    link: str
    start: object              # date
    end: object                # date
    out_dir: str
    include_visitor: bool = False
    headless: bool = False
    min_width: int = 300
    max_reviews: int = 300     # 목록에서 확인할 최대 리뷰 수 (블로그/방문자 각각)


class StopRequested(Exception):
    pass


class Job:
    def __init__(self, opts, log, progress=None, stop_event=None):
        self.o = opts
        self._log = log
        self.progress = progress or (lambda done, total: None)
        self.stop_event = stop_event
        self.debug_dir = os.path.join(opts.out_dir, "_진단")
        self.stats = {"saved": 0, "exists": 0, "dup": 0, "small": 0, "fail": 0}
        self.context_hook = None   # 테스트용: 브라우저 컨텍스트 준비 후 호출
        self.store_session = None  # 테스트용: 이미지 다운로드 세션 교체
        self.http = requests.Session()
        self.http.headers.update({"User-Agent": UA_MOBILE, "Accept-Language": "ko-KR,ko;q=0.9"})

    # ---------- 공통 ----------
    def log(self, msg):
        self._log(f"[{datetime.now():%H:%M:%S}] {msg}")

    def check_stop(self):
        if self.stop_event is not None and self.stop_event.is_set():
            raise StopRequested()

    def in_range(self, d):
        return d is not None and self.o.start <= d <= self.o.end

    def dump_debug(self, name, data):
        os.makedirs(self.debug_dir, exist_ok=True)
        path = os.path.join(self.debug_dir, name)
        with open(path, "w", encoding="utf-8") as f:
            if isinstance(data, str):
                f.write(data)
            else:
                json.dump(data, f, ensure_ascii=False, indent=1, default=str)
        return path

    # ---------- 실행 ----------
    def run(self):
        from playwright.sync_api import sync_playwright

        o = self.o
        self.log(f"기간: {o.start} ~ {o.end}")
        with sync_playwright() as pw:
            browser = self._launch(pw)
            try:
                ctx = browser.new_context(
                    user_agent=UA_MOBILE, locale="ko-KR", viewport={"width": 420, "height": 860},
                    is_mobile=True, has_touch=True)
                if self.context_hook:
                    self.context_hook(ctx)
                page = ctx.new_page()
                ptype, pid = self._resolve_place(page, o.link)
                self.log(f"플레이스 ID: {pid} (유형: {ptype})")

                blog_items, place_name = self._collect_blog_list(page, ptype, pid)
                visitor_items = []
                if o.include_visitor:
                    visitor_items = self._collect_visitor_list(page, ptype, pid)
            finally:
                browser.close()

        folder = os.path.join(o.out_dir, safe_name(place_name or f"플레이스_{pid}", 60))
        store = PhotoStore(folder, min_width=o.min_width, session=self.store_session)
        self.log(f"저장 폴더: {folder}")
        try:
            self._download_blogs(store, blog_items)
            if o.include_visitor:
                self._download_visitors(store, visitor_items)
        finally:
            store.flush()
        s = self.stats
        self.log(f"완료 — 새로 저장 {s['saved']}장, 이미 있음 {s['exists']}, 중복 {s['dup']}, "
                 f"작은 이미지 제외 {s['small']}, 실패 {s['fail']}")
        return folder

    def _launch(self, pw):
        errors = []
        for ch in BROWSER_CHANNELS:
            try:
                b = pw.chromium.launch(channel=ch, headless=self.o.headless)
                self.log(f"브라우저 실행: {ch}")
                return b
            except Exception as e:  # noqa: BLE001
                errors.append(f"{ch}: {str(e).splitlines()[0]}")
        try:
            return pw.chromium.launch(headless=self.o.headless)
        except Exception as e:  # noqa: BLE001
            errors.append(f"chromium: {str(e).splitlines()[0]}")
        raise RuntimeError("Edge/Chrome 브라우저를 실행하지 못했습니다.\n" + "\n".join(errors))

    # ---------- 링크 해석 ----------
    def _resolve_place(self, page, link):
        link = link.strip()
        if not link.startswith("http"):
            link = "https://" + link
        ptype, pid = parse_place_url(link)
        if pid:
            return ptype, pid
        self.log("링크 열어서 플레이스 주소 확인 중…")
        # 1) 단축링크는 HTTP 리다이렉트 주소만 읽어도 ID가 나오는 경우가 많다
        chain = self._redirect_chain(link)
        for u in chain:
            ptype, pid = parse_place_url(u)
            if pid:
                return ptype, pid
        # 2) 스크립트 이동이 필요한 경우 브라우저로 연다
        try:
            page.goto(link, wait_until="domcontentloaded", timeout=30000)
        except Exception as e:  # noqa: BLE001 - 오류 페이지라도 이동한 주소를 확인한다
            self.log(f"링크 열기 오류: {str(e).splitlines()[0]}")
        self._wait_captcha(page)
        # naver.me → map.naver.com 은 스크립트로 한 번 더 이동하는 경우가 있어 잠시 기다린다
        for _ in range(20):
            ptype, pid = parse_place_url(page.url)
            if pid:
                return ptype, pid
            page.wait_for_timeout(500)
        m = re.search(r"place(?:\.naver\.com/[a-z]+|/)/?(\d{6,})", page.content())
        if m:
            return "place", m.group(1)
        self.dump_debug("링크해석실패.txt", f"입력: {link}\n리다이렉트: {chain}\n최종 URL: {page.url}\n")
        raise RuntimeError(f"플레이스 ID를 찾지 못했습니다. 최종 주소: {page.url}"
                           + (" (단축링크)" if is_short_link(link) else ""))

    def _redirect_chain(self, link):
        chain, url = [], link
        for _ in range(8):
            try:
                r = self.http.get(url, allow_redirects=False, timeout=15)
            except requests.RequestException as e:
                self.log(f"링크 요청 실패: {e}")
                break
            loc = r.headers.get("Location")
            self.log(f"  {r.status_code} {url}" + (f" → {loc}" if loc else ""))
            if not loc:
                m = re.search(r"""(?:location\.(?:href|replace)\s*[=(]\s*|url=)["']?([^"' >)]+)""", r.text or "", re.I)
                if m and m.group(1).startswith("http"):
                    chain.append(m.group(1))
                break
            url = requests.compat.urljoin(url, loc)
            chain.append(url)
            if parse_place_url(url)[1]:
                break
        return chain

    # ---------- 목록 수집 ----------
    def _collect_blog_list(self, page, ptype, pid):
        url = f"https://m.place.naver.com/{ptype}/{pid}/review/ugc"
        self.log("블로그리뷰 목록 여는 중…")
        items, place_name = self._collect(page, url, extract_blog_reviews, OLD_STREAK_TO_STOP_BLOG,
                                          dom_blog_links=True, sort_label="최신순", pid=pid)
        self.log(f"블로그리뷰 {len(items)}개 확인")
        if not items:
            self.log("※ 블로그리뷰를 찾지 못했습니다. _진단 폴더를 개발자에게 전달해 주세요.")
        return items, place_name

    def _collect_visitor_list(self, page, ptype, pid):
        url = f"https://m.place.naver.com/{ptype}/{pid}/review/visitor?reviewSort=recent"
        self.log("방문자리뷰 목록 여는 중…")
        items, _ = self._collect(page, url, extract_visitor_reviews, OLD_STREAK_TO_STOP_VISITOR, pid=pid)
        items = [it for it in items if it["photos"]]
        self.log(f"사진 있는 방문자리뷰 {len(items)}개 확인")
        return items

    def _collect(self, page, url, extractor, old_streak_stop, dom_blog_links=False, sort_label=None, pid=None):
        pending = []

        def on_response(resp):
            if "graphql" in resp.url and resp.request.method == "POST":
                pending.append(resp)

        page.on("response", on_response)
        items, place_name, raw_dumps = {}, "", []
        try:
            try:
                resp = page.goto(url, wait_until="domcontentloaded", timeout=30000)
                if resp is not None and resp.status >= 400:
                    self.log(f"페이지 응답 {resp.status}: {url}")
            except Exception as e:  # noqa: BLE001 - 차단/오류 페이지도 진단 자료를 남긴다
                self.log(f"페이지 열기 오류: {str(e).splitlines()[0]}")
            self._wait_captcha(page)
            page.wait_for_timeout(2500)

            state = page.evaluate("() => window.__APOLLO_STATE__ || null")
            if state:
                raw_dumps.append(state)
                place_name = find_place_name(state, state, pid)
                self._merge(items, extractor(state, state))
            if not place_name:
                place_name = self._title_name(page)

            if sort_label:
                self._drain(pending, items, extractor, raw_dumps)
                if page.evaluate(_CLICK_TEXT_JS, sort_label):
                    self.log(f"'{sort_label}' 정렬 적용")
                    page.wait_for_timeout(2000)
                    items.clear()  # 정렬이 바뀌었으니 이후 응답 순서대로 새로 쌓는다

            no_growth = 0
            while len(items) < self.o.max_reviews:
                self.check_stop()
                before = len(items)
                self._drain(pending, items, extractor, raw_dumps)
                if dom_blog_links:
                    self._merge(items, extract_blog_reviews({"links": [
                        {"url": h} for h in page.evaluate(_BLOG_LINKS_JS)]}))
                self.progress(len(items), self.o.max_reviews)
                if self._tail_is_old(items, old_streak_stop):
                    self.log("시작일보다 오래된 리뷰까지 도달 — 목록 확인 종료")
                    break
                if len(items) == before:
                    no_growth += 1
                    if no_growth >= 3:
                        break
                else:
                    no_growth = 0
                if not page.evaluate(_CLICK_MORE_JS):
                    page.mouse.wheel(0, 4000)
                page.wait_for_timeout(1500)
                self._wait_captcha(page)
            self._drain(pending, items, extractor, raw_dumps)
        except Exception:
            kind = "blog" if dom_blog_links else "visitor"
            try:
                self._drain(pending, items, extractor, raw_dumps)
                self.dump_debug(f"{kind}_응답.json", raw_dumps[:20])
                self.dump_debug(f"{kind}_페이지.html", page.content())
            except Exception:  # noqa: BLE001 - 진단 저장 실패는 원래 오류를 가리지 않는다
                pass
            raise
        finally:
            page.remove_listener("response", on_response)
        if not items:
            kind = "blog" if dom_blog_links else "visitor"
            self.dump_debug(f"{kind}_응답.json", raw_dumps[:20])
            self.dump_debug(f"{kind}_페이지.html", page.content())
        return list(items.values())[: self.o.max_reviews], place_name

    def _drain(self, pending, items, extractor, raw_dumps):
        while pending:
            resp = pending.pop(0)
            try:
                data = resp.json()
            except Exception:  # noqa: BLE001 - 본문 없는 응답은 무시
                continue
            if len(raw_dumps) < 20:
                raw_dumps.append(data)
            self._merge(items, extractor(data))

    @staticmethod
    def _merge(items, found):
        for it in found:
            cur = items.get(it["key"])
            if cur is None:
                items[it["key"]] = it
            else:
                for k, v in it.items():
                    if v and not cur.get(k):
                        cur[k] = v

    def _tail_is_old(self, items, streak):
        dated = [parse_kr_date(it.get("date_text")) for it in items.values()]
        tail = dated[-streak:]
        return len(tail) == streak and all(d is not None and d < self.o.start for d in tail)

    @staticmethod
    def _title_name(page):
        try:
            t = page.evaluate("() => (document.querySelector('meta[property=\"og:title\"]')||{}).content || document.title")
        except Exception:  # noqa: BLE001
            return ""
        return re.split(r"\s*[:|-]\s*네이버", t or "")[0].strip()

    def _wait_captcha(self, page):
        def is_captcha():
            u = page.url.lower()
            if "captcha" in u or "nid.naver.com" in u:
                return True
            try:
                body = page.evaluate("() => (document.body && document.body.innerText || '').slice(0, 3000)")
            except Exception:  # noqa: BLE001
                return False
            return any(k in body for k in ("보안 확인", "자동입력 방지", "캡차", "정답을 입력"))

        if not is_captcha():
            return
        if self.o.headless:
            raise RuntimeError("네이버 보안확인(캡차)이 떴습니다. '브라우저 숨기기'를 끄고 다시 실행한 뒤 창에서 직접 풀어주세요.")
        self.log(f"⚠ 네이버 보안확인 화면이 떴습니다. 브라우저 창에서 직접 풀어주세요 (최대 {CAPTCHA_WAIT_SEC}초 대기)")
        deadline = time.time() + CAPTCHA_WAIT_SEC
        while time.time() < deadline:
            self.check_stop()
            page.wait_for_timeout(2000)
            if not is_captcha():
                self.log("보안확인 통과")
                page.wait_for_timeout(1500)
                return
        raise RuntimeError("보안확인 대기 시간이 지났습니다.")

    # ---------- 다운로드 ----------
    def _download_blogs(self, store, items):
        candidates = []
        for it in items:
            d = parse_kr_date(it.get("date_text"))
            if d is not None and not self.in_range(d):
                continue
            candidates.append(it)
        self.log(f"기간 내(또는 날짜 확인 필요) 블로그 글 {len(candidates)}개 처리 시작")
        for i, it in enumerate(candidates, 1):
            self.check_stop()
            self.progress(i - 1, len(candidates))
            html = self._fetch_blog(it)
            if html is None:
                self.stats["fail"] += 1
                continue
            post = blog_parser.parse_blog_html(html)
            d = post.date or parse_kr_date(it.get("date_text"))
            if d is None:
                self.log(f"작성일 확인 불가 — 건너뜀: {mobile_blog_url(it['blog_id'], it['log_no'])}")
                continue
            if not self.in_range(d):
                continue
            label = f"{d:%Y-%m-%d} {it['blog_id']} 「{(post.title or it.get('title') or '')[:30]}」"
            if not post.photos:
                self.log(f"{label} — 사진 없음")
                continue
            got = 0
            for n, ph in enumerate(post.photos, 1):
                self.check_stop()
                base = f"{d:%Y-%m-%d}_{safe_name(it['blog_id'], 30)}_{n:02d}" + ("_영상" if ph.is_video else "")
                status, _ = store.save(ph.url, ph.candidates(), base, "https://m.blog.naver.com/")
                self.stats[status] += 1
                got += status == "saved"
            self.log(f"{label} — 사진 {len(post.photos)}장 중 새로 저장 {got}장")
            if i % 5 == 0:
                store.flush()
            time.sleep(0.3)
        self.progress(len(candidates), len(candidates))

    def _fetch_blog(self, it):
        url = mobile_blog_url(it["blog_id"], it["log_no"])
        for attempt in range(3):
            try:
                r = self.http.get(url, timeout=20)
                if r.status_code == 200 and r.text:
                    return r.text
                self.log(f"블로그 글 응답 {r.status_code}: {url}")
            except requests.RequestException as e:
                self.log(f"블로그 글 요청 실패({attempt + 1}/3): {e}")
            time.sleep(1.5 * (attempt + 1))
        return None

    def _download_visitors(self, store, items):
        todo = [it for it in items if self.in_range(parse_kr_date(it.get("date_text")))]
        self.log(f"기간 내 방문자리뷰 {len(todo)}개 사진 저장 시작")
        for i, it in enumerate(todo, 1):
            self.check_stop()
            self.progress(i - 1, len(todo))
            d = parse_kr_date(it["date_text"])
            who = safe_name(it.get("author") or it.get("id") or "방문자", 20)
            for n, ph in enumerate(it["photos"], 1):
                url = blog_parser.normalize_image_url(ph["url"])
                raw = ph["url"] if ph["url"].startswith("http") else "https:" + ph["url"]
                base = f"{d:%Y-%m-%d}_방문자_{who}_{n:02d}" + ("_영상" if ph["is_video"] else "")
                status, _ = store.save(url, [url, url + "?type=w1500", raw], base, "https://m.place.naver.com/")
                self.stats[status] += 1
            if i % 10 == 0:
                store.flush()
        self.progress(len(todo), len(todo))
