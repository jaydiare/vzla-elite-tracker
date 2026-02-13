import os
import requests
import json

# --- 1. LOAD CONFIGURATION ---
try:
    with open('config.json', 'r') as f:
        config = json.load(f)
except FileNotFoundError:
    config = {"target_country": "Venezuela", "sports": {"baseball": True, "basketball": True, "soccer": True}}

COUNTRY = config.get('target_country', 'Venezuela')
NBA_API_KEY = os.getenv("NBA_API_KEY")
SPORTSDB_KEY = os.getenv("SPORTSDB_KEY", "3") # Free public key is '3'

def fetch_mlb():
    print(f"⚾ Fetching MLB for {COUNTRY}...")
    url = "https://statsapi.mlb.com/api/v1/sports/1/players"
    try:
        data = requests.get(url).json().get('people', [])
        return [{
            "name": p['fullName'], "sport": "Baseball", "league": "MLB",
            "team": p.get('currentTeam', {}).get('name', 'Free Agent'),
            "img": f"https://midfield.mlbstatic.com/v1/people/{p['id']}/spots/240"
        } for p in data if p.get('birthCountry') == COUNTRY]
    except Exception as e:
        print(f"MLB Error: {e}"); return []

def fetch_soccer():
    print(f"⚽ Fetching Soccer for {COUNTRY}...")
    # Using TheSportsDB API to find players by nationality
    url = f"https://www.thesportsdb.com/api/v1/json/{SPORTSDB_KEY}/searchplayers.php?t=Venezuela"
    try:
        data = requests.get(url).json().get('player', [])
        return [{
            "name": p['strPlayer'], "sport": "Soccer", "league": p.get('strLeague', 'Pro'),
            "team": p.get('strTeam', 'Active'),
            "img": p.get('strThumb') or "https://www.thesportsdb.com/images/media/player/thumb/placeholder.jpg"
        } for p in data]
    except Exception as e:
        print(f"Soccer Error: {e}"); return []

def main():
    all_athletes = []
    if config['sports'].get('baseball'): all_athletes.extend(fetch_mlb())
    if config['sports'].get('soccer'): all_athletes.extend(fetch_soccer())
    # Add basketball logic here if needed...

    os.makedirs('data', exist_ok=True)
    with open('data/athletes.json', 'w', encoding='utf-8') as f:
        json.dump(all_athletes, f, indent=4, ensure_ascii=False)
    print(f"✅ Finished! Found {len(all_athletes)} athletes.")

if __name__ == "__main__":
    main()
