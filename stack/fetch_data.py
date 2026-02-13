import os, requests, json

# Load Settings
with open('config.json', 'r') as f:
    CONFIG = json.load(f)

COUNTRY = CONFIG['target_country']
SPORTSDB_KEY = os.getenv("SPORTSDB_KEY", "1") # Default free key

def fetch_mlb():
    url = "https://statsapi.mlb.com/api/v1/sports/1/players"
    players = requests.get(url).json().get('people', [])
    return [{
        "name": p['fullName'], "sport": "Baseball", "league": "MLB",
        "team": p.get('currentTeam', {}).get('name', 'N/A'),
        "img": f"https://img.mlbstatic.com/mlb-photos/alphabetic/at18/600x600/{p['id']}.jpg"
    } for p in players if p.get('birthCountry') == COUNTRY]

def fetch_basketball():
    # Example logic for NBA/LatAm using TheSportsDB
    # IDs: 4387=NBA, 4513=Argentina, 4511=Brazil
    leagues = ["4387", "4513", "4511"]
    results = []
    for l_id in leagues:
        url = f"https://www.thesportsdb.com/api/v1/json/{SPORTSDB_KEY}/search_all_teams.php?l={l_id}"
        teams = requests.get(url).json().get('teams', []) or []
        for t in teams:
            # Note: For efficiency, in production you'd cache these lookups
            p_url = f"https://www.thesportsdb.com/api/v1/json/{SPORTSDB_KEY}/lookup_all_players.php?id={t['idTeam']}"
            roster = requests.get(p_url).json().get('player', []) or []
            for p in roster:
                if p.get('strNationality') == COUNTRY:
                    results.append({
                        "name": p['strPlayer'], "sport": "Basketball", 
                        "league": t['strLeague'], "team": t['strTeam'], "img": p.get('strThumb')
                    })
    return results

def main():
    all_data = []
    if CONFIG['sports']['baseball']: all_data.extend(fetch_mlb())
    if CONFIG['sports']['basketball']: all_data.extend(fetch_basketball())
    
    os.makedirs('data', exist_ok=True)
    with open('data/athletes.json', 'w') as f:
        json.dump(all_data, f, indent=4)
    print(f"✅ Successfully tracked {len(all_data)} athletes for {COUNTRY}")

if __name__ == "__main__":
    main()