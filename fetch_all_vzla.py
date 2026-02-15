import os
import json
import time
from typing import Any, Dict, List, Optional
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

# TheSportsDB key (GitHub secret: SPORTSDB_KEY)
TSDB_KEY = os.environ.get("SPORTSDB_KEY")

# fallback only if NBA_API_KEY is numeric like the TSDB "123" key
if not TSDB_KEY:
    maybe = os.environ.get("NBA_API_KEY", "").strip()
    if maybe.isdigit():
        TSDB_KEY = maybe

TSDB_BASE = f"https://www.thesportsdb.com/api/v1/json/{TSDB_KEY}" if TSDB_KEY else None

# Target
COUNTRY_TARGET = "venezuela"

FILE_PATH = "data/athletes.json"

# Free-tier safety:
BDB_SLEEP_SEC = 13
TSDB_SLEEP_SEC = 2.0

# Limit pages per BDB endpoint per run (keep your current behavior)
BDB_MAX_PAGES_PER_ENDPOINT = 2

# =========================
# ENDPOINTS
# =========================

ENDPOINTS: List[Dict[str, Any]] = [
    # --- BALLDONTLIE (Free-safe) ---
    {"sport": "Basketball", "league": "NBA",  "provider": "balldontlie", "path": "/nba/v1/players", "field": "birth_place"},
    # WNBA active can be tier-gated; script now skips silently if 401/403
    {"sport": "Basketball", "league": "WNBA", "provider": "balldontlie", "path": "/wnba/v1/players/active", "field": "birth_place"},
    {"sport": "Basketball", "league": "NCAAB", "provider": "balldontlie", "path": "/ncaab/v1/players", "field": "birth_place"},
    {"sport": "Basketball", "league": "NCAAW", "provider": "balldontlie", "path": "/ncaaw/v1/players", "field": "birth_place"},

    {"sport": "Football",   "league": "NFL",  "provider": "balldontlie", "path": "/nfl/v1/players", "field": "birth_place"},
    {"sport": "Football",   "league": "NCAAF","provider": "balldontlie", "path": "/ncaaf/v1/players/active", "field": "birth_place"},

    # MLB: filter active=True locally (field exists in MLB player object)
    {"sport": "Baseball",   "league": "MLB",  "provider": "balldontlie", "path": "/mlb/v1/players", "field": "birth_place", "active_field": "active"},

    {"sport": "Hockey",     "league": "NHL",  "provider": "balldontlie", "path": "/nhl/v1/players", "field": "birth_place"},

    # Soccer (balldontlie)
    {"sport": "Soccer", "league": "EPL",        "provider": "balldontlie", "path": "/epl/v2/players", "field": "birth_place"},
    {"sport": "Soccer", "league": "La Liga",    "provider": "balldontlie", "path": "/laliga/v1/players", "field": "birth_place"},
    {"sport": "Soccer", "league": "MLS",        "provider": "balldontlie", "path": "/mls/v1/players", "field": "birth_place"},
    {"sport": "Soccer", "league": "UCL",        "provider": "balldontlie", "path": "/ucl/v1/players", "field": "birth_place"},
    {"sport": "Soccer", "league": "Ligue 1",    "provider": "balldontlie", "path": "/ligue1/v1/players", "field": "birth_place"},
    {"sport": "Soccer", "league": "Bundesliga", "provider": "balldontlie", "path": "/bundesliga/v1/players", "field": "birth_place"},
    {"sport": "Soccer", "league": "Serie A",    "provider": "balldontlie", "path": "/seriea/v1/players", "field": "birth_place"},

    {"sport": "MMA", "league": "MMA", "provider": "balldontlie", "path": "/mma/v1/fighters", "field": "birth_place"},
    {"sport": "Golf", "league": "PGA Tour", "provider": "balldontlie", "path": "/pga/v1/players", "field": "birth_place"},
    {"sport": "Tennis", "league": "ATP", "provider": "balldontlie", "path": "/atp/v1/players", "field": "birth_place"},
    {"sport": "Tennis", "league": "WTA", "provider": "balldontlie", "path": "/wta/v1/players", "field": "birth_place"},
    {"sport": "Motorsport", "league": "F1", "provider": "balldontlie", "path": "/f1/v1/drivers", "field": "birth_place"},

    # --- THESPORTSDB (league -> teams -> players) ---
    {"sport": "Soccer", "league": "Copa Libertadores", "provider": "thesportsdb", "league_id": "4501"},
    {"sport": "Basketball", "league": "EuroLeague Basketball", "provider": "thesportsdb", "league_id": "4546"},
    {"sport": "Rugby", "league": "European Rugby Champions Cup", "provider": "thesportsdb", "league_id": "4550"},

    {"sport": "Volleyball", "league": "CEV Champions League", "provider": "thesportsdb", "league_id": "5616"},
    {"sport": "Volleyball", "league": "Polish PlusLiga", "provider": "thesportsdb", "league_id": "5619"},
    {"sport": "Volleyball", "league": "Italian Volleyball League", "provider": "thesportsdb", "league_id": "4544"},
    {"sport": "Volleyball", "league": "French Ligue A Mens Volleyball", "provider": "thesportsdb", "league_id": "4582"},
    {"sport": "Volleyball", "league": "Turkish Volleyball League", "provider": "thesportsdb", "league_id": "4543"},
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

def contains_venezuela(text: Optional[str]) -> bool:
    if not isinstance(text, str):
        return False
    return COUNTRY_TARGET in text.lower()

def is_venezuelan_bdb(rec: Dict[str, Any], birthplace_field: str) -> bool:
    # Prefer birthplace containing "Venezuela"
    if contains_venezuela(rec.get(birthplace_field)):
        return True

    # Fallback checks (country / codes)
    for k in ("country", "nationality", "citizenship", "country_code"):
        v = rec.get(k)
        if isinstance(v, str):
            s = v.strip().lower()
            if s == "venezuela" or s == "ven":
                return True
            if "venezuela" in s:
                return True
    return False

def is_venezuelan_tsdb(player: Dict[str, Any]) -> bool:
    nat = (player.get("strNationality") or "").strip().lower()
    if nat == "venezuela":
        return True
    if contains_venezuela(player.get("strBirthLocation")):
        return True
    if contains_venezuela(player.get("strBirthPlace")):
        return True
    return False

def normalize_name_bdb(rec: Dict[str, Any]) -> str:
    fn = rec.get("first_name") or ""
    ln = rec.get("last_name") or ""
    full = rec.get("full_name") or rec.get("name") or ""
    name = (f"{fn} {ln}").strip()
    if name:
        return name
    if isinstance(full, str) and full.strip():
        return full.strip()
    return "Unknown"

def normalize_team_bdb(rec: Dict[str, Any]) -> str:
    team = rec.get("team")
    if isinstance(team, dict):
        return team.get("full_name") or team.get("name") or "Unknown"
    return rec.get("team_name") or rec.get("club") or "Unknown"

# =========================
# THESPORTSDB HELPERS
# =========================

def tsdb_get_json(path: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not TSDB_BASE:
        return None
    url = f"{TSDB_BASE}/{path}"
    try:
        r = requests.get(url, params=params, timeout=30)
        if r.status_code == 429:
            time.sleep(5)
            r = requests.get(url, params=params, timeout=30)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"❌ TheSportsDB error {path} params={params}: {e}")
        return None

def tsdb_league_name_from_id(league_id: str) -> Optional[str]:
    payload = tsdb_get_json("lookupleague.php", {"id": league_id})
    if not payload:
        return None
    leagues = payload.get("leagues") or []
    if not leagues:
        return None
    return leagues[0].get("strLeague")

def tsdb_lookup_all_teams_by_league_id(league_id: str) -> List[Dict[str, Any]]:
    # ✅ Best method: avoids name mismatch issues (Copa Libertadores / cups)
    payload = tsdb_get_json("lookup_all_teams.php", {"id": league_id})
    if not payload:
        return []
    return payload.get("teams") or []

def tsdb_search_all_teams_by_league_name(league_name: str) -> List[Dict[str, Any]]:
    # ✅ IMPORTANT: do NOT replace spaces with underscores. requests URL-encodes safely.
    payload = tsdb_get_json("search_all_teams.php", {"l": league_name})
    if not payload:
        return []
    return payload.get("teams") or []

def tsdb_lookup_all_players(team_id: str) -> List[Dict[str, Any]]:
    payload = tsdb_get_json("lookup_all_players.php", {"id": team_id})
    if not payload:
        return []
    return payload.get("player") or []

# =========================
# MAIN SCANNERS
# =========================

def scan_balldontlie(entry: Dict[str, Any], all_venezuelans: List[Dict[str, Any]], seen: set) -> None:
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

        url = f"{BDB_BASE}{path}"
        try:
            resp = requests.get(url, headers=BDB_HEADERS, params=params, timeout=30)

            if resp.status_code == 429:
                print("⚠️ BDB rate limit reached. Sleeping 60s...")
                time.sleep(60)
                continue

            if resp.status_code in (401, 403):
                # ✅ Silent skip for endpoints not included in your tier (removes the WNBA log spam)
                return

            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"❌ Error in BDB {entry['league']}: {e}")
            return

        players = data.get("data", []) or []

        for p in players:
            # MLB active-only filter (free-safe; field is inside /players record)
            if active_field and p.get(active_field) is not True:
                continue

            if is_venezuelan_bdb(p, birthplace_field):
                name = normalize_name_bdb(p)
                team = normalize_team_bdb(p)

                key = f"{entry['league']}::{name}::{team}"
                if key in seen:
                    continue

                all_venezuelans.append({
                    "name": name,
                    "sport": entry["sport"],
                    "league": entry["league"],
                    "team": team,
                    "provider": "balldontlie"
                })
                seen.add(key)

        cursor = (data.get("meta") or {}).get("next_cursor")
        pages += 1
        if not cursor:
            break

        time.sleep(BDB_SLEEP_SEC)

def scan_thesportsdb_league(entry: Dict[str, Any], all_venezuelans: List[Dict[str, Any]], seen: set) -> None:
    if not TSDB_BASE:
        print("⚠️ SPORTSDB_KEY missing. Skipping TheSportsDB leagues.")
        return

    league_id = entry["league_id"]
    print(f"🚀 Scanning (TSDB) {entry['sport']} - {entry['league']} (league_id={league_id}) ...")

    # ✅ FIRST: best method by league id
    teams = tsdb_lookup_all_teams_by_league_id(league_id)
    time.sleep(TSDB_SLEEP_SEC)

    # Fallback: resolve name then search teams by name (no underscores)
    if not teams:
        league_name = tsdb_league_name_from_id(league_id)
        if not league_name:
            print(f"⚠️ Could not resolve league name for id={league_id}. Skipping.")
            return
        time.sleep(TSDB_SLEEP_SEC)
        teams = tsdb_search_all_teams_by_league_name(league_name)
        time.sleep(TSDB_SLEEP_SEC)

    if not teams:
        print(f"⚠️ No teams found for TSDB league_id={league_id}. Skipping.")
        return

    print(f"   ✅ TSDB teams found: {len(teams)}")
    time.sleep(TSDB_SLEEP_SEC)

    for t in teams:
        team_id = t.get("idTeam")
        team_name = t.get("strTeam") or "Unknown"
        if not team_id:
            continue

        players = tsdb_lookup_all_players(team_id)
        time.sleep(TSDB_SLEEP_SEC)

        if not players:
            continue

        for p in players:
            if is_venezuelan_tsdb(p):
                name = (p.get("strPlayer") or "").strip() or "Unknown"
                key = f"{entry['league']}::{name}::{team_id}"
                if key in seen:
                    continue

                all_venezuelans.append({
                    "name": name,
                    "sport": entry["sport"],
                    "league": entry["league"],
                    "team": team_name,
                    "provider": "thesportsdb",
                    "nationality": p.get("strNationality"),
                    "birth_location": p.get("strBirthLocation") or p.get("strBirthPlace"),
                })
                seen.add(key)

def fetch_all_venezuelans() -> List[Dict[str, Any]]:
    all_venezuelans = load_existing_athletes()

    # De-dupe across runs
    seen = set()
    for a in all_venezuelans:
        key = f"{a.get('league','?')}::{a.get('name','?')}::{a.get('team','?')}"
        seen.add(key)

    for entry in ENDPOINTS:
        provider = entry.get("provider", "balldontlie")
        if provider == "balldontlie":
            scan_balldontlie(entry, all_venezuelans, seen)
        elif provider == "thesportsdb":
            scan_thesportsdb_league(entry, all_venezuelans, seen)
        else:
            print(f"⚠️ Unknown provider={provider} for entry={entry.get('league')}. Skipping.")

    all_venezuelans.sort(key=lambda x: (x.get("sport", ""), x.get("league", ""), x.get("name", "")))
    return all_venezuelans

if __name__ == "__main__":
    os.makedirs("data", exist_ok=True)
    vzla_list = fetch_all_venezuelans()
    save_athletes(vzla_list)
    print(f"🏁 Finished! Total unique athletes in database: {len(vzla_list)}")
