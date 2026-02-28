import inspect
from supabase import create_client
client = create_client("http://foo", "bar")
print(inspect.signature(client.auth.exchange_code_for_session))
