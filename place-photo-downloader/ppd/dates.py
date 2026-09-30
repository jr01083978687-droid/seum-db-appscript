"""네이버에서 보이는 여러 날짜 표기를 date로 바꾼다.

지원 예시
  2024.03.15.  / 2024. 3. 15. 14:22 / 24.3.15. / 3.15.금 / 2024년 3월 15일
  2024-03-15T10:00:00 / 3일 전 / 5시간 전 / 방금 전 / 어제
"""
import re
from datetime import date, datetime, timedelta

_FULL = re.compile(r"(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})")
_SHORT_YEAR = re.compile(r"(?<!\d)(\d{2})\.(\d{1,2})\.(\d{1,2})(?!\d)")
_MONTH_DAY = re.compile(r"(?<![\d.])(\d{1,2})\.(\d{1,2})\.?(?:\s*[월화수목금토일])?(?![\d])")
_RELATIVE = re.compile(r"(\d+)\s*(분|시간|일|주|개월|달)\s*전")


def parse_kr_date(text, today=None):
    """문자열에서 날짜를 찾는다. 못 찾으면 None."""
    if text is None:
        return None
    if isinstance(text, datetime):
        return text.date()
    if isinstance(text, date):
        return text
    s = str(text).strip()
    if not s:
        return None
    today = today or date.today()

    m = _FULL.search(s)
    if m:
        return _safe_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))

    m = _SHORT_YEAR.search(s)
    if m:
        return _safe_date(2000 + int(m.group(1)), int(m.group(2)), int(m.group(3)))

    if "방금" in s or "초 전" in s:
        return today
    if "어제" in s:
        return today - timedelta(days=1)
    m = _RELATIVE.search(s)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        days = {"분": 0, "시간": 0, "일": n, "주": n * 7, "개월": n * 30, "달": n * 30}[unit]
        if unit == "시간" and n >= 24:
            days = n // 24
        return today - timedelta(days=days)

    m = _MONTH_DAY.search(s)
    if m:
        # 연도가 없는 표기(방문자리뷰 "9.12.목")는 올해로 보고, 미래면 작년으로 본다.
        d = _safe_date(today.year, int(m.group(1)), int(m.group(2)))
        if d and d > today:
            d = _safe_date(today.year - 1, d.month, d.day)
        return d
    return None


def parse_input_date(text):
    """GUI 입력(2026-09-30, 2026.9.30, 20260930)을 date로."""
    s = (text or "").strip()
    if re.fullmatch(r"\d{8}", s):
        return _safe_date(int(s[:4]), int(s[4:6]), int(s[6:]))
    m = _FULL.search(s)
    return _safe_date(int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def _safe_date(y, mo, d):
    try:
        return date(y, mo, d)
    except ValueError:
        return None
