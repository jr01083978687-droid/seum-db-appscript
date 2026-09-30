"""이미지 다운로드 + 크기 필터 + 중복 제거(재실행 시 건너뛰기)."""
import hashlib
import io
import json
import os
import re
import threading

import requests
from PIL import Image

MANIFEST_NAME = "_다운로드기록.json"
UA_MOBILE = ("Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36")
_EXT_BY_FORMAT = {"JPEG": ".jpg", "PNG": ".png", "GIF": ".gif", "WEBP": ".webp", "BMP": ".bmp"}


def safe_name(text, limit=40):
    text = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", str(text or "")).strip().strip(".")
    text = re.sub(r"\s+", " ", text)
    return (text[:limit].strip() or "이름없음")


class PhotoStore:
    """한 플레이스 폴더에 사진을 저장한다.

    기록 파일(_다운로드기록.json)에 원본 URL과 내용 해시를 남겨,
    다시 실행해도 같은 사진은 받지 않는다.
    """

    def __init__(self, folder, min_width=300, session=None):
        self.folder = folder
        self.min_width = min_width
        os.makedirs(folder, exist_ok=True)
        self.manifest_path = os.path.join(folder, MANIFEST_NAME)
        self._lock = threading.Lock()
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": UA_MOBILE})
        self.manifest = {"urls": {}, "hashes": {}}
        if os.path.exists(self.manifest_path):
            try:
                with open(self.manifest_path, encoding="utf-8") as f:
                    loaded = json.load(f)
                self.manifest["urls"].update(loaded.get("urls", {}))
                self.manifest["hashes"].update(loaded.get("hashes", {}))
            except (ValueError, OSError):
                pass

    def already_have(self, url_key):
        name = self.manifest["urls"].get(url_key)
        return bool(name) and (name.startswith("SKIP:") or os.path.exists(os.path.join(self.folder, name)))

    def save(self, url_key, candidates, base_name, referer):
        """반환: ('saved'|'exists'|'dup'|'small'|'fail', 파일명 또는 사유)"""
        if self.already_have(url_key):
            return "exists", self.manifest["urls"][url_key]

        data, last_err = None, ""
        for url in candidates:
            try:
                r = self.session.get(url, headers={"Referer": referer}, timeout=20)
                if r.status_code == 200 and r.content and r.headers.get("Content-Type", "image").startswith("image"):
                    data = r.content
                    break
                last_err = f"HTTP {r.status_code}"
            except requests.RequestException as e:
                last_err = str(e)
        if data is None:
            return "fail", last_err

        try:
            with Image.open(io.BytesIO(data)) as im:
                width, fmt = im.size[0], im.format
        except Exception:  # noqa: BLE001 - 이미지가 아니면 실패 처리
            return "fail", "이미지 형식 아님"

        if width < self.min_width:
            self._remember(url_key, "SKIP:small")
            return "small", f"가로 {width}px"

        digest = hashlib.md5(data).hexdigest()
        with self._lock:
            dup = self.manifest["hashes"].get(digest)
            if dup and os.path.exists(os.path.join(self.folder, dup)):
                self._remember(url_key, dup)
                return "dup", dup
            name = self._unique(base_name + _EXT_BY_FORMAT.get(fmt, ".jpg"))
            with open(os.path.join(self.folder, name), "wb") as f:
                f.write(data)
            self.manifest["hashes"][digest] = name
            self._remember(url_key, name)
        return "saved", name

    def _unique(self, name):
        stem, ext = os.path.splitext(name)
        candidate, i = name, 2
        while os.path.exists(os.path.join(self.folder, candidate)):
            candidate = f"{stem}({i}){ext}"
            i += 1
        return candidate

    def _remember(self, url_key, name):
        self.manifest["urls"][url_key] = name

    def flush(self):
        with self._lock:
            tmp = self.manifest_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.manifest, f, ensure_ascii=False, indent=1)
            os.replace(tmp, self.manifest_path)
