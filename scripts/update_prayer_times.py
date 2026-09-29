#!/usr/bin/env python3
import datetime as dt
import html
import json
import os
import re
import sys
import tempfile
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

TR_TIMEZONE = ZoneInfo("Europe/Istanbul")
WINDOW_DAYS = 30

LOCATIONS = {
    "selcuklu": {
        "label": "Konya • Selçuklu",
        "url": "https://namazvakitleri.diyanet.gov.tr/tr-TR/17871/selcuklu-icin-namaz-vakti",
    },
    "umraniye": {
        "label": "İstanbul • Ümraniye",
        "url": "https://namazvakitleri.diyanet.gov.tr/tr-TR/9541/istanbul-icin-namaz-vakti",
    },
}

PRAYERS = ("imsak", "gunes", "ogle", "ikindi", "aksam", "yatsi")

TR_MONTHS = {
    "ocak": 1, "şubat": 2, "mart": 3, "nisan": 4, "mayıs": 5, "haziran": 6,
    "temmuz": 7, "ağustos": 8, "eylül": 9, "ekim": 10, "kasım": 11, "aralık": 12,
}

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_FILE = ROOT / "data" / "prayer-times.json"

ROW_RE = re.compile(r"<tr[^>]*>([\s\S]*?)</tr>", re.IGNORECASE)
CELL_RE = re.compile(r"<td[^>]*>([\s\S]*?)</td>", re.IGNORECASE)
TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})")


def strip_html(value: str) -> str:
    value = re.sub(r"<br\s*/?>", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"<[^>]+>", " ", value)
    value = html.unescape(value)
    return re.sub(r"\s+", " ", value).strip()


def parse_date(value: str) -> dt.date | None:
    text = strip_html(value)
    m = re.match(r"^(\d{1,2})[./-](\d{1,2})[./-](\d{4})", text)
    if m:
        try:
            return dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None

    m = re.match(r"^(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})", text)
    if not m:
        return None

    month = TR_MONTHS.get(m.group(2).casefold())
    if month is None:
        return None

    try:
        return dt.date(int(m.group(3)), month, int(m.group(1)))
    except ValueError:
        return None


def parse_time(value: str) -> str | None:
    text = strip_html(value)
    match = TIME_RE.match(text)
    if not match:
        return None

    hour, minute = int(match.group(1)), int(match.group(2))
    if hour > 23 or minute > 59:
        return None
    return f"{hour:02d}:{minute:02d}"


def time_to_minutes(value: str) -> int:
    h, m = value.split(":")
    return int(h) * 60 + int(m)


def fetch_html(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "gnome-ezan-data-updater/1.0",
            "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.5",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"HTTP {response.status} alındı: {url}")
        raw = response.read()
        charset = response.headers.get_content_charset() or "utf-8"
        return raw.decode(charset, errors="replace")


def parse_diyanet_html(source: str) -> dict[str, dict[str, str]]:
    days = {}
    for row_match in ROW_RE.finditer(source):
        cells = [strip_html(c) for c in CELL_RE.findall(row_match.group(1))]
        if len(cells) < 8:
            continue

        date_val = parse_date(cells[0])
        if date_val is None:
            continue

        parsed_times = [parse_time(c) for c in cells[2:8]]
        if any(v is None for v in parsed_times):
            continue

        days[date_val.isoformat()] = {
            "imsak": parsed_times[0],
            "gunes": parsed_times[1],
            "ogle": parsed_times[2],
            "ikindi": parsed_times[3],
            "aksam": parsed_times[4],
            "yatsi": parsed_times[5],
        }
    return days


def validate_day(day: str, values: dict[str, str], location: str) -> None:
    if set(values) != set(PRAYERS):
        raise ValueError(f"[{location}] {day}: Eksik namaz alanı.")

    minutes = []
    for prayer in PRAYERS:
        val = values[prayer]
        if not re.fullmatch(r"\d{2}:\d{2}", val):
            raise ValueError(f"[{location}] {day}: {prayer} geçersiz saat ({val})")
        minutes.append(time_to_minutes(val))

    if not all(e < l for e, l in zip(minutes, minutes[1:])):
        raise ValueError(f"[{location}] {day}: Vakit sırası bozuk ({values})")


def validate_location_data(days: dict[str, dict[str, str]], location: str, today: dt.date) -> dict[str, dict[str, str]]:
    expected_keys = [(today + dt.timedelta(days=i)).isoformat() for i in range(WINDOW_DAYS)]
    missing = [k for k in expected_keys if k not in days]
    if missing:
        raise ValueError(f"[{location}] 30 günlük pencere eksik! İlk eksik gün: {missing[0]}")

    for k, v in days.items():
        validate_day(k, v, location)

    return {k: days[k] for k in expected_keys}


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def build_output() -> dict:
    today = dt.datetime.now(TR_TIMEZONE).date()
    end_date = today + dt.timedelta(days=WINDOW_DAYS - 1)

    output = {
        "schema": 3,
        "window_days": WINDOW_DAYS,
        "source": "Diyanet İşleri Başkanlığı • GitHub Actions Pipeline",
        "generated_at": (
            dt.datetime.now(dt.timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        ),
        "coverage": {
            "start": today.isoformat(),
            "end": end_date.isoformat(),
        },
        "locations": {},
    }

    for loc_key, info in LOCATIONS.items():
        print(f"Çekiliyor: {info['label']}")
        source = fetch_html(info["url"])
        raw_days = parse_diyanet_html(source)
        if not raw_days:
            raise ValueError(f"[{loc_key}] Tablo parse edilemedi.")

        filtered_days = validate_location_data(raw_days, loc_key, today)
        output["locations"][loc_key] = {
            "label": info["label"],
            "source_url": info["url"],
            "days": filtered_days,
        }
        print(f"  {len(filtered_days)} gün doğrulandı: {today.isoformat()} → {end_date.isoformat()}")

    return output


def main() -> None:
    payload = build_output()
    atomic_write_json(OUTPUT_FILE, payload)
    print(f"\nBAŞARILI: {OUTPUT_FILE} üretildi.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"HATA: {exc}", file=sys.stderr)
        sys.exit(1)
