"""
한국 주식 종목 검색 서버
- 코스피/코스닥 종목 검색
- 현재가 및 이동평균선(5, 10, 20, 60일) 표시
- 캔들 패턴 분석 및 AI 매매 리포트
"""

from flask import Flask, render_template, jsonify, request
import yfinance as yf
import pandas as pd
import requests as http_requests
from datetime import datetime, timedelta
from candle_patterns import analyze_candle_patterns

app = Flask(__name__)

# ─────────────────────────────────────────────
# 전체 종목 리스트 (KRX에서 동적 로드)
# ─────────────────────────────────────────────
STOCK_LIST = []

# 내장 종목 리스트 (KRX 로드 실패 시 폴백용)
FALLBACK_STOCK_LIST = [
    {"name": "삼성전자", "code": "005930", "market": "KOSPI"},
    {"name": "SK하이닉스", "code": "000660", "market": "KOSPI"},
    {"name": "LG에너지솔루션", "code": "373220", "market": "KOSPI"},
    {"name": "삼성바이오로직스", "code": "207940", "market": "KOSPI"},
    {"name": "현대차", "code": "005380", "market": "KOSPI"},
    {"name": "기아", "code": "000270", "market": "KOSPI"},
    {"name": "셀트리온", "code": "068270", "market": "KOSPI"},
    {"name": "NAVER", "code": "035420", "market": "KOSPI"},
    {"name": "카카오", "code": "035720", "market": "KOSPI"},
    {"name": "에코프로", "code": "086520", "market": "KOSDAQ"},
    {"name": "알테오젠", "code": "196170", "market": "KOSDAQ"},
    {"name": "HLB", "code": "028300", "market": "KOSDAQ"},
    {"name": "에코프로비엠", "code": "247540", "market": "KOSPI"},
    {"name": "삼천당제약", "code": "000250", "market": "KOSDAQ"},
]


def load_all_stocks():
    """네이버 증권 API에서 KOSPI + KOSDAQ 전체 종목을 로드합니다."""
    global STOCK_LIST
    try:
        headers = {"User-Agent": "Mozilla/5.0"}
        stocks = []
        seen_codes = set()

        for market in ["KOSPI", "KOSDAQ"]:
            page = 1
            while True:
                url = f"https://m.stock.naver.com/api/stocks/marketValue/{market}?page={page}&pageSize=100"
                resp = http_requests.get(url, headers=headers, timeout=10)
                resp.raise_for_status()
                data = resp.json()
                items = data.get("stocks", [])
                if not items:
                    break
                for item in items:
                    code = item.get("itemCode", "")
                    name = item.get("stockName", "")
                    if code and name and code not in seen_codes:
                        stocks.append({"name": name, "code": code, "market": market})
                        seen_codes.add(code)
                page += 1

        if stocks:
            STOCK_LIST = stocks
            kospi_count = sum(1 for s in stocks if s["market"] == "KOSPI")
            kosdaq_count = sum(1 for s in stocks if s["market"] == "KOSDAQ")
            print(f"📊 전체 종목 로드 완료: KOSPI {kospi_count}개 + KOSDAQ {kosdaq_count}개 = 총 {len(STOCK_LIST)}개")
        else:
            STOCK_LIST = FALLBACK_STOCK_LIST
            print(f"⚠️  종목 조회 결과 없음 → 폴백 종목 {len(FALLBACK_STOCK_LIST)}개 사용")

    except Exception as e:
        print(f"⚠️  종목 로드 실패: {e}")
        STOCK_LIST = FALLBACK_STOCK_LIST
        print(f"📊 폴백 종목 {len(FALLBACK_STOCK_LIST)}개 사용")


def search_stocks(query):
    """종목명 또는 종목코드로 검색합니다."""
    query = query.strip()
    if not query:
        return []

    results = []
    query_upper = query.upper()

    # 1차: 종목코드 정확 일치
    for item in STOCK_LIST:
        if item["code"] == query:
            results.append(item)
            break

    # 2차: 이름이 query로 시작 (우선순위 높음)
    for item in STOCK_LIST:
        if item not in results and item["name"].upper().startswith(query_upper):
            results.append(item)
            if len(results) >= 20:
                return results

    # 3차: 이름 또는 코드에 포함
    for item in STOCK_LIST:
        if item not in results and (query_upper in item["name"].upper() or query in item["code"]):
            results.append(item)
            if len(results) >= 20:
                break


    return results


def download_stock_df(code, market):
    """yfinance를 통해 주가 DataFrame을 다운로드합니다."""
    suffix = ".KS" if market == "KOSPI" else ".KQ"
    ticker = code + suffix
    end_date = datetime.now()
    start_date = end_date - timedelta(days=150)

    try:
        df = yf.download(ticker, start=start_date, end=end_date, progress=False)
        if df.empty:
            return None
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        return df
    except Exception as e:
        print(f"데이터 조회 오류 ({ticker}): {e}")
        return None


def get_stock_data(code, market):
    """이동평균선을 포함한 주가 요약 데이터를 반환합니다."""
    df = download_stock_df(code, market)
    if df is None:
        return None

    df["MA5"] = df["Close"].rolling(window=5).mean()
    df["MA10"] = df["Close"].rolling(window=10).mean()
    df["MA20"] = df["Close"].rolling(window=20).mean()
    df["MA60"] = df["Close"].rolling(window=60).mean()

    latest = df.iloc[-1]
    prev = df.iloc[-2] if len(df) > 1 else df.iloc[-1]

    close_price = float(latest["Close"])
    prev_close = float(prev["Close"])
    change = close_price - prev_close
    change_pct = (change / prev_close) * 100 if prev_close != 0 else 0

    return {
        "price": int(close_price),
        "change": int(change),
        "change_pct": round(change_pct, 2),
        "high": int(float(latest["High"])),
        "low": int(float(latest["Low"])),
        "open": int(float(latest["Open"])),
        "volume": int(float(latest["Volume"])),
        "ma5": int(float(latest["MA5"])) if pd.notna(latest["MA5"]) else None,
        "ma10": int(float(latest["MA10"])) if pd.notna(latest["MA10"]) else None,
        "ma20": int(float(latest["MA20"])) if pd.notna(latest["MA20"]) else None,
        "ma60": int(float(latest["MA60"])) if pd.notna(latest["MA60"]) else None,
        "date": df.index[-1].strftime("%Y-%m-%d"),
    }


def get_nxt_price(code):
    """네이버 증권 API에서 NXT 시간외 거래 정보를 조회합니다."""
    try:
        url = f"https://polling.finance.naver.com/api/realtime/domestic/stock/{code}"
        headers = {"User-Agent": "Mozilla/5.0"}
        resp = http_requests.get(url, headers=headers, timeout=5)
        resp.raise_for_status()
        data = resp.json()

        if not data.get("datas"):
            return None

        item = data["datas"][0]
        over = item.get("overMarketPriceInfo")
        market_status = item.get("marketStatus", "")

        # 정규장 실시간 가격 (네이버 기준)
        naver_info = {
            "naver_price": int(item.get("closePriceRaw", 0)),
            "market_status": market_status,
        }

        if not over:
            return {**naver_info, "nxt_available": False}

        # NXT 가격 파싱 (콤마 제거)
        def parse_num(s):
            if s is None:
                return 0
            return int(str(s).replace(",", ""))

        over_status = over.get("overMarketStatus", "CLOSE")
        over_price = parse_num(over.get("overPrice"))
        over_change = parse_num(over.get("compareToPreviousClosePrice"))
        over_ratio = over.get("fluctuationsRatio", "0")
        over_direction = over.get("compareToPreviousPrice", {}).get("name", "")
        over_volume = parse_num(over.get("accumulatedTradingVolume"))
        over_high = parse_num(over.get("highPrice"))
        over_low = parse_num(over.get("lowPrice"))
        over_time = over.get("localTradedAt", "")

        # 방향에 따라 변동값 부호 조정
        if over_direction == "FALLING":
            over_change = -abs(over_change)
            over_ratio = "-" + str(over_ratio).lstrip("-")

        return {
            **naver_info,
            "nxt_available": True,
            "nxt_status": over_status,  # OPEN / CLOSE
            "nxt_price": over_price,
            "nxt_change": over_change,
            "nxt_change_pct": float(str(over_ratio).replace(",", "")),
            "nxt_volume": over_volume,
            "nxt_high": over_high,
            "nxt_low": over_low,
            "nxt_time": over_time,
            "nxt_direction": over_direction,
        }
    except Exception as e:
        print(f"NXT 조회 오류 ({code}): {e}")
        return None


# ─────────────────────────────────────────────
# 라우트
# ─────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/suggest")
def suggest():
    """자동완성 종목 검색 API"""
    query = request.args.get("q", "")
    results = search_stocks(query)
    return jsonify(results)


@app.route("/api/stock")
def stock_detail():
    """종목 상세 정보 API"""
    code = request.args.get("code", "").strip()
    market = request.args.get("market", "KOSPI").strip()
    name = request.args.get("name", "").strip()

    if not code:
        return jsonify({"error": "종목코드가 필요합니다."}), 400

    data = get_stock_data(code, market)
    if data is None:
        return jsonify({"error": "주가 데이터를 가져올 수 없습니다."}), 404

    data["name"] = name
    data["code"] = code
    data["market"] = market

    # NXT 시간외 거래 가격 추가
    nxt = get_nxt_price(code)
    if nxt:
        data["nxt"] = nxt
    else:
        data["nxt"] = {"nxt_available": False}

    return jsonify(data)


@app.route("/api/analysis")
def stock_analysis():
    """캔들 패턴 분석 + AI 매매 리포트 API"""
    code = request.args.get("code", "").strip()
    market = request.args.get("market", "KOSPI").strip()
    name = request.args.get("name", "").strip()

    if not code:
        return jsonify({"error": "종목코드가 필요합니다."}), 400

    df = download_stock_df(code, market)
    if df is None:
        return jsonify({"error": "주가 데이터를 가져올 수 없습니다."}), 404

    analysis = analyze_candle_patterns(df)
    analysis["name"] = name
    analysis["code"] = code
    analysis["market"] = market
    return jsonify(analysis)


# --- Gunicorn 등 프로덕션 환경에서도 시작 시 종목을 로드하도록 모듈 레벨에서 호출 ---
load_all_stocks()
print(f"🕯️  캔들 패턴 분석 엔진 활성화")

if __name__ == "__main__":
    app.run(debug=True, port=5000)
