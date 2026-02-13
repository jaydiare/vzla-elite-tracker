import os
import requests
import json
import time

# Configuration
API_KEY = "YOUR_API_KEY"  # Replace with your actual key
HEADERS = {"Authorization": API_KEY}
COUNTRY = "Venezuela"

# Comprehensive list of endpoints from your dashboard
ENDPOINTS = [
    {"league": "NBA", "url": "/v1/players/active", "field": "country", "sport": "Basketball"},
    {"league": "LA LIGA", "url": "/laliga/v1/players", "field": "citizenship", "sport": "Soccer"},
    {"league": "MLS", "url": "/mls/v1/players", "field": "citizenship", "sport": "Soccer"},
    {"league": "UCL", "url": "/ucl/v1/players", "field": "citizenship", "sport": "Soccer"} # Champions League
]

def fetch_athletes():
    all_athletes = []
    
    for ep in ENDPOINTS:
        # Max per_page=100 stretches your 30-daily-call limit
        url = f"https://api.balldontlie.io{ep['url']}?per_page=100"
        print(f"📡 Scanning {ep['league']}...")
        
        try:
            response = requests.get(url, headers=HEADERS).json()
            players = response.get('data', [])
            
            for p in players:
                # Soccer uses 'citizenship', Basketball uses 'country'
                if p.get(ep['field']) == COUNTRY:
                    all_athletes.append({
                        "name": f"{p['first_name']} {p['last_name']}",
                        "sport": ep['sport'],
                        "league": ep['league'],
                        "team": p.get('team', {}).get('full_name', 'Active'),
                        "img": "" 
                    })
            
            # Rate Limit Protection: Wait 15s (Max 4 requests/min)
            time.sleep(15) 
            
        except Exception as e:
            print(f"Error fetching {ep['league']}: {e}")
            
    return all_athletes

if __name__ == "__main__":
    data = fetch_athletes()
    os.makedirs('data', exist_ok=True)
    with open('data/athletes.json', 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4)
    print(f"✅ Created athletes.json with {len(data)} entries.")
