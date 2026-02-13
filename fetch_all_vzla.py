import os
import requests
import json
import time

# --- CONFIGURATION ---
# Access the secret key securely from GitHub Actions
API_KEY = os.environ.get("NBA_API_KEY") 

if not API_KEY:
    print("❌ Error: NBA_API_KEY not found in environment. Check GitHub Secrets.")
    exit(1)

HEADERS = {"Authorization": API_KEY}
COUNTRY_TARGET = "Venezuela"

# Official Endpoints for 2026
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
    {"sport": "Golf", "url": "/pga/v1/players", "field": "country", "league": "PGA"},
    {"sport": "Baseball", "url": "/mlb/v1/players", "field": "country", "league": "MLB"},
    {"sport": "MMA", "url": "/ufc/v1/fighters", "field": "country", "league": "UFC"}
]

def fetch_all_venezuelans():
    all_venezuelans = []
    
    for entry in ENDPOINTS:
        cursor = None
        base_url = f"https://api.balldontlie.io{entry['url']}?per_page=100"

        print(f"🚀 Scanning {entry['sport']} - {entry['league']}...")

        while True:
            url = f"{base_url}&cursor={cursor}" if cursor else base_url

            try:
                response = requests.get(url, headers=HEADERS)
                
                # Handling Rate Limits for Free Tier (5 req/min)
                if response.status_code == 429:
                    print("⚠️ Rate limit reached. Sleeping 60 seconds...")
                    time.sleep(60)
                    continue
                    
                data = response.json()
                players = data.get('data', [])
                
                for p in players:
                    # Match nationality based on specific endpoint field
                    if p.get(entry['field']) == COUNTRY_TARGET:
                        all_venezuelans.append({
                            "name": f"{p['first_name']} {p['last_name']}",
                            "sport": entry['sport'],
                            "league": entry['league'],
                            "team": p.get('team', {}).get('full_name', 'Active')
                        })

                # Pagination: Get next cursor ID
                cursor = data.get('meta', {}).get('next_cursor')
                if not cursor: break

                # Wait 13s between requests to stay under 5 req/min
                time.sleep(13)

            except Exception as e:
                print(f"❌ Error in {entry['league']}: {e}")
                break

    # --- DEDUPLICATION & SORTING ---
    # 1. Remove duplicates (e.g., player in both MLS and UCL)
    seen = set()
    unique_list = []
    for athlete in all_venezuelans:
        if athlete['name'] not in seen:
            unique_list.append(athlete)
            seen.add(athlete['name'])
    
    # 2. Sort alphabetically by name
    unique_list.sort(key=lambda x: x['name'])
    
    return unique_list

if __name__ == "__main__":
    # Ensure data folder exists
    if not os.path.exists('data'):
        os.makedirs('data')

    vzla_list = fetch_all_venezuelans()
    
    # Save to local database file
    with open('data/athletes.json', 'w', encoding='utf-8') as f:
        json.dump(vzla_list, f, indent=4)
        
    print(f"🏁 Finished! Found {len(vzla_list)} unique athletes.")
