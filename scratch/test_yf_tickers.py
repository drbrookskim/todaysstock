import yfinance as yf
import pandas as pd

def test_tickers():
    tickers = {
        "dxy_futures": "DX=F",
        "dxy_index": "DX-Y.NYB",
        "dxy_uup": "UUP"
    }
    
    symbols = list(tickers.values())
    print(f"Downloading symbols: {symbols}")
    raw = yf.download(symbols, period="5d", interval="1d", group_by='ticker', progress=False)
    
    print("\nColumns found in 'raw':")
    if isinstance(raw.columns, pd.MultiIndex):
        print(raw.columns.levels[0].tolist())
    else:
        print(raw.columns.tolist())

    for key, sym in tickers.items():
        try:
            if isinstance(raw.columns, pd.MultiIndex):
                if sym not in raw.columns.levels[0]:
                    print(f"❌ {key} ({sym}) NOT found in levels[0]")
                    continue
                df = raw[sym].dropna(subset=['Close'])
            else:
                if sym not in raw.columns:
                    print(f"❌ {key} ({sym}) NOT found in columns")
                    continue
                df = raw[sym] # This might be different if not MultiIndex
            
            if df.empty:
                print(f"❌ {key} ({sym}) found but dataframe is EMPTY")
            else:
                price = df['Close'].iloc[-1]
                print(f"✅ {key} ({sym}): {price}")
        except Exception as e:
            print(f"💥 Error processing {key} ({sym}): {e}")

if __name__ == "__main__":
    test_tickers()
