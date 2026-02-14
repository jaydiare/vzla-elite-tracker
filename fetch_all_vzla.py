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
TSDB_KEY = os.environ.get("SPORTSDB_KEY")  # you showed you added it
TSDB_BASE = f"https://www.thesportsdb.com/api/v1/json/{TSDB_KEY}" if TSDB_KEY else None

# Target
COUNTRY_TARGET = "venezuela"

FILE_PATH = "data/athletes.json"

# Free-tier safety:
# - BallDontLie free is easy to rate-limit; keep it slow-ish
BDB_SLEEP_SEC = 13  # safe for free tier
# - TheSportsDB has request limits and can 429; keep very conservative
TSDB_SLEEP_SEC = 2.0

# Limit pages per BDB endpoint per run (keep your old behavior)
BDB_MAX_PAGES_PER_ENDPOINT = 2


# =========================
# ENDPOINTS
# =========================
# Your format: {"sport","league","path","field"}
# We keep that for balldontlie.
# For TheSportsDB we add provider+league_id; it does league->teams->players.

ENDPOINTS: List[Dict[str, Any]] = [
    # --- BALLDONTLIE (Free-safe) ---
    {"sport": "Basketball", "league": "NBA",  "provider": "balldontlie", "path": "/nba/v1/players", "field": "birth_place"},
    {"sport": "Football",   "league": "NFL",  "provider": "balldontlie", "path": "/nfl/v1/players", "field": "birth_place"},
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

    # --- THESPORTSDB (league -> teams -> players) ---
    # Uses: lookupleague.php?id=, search_all_teams.php?l=, lookup_all_players.php?id=
    # (All are documented v1 endpoints.) :contentReference[oaicite:1]{index=1}
    {"sport": "Soccer", "league": "Copa Libertadores", "provider": "thesportsdb", "league_id": "4501"},
    {"sport": "Basketball", "league": "EuroLeague Basketball", "provider": "thesportsdb", "league_id": "4546"},
    {"sport": "Rugby", "league": "European Rugby Champions Cup", "provider": "thesportsdb", "league_id": "4550"},

    # Volleyball Europe
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

    # Fallback checks (some BDB objects have "country" or codes)
    for k in ("country", "nationality", "citizenship", "country_code"):
        v = rec.get(k)
        if isinstance(v, str):
            s = v.strip().lower()
            if s == "venezuela" or s == "ven":
                return True
    return False


def is_venezuelan_tsdb(player: Dict[str, Any]) -> bool:
    # TheSportsDB player fields are typically:
    # - strNationality
    # - strBirthLocation or strBirthPlace
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
    name = (f"{fn} {ln}").strip()
    return name if name else (rec.get("name") or "Unknown")


def normalize_team_bdb(rec: Dict[str, Any]) -> str:
    team = rec.get("team")
    if isinstance(team, dict):
        return team.get("full_name") or team.get("name") or "Unknown"
    return rec.get("team_name") or rec.get("club") or "Unknown"


def tsdb_get_json(path: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not TSDB_BASE:
        return None
    url = f"{TSDB_BASE}/{path}"
    try:
        r = requests.get(url, params=params, timeout=30)
        if r.status_code == 429:
            # be nice and retry once
            time.sleep(5)
            r = requests.get(url, params=params, timeout=30)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"❌ TheSportsDB error {path} params={params}: {e}")
        return None


def tsdb_league_name_from_id(league_id: str) -> Optional[str]:
    # lookupleague.php?id=XXXX returns leagues[] with strLeague (doc v1) :contentReference[oaicite:2]{index=2}
    payload = tsdb_get_json("lookupleague.php", {"id": league_id})
    if not payload:
        return None
    leagues = payload.get("leagues") or []
    if not leagues:
        return None
    return leagues[0].get("strLeague")


def tsdb_search_all_teams_by_league_name(league_name: str) -> List[Dict[str, Any]]:
    # search_all_teams.php?l=English_Premier_League (doc v1) :contentReference[oaicite:3]{index=3}
    league_param = league_name.replace(" ", "_")
    payload = tsdb_get_json("search_all_teams.php", {"l": league_param})
    if not payload:
        return []
    return payload.get("teams") or []


def tsdb_lookup_all_players(team_id: str) -> List[Dict[str, Any]]:
    # lookup_all_players.php?id=TEAM_ID (doc v1) :contentReference[oaicite:4]{index=4}
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

    print(f"🚀 Scanning (BDB) {entry['sport']} - {entry['league']} ...")

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

            # if an endpoint is not available on your tier, skip it safely
            if resp.status_code in (401, 403):
                print(f"🔒 Skipping {entry['league']} (BDB) — access denied on your tier.")
                return

            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"❌ Error in BDB {entry['league']}: {e}")
            return

        players = data.get("data", []) or []

        # Debug sample (first page only)
        if pages == 0 and players:
            sample = players[0]
            print(f"DEBUG sample keys ({entry['league']}): {sorted(list(sample.keys()))[:20]}")

        for p in players:
            # MLB active-only filter (free-safe, because field is inside /players record)
            if active_field:
                if p.get(active_field) is not True:
                    continue

            if is_venezuelan_bdb(p, birthplace_field):
                name = normalize_name_bdb(p)
                key = f"{entry['league']}::{name}"
                if key in seen:
                    continue

                all_venezuelans.append({
                    "name": name,
                    "sport": entry["sport"],
                    "league": entry["league"],
                    "team": normalize_team_bdb(p),
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

    league_name = tsdb_league_name_from_id(league_id)
    if not league_name:
        print(f"⚠️ Could not resolve league name for id={league_id}. Skipping.")
        return

    time.sleep(TSDB_SLEEP_SEC)

    teams = tsdb_search_all_teams_by_league_name(league_name)
    if not teams:
        print(f"⚠️ No teams found for TSDB league '{league_name}'. Skipping.")
        return

    time.sleep(TSDB_SLEEP_SEC)

    for t in teams:
        team_id = t.get("idTeam")
        team_name = t.get("strTeam") or "Unknown"
        if not team_id:
            continue

        players = tsdb_lookup_all_players(team_id)
        time.sleep(TSDB_SLEEP_SEC)

        # Some sports/teams may have incomplete player feeds; just continue
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
        # stable-ish key
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
