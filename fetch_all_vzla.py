import os
import json
import time
from typing import Any, Dict, List, Optional, Set, Tuple
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
if not TSDB_KEY:
    maybe = os.environ.get("NBA_API_KEY", "").strip()
    if maybe.isdigit():
        TSDB_KEY = maybe

TSDB_BASE = f"https://www.thesportsdb.com/api/v1/json/{TSDB_KEY}" if TSDB_KEY else None

COUNTRY_TARGET = "venezuela"
FILE_PATH = "data/athletes.json"

# Free-tier safety
BDB_SLEEP_SEC = 13
TSDB_SLEEP_SEC = 2.0
BDB_MAX_PAGES_PER_ENDPOINT = 2

# TSDB country scan targets
TSDB_COUNTRIES = ["Mexico", "Argentina", "Brazil", "Chile"]
TSDB_SPORTS_COUNTRY = ["Soccer", "Basketball", "Baseball"]

# ✅ TSDB top divisions only (adjust names to match what TSDB returns)
TSDB_TOP_LEAGUES: Dict[Tuple[str, str], Set[str]] = {
    # Soccer
    ("Mexico", "Soccer"): {"Liga MX", "Mexican Primera League", "Primera Division Mexico"},
    ("Argentina", "Soccer"): {"Argentine Primera Division", "Liga Profesional", "Primera División Argentina"},
    ("Brazil", "Soccer"): {"Brazilian Serie A", "Campeonato Brasileiro Série A", "Brasileirão Série A"},
    ("Chile", "Soccer"): {"Chilean Primera Division", "Primera División de Chile", "Campeonato Nacional"},

    # Basketball (best guesses; TSDB naming varies)
    ("Mexico", "Basketball"): {"LNBP", "Liga Nacional de Baloncesto Profesional"},
    ("Argentina", "Basketball"): {"Liga Nacional de Básquet", "Liga Nacional de Basquet", "Liga Nacional"},
    ("Brazil", "Basketball"): {"NBB", "Novo Basquete Brasil"},
    ("Chile", "Basketball"): {"Liga Nacional de Básquetbol", "Liga Nacional de Basquetbol"},

    # Baseball (TSDB coverage varies; keep Mexico top league, others empty = skip)
    ("Mexico", "Baseball"): {"Liga Mexicana de Beisbol", "Mexican League", "LMB"},
    ("Argentina", "Baseball"): set(),
    ("Brazil", "Baseball"): set(),
    ("Chile", "Baseball"): set(),
}

# ✅ TSDB Golf: Sport → top tours only
TSDB_GOLF_TOP_TOURS: Set[str] = {
    "PGA Tour",
    "European Tour",
    "DP World Tour",
    "LPGA Tour",
    "LIV Golf",
}

# =========================
# BALLDONTLIE ENDPOINTS
# =========================

ENDPOINTS: List[Dict[str, Any]] = [
    {"sport": "Basketball", "league": "NBA",   "provider": "balldontlie", "path": "/nba/v1/players", "field": "birth_place"},
    {"sport": "Basketball", "league": "WNBA",  "provider": "balldontlie", "path": "/wnba/v1/players/active", "field": "birth_place"},
    {"sport": "Basketball", "league": "NCAAB", "provider": "balldontlie", "path": "/ncaab/v1/players", "field": "birth_place"},
    {"sport": "Basketball", "league": "NCAAW", "provider": "balldontlie", "path": "/ncaaw/v1/players", "field": "birth_place"},

    {"sport": "Football", "league": "NFL",   "provider": "balldontlie", "path": "/nfl/v1/players", "field": "birth_place"},
    {"sport": "Football", "league": "NCAAF", "provider": "balldontlie", "path": "/ncaaf/v1/players/active", "field": "birth_place"},

    {"sport": "Baseball", "league": "MLB", "provider": "balldontlie", "path": "/mlb/v1/players", "field": "birth_place", "active_field": "active"},

    {"sport": "Hockey", "league": "NHL", "provider": "balldontlie", "path": "/nhl/v1/players", "field": "birth_place"},

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
]

# =========================
# FILE HELPERS
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

# =========================
# MATCHERS / NORMALIZERS
# =========================

def contains_venezuela(text: Optional[str]) -> bool:
    return isinstance(text, str) and COUNTRY_TARGET in text.lower()

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

def normalize_name_bdb(rec: Dict[str, Any]) -> str:
    fn = rec.get("first_name") or ""
    ln = rec.get("last_name") or ""
    full = rec.get("full_name") or rec.get("name") or ""
    name = (f"{fn} {ln}").strip()
    return name if name else (full.strip() if isinstance(full, str) and full.strip() else "Unknown")

def normalize_team_bdb(rec: Dict[str, Any]) -> str:
    team = rec.get("team")
    if isinstance(team, dict):
        return team.get("full_name") or team.get("name") or "Unknown"
    return rec.get("team_name") or rec.get("club") or "Unknown"

def is_venezuelan_tsdb(player: Dict[str, Any]) -> bool:
    nat = (player.get("strNationality") or "").strip().lower()
    if nat == "venezuela":
        return True
    if contains_venezuela(player.get("strBirthLocation")):
        return True
    if contains_venezuela(player.get("strBirthPlace")):
        return True
    return False

# =========================
# BALLDONTLIE SCANNER
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
            resp = requests.get(f"{BDB_BASE}{path}", headers=BDB_HEADERS, params=params, timeout=30)

            if resp.status_code == 429:
                print("⚠️ BDB rate limit reached. Sleeping 60s...")
                time.sleep(60)
                continue

            if resp.status_code in (401, 403):
                # Silent skip if your tier doesn't include the endpoint
                return

            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"❌ Error in BDB {entry['league']}: {e}")
            return

        items = data.get("data", []) or []

        for rec in items:
            if active_field and rec.get(active_field) is not True:
                continue

            if is_venezuelan_bdb(rec, birthplace_field):
                name = normalize_name_bdb(rec)
                team = normalize_team_bdb(rec)
                key = f"bdb::{entry['sport']}::{entry['league']}::{team}::{name}".lower()
                if key in seen:
                    continue
                out.append({
                    "name": name,
                    "sport": entry["sport"],
                    "league": entry["league"],
                    "team": team,
                    "provider": "balldontlie",
                })
                seen.add(key)

        cursor = (data.get("meta") or {}).get("next_cursor")
        pages += 1
        if not cursor:
            break

        time.sleep(BDB_SLEEP_SEC)

# =========================
# THESPORTSDB HELPERS
# =========================

def tsdb_get_json(path: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not TSDB_BASE:
        return None
    try:
        r = requests.get(f"{TSDB_BASE}/{path}", params=params, timeout=30)
        if r.status_code == 429:
            time.sleep(5)
            r = requests.get(f"{TSDB_BASE}/{path}", params=params, timeout=30)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"❌ TSDB error {path} params={params}: {e}")
        return None

def tsdb_list_leagues_by_country(country: str, sport: str) -> List[Dict[str, Any]]:
    payload = tsdb_get_json("search_all_leagues.php", {"c": country, "s": sport})
    if not payload:
        return []
    # TSDB sometimes uses "countries" for leagues list
    return payload.get("countries") or payload.get("countrys") or payload.get("leagues") or []

def tsdb_list_leagues_by_sport(sport: str) -> List[Dict[str, Any]]:
    payload = tsdb_get_json("search_all_leagues.php", {"s": sport})
    if not payload:
        return []
    return payload.get("countries") or payload.get("countrys") or payload.get("leagues") or []

def tsdb_lookup_all_teams_by_league_id(league_id: str) -> List[Dict[str, Any]]:
    payload = tsdb_get_json("lookup_all_teams.php", {"id": league_id})
    if not payload:
        return []
    return payload.get("teams") or []

def tsdb_search_all_teams_by_league_name(league_name: str) -> List[Dict[str, Any]]:
    payload = tsdb_get_json("search_all_teams.php", {"l": league_name})
    if not payload:
        return []
    return payload.get("teams") or []

def tsdb_lookup_all_players(team_id: str) -> List[Dict[str, Any]]:
    payload = tsdb_get_json("lookup_all_players.php", {"id": team_id})
    if not payload:
        return []
    return payload.get("player") or []

def _normalize_leagues(raw: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for l in raw:
        lid = l.get("idLeague") or l.get("idleague") or l.get("id")
        lname = l.get("strLeague") or l.get("strleague") or l.get("name") or l.get("strLeagueAlternate")
        if lid and lname:
            out.append({"idLeague": str(lid), "strLeague": str(lname)})
    # de-dupe by id
    seen_ids = set()
    uniq = []
    for l in out:
        if l["idLeague"] in seen_ids:
            continue
        uniq.append(l)
        seen_ids.add(l["idLeague"])
    return uniq

# =========================
# TSDB SCANNERS
# =========================

def scan_tsdb_country_top_divisions(country: str, sport: str, out: List[Dict[str, Any]], seen: set) -> None:
    if not TSDB_BASE:
        return

    allow = TSDB_TOP_LEAGUES.get((country, sport), set())
    if allow is not None and len(allow) == 0:
        # explicitly skip this combo
        return

    print(f"🌎 Scanning (TSDB) TOP DIVISIONS: {sport} in {country} ...")

    leagues = _normalize_leagues(tsdb_list_leagues_by_country(country, sport))
    time.sleep(TSDB_SLEEP_SEC)

    # filter to allowlist only
    leagues = [l for l in leagues if l["strLeague"] in allow]
    if not leagues:
        print(f"   ⚠️ No matching TOP division leagues for {sport} in {country}.")
        return

    print(f"   ✅ Matched leagues: {[l['strLeague'] for l in leagues]}")
    time.sleep(TSDB_SLEEP_SEC)

    for league in leagues:
        league_id = league["idLeague"]
        league_name = league["strLeague"]

        teams = tsdb_lookup_all_teams_by_league_id(league_id)
        time.sleep(TSDB_SLEEP_SEC)
        if not teams:
            teams = tsdb_search_all_teams_by_league_name(league_name)
            time.sleep(TSDB_SLEEP_SEC)
        if not teams:
            continue

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
                    key = f"tsdb::{sport}::{country}::{league_name}::{team_id}::{name}".lower()
                    if key in seen:
                        continue
                    out.append({
                        "name": name,
                        "sport": sport,
                        "league": league_name,
                        "team": team_name,
                        "provider": "thesportsdb",
                        "country_scan": country,
                        "nationality": p.get("strNationality"),
                        "birth_location": p.get("strBirthLocation") or p.get("strBirthPlace"),
                    })
                    seen.add(key)

def scan_tsdb_golf_top_tours(out: List[Dict[str, Any]], seen: set) -> None:
    if not TSDB_BASE:
        return

    print("🏌️ Scanning (TSDB) Golf → TOP Tours → Teams → Players ...")

    leagues = _normalize_leagues(tsdb_list_leagues_by_sport("Golf"))
    time.sleep(TSDB_SLEEP_SEC)

    leagues = [l for l in leagues if l["strLeague"] in TSDB_GOLF_TOP_TOURS]
    if not leagues:
        print("   ⚠️ No TSDB Golf top tours matched. (Names may differ in TSDB.)")
        return

    print(f"   ✅ Matched Golf tours: {[l['strLeague'] for l in leagues]}")
    time.sleep(TSDB_SLEEP_SEC)

    for league in leagues:
        league_id = league["idLeague"]
        league_name = league["strLeague"]

        teams = tsdb_lookup_all_teams_by_league_id(league_id)
        time.sleep(TSDB_SLEEP_SEC)
        if not teams:
            teams = tsdb_search_all_teams_by_league_name(league_name)
            time.sleep(TSDB_SLEEP_SEC)
        if not teams:
            continue

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
                    key = f"tsdb::golf::{league_name}::{team_id}::{name}".lower()
                    if key in seen:
                        continue
                    out.append({
                        "name": name,
                        "sport": "Golf",
                        "league": league_name,
                        "team": team_name,
                        "provider": "thesportsdb",
                        "nationality": p.get("strNationality"),
                        "birth_location": p.get("strBirthLocation") or p.get("strBirthPlace"),
                    })
                    seen.add(key)

# =========================
# MAIN
# =========================

def fetch_all_venezuelans() -> List[Dict[str, Any]]:
    out = load_existing_athletes()

    # De-dupe across runs/providers
    seen = set()
    for a in out:
        key = f"{a.get('provider','?')}::{a.get('sport','?')}::{a.get('league','?')}::{a.get('team','?')}::{a.get('name','?')}".lower()
        seen.add(key)

    # 1) BallDontLie
    for entry in ENDPOINTS:
        scan_balldontlie(entry, out, seen)

    # 2) TSDB: top divisions only for country sports
    if TSDB_BASE:
        for country in TSDB_COUNTRIES:
            for sport in TSDB_SPORTS_COUNTRY:
                scan_tsdb_country_top_divisions(country, sport, out, seen)

        # 3) TSDB: Golf (top tours only)
        scan_tsdb_golf_top_tours(out, seen)
    else:
        print("⚠️ SPORTSDB_KEY missing. Skipping TSDB scans.")

    out.sort(key=lambda x: (x.get("sport", ""), x.get("league", ""), x.get("team", ""), x.get("name", "")))
    return out

if __name__ == "__main__":
    os.makedirs("data", exist_ok=True)
    vzla_list = fetch_all_venezuelans()
    save_athletes(vzla_list)
    print(f"🏁 Finished! Total unique athletes in database: {len(vzla_list)}")
