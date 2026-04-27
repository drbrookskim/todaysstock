import sys
import os
import json
import yfinance as yf

# Add parent dir to path to import local modules
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fundamental_analysis import analyze_fundamental, fetch_financials, compute_quant
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env'))

DART_API_KEY = os.environ.get("DART_API_KEY")
ECOS_KEY = os.environ.get("ECOS_API_KEY")

def debug():
    code = "042700"
    corp_code = "00143896" # Hanmi Semiconductor corp code from DART
    
    print(f"Testing for {code} / {corp_code}")
    
    print("\n--- 1. DART Financials ---")
    fin = fetch_financials(corp_code, DART_API_KEY)
    print(json.dumps(fin, indent=2, ensure_ascii=False))
    
    print("\n--- 2. Quant Calculation ---")
    qnt = compute_quant(fin)
    print(json.dumps(qnt, indent=2, ensure_ascii=False))
    
    print("\n--- 3. YF Data ---")
    ticker_obj = yf.Ticker(code + ".KS")
    current_price = getattr(ticker_obj.fast_info, 'last_price', None)
    shares = getattr(ticker_obj.fast_info, 'shares', None)
    print(f"Price: {current_price}, Shares: {shares}")
    
    if current_price is None:
        y_info = ticker_obj.info
        current_price = y_info.get('currentPrice')
        shares = y_info.get('sharesOutstanding')
        print(f"Fallback Price: {current_price}, Fallback Shares: {shares}")
    
    print("\n--- 4. Final Analysis Result ---")
    res = analyze_fundamental(
        stock_code=code,
        corp_name="한미반도체",
        corp_code=corp_code,
        dart_key=DART_API_KEY,
        ecos_key=ECOS_KEY,
        current_price=current_price,
        shares=shares,
        induty_code="C261" # Assuming equipment/IDM roughly
    )
    
    print(json.dumps(res.get("target"), indent=2, ensure_ascii=False))

if __name__ == "__main__":
    debug()
