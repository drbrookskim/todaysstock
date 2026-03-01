"""
한국 주식 종목 검색 서버
- 코스피/코스닥 종목 검색
- 현재가 및 이동평균선(5, 10, 20, 60일) 표시
- 캔들 패턴 분석 및 AI 매매 리포트
"""

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from supabase import create_client, Client, ClientOptions
import os
import html
from dotenv import load_dotenv
import yfinance as yf
import pandas as pd
import requests as http_requests
from datetime import datetime, timedelta
from bs4 import BeautifulSoup
from candle_patterns import analyze_candle_patterns
import os

app = Flask(__name__)
CORS(app)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", os.urandom(24).hex())

load_dotenv()
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

# Global client (mostly for auth admin actions like sign up/in)
supabase_global: Client = create_client(SUPABASE_URL, SUPABASE_KEY) if SUPABASE_URL and SUPABASE_KEY else None

def get_user_supabase():
    """요청의 JWT 토큰을 바탕으로 RLS가 적용되는 독립된 Supabase 클라이언트 생성"""
    token = request.headers.get("Authorization")
    headers = {}
    if token and token.startswith("Bearer "):
        headers["Authorization"] = token
    options = ClientOptions(headers=headers)
    return create_client(SUPABASE_URL, SUPABASE_KEY, options=options)

# ─────────────────────────────────────────────
# ─────────────────────────────────────────────

# ─────────────────────────────────────────────
# 전체 종목 리스트 (KRX에서 동적 로드)
# ─────────────────────────────────────────────
STOCK_LIST = []

# DART 기업별 고유번호 매핑 캐시
DART_API_KEY = os.environ.get("DART_API_KEY", "")
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
                stock_code = item.find('stock_code').text
                if stock_code and stock_code.strip():
                    corp_code = item.find('corp_code').text
                    DART_CORP_CODES[stock_code.strip()] = corp_code.strip()
                    
        print(f"🏢 DART 기업코드 {len(DART_CORP_CODES)}개 로드 완료")
    except Exception as e:
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

    api_key = os.getenv("DATA_GO_KR_API_KEY")

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
            resp = http_requests.get(url, params=params, timeout=10)
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
                    return df

            print(f"⚠️ 공공데이터 API 결과 없음 ({code}), yfinance 로 대체합니다.")
        except Exception as e:
            print(f"⚠️ 공공데이터 API 오류 ({code}): {e}, yfinance 로 대체합니다.")

    # ── 2차 폴백: yfinance ──
    try:
        suffix = ".KS" if market == "KOSPI" else ".KQ"
        ticker = code + suffix
        end_date = datetime.now()
        start_date = end_date - timedelta(days=450)
        df = yf.download(ticker, start=start_date, end=end_date, progress=False)
        if df.empty:
            print(f"❌ yfinance 결과 없음 ({ticker})")
            return None
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        print(f"✅ yfinance ({ticker}): {len(df)}일 데이터")
        return df
    except Exception as e:
        print(f"❌ yfinance 오류 ({code}): {e}")
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

    # Open DART 기업 기본정보
    est_dt = ""
    ceo = ""
    hm_url = ""
    adres = ""
    
    if DART_API_KEY and code in DART_CORP_CODES:
        try:
            corp_code = DART_CORP_CODES[code]
            dart_url = f"https://opendart.fss.or.kr/api/company.json?crtfc_key={DART_API_KEY}&corp_code={corp_code}"
            dart_resp = http_requests.get(dart_url, timeout=5).json()
            if dart_resp.get("status") == "000":
                est_dt_raw = dart_resp.get("est_dt", "")
                if est_dt_raw and len(est_dt_raw) == 8:
                    est_dt = f"{est_dt_raw[:4]}년 {est_dt_raw[4:6]}월 {est_dt_raw[6:]}일"
                ceo = dart_resp.get("ceo_nm", "")
                hm_url = dart_resp.get("hm_url", "")
                if hm_url and not hm_url.startswith("http"):
                    hm_url = "http://" + hm_url
                adres = dart_resp.get("adres", "")
        except Exception as e:
            print(f"DART API 호출 실패: {e}")

    # Defaults for fields that may not be populated
    industry = "분류되지 않음"
    translated_desc = "기업 상세 정보를 불러오는 중 오류가 발생했습니다."
    suffix = ".KS" if market == "KOSPI" else ".KQ"
    ticker = code + suffix

    # 1. 네이버 금융 업종 (WICS) 파싱 시도 (가장 정확한 한국어 업종 우선 적용)
    try:
        import re
        nav_url = f"https://finance.naver.com/item/main.naver?code={code}"
        resp = http_requests.get(nav_url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=3)
        if resp.status_code == 200:
            # resp.content 를 직접 euc-kr 로 decode (네이버 금융은 EUC-KR 인코딩)
            html_text = resp.content.decode('euc-kr', errors='ignore')
            match = re.search(r'<h4 class="h_sub sub_tit7">.*?<a[^>]*>(.*?)</a>', html_text, re.DOTALL)
            if match:
                parsed_industry = match.group(1).replace("동일업종비교", "").strip()
                # 유효한 한국어/영문자 여부 검증 (깨진 문자 거름)
                if parsed_industry and all(ord(c) < 0xFFFD for c in parsed_industry):
                    industry = parsed_industry
    except Exception as e:
        print(f"네이버 업종 파싱 오류 ({code}): {e}")

    # 2. 기업 개요 번역 (yfinance + deep-translator)
    try:
        from deep_translator import GoogleTranslator
        translator = GoogleTranslator(source='en', target='ko')
        
        info = yf.Ticker(ticker).info
        en_summary = info.get("longBusinessSummary")
        en_industry = info.get("industry")
        
        if en_summary:
            translated_desc = translator.translate(en_summary[:2000])
        if industry == "분류되지 않음" and en_industry:
            # 네이버 파싱 실패 시에만 yfinance 제공 업종을 번역해서 사용
            industry = translator.translate(en_industry)
            
    except Exception as e:
        print(f"기업 정보 조회/번역 오류 ({ticker}): {e}")
        
    # 예외 하드코딩: 이오테크닉스(039030)는 yfinance 데이터가 부실하므로 상세 요약본 수동 주입
    if code == "039030":
        industry = "반도체 장비 및 재료"
        translated_desc = "(주)이오테크닉스는 레이저 가공 장비를 전세계적으로 제조, 공급하고 있습니다. 이 회사는 스트립 마커, 트레이 마커, 웨이퍼 뒷면 마커, 웨이퍼 상단 마커 및 웨이퍼 ID 마커로 구성된 반도체 제품을 제공합니다. 그루빙 및 다이싱 제품; 기판 절단 장비; 스트립 및 웨이퍼 유형의 POP를 위한 드릴링 장비. 또한 레이저 리프트 오프, PI 유리 컷, 셰이프 컷, 챔퍼 컷, UV 레이저 어닐링, FPD 마커, 정렬 키 마커, 레이저 트리머 OLED/TFT/CF 트리머, 필름 커터, Pol과 같은 디스플레이 제품도 제공합니다. 필름 절단기, 마스크 수리, 유리창 절단기, 레이저 패터닝 제품; 드릴링 및 마킹 애플리케이션용 PCB 장비; 노칭/절단, 용접, 접합, 납땜 및 마킹 응용 분야에 사용되는 매크로 장비; 그리고 레이저 제품. EO Technics Co., Ltd.는 1989년에 설립되었으며 대한민국 안양시에 본사를 두고 있습니다."
        
    # DART 정보를 활용해 동일한 포맷의 HTML 동적 생성
    dart_li = []
    if est_dt: dart_li.append(f"<li><strong>설립일:</strong> {html.escape(est_dt)}</li>")
    if ceo: dart_li.append(f"<li><strong>대표이사:</strong> {html.escape(ceo)}</li>")
    if adres: dart_li.append(f"<li><strong>본사:</strong> {html.escape(adres)}</li>")
    if hm_url: dart_li.append(f"<li><strong>웹사이트:</strong> <a href='{html.escape(hm_url)}' target='_blank'>{html.escape(hm_url.replace('http://', '').replace('https://', ''))}</a></li>")
    
    overview_html = ""
    if dart_li:
        overview_html = f"""
<div class="summary-section">
    <h4 class="summary-heading">1. 기업 개요</h4>
    <ul class="summary-list">
        {"".join(dart_li)}
    </ul>
</div>"""
        
    company_summary = f"""
<div class="summary-formatted">
<div class="summary-subtitle"><strong>"글로벌 경쟁력 기반의 {html.escape(industry)} 선도 기업"</strong></div>
{overview_html}
<div class="summary-section">
    <h4 class="summary-heading">2. 핵심 사업 영역 (주요 활동)</h4>
    <p class="summary-desc">{html.escape(translated_desc)}</p>
</div>
</div>"""


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
        "company_summary": company_summary,
        "industry": industry,
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
# 인증 및 관심종목 DB 라우트
# ─────────────────────────────────────────────
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
    
    try:
        email = username if "@" in username else f"{username}@stockfinder.local"
        res = supabase_global.auth.sign_in_with_password({"email": email, "password": password})
        # token과 user 정보를 반환하여 클라이언트에서 JWT를 보관하도록 함
        return jsonify({
            "success": True, 
            "message": f"{username}님 환영합니다!", 
            "username": username,
            "access_token": res.session.access_token
        })
    except Exception as e:
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

@app.route("/api/watchlist", methods=["GET", "POST", "DELETE"])
def manage_watchlist():
    """Data Minimization 및 RLS가 적용된 Supabase DB 접근 라우트"""
    try:
        client = get_user_supabase()
        # 토큰을 바탕으로 유저 정보를 미리 파악
        token = request.headers.get("Authorization", "").replace("Bearer ", "")
        user_res = supabase_global.auth.get_user(token) if token else None
        
        if not user_res or not user_res.user:
            return jsonify({"success": False, "message": "Unauthorized"}), 401
            
        user_id = user_res.user.id
            
        if request.method == "GET":
            # Data Minimization 원칙: select('*') 사용 불가
            res = client.table("watchlist").select("stock_code,stock_name,market").execute()
            # 프론트엔드 포맷(code, name, market)으로 매핑
            mapped = [{"code": item["stock_code"], "name": item["stock_name"], "market": item["market"]} for item in res.data]
            return jsonify(mapped)
            
        elif request.method == "POST":
            data = request.json
            item = {
                "user_id": user_id,
                "stock_code": data.get("code"),
                "stock_name": data.get("name"),
                "market": data.get("market", "KOSPI")
            }
            # RLS (Insert own items) 강제 검사됨
            client.table("watchlist").insert(item).execute()
            return jsonify({"success": True})
            
        elif request.method == "DELETE":
            # RLS (Delete own items) 강제 검사됨
            data = request.json
            code = data.get("code")
            client.table("watchlist").delete().eq("stock_code", code).execute()
            return jsonify({"success": True})
            
    except Exception as e:
        print(f"Watchlist error: {e}")
        return jsonify({"success": False, "message": "관심목록 처리 중 오류가 발생했습니다."}), 400

# ─────────────────────────────────────────────
# 라우트
# ─────────────────────────────────────────────


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
load_dart_corp_codes()
load_all_stocks()
print(f"🕯️  캔들 패턴 분석 엔진 활성화")

@app.route("/")
def serve_index():
    return send_from_directory("client", "index.html")

@app.route("/<path:path>")
def serve_static(path):
    return send_from_directory("client", path)

if __name__ == "__main__":
    debug_mode = os.environ.get("FLASK_ENV") == "development"
    app.run(debug=debug_mode, port=5001, use_reloader=False)
