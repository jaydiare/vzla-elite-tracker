import os
import json
import time
import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple
import requests

# --- CONFIG ---
API_KEY = os.environ.get("NBA_API_KEY")  # keep your env var name
if not API_KEY:
    print("❌ Error: NBA_API_KEY not found in environment.")
    raise SystemExit(1)

BASE_URL = "https://api.balldontlie.io"
HEADERS = {"Authorization": API_KEY}  # spec uses apiKey in header "Authorization"  [oai_citation:6‡Balldontlie](https://www.balldontlie.io/openapi.yml)

FILE_PATH = "data/athletes.json"

# Venezuela matching
COUNTRY_NAME = "Venezuela"
ISO3_VEN = "VEN"
ISO2_VE = "VE"

# Pagination / throttling
PER_PAGE = 100
SLEEP_BETWEEN_CALLS_SEC = 0.25
REQUEST_TIMEOUT = 30
MAX_RETRIES_429 = 6

# If you want a cheap run (like your original), set e.g. 2. Otherwise None = full scan.
MAX_PAGES_PER_ENDPOINT: Optional[int] = None

# --- Helpers: season logic for leagues that allow season filters (optional) ---
# NHL seasons are typically labeled by the start year (e.g., 2025 for 2025-26 season).
def current_nhl_season_start_year(today: Optional[datetime.date] = None) -> int:
    today = today or datetime.date.today()
    # if we're before July, we're still in the season that started last year
    return today.year - 1 if today.month < 7 else today.year

# --- ENDPOINT DEFINITIONS ---
# Modes:
# - "paged": standard {data: [...], meta: {next_cursor}} player list
# - "soccer_rosters": teams -> rosters (active squads)
Endpoint = Dict[str, Any]

SOCCER_LEAGUES: List[Dict[str, str]] = [
    # EPL v2 is current  [oai_citation:7‡Balldontlie](https://www.balldontlie.io/openapi.yml)
    {"league": "EPL",        "teams": "/epl/v2/teams",        "rosters": "/epl/v2/rosters"},
    {"league": "La Liga",    "teams": "/laliga/v1/teams",     "rosters": "/laliga/v1/rosters"},
    {"league": "Serie A",    "teams": "/seriea/v1/teams",     "rosters": "/seriea/v1/rosters"},
    {"league": "Ligue 1",    "teams": "/ligue1/v1/teams",     "rosters": "/ligue1/v1/rosters"},
    {"league": "Bundesliga", "teams": "/bundesliga/v1/teams", "rosters": "/bundesliga/v1/rosters"},
    {"league": "UCL",        "teams": "/ucl/v1/teams",        "rosters": "/ucl/v1/rosters"},
    {"league": "MLS",        "teams": "/mls/v1/teams",        "rosters": "/mls/v1/rosters"},
]

ENDPOINTS: List[Endpoint] = [
    # Active endpoints (true "active-only")  [oai_citation:8‡Balldontlie](https://www.balldontlie.io/openapi.yml)
    {"mode": "paged", "sport": "Basketball", "league": "NBA",   "path": "/nba/v1/players/active"},
    {"mode": "paged", "sport": "Football",   "league": "NFL",   "path": "/nfl/v1/players/active"},
    {"mode": "paged", "sport": "Baseball",   "league": "MLB",   "path": "/mlb/v1/players/active"},
    {"mode": "paged", "sport": "Hockey",     "league": "NHL",   "path": "/nhl/v1/players", "active_best_effort": True},
    {"mode": "paged", "sport": "Basketball", "league": "NCAAB", "path": "/ncaab/v1/players/active"},
    {"mode": "paged", "sport": "Basketball", "league": "NCAAW", "path": "/ncaaw/v1/players/active"},

    # Soccer: use rosters for active squads  [oai_citation:9‡Balldontlie](https://www.balldontlie.io/openapi.yml)
    {"mode": "soccer_rosters", "sport": "Soccer", "league": "SOCCER_ROSTERS"},

    # Golf: server-side active + country  [oai_citation:10‡Balldontlie](https://www.balldontlie.io/openapi.yml)
    {"mode": "paged", "sport": "Golf", "league": "PGA Tour", "path": "/pga/v1/players", "filters": {"country": COUNTRY_NAME, "active": "true"}},

    # Tennis: country_code filter exists, but no "active" flag in spec  [oai_citation:11‡Balldontlie](https://www.balldontlie.io/openapi.yml)
    {"mode": "paged", "sport": "Tennis", "league": "ATP", "path": "/atp/v1/players", "filters": {"country_code": ISO3_VEN}},
    {"mode": "paged", "sport": "Tennis", "league": "WTA", "path": "/wta/v1/players", "filters": {"country_code": ISO3_VEN}},

    # Motorsport: country_code is ISO-2 for F1  [oai_citation:12‡Balldontlie](https://www.balldontlie.io/openapi.yml)
    {"mode": "paged", "sport": "Motorsport", "league": "F1", "path": "/f1/v1/drivers", "filters": {"country_code": ISO2_VE}},

    # MMA fighters list (no active flag)  [oai_citation:13‡Balldontlie](https://www.balldontlie.io/openapi.yml)
    {"mode": "paged", "sport": "MMA", "league": "MMA", "path": "/mma/v1/fighters"},

    # Esports players lists (no active flag; best-effort “current pro players” lists)  [oai_citation:14‡Balldontlie](https://www.balldontlie.io/openapi.yml)
    {"mode": "paged", "sport": "Esports", "league": "LoL",  "path": "/lol/v1/players"},
    {"mode": "paged", "sport": "Esports", "league": "Dota", "path": "/dota/v1/players"},
]


# --- IO ---
def load_existing() -> List[Dict[str, Any]]:
    if os.path.exists(FILE_PATH):
        with open(FILE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return []


# --- Matching ---
def deep_string_values(obj: Any) -> Iterable[str]:
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
    Heuristic:
    - direct fields (country, nationality, citizenship, birth_place/birth_country)
    - deep scan for 'Venezuela' or exact 'VEN'
    """
    candidates = [
        record.get("country"),
        record.get("country_code"),
        record.get("nationality"),
        record.get("citizenship"),
        record.get("birth_country"),
        record.get("birthplace"),
        record.get("birth_place"),
        record.get("place_of_birth"),
    ]
    for val in candidates:
        if isinstance(val, str):
            v = val.strip()
            if v == COUNTRY_NAME:
                return True
            if v.upper() == ISO3_VEN:
                return True
            if COUNTRY_NAME.lower() in v.lower():
                return True

    for s in deep_string_values(record):
        sl = s.lower().strip()
        if "venezuela" in sl:
            return True
        if s.strip().upper() == ISO3_VEN:
            return True

    return False


# --- HTTP ---
def request_with_backoff(url: str, session: requests.Session, max_retries: int = MAX_RETRIES_429) -> Dict[str, Any]:
    backoff = 2
    for _ in range(max_retries):
        r = session.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        if r.status_code == 429:
            wait = min(60, backoff)
            print(f"⚠️  429 rate limit. Sleeping {wait}s...")
            time.sleep(wait)
            backoff *= 2
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError(f"Too many retries after 429s for url={url}")


def build_url(path: str, cursor: Optional[int], extra_params: Optional[Dict[str, Any]] = None) -> str:
    params: Dict[str, Any] = {"per_page": PER_PAGE}
    if cursor is not None:
        params["cursor"] = cursor
    if extra_params:
        params.update(extra_params)
    qs = "&".join(f"{k}={requests.utils.quote(str(v))}" for k, v in params.items())
    return f"{BASE_URL}{path}?{qs}"


# --- Normalization ---
def normalize_name(record: Dict[str, Any]) -> str:
    full = record.get("full_name") or record.get("name") or record.get("player_name")
    if isinstance(full, str) and full.strip():
        return full.strip()

    fn = record.get("first_name")
    ln = record.get("last_name")
    if isinstance(fn, str) and isinstance(ln, str):
        return f"{fn.strip()} {ln.strip()}".strip()
    if isinstance(fn, str):
        return fn.strip()
    if isinstance(ln, str):
        return ln.strip()
    return "Unknown"


def normalize_team(record: Dict[str, Any]) -> Optional[str]:
    team = record.get("team")
    if isinstance(team, dict):
        return team.get("full_name") or team.get("name")
    return record.get("team_name") or record.get("club") or record.get("current_team") or None


def coerce_player_record(item: Dict[str, Any]) -> Dict[str, Any]:
    """
    Soccer roster items often wrap the player inside a 'player' object (and sometimes 'team').
    Keep it generic.
    """
    if isinstance(item.get("player"), dict):
        merged = dict(item["player"])
        # attach team context if present
        if isinstance(item.get("team"), dict):
            merged["_team_ctx"] = item["team"]
        return merged
    return item


def is_active_best_effort(ep: Endpoint, rec: Dict[str, Any]) -> bool:
    """
    For endpoints without explicit /active:
    - If they provide a boolean like 'active', enforce it.
    - Otherwise, accept as "best-effort active".
    """
    if ep.get("active_best_effort"):
        if isinstance(rec.get("active"), bool):
            return rec["active"] is True
        # if an endpoint returns status strings:
        status = rec.get("status")
        if isinstance(status, str) and status.strip():
            # common patterns: "Active"
            if status.strip().lower() in ("inactive", "retired", "deceased"):
                return False
        return True
    return True


# --- Soccer rosters flow ---
def fetch_soccer_rosters(session: requests.Session) -> Iterable[Tuple[str, str, Dict[str, Any]]]:
    """
    Yields (league, team_name, player_record) for all soccer leagues defined in SOCCER_LEAGUES.
    Rosters are treated as "active" squads for the selected season (default = current season).
    """
    for lg in SOCCER_LEAGUES:
        league = lg["league"]
        print(f"⚽ Fetching teams for {league}...")
        # Teams endpoint: not paginated in many cases, but spec shows it returns data list  [oai_citation:15‡Balldontlie](https://www.balldontlie.io/openapi.yml)
        teams_payload = request_with_backoff(f"{BASE_URL}{lg['teams']}", session=session)
        teams = teams_payload.get("data", []) or []
        for t in teams:
            team_id = t.get("id")
            team_name = t.get("name") or t.get("full_name") or f"team:{team_id}"
            if team_id is None:
                continue

            # Rosters endpoint requires team_id  [oai_citation:16‡Balldontlie](https://www.balldontlie.io/openapi.yml)
            url = build_url(lg["rosters"], cursor=None, extra_params={"team_id": team_id})
            try:
                roster_payload = request_with_backoff(url, session=session)
            except Exception as e:
                print(f"❌ Roster error {league} team_id={team_id}: {e}")
                continue

            roster_items = roster_payload.get("data", []) or []
            for item in roster_items:
                p = coerce_player_record(item)
                # attach team context
                p["_team_name"] = team_name
                yield (league, team_name, p)

            time.sleep(SLEEP_BETWEEN_CALLS_SEC)


# --- Main fetch ---
def fetch_all_venezuelans() -> List[Dict[str, Any]]:
    existing = load_existing()

    # de-dupe by (league, id) if possible; fallback to (league, name)
    seen: set[Tuple[str, Any]] = set()
    for a in existing:
        key = (a.get("league", "?"), a.get("id") or a.get("name"))
        seen.add(key)

    out = existing[:]
    nhl_season = current_nhl_season_start_year()

    with requests.Session() as session:
        for ep in ENDPOINTS:
            mode = ep["mode"]

            if mode == "soccer_rosters":
                print("🚀 Scanning Soccer (active rosters across major leagues)...")
                for league, team_name, rec in fetch_soccer_rosters(session):
                    if not is_venezuelan(rec):
                        continue
                    name = normalize_name(rec)
                    rec_id = rec.get("id")
                    key = (league, rec_id or name)
                    if key in seen:
                        continue

                    out.append({
                        "id": rec_id,
                        "name": name,
                        "sport": "Soccer",
                        "league": league,
                        "team": team_name,
                        "source_endpoint": "soccer_rosters",
                        "country": rec.get("country"),
                        "country_code": rec.get("country_code"),
                        "nationality": rec.get("nationality"),
                        "citizenship": rec.get("citizenship"),
                        "birth_place": rec.get("birth_place") or rec.get("birthplace"),
                        "active_only": True,  # by construction (rosters)
                    })
                    seen.add(key)
                continue

            # paged mode
            print(f"🚀 Scanning {ep['sport']} - {ep['league']} ({ep['path']})...")
            cursor = None
            pages = 0

            extra = dict(ep.get("filters") or {})

            # NHL "best effort" to approximate active: filter to current season when possible.
            # /nhl/v1/players supports 'seasons' array param  [oai_citation:17‡Balldontlie](https://www.balldontlie.io/openapi.yml)
            if ep["league"] == "NHL":
                extra.setdefault("seasons", nhl_season)

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

                for raw in data:
                    rec = coerce_player_record(raw)

                    if not is_active_best_effort(ep, rec):
                        continue

                    if not is_venezuelan(rec):
                        continue

                    name = normalize_name(rec)
                    team = normalize_team(rec)

                    # better team for soccer-like wrappers
                    if ep["league"] in ("LoL", "Dota") and isinstance(raw.get("team"), dict):
                        team = raw["team"].get("name") or team

                    rec_id = rec.get("id")
                    key = (ep["league"], rec_id or name)
                    if key in seen:
                        continue

                    out.append({
                        "id": rec_id,
                        "name": name,
                        "sport": ep["sport"],
                        "league": ep["league"],
                        "team": team,
                        "source_endpoint": ep["path"],
                        "country": rec.get("country"),
                        "country_code": rec.get("country_code"),
                        "nationality": rec.get("nationality"),
                        "citizenship": rec.get("citizenship"),
                        "birth_place": rec.get("birth_place") or rec.get("birthplace"),
                        "active_only": ep["path"].endswith("/active") or ep.get("active_best_effort") or ep["league"] in ("PGA Tour",),
                    })
                    seen.add(key)

                pages += 1
                cursor = next_cursor
                if not cursor:
                    break

                time.sleep(SLEEP_BETWEEN_CALLS_SEC)

    out.sort(key=lambda x: (x.get("sport", ""), x.get("league", ""), x.get("name", "")))
    return out


if __name__ == "__main__":
    os.makedirs("data", exist_ok=True)
    vzla_list = fetch_all_venezuelans()

    with open(FILE_PATH, "w", encoding="utf-8") as f:
        json.dump(vzla_list, f, indent=2, ensure_ascii=False)

    print(f"🏁 Finished! Total unique athletes in database: {len(vzla_list)}")
    print(f"✅ Saved to: {FILE_PATH}")
