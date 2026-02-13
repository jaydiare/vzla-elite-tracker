import os
import requests
import json
import time

# --- 1. CONFIGURATION ---
try:
    with open('config.json', 'r') as f:
        config = json.load(f)
except FileNotFoundError:
    config = {"target_country": "Venezuela", "sports": {"baseball": True, "basketball": True, "soccer": True}}

COUNTRY = config.get('target_country', 'Venezuela')

# --- 2. SECURITY: LOAD KEYS ---
# NBA: Get from https://app.balldontlie.io/ (Free tier: 5 req/min)
NBA_API_KEY = os.getenv("NBA_API_KEY")
# SOCCER: '3' is the free public test key
SPORTSDB_KEY = os.getenv("SPORTSDB_KEY", "3") 

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

def fetch_basketball():
    if not NBA_API_KEY:
        print("⚠️ Skipping NBA: No API Key found.")
        return []
    
    print(f"🏀 Fetching NBA for {COUNTRY} (Manual Filter)...")
    url = "https://api.balldontlie.io/v1/players"
    headers = {"Authorization": NBA_API_KEY}
    
    # NBA API has no country filter, so we pull 100 players per page
    # To avoid 429 errors (rate limits), we only check the first 2 pages in this demo
    athletes = []
    try:
        for page in range(1, 3): 
            params = {"per_page": 100, "cursor": page}
            response = requests.get(url, headers=headers, params=params).json()
            data = response.get('data', [])
            
            for p in data:
                # Some players have country in metadata; otherwise check known names
                if p.get('country') == COUNTRY:
                    athletes.append({
                        "name": f"{p['first_name']} {p['last_name']}",
                        "sport": "Basketball", "league": "NBA",
                        "team": p.get('team', {}).get('full_name', 'Active'),
                        "img": "https://www.nba.com/assets/logos/teams/primary/web/NBA.svg"
                    })
            time.sleep(1) # Safety delay for free tier
        return athletes
    except Exception as e:
        print(f"NBA Error: {e}"); return []

def fetch_soccer():
    print(f"⚽ Fetching Soccer (MLS & La Liga) for {COUNTRY}...")
    # Using the Nationality Search endpoint
    url = f"https://www.thesportsdb.com/api/v1/json/{SPORTSDB_KEY}/searchplayers.php?t={COUNTRY}"
    
    league_map = {
        "American Major League Soccer": "MLS",
        "Spanish La Liga": "La Liga",
        "UEFA Champions League": "Champions League"
    }
    
    try:
        data = requests.get(url).json().get('player', [])
        if not data:
            print("⚽ Soccer: No players found by nationality."); return []
            
        return [{
            "name": p['strPlayer'], "sport": "Soccer", 
            "league": league_map.get(p.get('strLeague'), p.get('strLeague', 'Pro')),
            "team": p.get('strTeam', 'Active'),
            "img": p.get('strThumb') or "https://www.thesportsdb.com/images/media/player/thumb/placeholder.jpg"
        } for p in data]
    except Exception as e:
        print(f"Soccer Error: {e}"); return []

def main():
    all_athletes = []
    
    if config['sports'].get('baseball'): 
        all_athletes.extend(fetch_mlb())
    if config['sports'].get('soccer'): 
        all_athletes.extend(fetch_soccer())
    if config['sports'].get('basketball'): 
        all_athletes.extend(fetch_basketball())

    os.makedirs('data', exist_ok=True)
    with open('data/athletes.json', 'w', encoding='utf-8') as f:
        json.dump(all_athletes, f, indent=4, ensure_ascii=False)
    
    print(f"✅ Finished! Found {len(all_athletes)} Venezuelan athletes.")

if __name__ == "__main__":
    main()
