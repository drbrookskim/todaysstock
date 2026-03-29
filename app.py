"""
한국 주식 종목 검색 서버
- 코스피/코스닥 종목 검색
- 현재가 및 이동평균선(5, 10, 20, 60일) 표시
- 캔들 패턴 분석 및 AI 매매 리포트
"""

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from supabase import create_client, Client
import os
import json
import html
import time
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv
import yfinance as yf
import pandas as pd
import requests as http_requests
from datetime import datetime, timedelta
from bs4 import BeautifulSoup
from candle_patterns import analyze_candle_patterns
from fundamental_analysis import analyze_fundamental

# ── 인메모리 TTL 캐시 (5분) ──────────────────────────────────────
# {cache_key: (timestamp, result)}
_STOCK_CACHE: dict = {}
_CACHE_TTL = 300  # 5분 (초)

def _cache_get(key: str):
    entry = _STOCK_CACHE.get(key)
    if entry and (time.time() - entry[0]) < _CACHE_TTL:
        return entry[1]
    return None

def _cache_set(key: str, value):
    _STOCK_CACHE[key] = (time.time(), value)



app = Flask(__name__, static_folder=None)
CORS(app)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", os.urandom(24).hex())

load_dotenv()
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")  # anon key (공개 키)
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")  # service role key (서버 전용)

# Auth 전용 클라이언트 (anon key — auth.get_user() 검증용)
supabase_global: Client = create_client(SUPABASE_URL, SUPABASE_KEY) if SUPABASE_URL and SUPABASE_KEY else None

# DB 전용 서비스 롤 클라이언트 (RLS를 우회하고, 코드에서 user_id로 보안 필터링)
# service role key가 없으면 supabase_global로 폴백 (RLS 오류 위험 있음)
db_client: Client = (
    create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    if SUPABASE_URL and SUPABASE_SERVICE_KEY
    else supabase_global
)

@app.errorhandler(Exception)
def handle_exception(e):
    # API 요청 중 발생한 모든 예외를 잡아서 JSON 형태로 반환합니다.
    print(f"🌍 Server Error: {e}")
    import traceback
    traceback.print_exc()
    return jsonify({
        "error": "서버 내부 오류가 발생했습니다.",
        "details": str(e),
        "status": 500
    }), 500

def get_user_id_from_token(token: str):
    """주어진 JWT 토큰으로 user_id를 검증하고 반환. 실패 시 None 반환."""
    if not token or not supabase_global:
        return None
    try:
        user_res = supabase_global.auth.get_user(token)
        if user_res and user_res.user:
            return user_res.user.id
    except Exception as e:
        print(f"Token validation error: {e}")
    return None

# ─────────────────────────────────────────────
# ─────────────────────────────────────────────

# ─────────────────────────────────────────────
# 전체 종목 리스트 (KRX에서 동적 로드)
# ─────────────────────────────────────────────
STOCK_LIST = []

# DART 기업별 고유번호 매핑 캐시
DART_API_KEY = os.environ.get("DART_API_KEY", "")
ECOS_KEY     = os.environ.get("ECOS_KEY", "")
DART_CORP_CODES = {}

def load_dart_corp_codes():
    """DART API에서 종목코드-고유번호 매핑을 가져와 메모리에 캐싱합니다."""
    global DART_CORP_CODES
    if not DART_API_KEY:
        print("💡 DART_API_KEY가 설정되지 않아 DART 연동이 비활성화됩니다.")
        return
    try:
        url = f"https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key={DART_API_KEY}"
        import zipfile
        import io
        import xml.etree.ElementTree as ET
        
        resp = http_requests.get(url, timeout=10)
        if resp.status_code == 200:
            with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
                with z.open('CORPCODE.xml') as f:
                    tree = ET.parse(f)
                    root = tree.getroot()
                    
            for item in root.findall('list'):
                stock_node = item.find('stock_code')
                corp_node  = item.find('corp_code')
                if stock_node is not None and stock_node.text:
                    s_code = stock_node.text.strip()
                    if s_code and corp_node is not None and corp_node.text:
                        DART_CORP_CODES[s_code] = corp_node.text.strip()
                    
        print(f"🏢 DART 기업코드 {len(DART_CORP_CODES)}개 로드 완료")
    except Exception as e:
        print(f"🏢 DART 기업코드 로드 실패: {e}")
        print(f"⚠️ DART 기업코드 로드 실패: {e}")

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
    """공공데이터포털(data.go.kr) 주식 시세 API + yfinance 이중 소스로 DataFrame을 생성합니다."""
    import urllib.parse
    import pandas as pd

    api_key = os.getenv("DATA_GO_KR_API_KEY")
    df = None

    # ── 1차: 공공데이터포털 API ──
    if api_key:
        try:
            encoded_key = urllib.parse.unquote(api_key)
            url = "http://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo"
            params = {
                "serviceKey": encoded_key,
                "numOfRows": "300",
                "pageNo": "1",
                "resultType": "json",
                "likeSrtnCd": code
            }
            resp = http_requests.get(url, params=params, timeout=3)
            resp.raise_for_status()
            data = resp.json()

            items = data.get("response", {}).get("body", {}).get("items", {}).get("item", [])
            if items:
                records = []
                for row in reversed(items):
                    try:
                        dt = datetime.strptime(row["basDt"], "%Y%m%d")
                        records.append({
                            "Date": dt,
                            "Open": float(row["mkp"]),
                            "High": float(row["hipr"]),
                            "Low": float(row["lopr"]),
                            "Close": float(row["clpr"]),
                            "Volume": float(row["trqu"])
                        })
                    except Exception:
                        continue

                if records:
                    df = pd.DataFrame(records)
                    df.set_index("Date", inplace=True)
                    print(f"✅ 공공데이터 API ({code}): {len(df)}일 데이터")
            
            if df is None:
                print(f"⚠️ 공공데이터 API 결과 없음 ({code}), yfinance 로 대체합니다.")
        except Exception as e:
            print(f"⚠️ 공공데이터 API 오류 ({code}): {e}, yfinance 로 대체합니다.")

    # ── 2차 폴백: yfinance ──
    if df is None:
        try:
            suffix = ".KS" if market == "KOSPI" else ".KQ"
            ticker = code + suffix
            end_date = datetime.now()
            start_date = end_date - timedelta(days=450)
            df = yf.download(ticker, start=start_date, end=end_date, progress=False)
            if df.empty:
                print(f"❌ yfinance 결과 없음 ({ticker})")
                df = None
            else:
                if isinstance(df.columns, pd.MultiIndex):
                    df.columns = df.columns.get_level_values(0)
                print(f"✅ yfinance ({ticker}): {len(df)}일 데이터")
        except Exception as e:
            print(f"❌ yfinance 오류 ({code}): {e}")
            df = None

    # ── [LATEST PRICE UPDATE (GLOBAL TARGET)] ──
    # 데이터 소스에 관계없이 반환 전 fast_info로 오늘자 최신 틱 데이터를 덮어쓰거나 추가하여 실시간 동기화율을 극대화합니다.
    if df is not None and not df.empty:
        try:
            suffix_sync = ".KS" if market == "KOSPI" else ".KQ"
            ticker_obj = yf.Ticker(code + suffix_sync)
            fast = ticker_obj.fast_info
            
            if hasattr(fast, 'last_price') and fast.last_price is not None:
                today_dt = pd.to_datetime(datetime.now().date())
                last_dt = pd.to_datetime(df.index[-1].date())
                
                # 당일 행이 이미 존재하면 업데이트, 없으면 신규 행 추가
                if today_dt == last_dt:
                    df.at[df.index[-1], "Close"] = float(fast.last_price)
                    if hasattr(fast, 'open') and fast.open is not None:
                        df.at[df.index[-1], "Open"] = float(fast.open)
                    if hasattr(fast, 'day_high') and fast.day_high is not None:
                        df.at[df.index[-1], "High"] = float(fast.day_high)
                    if hasattr(fast, 'day_low') and fast.day_low is not None:
                        df.at[df.index[-1], "Low"] = float(fast.day_low)
                    if hasattr(fast, 'last_volume') and fast.last_volume is not None:
                        df.at[df.index[-1], "Volume"] = float(fast.last_volume)
                else:
                    new_row = pd.DataFrame({
                        "Open": [float(fast.open) if hasattr(fast, 'open') and fast.open is not None else float(fast.last_price)],
                        "High": [float(fast.day_high) if hasattr(fast, 'day_high') and fast.day_high is not None else float(fast.last_price)],
                        "Low": [float(fast.day_low) if hasattr(fast, 'day_low') and fast.day_low is not None else float(fast.last_price)],
                        "Close": [float(fast.last_price)],
                        "Volume": [float(fast.last_volume) if hasattr(fast, 'last_volume') and fast.last_volume is not None else 0.0]
                    }, index=[today_dt])
                    df = pd.concat([df, new_row])
                print(f"📡 DF Real-time Sync ({code}): {fast.last_price}")
        except Exception as e:
            print(f"⚠️ DF Real-time Sync Error ({code}): {e}")

    return df



def get_stock_data(code, market):
    """이동평균선을 포함한 주가 요약 데이터를 반환합니다. TTL 캐시 + 병렬 API 호출."""
    # -- 캐시 우선 확인 --
    cache_key = f"stock:{code}:{market}"
    cached = _cache_get(cache_key)
    if cached:
        print(f"캐시 히트 ({code})")
        return cached

    suffix = ".KS" if market == "KOSPI" else ".KQ"
    ticker = code + suffix

    # -- 병렬 외부 API 호출을 위한 내부 함수들 --
    def fetch_dart():
        if not (DART_API_KEY and code in DART_CORP_CODES):
            return {}
        try:
            corp_code = DART_CORP_CODES[code]
            url = (f"https://opendart.fss.or.kr/api/company.json"
                   f"?crtfc_key={DART_API_KEY}&corp_code={corp_code}")
            d = http_requests.get(url, timeout=5).json()
            if d.get("status") == "000":
                res = {}
                raw = d.get("est_dt", "")
                if raw and len(raw) == 8:
                    res["est_dt"] = f"{raw[:4]}년 {raw[4:6]}월 {raw[6:]}일"
                res["ceo"]   = d.get("ceo_nm", "")
                res["adres"] = d.get("adres", "")
                u = d.get("hm_url", "")
                if u and not u.startswith("http"):
                    u = "http://" + u
                res["hm_url"] = u
                return res
        except Exception as e:
            print(f"DART API 오류: {e}")
        return {}

    def fetch_naver_info():
        try:
            nav_url = f"https://finance.naver.com/item/main.naver?code={code}"
            resp = http_requests.get(
                nav_url, headers={"User-Agent": "Mozilla/5.0"}, timeout=3)
            if resp.status_code == 200:
                html_txt = resp.text
                ind = None
                m_ind = re.search(r'h_sub sub_tit7.*?<a[^>]*>(.*?)</a>', html_txt, re.DOTALL)
                if m_ind:
                    parsed = re.sub(r'<[^>]+>', '', m_ind.group(1)).strip()
                    if parsed and len(parsed) < 30: ind = parsed
                dsc = None
                m_dsc = re.search(r'summary_info.*?<p>(.*?)</p>', html_txt, re.DOTALL)
                if m_dsc:
                    txt = re.sub(r'<[^>]+>', '', m_dsc.group(1)).strip()
                    if txt and 10 < len(txt) < 1000: dsc = txt
                return {"industry": ind, "desc": dsc}
        except Exception as e:
            print(f"Naver 기업정보 파싱 오류 ({code}): {e}")
        return {}

    def fetch_yf_info_lazy():
        try:
            print(f"⚠️ 네이버 대신 yfinance 폴백 실행 ({code})")
            from deep_translator import GoogleTranslator
            tr = GoogleTranslator(source='en', target='ko')
            info = yf.Ticker(ticker).info
            en_sum = info.get("longBusinessSummary")
            en_ind = info.get("industry")
            return {
                "desc":     tr.translate(en_sum[:2000]) if en_sum else None,
                "industry": tr.translate(en_ind)        if en_ind else None,
            }
        except Exception as e:
            print(f"yfinance/번역 오류 ({ticker}): {e}")
        return {}

    def fetch_df():
        return download_stock_df(code, market)

    # -- 실행 테이블 구성 --
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_dart  = ex.submit(fetch_dart)
        f_naver = ex.submit(fetch_naver_info)
        f_df    = ex.submit(fetch_df)
        
        try: dart_r = f_dart.result(timeout=4)
        except Exception: dart_r = {}
        try: naver_r = f_naver.result(timeout=4)
        except Exception: naver_r = {}
        try: df = f_df.result(timeout=10) # DF는 약간 더 기다림
        except Exception: df = None

    if df is None or df.empty:
        return None

    df["MA5"]  = df["Close"].rolling(window=5).mean()
    df["MA10"] = df["Close"].rolling(window=10).mean()
    df["MA20"] = df["Close"].rolling(window=20).mean()
    df["MA60"] = df["Close"].rolling(window=60).mean()

    # --- 실시간 가격 및 변동률 계산 ---
    latest = df.iloc[-1]
    prev   = df.iloc[-2] if len(df) > 1 else df.iloc[-1]

    close_price = float(latest["Close"])
    prev_close  = float(prev["Close"])
    change      = close_price - prev_close
    change_pct  = (change / prev_close) * 100 if prev_close != 0 else 0

    est_dt = dart_r.get("est_dt", "")
    ceo    = dart_r.get("ceo", "")
    adres  = dart_r.get("adres", "")
    hm_url = dart_r.get("hm_url", "")

    industry = naver_r.get("industry")
    translated_desc = naver_r.get("desc")

    if not translated_desc:
        yf_r = fetch_yf_info_lazy()
        industry = industry or yf_r.get("industry")
        translated_desc = yf_r.get("desc")



    # 이오테크닉스 예외 하드코딩
    if code == "039030":
        industry = "반도체 장비 및 재료"
        translated_desc = (
            "(주)이오테크닉스는 레이저 가공 장비를 전세계적으로 제조, 공급하고 있습니다."
        )

    dart_li = []
    sv = 'class="summary-value"'
    if est_dt: dart_li.append(f'<li><strong>설립일:</strong><span {sv}>{html.escape(est_dt)}</span></li>')
    if ceo:    dart_li.append(f'<li><strong>대표이사:</strong><span {sv}>{html.escape(ceo)}</span></li>')
    if adres:  dart_li.append(f'<li><strong>본사:</strong><span {sv}>{html.escape(adres)}</span></li>')
    if hm_url:
        dh = html.escape(hm_url)
        dt_text = html.escape(hm_url.replace('http://','').replace('https://','')).rstrip('/')
        dart_li.append(f'<li><strong>웹사이트:</strong><span {sv}><a href="{dh}" target="_blank">{dt_text}</a></span></li>')

    overview_html = ""
    if dart_li:
        rows = "".join(dart_li)
        overview_html = (
            '<div class="summary-section">'
            '<h4 class="summary-heading">1. 기업 개요</h4>'
            f'<ul class="summary-list">{rows}</ul>'
            '</div>'
        )

    # None 가드: html.escape()는 None을 허용하지 않으므로 반드시 str로 변환해야 합니다.
    ei = html.escape(industry or "업종 정보 없음")
    ed = html.escape(translated_desc or "기업 설명을 불러올 수 없습니다.")
    company_summary = (
        '<div class="summary-formatted">'
        f'<div class="summary-subtitle"><strong>"글로벌 경쟁력 기반의 {ei} 선도 기업"</strong></div>'
        f'{overview_html}'
        '<div class="summary-section">'
        '<h4 class="summary-heading">2. 핵심 사업 영역 (주요 활동)</h4>'
        f'<p class="summary-desc">{ed}</p>'
        '</div></div>'
    )

    result = {
        "code":       code,
        "market":     market,
        "price":      int(close_price) if pd.notna(close_price) else None,
        "change":     int(change) if pd.notna(change) else None,
        "change_pct": round(change_pct, 2) if pd.notna(change_pct) else None,
        "high":   int(float(latest["High"])) if pd.notna(latest["High"]) else None,
        "low":    int(float(latest["Low"])) if pd.notna(latest["Low"]) else None,
        "open":   int(float(latest["Open"])) if pd.notna(latest["Open"]) else None,
        "volume": int(float(latest["Volume"])) if pd.notna(latest["Volume"]) else None,
        "ma5":  int(float(latest["MA5"]))  if pd.notna(latest["MA5"])  else None,
        "ma10": int(float(latest["MA10"])) if pd.notna(latest["MA10"]) else None,
        "ma20": int(float(latest["MA20"])) if pd.notna(latest["MA20"]) else None,
        "ma60": int(float(latest["MA60"])) if pd.notna(latest["MA60"]) else None,
        "date":            df.index[-1].strftime("%Y-%m-%d"),
        "company_summary": company_summary,
        "industry":        industry,
    }

    _cache_set(cache_key, result)
    return result


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
# 인증 및 관심종목 DB 라우트
# ─────────────────────────────────────────────

@app.route("/api/config", methods=["GET"])
def public_config():
    """프론트엔드가 Supabase JS SDK를 직접 초기화할 수 있도록 공개 설정을 반환합니다.
    SUPABASE_KEY 는 anon (공개) 키입니다 — RLS로 보호되므로 노출이 안전합니다."""
    return jsonify({
        "supabase_url":      SUPABASE_URL,
        "supabase_anon_key": SUPABASE_KEY,
    })

@app.route("/api/register", methods=["POST"])
def register():
    """Supabase를 이용한 회원가입 (이메일 폼으로 우회)"""
    if not supabase_global:
        return jsonify({"success": False, "message": "Supabase 환경 설정이 안되어 있습니다."}), 500
        
    data = request.json
    username = data.get("username")
    password = data.get("password")
    
    if not username or not password:
        return jsonify({"success": False, "message": "아이디와 비밀번호를 입력해주세요."}), 400
        
    try:
        # Supabase Auth expects email format. 
        email = username if "@" in username else f"{username}@stockfinder.local"
        res = supabase_global.auth.sign_up({"email": email, "password": password})
        return jsonify({"success": True, "message": "회원가입 성공. 이제 로그인할 수 있습니다."})
    except Exception as e:
        print(f"Auth error (sign_up): {e}")
        return jsonify({"success": False, "message": "회원가입 중 오류가 발생했습니다."}), 400

@app.route("/api/login", methods=["POST"])
def login():
    """Supabase를 이용한 로그인"""
    if not supabase_global:
        return jsonify({"success": False, "message": "Supabase 환경 설정이 안되어 있습니다."}), 500
        
    data = request.json
    username = data.get("username")
    password = data.get("password")
    
    print(f"🔑 Login attempt for: {username}")
    
    try:
        email = username if "@" in username else f"{username}@stockfinder.local"
        res = supabase_global.auth.sign_in_with_password({"email": email, "password": password})
        
        if not res.session:
            print(f"❌ Login failed for {username}: No session returned")
            return jsonify({"success": False, "message": "로그인 세션을 생성할 수 없습니다."}), 401
            
        print(f"✅ Login success for: {username}")
        # token과 user 정보를 반환하여 클라이언트에서 JWT를 보관하도록 함
        return jsonify({
            "success": True, 
            "message": f"{username}님 환영합니다!", 
            "username": username,
            "access_token": res.session.access_token
        })
    except Exception as e:
        print(f"❌ Login error for {username}: {str(e)}")
        return jsonify({"success": False, "message": "아이디 또는 비밀번호가 올바르지 않습니다."}), 401


@app.route("/api/auth/google", methods=["GET"])
def auth_google():
    """Supabase OAuth (Google) 로그인 URL 반환 (Implicit Flow 강제 적용)"""
    if not supabase_global:
        return jsonify({"success": False, "message": "Supabase 환경 설정이 안되어 있습니다."}), 500
        
    try:
        # 프론트엔드에서 명시적으로 전달한 콜백 주소 우선 사용
        client_redirect = request.args.get("redirect_to")
        if client_redirect:
            redirect_url = client_redirect
        else:
            # 분리된 프론트엔드 URL을 동적으로 감지하거나 환경 변수로 처리
            origin = request.headers.get("Origin")
            if origin:
                redirect_url = f"{origin}/callback.html"
            else:
                frontend_url = os.environ.get("FRONTEND_URL", request.url_root.rstrip('/'))
                redirect_url = f"{frontend_url}/callback.html"
        
        # supabase-py 의 sign_in_with_oauth()는 기본적으로 PKCE flow를 강제하므로
        # code_challenge를 URL에 붙이고, 콜백에서 ?code= 를 반환하게 됩니다.
        # Python 백엔드는 stateful하지 않아 code_verifier를 유지하기 어려우므로,
        # 수동으로 URL을 구성하여 PKCE를 우회하고 Implicit Flow(#access_token=)를 유도합니다.
        import urllib.parse
        supabase_url = os.environ.get("SUPABASE_URL")
        encoded_redirect = urllib.parse.quote(redirect_url)
        oauth_url = f"{supabase_url}/auth/v1/authorize?provider=google&redirect_to={encoded_redirect}"
        
        return jsonify({"success": True, "url": oauth_url})
    except Exception as e:
        print(f"Auth error (google): {e}")
        return jsonify({"success": False, "message": "Google 로그인 설정 중 오류가 발생했습니다."}), 400

@app.route("/api/logout", methods=["POST"])
def logout():
    # 클라이언트에서 토큰을 폐기하므로 백엔드에서는 별도 검증 없이 성공 반환
    return jsonify({"success": True, "message": "로그아웃 되었습니다."})

@app.route("/api/me", methods=["GET"])
def me():
    """클라이언트가 전달한 토큰을 기반으로 사용자 정보 확인"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if token and supabase_global:
        try:
            res = supabase_global.auth.get_user(token)
            
            # Extract name from Google OAuth metadata if not strictly local
            metadata = res.user.user_metadata or {}
            full_name = metadata.get("full_name") or metadata.get("name")
            
            email = res.user.email
            if full_name:
                username = full_name
            else:
                username = email.split('@')[0] if email and email.endswith('@stockfinder.local') else email.split('@')[0] if email else "사용자"
                
            return jsonify({"logged_in": True, "username": username})
        except:
            pass
    return jsonify({"logged_in": False})

@app.route("/api/session", methods=["GET"])
def session():
    """/api/me + /api/watchlist(GET) 를 한 번의 요청으로 처리 — 로그인 속도 최적화"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token or not supabase_global:
        return jsonify({"logged_in": False, "watchlist": []})
    try:
        user_res = supabase_global.auth.get_user(token)
        metadata  = user_res.user.user_metadata or {}
        full_name = metadata.get("full_name") or metadata.get("name")
        email     = user_res.user.email or ""
        username  = full_name or (email.split('@')[0] if email else "사용자")

        # Watchlist: 서비스 롤 클라이언트를 사용하고 user_id로 명시적 필터링
        try:
            user_id = user_res.user.id
            wl_res = db_client.table("watchlist").select("stock_code,stock_name,market").eq("user_id", user_id).execute()
            watchlist = [
                {"code": item["stock_code"], "name": item["stock_name"], "market": item["market"]}
                for item in wl_res.data
            ]
        except Exception as wl_err:
            print(f"session watchlist error: {wl_err}")
            watchlist = []

        return jsonify({"logged_in": True, "username": username, "watchlist": watchlist})
    except Exception as e:
        print(f"session auth error: {e}")
        return jsonify({"logged_in": False, "watchlist": []})


@app.route("/api/watchlist", methods=["GET", "POST", "DELETE"])
def manage_watchlist():
    """서비스 롤 Supabase 클라이언트를 사용하고 user_id로 명시적 필터링하여 RLS 역할 수행"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    user_id = get_user_id_from_token(token)

    if not user_id:
        return jsonify({"success": False, "message": "사용자 인증에 실패했습니다. 다시 로그인해주세요."}), 401

    if not supabase_global:
        return jsonify({"success": False, "message": "서버 설정 오류 (DB 연결 없음)"}), 500

    try:
        if request.method == "GET":
            res = db_client.table("watchlist").select("stock_code,stock_name,market").eq("user_id", user_id).execute()
            mapped = [{"code": item["stock_code"], "name": item["stock_name"], "market": item["market"]} for item in res.data]
            return jsonify(mapped)

        elif request.method == "POST":
            data = request.json
            stock_code = data.get("code")
            if not stock_code:
                return jsonify({"success": False, "message": "종목 코드가 필요합니다."}), 400

            # 중복 방지: 이미 있는지 확인
            existing = db_client.table("watchlist").select("stock_code").eq("user_id", user_id).eq("stock_code", stock_code).execute()
            if existing.data:
                return jsonify({"success": True, "message": "이미 관심종목에 있습니다."})

            item = {
                "user_id": user_id,
                "stock_code": stock_code,
                "stock_name": data.get("name"),
                "market": data.get("market", "KOSPI")
            }
            db_client.table("watchlist").insert(item).execute()
            return jsonify({"success": True})

        elif request.method == "DELETE":
            data = request.json
            code = data.get("code")
            if not code:
                return jsonify({"success": False, "message": "종목 코드가 필요합니다."}), 400
            db_client.table("watchlist").delete().eq("user_id", user_id).eq("stock_code", code).execute()
            return jsonify({"success": True})

    except Exception as e:
        print(f"Watchlist error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "message": f"관심목록 처리 오류: {str(e)}"}), 500

# ─────────────────────────────────────────────
# 라우트
# ─────────────────────────────────────────────

@app.route("/api/market-index/history")
def market_index_history():
    """시장 지수 최근 1개월 히스토리 API"""
    symbol_name = request.args.get("symbol", "KOSPI").upper()
    
    # 심볼 매핑
    mapping = {
        "KOSPI": "^KS11",
        "KOSDAQ": "^KQ11",
        "S&P 500": "^GSPC",
        "NASDAQ": "^IXIC",
        "PHLX SEMI": "^SOX",
        "DXY": "DX=F",
        "WTI": "CL=F"
    }
    
    ticker_symbol = mapping.get(symbol_name)
    if not ticker_symbol:
        return jsonify({"error": f"지원하지 않는 심볼입니다: {symbol_name}"}), 400

    try:
        # 최근 1년 데이터 (yfinance)
        ticker = yf.Ticker(ticker_symbol)
        df = ticker.history(period="1y")
        
        if df.empty:
            return jsonify({"error": "데이터를 불러올 수 없습니다."}), 404
            
        # NaN 값이 포함된 행 제거 (JSON 직렬화 오류 방지)
        df = df.dropna(subset=['Close', 'Open', 'High', 'Low'])
        
        if df.empty:
            return jsonify({"error": "유효한 데이터가 없습니다."}), 404

        history = []
        import math
        for i in range(len(df)):
            row = df.iloc[i]
            
            # 모든 값이 유효한지 최종 확인
            vals = {
                "time": df.index[i].strftime("%Y-%m-%d"),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"])
            }
            
            # NaN 발생 시 건너뜀 (이미 dropna 했지만 안전장치)
            if any(math.isnan(v) for v in [vals["open"], vals["high"], vals["low"], vals["close"]]):
                continue

            history.append({
                "time": vals["time"],
                "value": round(vals["close"], 2),
                "open": round(vals["open"], 2),
                "high": round(vals["high"], 2),
                "low": round(vals["low"], 2),
                "close": round(vals["close"], 2)
            })
            
        return jsonify({
            "status": "success",
            "symbol": symbol_name,
            "ticker": ticker_symbol,
            "history": history
        })
    except Exception as e:
        print(f"Index History Error ({symbol_name}): {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/macro")
def api_macro():
    """거시경제 지표 API (KOSPI, KOSDAQ, S&P500, NASDAQ, 환율 등)"""
    from fundamental_analysis import get_macro
    try:
        data = get_macro(ECOS_KEY)
        if not data:
            return jsonify({"status": "partial", "message": "일부 지표를 불러올 수 없습니다.", "data": {}})
        return jsonify(data)
    except Exception as e:
        print(f"Macro API 오류: {e}")
        import traceback
        traceback.print_exc()
        # 서비스 중단 방지를 위해 빈 데이터라도 반환
        return jsonify({"error": str(e), "data": {}}), 200 # 200으로 반환하여 프론트엔드 크래시 방지


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



@app.route("/api/fundamental/<code>")
def api_fundamental(code: str):
    """4-Pillar 펀더멘탈 분석 API"""
    if not code or len(code) > 10:
        return jsonify({"error": "invalid code"}), 400

    corp_code = DART_CORP_CODES.get(code.strip(), "")
    # 종목명 조회
    corp_name = ""
    for s in STOCK_LIST:
        if s.get("code") == code:
            corp_name = s.get("name", "")
            break
    if not corp_name:
        # 폴백: fallback 리스트
        for s in FALLBACK_STOCK_LIST:
            if s.get("code") == code:
                corp_name = s.get("name", "")
                break

    cache_key = f"fundamental_{code}"
    cached = _cache_get(cache_key)
    if cached:
        return jsonify(cached)

    # 실시간 가격 및 발행주식수 (적정주가 계산용)
    # yfinance를 사용하여 실시간 데이터를 보강합니다.
    current_price = None
    shares = None
    market = "KOSPI"
    for s in STOCK_LIST:
        if s.get("code") == code:
            market = s.get("market", "KOSPI")
            break

    try:
        suffix = ".KS" if market == "KOSPI" else ".KQ"
        ticker_obj = yf.Ticker(code + suffix)
        finfo = ticker_obj.fast_info
        current_price = getattr(finfo, 'last_price', None)
        shares = getattr(finfo, 'shares', None)
        
        # yfinance info를 통한 추가 보강 (Price, Shares, 펀더멘탈 Fallback)
        y_info = ticker_obj.info
        if current_price is None: current_price = y_info.get('currentPrice')
        if shares is None: shares = y_info.get('sharesOutstanding')
        
        roe_fb = y_info.get('returnOnEquity')
        if roe_fb is not None: roe_fb *= 100.0
        net_inc_fb = y_info.get('netIncomeToCommon')
        bps_fb = y_info.get('bookValue')
        equity_fb = (bps_fb * shares) if (bps_fb and shares) else None

    except Exception as e:
        print(f"⚠️ 실시간 및 보강 데이터 조회 실패: {e}")
        roe_fb, net_inc_fb, equity_fb = None, None, None

    result = analyze_fundamental(
        stock_code=code,
        corp_name=corp_name,
        corp_code=corp_code,
        dart_key=DART_API_KEY,
        ecos_key=ECOS_KEY,
        current_price=current_price,
        shares=shares,
        roe_fallback=roe_fb,
        net_inc_fallback=net_inc_fb,
        equity_fallback=equity_fb
    )
    _cache_set(cache_key, result)
    return jsonify(result)


# --- Gunicorn 등 프로덕션 환경에서도 시작 시 종목을 로드하도록 모듈 레벨에서 호출 ---
load_dart_corp_codes()
load_all_stocks()
print(f"🕯️  캔들 패턴 분석 엔진 활성화")


# ── 밸류체인 API ──────────────────────────────────────────────────
_VALUE_CHAIN_DATA = None

def _load_valuechain_data():
    global _VALUE_CHAIN_DATA
    if _VALUE_CHAIN_DATA is None:
        try:
            kb_path = os.path.join(os.path.dirname(__file__), "knowledge_base.json")
            with open(kb_path, 'r', encoding='utf-8') as f:
                _VALUE_CHAIN_DATA = json.load(f)
        except Exception as e:
            print(f"⚠️ knowledge_base.json 로드 실패: {e}")
            _VALUE_CHAIN_DATA = []
    return _VALUE_CHAIN_DATA


@app.route("/api/valuechain/categories")
def api_valuechain_categories():
    """밸류체인 대분류 카테고리 목록 반환"""
    data = _load_valuechain_data()
    categories = []
    seen = set()
    for item in data:
        cat = item.get("대분류 (산업군)", "")
        if cat and cat not in seen:
            seen.add(cat)
            categories.append(cat)
    return jsonify(categories)


@app.route("/api/valuechain/detail")
def api_valuechain_detail():
    """특정 대분류의 섹터 + 종목 목록 반환"""
    category = request.args.get("category", "").strip()
    data = _load_valuechain_data()
    sectors = []
    for item in data:
        cat = item.get("대분류 (산업군)", "")
        if not category or cat == category:
            sector_name = item.get("중분류 (섹터/테마)", "")
            stocks_raw = item.get("관련 종목", "")
            stocks = [s.strip() for s in stocks_raw.split(",") if s.strip()]
            sectors.append({"sector": sector_name, "stocks": stocks, "category": cat})
    return jsonify(sectors)


@app.route("/api/valuechain/search")
def api_valuechain_search():
    """밸류체인 전체 종목에서 키워드 검색"""
    query = request.args.get("q", "").strip().lower()
    data = _load_valuechain_data()
    results = []
    for item in data:
        cat = item.get("대분류 (산업군)", "")
        sector = item.get("중분류 (섹터/테마)", "")
        stocks_raw = item.get("관련 종목", "")
        stocks = [s.strip() for s in stocks_raw.split(",") if s.strip()]
        matched = [s for s in stocks if not query or query in s.lower()]
        if matched:
            results.append({"category": cat, "sector": sector, "stocks": matched})
    return jsonify(results)

@app.route("/")
def serve_index():
    return send_from_directory("client", "index.html")

@app.route("/<path:path>")
def serve_static(path):
    return send_from_directory("client", path)

if __name__ == "__main__":
    debug_mode = os.environ.get("FLASK_ENV") == "development"
    app.run(debug=debug_mode, port=5001, use_reloader=False)
