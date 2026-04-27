import sys
import os
import json
import yfinance as yf

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fundamental_analysis import analyze_fundamental, fetch_financials, compute_quant
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env'))
DART_API_KEY = os.environ.get("DART_API_KEY")
ECOS_KEY = os.environ.get("ECOS_API_KEY")

def debug():
    code = "042700"
    corp_code = "00161383"
    
    print("\n--- 1. DART Financials ---")
    fin = fetch_financials(corp_code, DART_API_KEY)
    
    print("\n--- 2. Quant Calculation ---")
    qnt = compute_quant(fin)
    print(json.dumps(qnt, indent=2, ensure_ascii=False))
    
    print("\n--- 3. YF Data ---")
    ticker_obj = yf.Ticker(code + ".KS")
    current_price = getattr(ticker_obj.fast_info, 'last_price', None)
    shares = getattr(ticker_obj.fast_info, 'shares', None)
    
    y_info = ticker_obj.info
    if current_price is None: current_price = y_info.get('currentPrice')
    if shares is None: shares = y_info.get('sharesOutstanding')
    
    roe_fb = y_info.get('returnOnEquity')
    if roe_fb is not None: roe_fb *= 100.0
    net_inc_fb = y_info.get('netIncomeToCommon')
    bps_fb = y_info.get('bookValue')
    equity_fb = (bps_fb * shares) if (bps_fb and shares) else None
    
    print(f"Price: {current_price}, Shares: {shares}")
    print(f"Fallbacks -> ROE: {roe_fb}, NetInc: {net_inc_fb}, BPS: {bps_fb}, Equity: {equity_fb}")
    
    print("\n--- Final Analysis Result ---")
    res = analyze_fundamental(
        stock_code=code,
        corp_name="한미반도체",
        corp_code=corp_code,
        dart_key=DART_API_KEY,
        ecos_key=ECOS_KEY,
        current_price=current_price,
        shares=shares,
        roe_fallback=roe_fb,
        net_inc_fallback=net_inc_fb,
        equity_fallback=equity_fb,
        induty_code="C261"
    )
    
    print(json.dumps(res.get("target"), indent=2, ensure_ascii=False))

if __name__ == "__main__":
    debug()
