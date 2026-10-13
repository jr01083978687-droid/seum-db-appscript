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


SIMILAR_BITS = 4  # 이미지 지문(64비트) 차이가 이 이하면 같은 사진으로 본다


def image_fingerprint(im):
    """dHash: 크기·압축률이 달라도 같은 사진이면 거의 같은 64비트 값이 나온다."""
    g = im.convert("L").resize((9, 8), Image.LANCZOS)
    px = g.tobytes()  # L 모드: 픽셀당 1바이트
    bits = 0
    for row in range(8):
        for col in range(8):
            bits = (bits << 1) | (px[row * 9 + col] > px[row * 9 + col + 1])
    return bits


def _hamming(a, b):
    return bin(a ^ b).count("1")


class PhotoStore:
    """한 플레이스 폴더에 사진을 저장한다.

    - 기록 파일(_다운로드기록.json)에 원본 URL·내용 해시·이미지 지문을 남겨 재실행 시 건너뛴다.
    - 눈으로 같은 사진(크기만 다르거나 다시 저장된 것)은 하나만 남기고, 더 큰 해상도로 교체한다.
    - 어떤 주소로 받았는지(원본/축소본)와 해상도를 집계한다.
    """

    def __init__(self, folder, min_width=300, session=None):
        self.folder = folder
        self.min_width = min_width
        os.makedirs(folder, exist_ok=True)
        self.manifest_path = os.path.join(folder, MANIFEST_NAME)
        self._lock = threading.Lock()
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": UA_MOBILE})
        self.manifest = {"urls": {}, "hashes": {}, "prints": {}}
        self.quality = {"원본": 0, "축소본": 0, "replaced": 0, "widths": []}
        self.small_examples = []  # 작은 이미지로 판정된 응답 예시 (원인 진단용)
        if os.path.exists(self.manifest_path):
            try:
                with open(self.manifest_path, encoding="utf-8") as f:
                    loaded = json.load(f)
                for k in self.manifest:
                    self.manifest[k].update(loaded.get(k, {}))
            except (ValueError, OSError):
                pass

    def already_have(self, url_key):
        name = self.manifest["urls"].get(url_key)
        return bool(name) and (name.startswith("SKIP:") or os.path.exists(os.path.join(self.folder, name)))

    def save(self, url_key, candidates, base_name, referer):
        """candidates[0] 이 원본 주소. 반환: ('saved'|'exists'|'dup'|'small'|'fail', 파일명 또는 사유)"""
        if self.already_have(url_key):
            return "exists", self.manifest["urls"][url_key]

        # 원본 주소부터 차례로 받고, 너무 작은 이미지(대체 이미지·썸네일)가 오면 다음 주소도 시도해 가장 큰 것을 쓴다
        best, last_err = None, ""
        for i, url in enumerate(candidates):
            try:
                r = self.session.get(url, headers={"Referer": referer}, timeout=30)
            except requests.RequestException as e:
                last_err = str(e)
                continue
            if not (r.status_code == 200 and r.content and r.headers.get("Content-Type", "image").startswith("image")):
                last_err = f"HTTP {r.status_code}"
                continue
            try:
                with Image.open(io.BytesIO(r.content)) as im:
                    info = (im.size[0], im.size[1], im.format, image_fingerprint(im))
            except Exception:  # noqa: BLE001 - 이미지가 아니면 다음 주소
                last_err = "이미지 형식 아님"
                continue
            if best is None or info[0] > best[1][0]:
                best = (r.content, info, i)
            if info[0] >= self.min_width:
                break
            if len(self.small_examples) < 5:
                self.small_examples.append(f"{info[0]}x{info[1]} {info[2]} {len(r.content)}B "
                                           f"({'원본주소' if i == 0 else '대체주소'}) {url[:90]}")
        if best is None:
            return "fail", last_err
        data, (width, height, fmt, fp), used = best

        if width < self.min_width:
            self._remember(url_key, "SKIP:small")
            return "small", f"가로 {width}px"

        digest = hashlib.md5(data).hexdigest()
        ext = _EXT_BY_FORMAT.get(fmt, ".jpg")
        with self._lock:
            dup = self.manifest["hashes"].get(digest)
            if dup and os.path.exists(os.path.join(self.folder, dup)):
                self._remember(url_key, dup)
                return "dup", dup
            similar = self._find_similar(fp, width / max(height, 1))
            if similar:
                name = self._maybe_upgrade(similar, data, ext, width, height, digest)
                self._remember(url_key, name)
                return "dup", name
            name = self._unique(base_name + ext)
            with open(os.path.join(self.folder, name), "wb") as f:
                f.write(data)
            self.manifest["hashes"][digest] = name
            self.manifest["prints"][name] = {"fp": format(fp, "016x"), "w": width, "h": height}
            self._remember(url_key, name)
            self.quality["원본" if used == 0 else "축소본"] += 1
            self.quality["widths"].append(width)
        return "saved", name

    def _find_similar(self, fp, ratio):
        for name, info in self.manifest["prints"].items():
            try:
                other = int(info["fp"], 16)
            except (KeyError, ValueError):
                continue
            other_ratio = info.get("w", 1) / max(info.get("h", 1), 1)
            if _hamming(fp, other) <= SIMILAR_BITS and abs(ratio - other_ratio) < 0.05 \
                    and os.path.exists(os.path.join(self.folder, name)):
                return name
        return None

    def _maybe_upgrade(self, old_name, data, ext, width, height, digest):
        """같은 사진이 더 큰 해상도로 다시 나오면 기존 파일을 교체한다 (파일명은 유지, 확장자만 맞춤)."""
        info = self.manifest["prints"][old_name]
        if width * height <= info.get("w", 0) * info.get("h", 0) * 1.1:
            return old_name
        new_name = os.path.splitext(old_name)[0] + ext
        os.remove(os.path.join(self.folder, old_name))
        with open(os.path.join(self.folder, new_name), "wb") as f:
            f.write(data)
        self.manifest["prints"].pop(old_name)
        self.manifest["prints"][new_name] = {"fp": info["fp"], "w": width, "h": height}
        self.manifest["hashes"] = {d: (new_name if n == old_name else n) for d, n in self.manifest["hashes"].items()}
        self.manifest["hashes"][digest] = new_name
        self.manifest["urls"] = {u: (new_name if n == old_name else n) for u, n in self.manifest["urls"].items()}
        self.quality["replaced"] += 1
        return new_name

    def quality_summary(self):
        q, ws = self.quality, sorted(self.quality["widths"])
        if not ws:
            return ""
        mid = ws[len(ws) // 2]
        extra = ("\n  작은 이미지 응답 예시: " + " | ".join(self.small_examples)) if self.small_examples else ""
        return (f"화질 — 원본 주소로 받음 {q['원본']}장, 축소본으로 받음 {q['축소본']}장, "
                f"가로 해상도 중간값 {mid}px (최소 {ws[0]} / 최대 {ws[-1]})"
                + (f", 같은 사진을 더 큰 해상도로 교체 {q['replaced']}장" if q["replaced"] else "") + extra)

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
