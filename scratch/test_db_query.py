import os
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    print("Error: Env vars missing")
    exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

print("--- Testing profiles table ---")
try:
    # 1. Check if we can fetch profiles
    res = supabase.table("profiles").select("*").limit(1).execute()
    print(f"Fetch success: {len(res.data)} rows")
    if res.data:
        print(f"Columns: {res.data[0].keys()}")
    
    # 2. Test the ordering
    print("\n--- Testing order by created_at ---")
    res_ordered = supabase.table("profiles").select("*").order("created_at", desc=True).limit(5).execute()
    print(f"Order success: {len(res_ordered.data)} rows")

except Exception as e:
    print(f"Error occurred: {e}")
