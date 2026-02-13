def fetch_mlb():
    print(f"⚾ Fetching MLB for {COUNTRY}...")
    url = "https://statsapi.mlb.com/api/v1/sports/1/players"
    try:
        data = requests.get(url).json().get('people', [])
        return [{
            "name": p['fullName'], "sport": "Baseball", "league": "MLB",
            "team": p.get('currentTeam', {}).get('name', 'Free Agent'),
            # UPDATED: Using the 'midfield' URL which is more reliable for external use
            "img": f"https://midfield.mlbstatic.com/v1/people/{p['id']}/spots/240"
        } for p in data if p.get('birthCountry') == COUNTRY]
    except Exception as e:
        print(f"MLB Error: {e}")
        return []

def fetch_basketball():
    if not NBA_API_KEY:
        print("⚠️ Skipping Basketball: NBA_API_KEY not found in Secrets.")
        return []
    
    print(f"🏀 Fetching NBA for {COUNTRY}...")
    url = "https://api.balldontlie.io/v1/players"
    headers = {"Authorization": NBA_API_KEY}
    
    try:
        response = requests.get(url, headers=headers).json()
        players = response.get('data', [])
        return [{
            "name": f"{p['first_name']} {p['last_name']}",
            "sport": "Basketball", "league": "NBA",
            "team": p.get('team', {}).get('full_name', 'Active'),
            # Fallback image since the basic API doesn't provide headshots
            "img": "https://www.nba.com/assets/logos/teams/primary/web/NBA.svg" 
        } for p in players if p.get('country') == COUNTRY]
    except Exception as e:
        print(f"NBA Error: {e}")
        return []
