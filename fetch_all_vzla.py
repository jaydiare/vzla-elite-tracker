import requests
import json
import time
import os

# --- CONFIGURATION ---
API_KEY = "NBA_API_KEY" # Replace with your actual key
HEADERS = {"Authorization": API_KEY}
COUNTRY_TARGET = "Venezuela"

# List of endpoints to scan for each sport
ENDPOINTS = [
    {"sport": "Basketball", "url": "/v1/players", "field": "country"},
    {"sport": "Soccer", "url": "/laliga/v1/players", "field": "citizenship"},
    {"sport": "Soccer", "url": "/mls/v1/players", "field": "citizenship"},
    # Note: Balldontlie added MLB/Baseball recently - check dashboard for specific URL
]

def fetch_all_venezuelans():
    all_venezuelans = []
    
    for entry in ENDPOINTS:
        cursor = None
        page_count = 0
        sport_name = entry["sport"]
        base_url = f"https://api.balldontlie.io{entry['url']}?per_page=100"
        field_name = entry["field"] # Soccer uses 'citizenship'

        print(f"🚀 Starting scan for {sport_name}...")

        while True:
            url = base_url
            if cursor:
                url += f"&cursor={cursor}"

            try:
                response = requests.get(url, headers=HEADERS)
                
                if response.status_code == 429:
                    print("⚠️ Rate limit reached. Sleeping for 60 seconds...")
                    time.sleep(60)
                    continue
                    
                data = response.json()
                players = data.get('data', [])
                
                for p in players:
                    # Fix: Use the correct field (country or citizenship)
                    if p.get(field_name) == COUNTRY_TARGET:
                        all_venezuelans.append({
                            "name": f"{p['first_name']} {p['last_name']}",
                            "sport": sport_name,
                            "league": p.get('team', {}).get('conference', sport_name), # Simple fallback
                            "team": p.get('team', {}).get('full_name', 'Active'),
                        })

                cursor = data.get('meta', {}).get('next_cursor')
                page_count += 1
                print(f"✅ {sport_name}: Page {page_count} processed. Total found: {len(all_venezuelans)}")

                if not cursor:
                    break

                # Safety delay for Free Tier
                time.sleep(13)

            except Exception as e:
                print(f"❌ Error in {sport_name}: {e}")
                break

    return all_venezuelans

# Ensure directory exists
os.makedirs('data', exist_ok=True)

# Run and Save
vzla_list = fetch_all_venezuelans()
with open('data/athletes.json', 'w', encoding='utf-8') as f:
    json.dump(vzla_list, f, indent=4)
