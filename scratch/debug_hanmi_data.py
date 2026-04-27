import yfinance as yf
import json

def test_hanmi():
    code = "042700.KS"
    ticker = yf.Ticker(code)
    
    print(f"--- {code} Fast Info ---")
    finfo = ticker.fast_info
    print(f"Last Price: {getattr(finfo, 'last_price', None)}")
    print(f"Shares: {getattr(finfo, 'shares', None)}")
    
    print(f"\n--- {code} Info ---")
    info = ticker.info
    print(f"Current Price: {info.get('currentPrice')}")
    print(f"Shares Outstanding: {info.get('sharesOutstanding')}")
    print(f"ROE: {info.get('returnOnEquity')}")
    print(f"BPS (bookValue): {info.get('bookValue')}")

if __name__ == "__main__":
    test_hanmi()
