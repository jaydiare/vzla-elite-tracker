import os
import requests
import json

# --- 1. LOAD CONFIGURATION ---
try:
    with open('config.json', 'r') as f:
        config = json.load(f)
except FileNotFoundError:
    # Default config if file is missing
    config = {"target_country": "Venezuela", "sports": {"baseball": True, "basketball": True}}

COUNTRY = config.get('target_country', 'Venezuela')

# --- 2. SECURITY: LOAD KEYS FROM GITHUB SECRETS ---
# This ensures your key is never public
NBA_API_KEY = os.getenv("NBA_API_KEY") 
SPORTSDB_KEY = os.getenv("SPORTSDB_KEY", "1") 

def fetch_mlb():
    print(f"⚾ Fetching MLB for {COUNTRY}...")
    url = "https://statsapi.mlb.com/api/v1/sports/1/players"
    try:
        data = requests.get(url).json().get('people', [])
        return [{
            "name": p['fullName'], "sport": "Baseball", "league": "MLB",
            "team": p.get('currentTeam', {}).get('name', 'Free Agent'),
            "img": f"https://img.mlbstatic.com/mlb-photos/alphabetic/at18/600x600/{p['id']}.jpg"
        } for p in data if p.get('birthCountry') == COUNTRY]
    except Exception as e:
        print(f"MLB Error: {e}")
        return []

def fetch_basketball():
    if not NBA_API_KEY:
        print("⚠️ Skipping Basketball: NBA_API_KEY not found in Secrets.")
        return []
    
    print(f"🏀 Fetching NBA for {COUNTRY}...")
    # Balldontlie v1 endpoint
    url = "https://api.balldontlie.io/v1/players"
    headers = {"Authorization": NBA_API_KEY}
    
    try:
        response = requests.get(url, headers=headers).json()
        players = response.get('data', [])
        # Note: balldontlie uses 'country' field. Ensure match with config
        return [{
            "name": f"{p['first_name']} {p['last_name']}",
            "sport": "Basketball", "league": "NBA",
            "team": p.get('team', {}).get('full_name', 'Active'),
            "img": None # Placeholder for free tier
        } for p in players if p.get('country') == COUNTRY]
    except Exception as e:
        print(f"NBA Error: {e}")
        return []

def main():
    all_athletes = []
    
    # Run fetchers based on config
    if config['sports'].get('baseball'):
        all_athletes.extend(fetch_mlb())
    if config['sports'].get('basketball'):
        all_athletes.extend(fetch_basketball())

    # Ensure data folder exists
    os.makedirs('data', exist_ok=True)
    
    # Save unified data
    with open('data/athletes.json', 'w', encoding='utf-8') as f:
        json.dump(all_athletes, f, indent=4, ensure_ascii=False)
    
    print(f"✅ Finished! Found {len(all_athletes)} athletes.")

if __name__ == "__main__":
    main()