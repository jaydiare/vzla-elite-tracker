import os
import requests
import json

# --- 1. LOAD CONFIGURATION ---
try:
    with open('config.json', 'r') as f:
        config = json.load(f)
except FileNotFoundError:
    config = {"target_country": "Venezuela", "sports": {"baseball": True, "soccer": True}}

COUNTRY = config.get('target_country', 'Venezuela')
SPORTSDB_KEY = os.getenv("SPORTSDB_KEY", "3") # Free public key is '3'

def fetch_mlb():
    print(f"⚾ Fetching MLB for {COUNTRY}...")
    url = "https://statsapi.mlb.com/api/v1/sports/1/players"
    try:
        data = requests.get(url).json().get('people', [])
        return [{
            "name": p['fullName'], 
            "sport": "Baseball", 
            "league": "MLB",
            "team": p.get('currentTeam', {}).get('name', 'Free Agent'),
            # Using midfield URL to bypass hotlink protection
            "img": f"https://midfield.mlbstatic.com/v1/people/{p['id']}/spots/240"
        } for p in data if p.get('birthCountry') == COUNTRY]
    except Exception as e:
        print(f"MLB Error: {e}")
        return []

def fetch_soccer():
    print(f"⚽ Fetching Soccer (MLS, La Liga, etc.) for {COUNTRY}...")
    # Pulls all Venezuelan players reachable via the nationality endpoint
    url = f"https://www.thesportsdb.com/api/v1/json/{SPORTSDB_KEY}/searchplayers.php?t={COUNTRY}"
    
    # Mapping raw API league names to your preferred labels
    league_map = {
        "American Major League Soccer": "MLS",
        "Spanish La Liga": "La Liga",
        "UEFA Champions League": "Champions League"
    }
    
    try:
        response = requests.get(url).json()
        players = response.get('player', []) or []
        
        soccer_athletes = []
        for p in players:
            raw_league = p.get('strLeague', 'Other')
            # Check if the league is one of your targets, otherwise use the API's name
            display_league = league_map.get(raw_league, raw_league)
            
            soccer_athletes.append({
                "name": p['strPlayer'],
                "sport": "Soccer",
                "league": display_league,
                "team": p.get('strTeam', 'Active'),
                "img": p.get('strThumb') or "https://www.thesportsdb.com/images/media/player/thumb/placeholder.jpg"
            })
        return soccer_athletes
    except Exception as e:
        print(f"Soccer Error: {e}")
        return []

def main():
    all_athletes = []
    
    if config['sports'].get('baseball'):
        all_athletes.extend(fetch_mlb())
    
    if config['sports'].get('soccer'):
        all_athletes.extend(fetch_soccer())

    # Ensure the data directory exists
    os.makedirs('data', exist_ok=True)
    
    with open('data/athletes.json', 'w', encoding='utf-8') as f:
        json.dump(all_athletes, f, indent=4, ensure_ascii=False)
    
    print(f"✅ Finished! Successfully synced {len(all_athletes)} athletes to data/athletes.json.")

if __name__ == "__main__":
    main()
