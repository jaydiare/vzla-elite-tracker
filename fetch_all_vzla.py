import os
import json
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple
import requests

# --- CONFIGURATION ---
API_KEY = os.environ.get("NBA_API_KEY")  # keep your env var name if you want

if not API_KEY:
    print("❌ Error: NBA_API_KEY not found in environment.")
    raise SystemExit(1)

BASE_URL = "https://api.balldontlie.io"
HEADERS = {"Authorization": API_KEY}  # apiKey in header name=Authorization  [oai_citation:9‡Balldontlie](https://www.balldontlie.io/openapi.yml)

# Targets
COUNTRY_NAME = "Venezuela"
ISO3_VEN = "VEN"  # common 3-letter code used by several endpoints (ATP/WTA examples use 3-letter codes)  [oai_citation:10‡Balldontlie](https://www.balldontlie.io/openapi.yml)
ISO2_VE = "VE"    # ISO-2 code used by F1 driver filter (spec says ISO country code)  [oai_citation:11‡Balldontlie](https://www.balldontlie.io/openapi.yml)

FILE_PATH = "data/athletes.json"

# Tuning
PER_PAGE = 100
MAX_PAGES_PER_ENDPOINT = None  # set to e.g. 2 if you want a cheap run like your current script
SLEEP_BETWEEN_CALLS_SEC = 0.3  # keep small; backoff handles 429
REQUEST_TIMEOUT = 30

# --- ENDPOINTS (based on what's in openapi.yml) ---
# Notes:
# - NBA: spec shows /nba/v1/players/active  [oai_citation:12‡Balldontlie](https://www.balldontlie.io/openapi.yml)
# - NFL: /nfl/v1/players exists  [oai_citation:13‡Balldontlie](https://www.balldontlie.io/openapi.yml)
# - MLB: /mlb/v1/players exists  [oai_citation:14‡Balldontlie](https://www.balldontlie.io/openapi.yml)
# - NHL: /nhl/v1/players exists  [oai_citation:15‡Balldontlie](https://www.balldontlie.io/openapi.yml)
# - Soccer: /mls/v1/players exists  [oai_citation:16‡Balldontlie](https://www.balldontlie.io/openapi.yml) ; EPL v2 exists  [oai_citation:17‡Balldontlie](https://www.balldontlie.io/openapi.yml)
# - NCAAB/NCAAW: players exist  [oai_citation:18‡Balldontlie](https://www.balldontlie.io/openapi.yml)
# - PGA: supports country query param  [oai_citation:19‡Balldontlie](https://www.balldontlie.io/openapi.yml)
# - ATP/WTA: support country/country_code query params  [oai_citation:20‡Balldontlie](https://www.balldontlie.io/openapi.yml)
# - F1: /f1/v1/drivers supports country_code filter  [oai_citation:21‡Balldontlie](https://www.balldontlie.io/openapi.yml)

ENDPOINTS: List[Dict[str, Any]] = [
    # Basketball
    {"sport": "Basketball", "league": "NBA", "path": "/nba/v1/players/active"},

    # Football
    {"sport": "Football", "league": "NFL", "path": "/nfl/v1/players/active"},

    # Baseball
    {"sport": "Baseball", "league": "MLB", "path": "/mlb/v1/players/active"},

    # Hockey
    {"sport": "Hockey", "league": "NHL", "path": "/nhl/v1/players"},

    # College basketball
    {"sport": "Basketball", "league": "NCAAB", "path": "/ncaab/v1/players/active"},
    {"sport": "Basketball", "league": "NCAAW", "path": "/ncaaw/v1/players/active"},

    # Soccer
    {"sport": "Soccer", "league": "EPL", "path": "/epl/v2/players"},
    {"sport": "Soccer", "league": "La Liga", "path": "/laliga/v1/players"},
    {"sport": "Soccer", "league": "MLS", "path": "/mls/v1/players"},
    {"sport": "Soccer", "league": "UCL", "path": "/ucl/v1/players"},
    {"sport": "Soccer", "league": "Ligue 1", "path": "/ligue1/v1/players"},
    {"sport": "Soccer", "league": "Bundesliga", "path": "/bundesliga/v1/players"},
    {"sport": "Soccer", "league": "Serie A", "path": "/seriea/v1/players"},

    # Tennis
    {"sport": "Tennis", "league": "ATP", "path": "/atp/v1/players"},
    {"sport": "Tennis", "league": "WTA", "path": "/wta/v1/players"},

    # Golf
    {"sport": "Golf", "league": "PGA Tour", "path": "/pga/v1/players"},

    # Motorsport
    {"sport": "Motorsport", "league": "F1", "path": "/f1/v1/drivers"},
]


def load_existing() -> List[Dict[str, Any]]:
    if os.path.exists(FILE_PATH):
        with open(FILE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


def deep_string_values(obj: Any) -> Iterable[str]:
    """Yield every string value inside a nested dict/list structure."""
    if isinstance(obj, dict):
        for v in obj.values():
            yield from deep_string_values(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from deep_string_values(item)
    elif isinstance(obj, str):
        yield obj


def is_venezuelan(record: Dict[str, Any]) -> bool:
    """
    Heuristic matcher:
    - checks common nationality fields
    - checks country codes
    - checks birth place strings (contains 'Venezuela')
    - deep scans all string values for Venezuela / VEN (helps when schemas differ)
    """
    # Common direct fields (seen across many sports APIs)
    candidates = [
        record.get("country"),
        record.get("country_code"),
        record.get("nationality"),
        record.get("citizenship"),
        record.get("birth_country"),
        record.get("birthplace"),
        record.get("birth_place"),
    ]

    for val in candidates:
        if isinstance(val, str):
            v = val.strip()
            if v == COUNTRY_NAME:
                return True
            if v.upper() == ISO3_VEN:
                return True
            # sometimes people store "Caracas, Venezuela"
            if COUNTRY_NAME.lower() in v.lower():
                return True

    # Deep scan all strings
    for s in deep_string_values(record):
        sl = s.lower()
        if "venezuela" in sl:
            return True
        if s.strip().upper() == ISO3_VEN:
            return True

    return False


def request_with_backoff(url: str, session: requests.Session, max_retries: int = 6) -> Dict[str, Any]:
    backoff = 2
    for attempt in range(max_retries):
        r = session.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)

        if r.status_code == 429:
            wait = min(60, backoff)
            print(f"⚠️ 429 rate limit. Sleeping {wait}s...")
            time.sleep(wait)
            backoff *= 2
            continue

        r.raise_for_status()
        return r.json()

    raise RuntimeError(f"Too many retries after 429s for url={url}")


def build_url(path: str, cursor: Optional[int], extra_params: Optional[Dict[str, str]] = None) -> str:
    params = {"per_page": str(PER_PAGE)}
    if cursor is not None:
        params["cursor"] = str(cursor)
    if extra_params:
        params.update(extra_params)

    qs = "&".join(f"{k}={requests.utils.quote(str(v))}" for k, v in params.items())
    return f"{BASE_URL}{path}?{qs}"


def endpoint_extra_filters(ep: Dict[str, Any]) -> Dict[str, str]:
    """
    Use server-side filters when the spec supports them (huge speedup).
    - PGA: country=...  [oai_citation:22‡Balldontlie](https://www.balldontlie.io/openapi.yml)
    - ATP/WTA: country_code=... works in many cases  [oai_citation:23‡Balldontlie](https://www.balldontlie.io/openapi.yml)
    - F1: country_code is ISO country code; Venezuela ISO-2 is VE  [oai_citation:24‡Balldontlie](https://www.balldontlie.io/openapi.yml)
    """
    league = ep["league"]

    if league == "PGA Tour":
        return {"country": COUNTRY_NAME}  # per spec
    if league in ("ATP", "WTA"):
        return {"country_code": ISO3_VEN}  # tends to be 3-letter
    if league == "F1":
        return {"country_code": ISO2_VE}  # ISO-2
    return {}


def normalize_name(record: Dict[str, Any]) -> str:
    # Most endpoints use first_name/last_name; some include full_name
    fn = record.get("first_name")
    ln = record.get("last_name")
    full = record.get("full_name")
    if isinstance(full, str) and full.strip():
        return full.strip()
    if isinstance(fn, str) and isinstance(ln, str):
        return f"{fn.strip()} {ln.strip()}".strip()
    if isinstance(fn, str):
        return fn.strip()
    return "Unknown"


def normalize_team(record: Dict[str, Any]) -> Optional[str]:
    # NBA uses nested team.full_name  [oai_citation:25‡Balldontlie](https://www.balldontlie.io/openapi.yml) ; soccer often has team fields elsewhere
    team = record.get("team")
    if isinstance(team, dict):
        return team.get("full_name") or team.get("name")
    return record.get("team_name") or record.get("club") or None


def fetch_all_venezuelans() -> List[Dict[str, Any]]:
    existing = load_existing()

    # de-dupe by (league, id) if possible; fallback to (league, name)
    seen: set[Tuple[str, Any]] = set()
    for a in existing:
        key = (a.get("league", "?"), a.get("id") or a.get("name"))
        seen.add(key)

    out = existing[:]

    with requests.Session() as session:
        for ep in ENDPOINTS:
            print(f"🚀 Scanning {ep['sport']} - {ep['league']} ({ep['path']})...")
            cursor = None
            pages = 0

            extra = endpoint_extra_filters(ep)

            while True:
                if MAX_PAGES_PER_ENDPOINT is not None and pages >= MAX_PAGES_PER_ENDPOINT:
                    break

                url = build_url(ep["path"], cursor=cursor, extra_params=extra)
                try:
                    payload = request_with_backoff(url, session=session)
                except Exception as e:
                    print(f"❌ Error in {ep['league']}: {e}")
                    break

                data = payload.get("data", []) or []
                meta = payload.get("meta", {}) or {}
                next_cursor = meta.get("next_cursor")

                # Optional debug: show which fields exist
                if pages == 0 and data:
                    sample_keys = sorted(list(data[0].keys()))[:25]
                    print(f"   DEBUG keys sample: {sample_keys}")

                for rec in data:
                    if is_venezuelan(rec):
                        name = normalize_name(rec)
                        team = normalize_team(rec)

                        rec_id = rec.get("id")
                        key = (ep["league"], rec_id or name)
                        if key in seen:
                            continue

                        out.append(
                            {
                                "id": rec_id,
                                "name": name,
                                "sport": ep["sport"],
                                "league": ep["league"],
                                "team": team,
                                # keep raw nationality-ish fields for audit
                                "country": rec.get("country"),
                                "country_code": rec.get("country_code"),
                                "nationality": rec.get("nationality"),
                                "citizenship": rec.get("citizenship"),
                                "birth_place": rec.get("birth_place") or rec.get("birthplace"),
                                "source_endpoint": ep["path"],
                            }
                        )
                        seen.add(key)

                pages += 1
                cursor = next_cursor
                if not cursor:
                    break

                time.sleep(SLEEP_BETWEEN_CALLS_SEC)

    out.sort(key=lambda x: (x.get("league", ""), x.get("name", "")))
    return out


if __name__ == "__main__":
    os.makedirs("data", exist_ok=True)

    vzla_list = fetch_all_venezuelans()

    with open(FILE_PATH, "w", encoding="utf-8") as f:
        json.dump(vzla_list, f, indent=2, ensure_ascii=False)

    print(f"🏁 Finished! Total unique athletes in database: {len(vzla_list)}")
    print(f"✅ Saved to: {FILE_PATH}")
