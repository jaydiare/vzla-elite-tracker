import os
import requests
import json
import time

# --- CONFIGURATION ---
API_KEY = os.environ.get("NBA_API_KEY") 

if not API_KEY:
    print("❌ Error: NBA_API_KEY not found in environment. Check GitHub Secrets.")
    exit(1)

HEADERS = {"Authorization": API_KEY}
COUNTRY_TARGET = "Venezuela"
FILE_PATH = 'data/athletes.json'

# Endpoints actualizados
ENDPOINTS: List[Dict[str, Any]] = [
    # Core majors (Free-safe)
    {"sport": "Basketball", "league": "NBA",  "path": "/nba/v1/players"},
    {"sport": "Football",   "league": "NFL",  "path": "/nfl/v1/players"},
    {"sport": "Baseball",   "league": "MLB",  "path": "/mlb/v1/players"},  # includes birth_place + active flag in records :contentReference[oaicite:6]{index=6}
    {"sport": "Hockey",     "league": "NHL",  "path": "/nhl/v1/players"},

    # College (if enabled for your key)
    {"sport": "Basketball", "league": "NCAAB","path": "/ncaab/v1/players"},
    {"sport": "Basketball", "league": "NCAAW","path": "/ncaaw/v1/players"},
    {"sport": "Football",   "league": "NCAAF","path": "/ncaaf/v1/players"},

    # Soccer (if enabled for your key)
    {"sport": "Soccer", "league": "EPL",        "path": "/epl/v2/players"},
    {"sport": "Soccer", "league": "La Liga",    "path": "/laliga/v1/players"},
    {"sport": "Soccer", "league": "MLS",        "path": "/mls/v1/players"},
    {"sport": "Soccer", "league": "UCL",        "path": "/ucl/v1/players"},
    {"sport": "Soccer", "league": "Ligue 1",    "path": "/ligue1/v1/players"},
    {"sport": "Soccer", "league": "Bundesliga", "path": "/bundesliga/v1/players"},
    {"sport": "Soccer", "league": "Serie A",    "path": "/seriea/v1/players"},

    # Optional (only if your key has access)
    {"sport": "Basketball", "league": "WNBA", "path": "/wnba/v1/players"},
    {"sport": "MMA", "league": "MMA", "path": "/mma/v1/fighters"},
    {"sport": "Motorsport", "league": "F1", "path": "/f1/v1/drivers"},
    {"sport": "Tennis", "league": "ATP", "path": "/atp/v1/players"},
    {"sport": "Tennis", "league": "WTA", "path": "/wta/v1/players"},
    {"sport": "Golf", "league": "PGA Tour", "path": "/pga/v1/players"},
]


def load_existing_athletes():
    """Carga los atletas actuales para no perder datos si la API falla."""
    if os.path.exists(FILE_PATH):
        with open(FILE_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

def fetch_all_venezuelans():
    # Iniciamos con los que ya tenemos para ir construyendo la lista poco a poco
    all_venezuelans = load_existing_athletes()
    seen = {a['name'] for a in all_venezuelans}
    
    for entry in ENDPOINTS:
        cursor = None
        base_url = f"https://api.balldontlie.io{entry['url']}?per_page=100"

        print(f"🚀 Scanning {entry['sport']} - {entry['league']}...")

        # Limitamos a un par de páginas por ejecución para no quemar la API free
        for _ in range(2): 
            url = f"{base_url}&cursor={cursor}" if cursor else base_url

            try:
                response = requests.get(url, headers=HEADERS)
                
                if response.status_code == 429:
                    print("⚠️ Rate limit reached. Sleeping 60s...")
                    time.sleep(60)
                    continue
                    
                data = response.json()
                players = data.get('data', [])
                
                # Debug: Imprimir el primer jugador de cada página para ver el formato de país
                if players:
                    sample = players[0]
                    print(f"DEBUG: Sample Player: {sample.get('first_name')} - Country Field ({entry['field']}): '{sample.get(entry['field'])}'")

                for p in players:
                    val = p.get(entry['field'])
                    # Aceptamos 'Venezuela' o 'VEN' por si la API cambia el formato
                    if val in [COUNTRY_TARGET, "VEN"]:
                        name = f"{p['first_name']} {p['last_name']}"
                        if name not in seen:
                            all_venezuelans.append({
                                "name": name,
                                "sport": entry['sport'],
                                "league": entry['league'],
                                "team": p.get('team', {}).get('full_name', 'Active')
                            })
                            seen.add(name)

                cursor = data.get('meta', {}).get('next_cursor')
                if not cursor: break
                time.sleep(13)

            except Exception as e:
                print(f"❌ Error in {entry['league']}: {e}")
                break

    # Ordenar alfabéticamente antes de devolver
    all_venezuelans.sort(key=lambda x: x['name'])
    return all_venezuelans

if __name__ == "__main__":
    os.makedirs('data', exist_ok=True)
    vzla_list = fetch_all_venezuelans()
    
    with open(FILE_PATH, 'w', encoding='utf-8') as f:
        json.dump(vzla_list, f, indent=4)
        
    print(f"🏁 Finished! Total unique athletes in database: {len(vzla_list)}")
