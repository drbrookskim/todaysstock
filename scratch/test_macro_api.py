import requests
import json

def test_macro_api():
    url = "https://todaysstock.onrender.com/api/macro"
    try:
        print(f"Fetching from {url}...")
        resp = requests.get(url, timeout=10)
        print(f"Status: {resp.status_code}")
        if resp.status_code == 200:
            data = resp.json()
            print("Keys in response:", data.keys())
            # print(json.dumps(data, indent=2))
        else:
            print("Error response:", resp.text)
    except Exception as e:
        print(f"Request failed: {e}")

if __name__ == "__main__":
    test_macro_api()
