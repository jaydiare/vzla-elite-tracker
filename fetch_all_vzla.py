import os
import requests
import json
import time

# --- CONFIGURATION ---
API_KEY = os.environ.get("NBA_API_KEY") 
HEADERS = {"Authorization": API_KEY}
COUNTRY_TARGET = "Venezuela"

# Expanded list of endpoints
ENDPOINTS = [
    {"sport": "Basketball", "url": "/v1/players", "field": "country", "league": "NBA"},
    {"sport": "Soccer", "url": "/laliga/v1/players", "field": "citizenship", "league": "La Liga"},
    {"sport": "Soccer", "url": "/mls/v1/players", "field": "citizenship", "league": "MLS"},
    {"sport": "Soccer", "url": "/ucl/v1/players", "field": "citizenship", "league": "UCL"},
    {"sport": "Soccer", "url": "/ligue1/v1/players", "field": "citizenship", "league": "Ligue 1"},
    {"sport": "Soccer", "url": "/bundesliga/v1/players", "field": "citizenship", "league": "Bundesliga"},
    {"sport": "Soccer", "url": "/epl/v1/players", "field": "citizenship", "league": "EPL"},
    {"sport": "Football", "url": "/nfl/v1/players", "field": "country", "league": "NFL"},
    {"sport": "Tennis", "url": "/atp/v1/players", "field": "country", "league": "ATP"},
    {"sport": "Golf", "url": "/pga/v1/players", "field": "country", "league": "PGA"}
]

def fetch_all_venezuelans():
    all_venezuelans = []
    
    for entry in ENDPOINTS:
        cursor = None
        sport_name = entry["sport"]
        league_name = entry["league"]
        base_url = f"https://api.balldontlie.io{entry['url']}?per_page=100"
        field_name = entry["field"]

        print(f"🚀 Scanning {sport_name} - {league_name}...")

        while True:
            url = f"{base_url}&cursor={cursor}" if cursor else base_url

            try:
                response = requests.get(url, headers=HEADERS)
                
                if response.status_code == 429:
                    print("⚠️ Rate limit reached. Sleeping...")
                    time.sleep(60)
                    continue
                    
                data = response.json()
                players = data.get('data', [])
                
                for p in players:
                    # Robust check for nationality
                    if p.get(field_name) == COUNTRY_TARGET:
                        all_venezuelans.append({
                            "name": f"{p['first_name']} {p['last_name']}",
                            "sport": sport_name,
                            "league": league_name,
                            "team": p.get('team', {}).get('full_name', 'Active')
                        })

                cursor = data.get('meta', {}).get('next_cursor')
                if not cursor: break

                time.sleep(13) # Free tier safety

            except Exception as e:
                print(f"❌ Error in {league_name}: {e}")
                break

    return all_venezuelans

# Run and Save
if __name__ == "__main__":
    if not os.path.exists('data'): os.makedirs('data')
    
    vzla_list = fetch_all_venezuelans()
    
    # Save with progress log
    with open('data/athletes.json', 'w', encoding='utf-8') as f:
        json.dump(vzla_list, f, indent=4)
        
    print(f"🏁 Finished! Total Venezuelan Athletes found: {len(vzla_list)}")
