import requests
import json
import time

# --- CONFIGURATION ---
API_KEY = "NBA_API_KEY" # Replace with your actual key
HEADERS = {"Authorization": API_KEY}
COUNTRY_TARGET = "Venezuela"
# Max per_page is 100 to reduce total number of calls
BASE_URL = "https://api.balldontlie.io/v1/players?per_page=100"

def fetch_all_venezuelans():
    all_venezuelans = []
    cursor = None
    page_count = 0

    print("🚀 Starting full database scan...")

    while True:
        # Build URL with cursor if it exists
        url = BASE_URL
        if cursor:
            url += f"&cursor={cursor}"

        try:
            response = requests.get(url, headers=HEADERS)
            
            # Handle rate limiting
            if response.status_code == 429:
                print("⚠️ Rate limit reached. Sleeping for 60 seconds...")
                time.sleep(60)
                continue
                
            data = response.json()
            players = data.get('data', [])
            
            # Filter locally for Venezuela
            for p in players:
                if p.get('country') == COUNTRY_TARGET:
                    all_venezuelans.append({
                        "name": f"{p['first_name']} {p['last_name']}",
                        "sport": "Basketball",
                        "league": "NBA",
                        "team": p.get('team', {}).get('full_name', 'Active'),
                    })

            # Check for next page
            cursor = data.get('meta', {}).get('next_cursor')
            page_count += 1
            print(f"✅ Processed page {page_count}. Found {len(all_venezuelans)} so far...")

            if not cursor:
                print("🏁 Finished! No more pages found.")
                break

            # Free Tier safety: 5 req/min means 1 request every 12 seconds
            time.sleep(13)

        except Exception as e:
            print(f"❌ Error: {e}")
            break

    return all_venezuelans

# Run and Save
vzla_list = fetch_all_venezuelans()
with open('data/athletes.json', 'w', encoding='utf-8') as f:
    json.dump(vzla_list, f, indent=4)
