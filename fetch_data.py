import os
import requests
import json
import time

# --- CONFIGURATION ---
NBA_API_KEY = os.getenv("NBA_API_KEY") # Ensure this is your balldontlie key
COUNTRY = "Venezuela"

def fetch_balldontlie(endpoint, country_field, target_country):
    """Generic fetcher for balldontlie endpoints with rate limiting"""
    if not NBA_API_KEY:
        print(f"⚠️ Skipping {endpoint}: No API Key.")
        return []

    print(f"🔍 Fetching {endpoint}...")
    headers = {"Authorization": NBA_API_KEY}
    athletes = []
    cursor = None
    
    # We only pull 1-2 pages per sport to stay under the 30-daily-request limit
    for _ in range(2): 
        url = f"https://api.balldontlie.io{endpoint}?per_page=100"
        if cursor:
            url += f"&cursor={cursor}"
            
        try:
            response = requests.get(url, headers=headers).json()
            data = response.get('data', [])
            
            for p in data:
                # Soccer uses 'citizenship', Basketball uses 'country'
                if p.get(country_field) == target_country:
                    name = f"{p['first_name']} {p['last_name']}"
                    athletes.append({
                        "name": name,
                        "sport": "Soccer" if "v1" in endpoint else "Basketball",
                        "league": endpoint.split('/')[1].upper(),
                        "team": p.get('team', {}).get('full_name', 'Active'),
                        "img": "" # Placeholder for design
                    })
            
            cursor = response.get('meta', {}).get('next_cursor')
            if not cursor:
                break
                
            # Wait 15 seconds to stay within 5 requests per minute
            time.sleep(15) 
            
        except Exception as e:
            print(f"Error: {e}")
            break
            
    return athletes

def main():
    all_data = []
    
    # 1. Fetch Basketball (NBA)
    all_data.extend(fetch_balldontlie("/v1/players/active", "country", COUNTRY))
    
    # 2. Fetch Soccer (La Liga)
    all_data.extend(fetch_balldontlie("/laliga/v1/players", "citizenship", COUNTRY))
    
    # 3. Fetch Soccer (MLS)
    all_data.extend(fetch_balldontlie("/mls/v1/players", "citizenship", COUNTRY))

    # Save output
    os.makedirs('data', exist_ok=True)
    with open('data/athletes.json', 'w', encoding='utf-8') as f:
        json.dump(all_data, f, indent=4)
    print(f"✅ Found {len(all_data)} athletes.")

if __name__ == "__main__":
    main()
