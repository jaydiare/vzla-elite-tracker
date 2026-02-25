import os
import json
import time
from typing import Any, Dict, List, Optional, Tuple
import requests

# =========================
# CONFIG
# =========================

# BallDontLie key (GitHub secret: NBA_API_KEY)
BDB_KEY = os.environ.get("NBA_API_KEY")
if not BDB_KEY:
    print("❌ Error: NBA_API_KEY not found in environment. Check GitHub Secrets.")
    raise SystemExit(1)

BDB_BASE = "https://api.balldontlie.io"
BDB_HEADERS = {"Authorization": BDB_KEY}
BDB_PER_PAGE = 100

# TheSportsDB key (GitHub secret: SPORTSDB_KEY). Free keys are typically numeric.
TSDB_KEY = os.environ.get("SPORTSDB_KEY", "").strip() or None
TSDB_BASE = f"https://www.thesportsdb.com/api/v1/json/{TSDB_KEY}" if TSDB_KEY else None

# Target
COUNTRY_TARGET = "venezuela"
FILE_PATH = "data/athletes.json"

# TSDB cache (to avoid re-hitting the same rosters every run)
TSDB_CACHE_PATH = "data/tsdb_cache.json"

# Free-tier safety
BDB_SLEEP_SEC = 13
BDB_MAX_PAGES_PER_ENDPOINT = 50

# TSDB safety (free-tier is strict)
TSDB_SLEEP_SEC = 8.0
TSDB_MAX_TEAMS_PER_LEAGUE = 40
TSDB_MAX_RETRIES = 7
TSDB_BACKOFF_START = 6.0
REQUEST_TIMEOUT = 30

# If a team roster call fails (429/give-up), wait before retrying that team on future runs
TSDB_TEAM_RETRY_COOLDOWN_SEC = 6 * 60 * 60  # 6 hours

# =========================
# BALLDONTLIE ENDPOINTS (free-safe list)
# =========================
BDB_ENDPOINTS: List[Dict[str, Any]] = [
    #{"sport": "Basketball", "league": "NBA",   "provider": "balldontlie", "path": "/nba/v1/players",      "field": "birth_place"},
    #{"sport": "Basketball", "league": "NCAAB", "provider": "balldontlie", "path": "/ncaab/v1/players",    "field": "birth_place"},
    #{"sport": "Basketball", "league": "NCAAW", "provider": "balldontlie", "path": "/ncaaw/v1/players",    "field": "birth_place"},

    #{"sport": "Football",   "league": "NFL",   "provider": "balldontlie", "path": "/nfl/v1/players",      "field": "birth_place"},
   # {"sport": "Football",   "league": "NCAAF", "provider": "balldontlie", "path": "/ncaaf/v1/players",    "field": "birth_place"},

    #{"sport": "Baseball",   "league": "MLB",   "provider": "balldontlie", "path": "/mlb/v1/players",      "field": "birth_place", "active_field": "active"},

    #{"sport": "Hockey",     "league": "NHL",   "provider": "balldontlie", "path": "/nhl/v1/players",      "field": "birth_place"},

    #{"sport": "Soccer", "league": "EPL",        "provider": "balldontlie", "path": "/epl/v2/players",        "field": "birth_place"},
    #{"sport": "Soccer", "league": "La Liga",    "provider": "balldontlie", "path": "/laliga/v1/players",     "field": "birth_place"},
    #{"sport": "Soccer", "league": "MLS",        "provider": "balldontlie", "path": "/mls/v1/players",        "field": "birth_place"},
    #{"sport": "Soccer", "league": "UCL",        "provider": "balldontlie", "path": "/ucl/v1/players",        "field": "birth_place"},
    #{"sport": "Soccer", "league": "Ligue 1",    "provider": "balldontlie", "path": "/ligue1/v1/players",     "field": "birth_place"},
    #{"sport": "Soccer", "league": "Bundesliga", "provider": "balldontlie", "path": "/bundesliga/v1/players", "field": "birth_place"},
    #{"sport": "Soccer", "league": "Serie A",    "provider": "balldontlie", "path": "/seriea/v1/players",     "field": "birth_place"},

    #{"sport": "MMA",        "league": "MMA",       "provider": "balldontlie", "path": "/mma/v1/fighters",   "field": "birth_place"},
    #{"sport": "Golf",       "league": "PGA Tour",  "provider": "balldontlie", "path": "/pga/v1/players",    "field": "birth_place"},
    #{"sport": "Tennis",     "league": "ATP",       "provider": "balldontlie", "path": "/atp/v1/players",    "field": "birth_place"},
    #{"sport": "Tennis",     "league": "WTA",       "provider": "balldontlie", "path": "/wta/v1/players",    "field": "birth_place"},
    #{"sport": "Motorsport", "league": "F1",        "provider": "balldontlie", "path": "/f1/v1/drivers",     "field": "birth_place"},
]

# =========================
# THESPORTSDB TOP DIVISIONS
# =========================
TSDB_TOP_DIVISIONS: List[Dict[str, Any]] = [
    #{"sport": "Soccer", "country": "Mexico",    "league": "Mexican Primera League",       "league_id": "4350"},
    #{"sport": "Soccer", "country": "Argentina", "league": "Argentinian Primera Division", "league_id": "4406"},
    #{"sport": "Soccer", "country": "Brazil",    "league": "Brazilian Serie A",            "league_id": "4351"},
    #{"sport": "Soccer", "country": "Chile",     "league": "Chile Primera Division",       "league_id": "4627"},
    #{"sport": "Soccer", "country": "Italy",     "league": "Italian Serie A",              "league_id": "4332"},
    #{"sport": "Soccer", "country": "France",    "league": "French Ligue 1",               "league_id": "4334"},
    {"sport": "Soccer", "country": "United States",    "league": "American NWSL",          "league_id": "4521"},
    

    #{"sport": "Basketball", "country": "Mexico",    "league": "Mexican LNBP",  "league_id": "5119"},
    #{"sport": "Basketball", "country": "Argentina", "league": "Argentine LNB", "league_id": "4734"},
    #{"sport": "Basketball", "country": "Europe",    "league": "EuroLeague Basketball",  "league_id": "4546"},

    #{"sport": "Baseball", "country": "Mexico", "league": "Liga Mexicana de Béisbol", "league_id": "5064"},
    #{"sport": "Baseball", "country": "Mexico", "league": "Mexican Pacific League",   "league_id": "5109"},
    {"sport": "Baseball", "country": "Japan",  "league": "Nippon Baseball League",    "league_id": "4591"},
    {"sport": "Baseball", "country": "Korea",  "league": "Korean KBO League",         "league_id": "4830"},
]

TSDB_GOLF_TOP_TOURS: List[Dict[str, str]] = [
    {"league_id": "4486", "league": "European Tour"},
    {"league_id": "4425", "league": "PGA Tour"},
    {"league_id": "4553", "league": "LPGA Tour"},
    {"league_id": "4426", "league": "European Tour"},
]

# =========================
# HELPERS
# =========================

def load_existing_athletes() -> List[Dict[str, Any]]:
    if os.path.exists(FILE_PATH):
        with open(FILE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return []

def save_athletes(items: List[Dict[str, Any]]) -> None:
    os.makedirs(os.path.dirname(FILE_PATH), exist_ok=True)
    with open(FILE_PATH, "w", encoding="utf-8") as f:
        json.dump(items, f, indent=4, ensure_ascii=False)

def load_tsdb_cache() -> Dict[str, Any]:
    """
    Backward-compatible cache loader.

    Old schema:
      { "scanned_team_ids": [ ... ] }

    New schema:
      {
        "scanned_team_ids": [ ... ],
        "team_next_retry": { "TEAM_ID": UNIX_TS, ... }
      }
    """
    if os.path.exists(TSDB_CACHE_PATH):
        try:
            with open(TSDB_CACHE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                data.setdefault("scanned_team_ids", [])
                data.setdefault("team_next_retry", {})
                # normalize types
                if not isinstance(data["scanned_team_ids"], list):
                    data["scanned_team_ids"] = []
                if not isinstance(data["team_next_retry"], dict):
                    data["team_next_retry"] = {}
                return data
        except Exception:
            pass
    return {"scanned_team_ids": [], "team_next_retry": {}}

def save_tsdb_cache(cache: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(TSDB_CACHE_PATH), exist_ok=True)
    with open(TSDB_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)

def contains_venezuela(text: Optional[str]) -> bool:
    return isinstance(text, str) and (COUNTRY_TARGET in text.lower())

def is_venezuelan_bdb(rec: Dict[str, Any], birthplace_field: str) -> bool:
    if contains_venezuela(rec.get(birthplace_field)):
        return True
    for k in ("country", "nationality", "citizenship", "country_code"):
        v = rec.get(k)
        if isinstance(v, str):
            s = v.strip().lower()
            if s == "venezuela" or s == "ven" or "venezuela" in s:
                return True
    return False

def is_venezuelan_tsdb_player(player: Dict[str, Any]) -> bool:
    nat = (player.get("strNationality") or "").strip().lower()
    if nat == "venezuela":
        return True
    if contains_venezuela(player.get("strBirthLocation")):
        return True
    if contains_venezuela(player.get("strBirthPlace")):
        return True
    return False

def is_venezuelan_tsdb_team_as_player(team_obj: Dict[str, Any]) -> bool:
    c = (team_obj.get("strCountry") or "").strip().lower()
    if c == "venezuela":
        return True
    if contains_venezuela(team_obj.get("strTeam")):
        return True
    return False

def normalize_name_bdb(rec: Dict[str, Any]) -> str:
    fn = (rec.get("first_name") or "").strip()
    ln = (rec.get("last_name") or "").strip()
    name = (f"{fn} {ln}").strip()
    return name if name else (rec.get("name") or "Unknown")

def normalize_team_bdb(rec: Dict[str, Any]) -> str:
    team = rec.get("team")
    if isinstance(team, dict):
        return team.get("full_name") or team.get("name") or "Unknown"
    return rec.get("team_name") or rec.get("club") or "Unknown"

# =========================
# TSDB REQUEST (backoff on 429) + SUCCESS FLAG
# =========================

def tsdb_get_json_with_ok(path: str, params: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], bool]:
    """
    Returns (payload, ok)
    ok=True means we got a valid HTTP 2xx JSON response.
    ok=False means we failed (429 gave up, HTTP error, network error, etc.)
    """
    if not TSDB_BASE:
        return None, False

    url = f"{TSDB_BASE}/{path}"
    backoff = TSDB_BACKOFF_START

    for attempt in range(TSDB_MAX_RETRIES):
        try:
            r = requests.get(url, params=params, timeout=REQUEST_TIMEOUT)

            if r.status_code == 429:
                wait = min(60.0, backoff)
                print(f"⚠️ TSDB 429 on {path} {params}. Sleeping {wait:.1f}s (attempt {attempt+1}/{TSDB_MAX_RETRIES})...")
                time.sleep(wait)
                backoff *= 2
                continue

            r.raise_for_status()
            return r.json(), True

        except requests.HTTPError as e:
            print(f"❌ TSDB HTTP error {path} params={params}: {e}")
            return None, False
        except Exception as e:
            wait = min(20.0, backoff)
            print(f"❌ TSDB error {path} params={params}: {e} (sleep {wait:.1f}s)")
            time.sleep(wait)
            backoff *= 2

    print(f"❌ TSDB gave up after retries: {path} params={params}")
    return None, False

def tsdb_lookup_teams_by_league_id(league_id: str) -> Tuple[List[Dict[str, Any]], bool]:
    payload, ok = tsdb_get_json_with_ok("lookup_all_teams.php", {"id": league_id})
    if not ok or not payload:
        return [], ok
    return payload.get("teams") or [], ok

def tsdb_lookup_all_players(team_id: str) -> Tuple[List[Dict[str, Any]], bool]:
    payload, ok = tsdb_get_json_with_ok("lookup_all_players.php", {"id": team_id})
    if not ok or not payload:
        return [], ok
    return payload.get("player") or [], ok

def tsdb_lookupleague_name(league_id: str) -> Optional[str]:
    payload, ok = tsdb_get_json_with_ok("lookupleague.php", {"id": league_id})
    if not ok or not payload:
        return None
    leagues = payload.get("leagues") or []
    if not leagues:
        return None
    return leagues[0].get("strLeague")

# =========================
# SCANNERS
# =========================

def scan_balldontlie(entry: Dict[str, Any], out: List[Dict[str, Any]], seen: set) -> None:
    cursor = None
    pages = 0
    path = entry["path"]
    birthplace_field = entry.get("field", "birth_place")
    active_field = entry.get("active_field")

    print(f"🚀 Scanning (BDB) {entry['sport']} - {entry['league']} ... {path}")

    while True:
        if BDB_MAX_PAGES_PER_ENDPOINT is not None and pages >= BDB_MAX_PAGES_PER_ENDPOINT:
            break

        params = {"per_page": BDB_PER_PAGE}
        if cursor:
            params["cursor"] = cursor

        try:
            resp = requests.get(f"{BDB_BASE}{path}", headers=BDB_HEADERS, params=params, timeout=REQUEST_TIMEOUT)

            if resp.status_code == 429:
                print("⚠️ BDB rate limit reached. Sleeping 60s...")
                time.sleep(60)
                continue

            if resp.status_code in (401, 403):
                print(f"Auth failed {resp.status_code} for {resp.url}: {resp.text[:200]}")
                return

            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"❌ Error in BDB {entry['league']}: {e}")
            return

        players = data.get("data", []) or []

        for p in players:
            if active_field and p.get(active_field) is not True:
                continue

            if is_venezuelan_bdb(p, birthplace_field):
                name = normalize_name_bdb(p)
                key = f"balldontlie::{entry['league']}::{name}::{normalize_team_bdb(p)}"
                if key in seen:
                    continue

                out.append({
                    "name": name,
                    "sport": entry["sport"],
                    "league": entry["league"],
                    "team": normalize_team_bdb(p),
                    "provider": "balldontlie",
                })
                seen.add(key)

        cursor = (data.get("meta") or {}).get("next_cursor")
        pages += 1
        if not cursor:
            break

        time.sleep(BDB_SLEEP_SEC)

def scan_tsdb_top_division(
    division: Dict[str, Any],
    out: List[Dict[str, Any]],
    seen: set,
    cache: Dict[str, Any],
) -> None:
    if not TSDB_BASE:
        print("⚠️ SPORTSDB_KEY missing. Skipping TSDB.")
        return

    league_id = division["league_id"]
    league_label = division["league"]
    sport = division["sport"]
    country = division["country"]

    resolved = tsdb_lookupleague_name(league_id) or league_label
    print(f"🌎 Scanning (TSDB) {sport} TOP DIVISION in {country}: {resolved} (id={league_id}) ...")

    teams, teams_ok = tsdb_lookup_teams_by_league_id(league_id)
    time.sleep(TSDB_SLEEP_SEC)

    if not teams_ok:
        print(f"   ⚠️ TSDB teams fetch failed for league_id={league_id} ({resolved}). Will retry next run.")
        return

    if not teams:
        print(f"   ⚠️ No teams found for league_id={league_id} ({resolved}).")
        return

    scanned_team_ids = set(str(x) for x in (cache.get("scanned_team_ids") or []))
    team_next_retry = cache.get("team_next_retry") or {}
    now = int(time.time())

    new_attempts = 0
    for t in teams:
        if new_attempts >= TSDB_MAX_TEAMS_PER_LEAGUE:
            break

        team_id_raw = t.get("idTeam")
        team_name = (t.get("strTeam") or "Unknown").strip()
        if not team_id_raw:
            continue

        team_id = str(team_id_raw).strip()

        # already successfully scanned in a prior run
        if team_id in scanned_team_ids:
            continue

        # cooldown if previously failed
        next_ok = int(team_next_retry.get(team_id, 0) or 0)
        if next_ok and now < next_ok:
            continue

        players, ok = tsdb_lookup_all_players(team_id)
        time.sleep(TSDB_SLEEP_SEC)

        new_attempts += 1

        if not ok:
            # IMPORTANT FIX:
            # Do NOT mark scanned on failure. Just set a cooldown so we don't hammer.
            team_next_retry[team_id] = now + TSDB_TEAM_RETRY_COOLDOWN_SEC
            continue

        # SUCCESS:
        # Mark scanned even if roster is empty (that's a real "done" state).
        scanned_team_ids.add(team_id)
        if team_id in team_next_retry:
            team_next_retry.pop(team_id, None)

        if not players:
            continue

        for p in players:
            if is_venezuelan_tsdb_player(p):
                name = (p.get("strPlayer") or "").strip() or "Unknown"
                key = f"thesportsdb::{resolved}::{name}::{team_id}"
                if key in seen:
                    continue

                out.append({
                    "name": name,
                    "sport": sport,
                    "league": resolved,
                    "team": team_name,
                    "provider": "thesportsdb",
                    "country_context": country,
                    "nationality": p.get("strNationality"),
                    "birth_location": p.get("strBirthLocation") or p.get("strBirthPlace"),
                })
                seen.add(key)

    # write back into cache dict (caller saves once)
    cache["scanned_team_ids"] = sorted(scanned_team_ids)
    cache["team_next_retry"] = team_next_retry

def scan_tsdb_golf(out: List[Dict[str, Any]], seen: set) -> None:
    if not TSDB_BASE:
        return

    print("🏌️ Scanning (TSDB) Golf → Tours → (Teams-as-golfers) → filter Venezuelans ...")

    for tour in TSDB_GOLF_TOP_TOURS:
        league_id = tour["league_id"]
        league_name = tsdb_lookupleague_name(league_id) or tour.get("league", f"Golf Tour {league_id}")

        teams, ok = tsdb_lookup_teams_by_league_id(league_id)
        time.sleep(TSDB_SLEEP_SEC)

        if not ok or not teams:
            continue

        for golfer in teams:
            if is_venezuelan_tsdb_team_as_player(golfer):
                name = (golfer.get("strTeam") or "Unknown").strip()
                key = f"thesportsdb::{league_name}::{name}::golfteam"
                if key in seen:
                    continue

                out.append({
                    "name": name,
                    "sport": "Golf",
                    "league": league_name,
                    "team": "Venezuela",
                    "provider": "thesportsdb",
                    "nationality": golfer.get("strCountry"),
                })
                seen.add(key)

# =========================
# MAIN
# =========================

def fetch_all_venezuelans() -> List[Dict[str, Any]]:
    out = load_existing_athletes()

    # De-dupe across runs (provider+league+name+team)
    seen = set()
    for a in out:
        key = f"{a.get('provider','?')}::{a.get('league','?')}::{a.get('name','?')}::{a.get('team','?')}"
        seen.add(key)

    # BallDontLie scan
    for ep in BDB_ENDPOINTS:
        scan_balldontlie(ep, out, seen)

    # TheSportsDB scan + cache
    if TSDB_BASE:
        cache = load_tsdb_cache()

        for div in TSDB_TOP_DIVISIONS:
            scan_tsdb_top_division(div, out, seen, cache)

        save_tsdb_cache(cache)

        # Optional TSDB golf
        scan_tsdb_golf(out, seen)

    out.sort(key=lambda x: (x.get("sport", ""), x.get("league", ""), x.get("name", "")))
    return out

if __name__ == "__main__":
    os.makedirs("data", exist_ok=True)
    vzla_list = fetch_all_venezuelans()
    save_athletes(vzla_list)
    print(f"🏁 Finished! Total unique athletes in database: {len(vzla_list)}")
