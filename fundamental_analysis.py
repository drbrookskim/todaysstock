"""
fundamental_analysis.py
Antigravity 펀더멘탈 분석 엔진

4개 핵심 축:
  1. Quant        — DART XBRL 재무제표 기반 정량 스코어 (연간 + 분기)
  2. Event-Driven — DART 공시 이벤트 스캐너
  3. Macro        — 한국은행 ECOS + yfinance 거시경제
  4. Alt Data     — Phase 2 (KIPRIS 특허)
"""

import requests
import time
import yfinance as yf
from datetime import datetime, timedelta
from typing import List, Tuple, Optional

# ── 메모리 캐시 ──────────────────────────────────────────────
_FC: dict = {}

def _fg(k: str, ttl: int):
    e = _FC.get(k)
    return e[1] if (e and time.time() - e[0] < ttl) else None

def _fs(k: str, v):
    _FC[k] = (time.time(), v)

TTL_FIN = 21600   # 6h  — 재무제표
TTL_DIS = 3600    # 1h  — 공시
TTL_MAC = 600     # 10m — 거시


# ════════════════════════════════════════════════════════════
# 1.  기업 유형 분류
# ════════════════════════════════════════════════════════════
_SECTOR_KW = {
    "IDM":       ["삼성전자", "SK하이닉스"],
    "EQUIPMENT": ["한미반도체", "HPSP", "피에스케이", "주성엔지니어링",
                  "원익IPS", "테스", "유진테크", "AP시스템", "와이아이케이",
                  "케이씨텍", "솔브레인", "이오테크닉스", "레이저쎄미콘"],
    "FABLESS":   ["실리콘웍스", "어보브반도체", "동운아나텍"],
    "BATTERY":   ["LG에너지솔루션", "삼성SDI", "에코프로", "포스코퓨처엠",
                  "POSCO홀딩스", "일진머티리얼즈", "에코프로비엠"],
    "BIO":       ["삼성바이오로직스", "셀트리온", "알테오젠", "HLB",
                  "유한양행", "한미약품", "종근당"],
    "EV":        ["현대차", "기아", "한온시스템", "HL만도"],
    "INTERNET":  ["NAVER", "카카오", "카카오페이", "카카오뱅크"],
    "FINANCE":   ["KB금융", "신한지주", "하나금융", "우리금융", "삼성화재"],
    "TELECOM":   ["SK텔레콤", "KT", "LG유플러스"],
    "ENERGY":    ["한국전력", "한국가스공사", "두산에너빌리티", "한화솔루션"],
}
_LABELS = {
    "IDM": "종합 반도체(IDM)", "EQUIPMENT": "반도체 장비·소재",
    "FABLESS": "반도체 팹리스", "BATTERY": "이차전지",
    "BIO": "바이오·제약", "EV": "자동차", "INTERNET": "인터넷·플랫폼",
    "FINANCE": "금융", "TELECOM": "통신", "ENERGY": "에너지",
    "GENERAL": "기타",
}

def classify_company(corp_name: str, induty_code: str = "") -> Tuple[str, str]:
    for ctype, kws in _SECTOR_KW.items():
        for kw in kws:
            if kw in corp_name:
                return ctype, _LABELS[ctype]
    imap = {"C261": "IDM", "C309": "EV", "C210": "BIO", "J": "INTERNET"}
    for pfx, ct in imap.items():
        if induty_code.startswith(pfx):
            return ct, _LABELS.get(ct, ct)
    return "GENERAL", _LABELS["GENERAL"]


# ════════════════════════════════════════════════════════════
# 2.  DART 재무제표 파싱
# ════════════════════════════════════════════════════════════
_ACCT = {
    "매출액": "rev",        "영업수익": "rev",
    "영업이익": "op",       "영업손실": "op",
    "당기순이익": "net",    "당기순손실": "net",
    "자산총계": "assets",   "부채총계": "liab",
    "자본총계": "equity",   "재고자산": "inv",
}

def _amt(s) -> float:
    try:
        return float(str(s or "0").replace(",", "").strip() or "0")
    except:
        return 0.0

def _dart_stmt(corp_code: str, dart_key: str, year: str, reprt_code: str) -> list:
    url = (f"https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json"
           f"?crtfc_key={dart_key}&corp_code={corp_code}"
           f"&bsns_year={year}&reprt_code={reprt_code}&fs_div=CFS")
    try:
        r = requests.get(url, timeout=12)
        d = r.json()
        return d.get("list", []) if d.get("status") == "000" else []
    except:
        return []

def _parse_rows(rows: list) -> dict:
    out = {v: {"cur": 0.0, "prv": 0.0} for v in set(_ACCT.values())}
    seen: set = set()
    for row in rows:
        nm = str(row.get("account_nm", "")).strip()
        tgt = _ACCT.get(nm)
        if not tgt or nm in seen:
            continue
        seen.add(nm)
        c = _amt(row.get("thstrm_amount"))
        p = _amt(row.get("frmtrm_amount"))
        if "손실" in nm:
            c, p = -c, -p
        out[tgt] = {"cur": c, "prv": p}
    return out

def fetch_financials(corp_code: str, dart_key: str) -> dict:
    ck = f"fin_{corp_code}"
    if cached := _fg(ck, TTL_FIN):
        return cached

    now = datetime.now()
    yr, yr1, yr2 = str(now.year), str(now.year - 1), str(now.year - 2)

    # 연간: 전년도 사업보고서 우선
    ann_rows, ann_yr = [], yr1
    for y in [yr1, yr2]:
        ann_rows = _dart_stmt(corp_code, dart_key, y, "11011")
        ann_yr = y
        if ann_rows:
            break

    # 분기: 최신 분기 우선 (Q3 → 반기 → Q1)
    qtr_rows, qtr_label = [], ""
    for y in [yr, yr1]:
        for rcode, lbl in [("11014", f"{y}년 3분기"),
                           ("11012", f"{y}년 반기"),
                           ("11013", f"{y}년 1분기")]:
            rows = _dart_stmt(corp_code, dart_key, y, rcode)
            if rows:
                qtr_rows, qtr_label = rows, lbl
                break
        if qtr_rows:
            break

    result = {
        "annual":        {"period": f"{ann_yr}년 연간", "data": _parse_rows(ann_rows)},
        "quarterly":     {"period": qtr_label,           "data": _parse_rows(qtr_rows)},
        "has_annual":    bool(ann_rows),
        "has_quarterly": bool(qtr_rows),
    }
    _fs(ck, result)
    return result


# ════════════════════════════════════════════════════════════
# 3.  퀀트 점수
# ════════════════════════════════════════════════════════════
def compute_quant(financials: dict) -> dict:
    ann = financials.get("annual", {}).get("data", {})
    qtr = financials.get("quarterly", {}).get("data", {})

    def _v(acct, period):
        d = (ann if period == "ann" else qtr).get(acct, {})
        return d.get("cur", 0.0), d.get("prv", 0.0)

    rev_c, rev_p = _v("rev", "ann")
    if not rev_c:
        rev_c, rev_p = _v("rev", "qtr")
    op_c, _   = _v("op",     "ann") if ann.get("op", {}).get("cur") else _v("op", "qtr")
    net_c, _  = _v("net",    "ann") if ann.get("net", {}).get("cur") else _v("net", "qtr")
    eq_c, _   = _v("equity", "ann")
    liab_c, _ = _v("liab",   "ann")
    inv_c, _  = _v("inv",    "ann")
    qtr_c, qtr_p = _v("rev", "qtr")

    def sd(a, b):
        return a / b if b else None

    roe        = sd(net_c, eq_c) and sd(net_c, eq_c) * 100
    op_margin  = sd(op_c, rev_c) and sd(op_c, rev_c) * 100
    rev_growth = sd(rev_c - rev_p, rev_p) * 100 if rev_p else None
    qtr_growth = sd(qtr_c - qtr_p, qtr_p) * 100 if qtr_p else None
    debt_ratio = sd(liab_c, eq_c) * 100 if eq_c else None
    inv_turn   = sd(rev_c, inv_c) if inv_c else None

    def sc_roe(v):
        if v is None: return 50
        if v >= 20:   return 100
        if v >= 15:   return 85
        if v >= 10:   return 70
        if v >= 5:    return 55
        if v >= 0:    return 35
        return 10

    def sc_opm(v):
        if v is None: return 50
        if v >= 20:   return 100
        if v >= 15:   return 85
        if v >= 10:   return 70
        if v >= 5:    return 55
        if v >= 0:    return 40
        return 15

    def sc_grw(v):
        if v is None:  return 50
        if v >= 20:    return 100
        if v >= 10:    return 80
        if v >= 5:     return 65
        if v >= 0:     return 50
        if v >= -10:   return 30
        return 10

    def sc_dbt(v):
        if v is None:  return 50
        if v <= 30:    return 100
        if v <= 60:    return 85
        if v <= 100:   return 70
        if v <= 150:   return 55
        if v <= 200:   return 35
        return 15

    s_roe = sc_roe(roe)
    s_opm = sc_opm(op_margin)
    s_grw = sc_grw(rev_growth)
    s_dbt = sc_dbt(debt_ratio)

    total = round(s_roe * 0.30 + s_opm * 0.25 + s_grw * 0.25 + s_dbt * 0.20)

    def grade(s):
        if s >= 85: return "A+"
        if s >= 75: return "A"
        if s >= 65: return "B+"
        if s >= 55: return "B"
        if s >= 45: return "C"
        return "D"

    def _r(v, n=2):
        return round(v, n) if v is not None else None

    return {
        "score":         total,
        "grade":         grade(total),
        "roe":           _r(roe),
        "op_margin":     _r(op_margin),
        "rev_growth":    _r(rev_growth),
        "qtr_growth":    _r(qtr_growth),
        "debt_ratio":    _r(debt_ratio),
        "inv_turnover":  _r(inv_turn),
        "breakdown":     {"roe": s_roe, "op_margin": s_opm,
                          "rev_growth": s_grw, "debt_ratio": s_dbt},
        "period":        financials.get("annual", {}).get("period", ""),
        "qtr_period":    financials.get("quarterly", {}).get("period", ""),
        "data_available": financials.get("has_annual", False),
    }


# ════════════════════════════════════════════════════════════
# 4.  Event-Driven 공시 스캐너
# ════════════════════════════════════════════════════════════
_TRIGGERS = [
    ("단일판매",   "supply_contract", "bullish",  3, "🟢 공급·수주계약"),
    ("공급계약",   "supply_contract", "bullish",  3, "🟢 공급·수주계약"),
    ("자기주식취득", "buyback",       "bullish",  2, "🟢 자사주 매입"),
    ("전환사채",   "cb",              "bearish", -1, "🟡 전환사채 발행"),
    ("유상증자",   "rights",          "bearish", -2, "🔴 유상증자 (희석)"),
    ("감사",       "audit",           "bearish", -3, "🔴 감사意見 이슈"),
    ("주요사항",   "major_event",     "neutral",  0, "⚪ 주요사항 보고"),
]

def scan_disclosures(corp_code: str, dart_key: str, days: int = 30) -> list:
    ck = f"dis_{corp_code}"
    if cached := _fg(ck, TTL_DIS):
        return cached

    end_d   = datetime.now()
    start_d = end_d - timedelta(days=days)
    url = (f"https://opendart.fss.or.kr/api/list.json"
           f"?crtfc_key={dart_key}&corp_code={corp_code}"
           f"&bgn_de={start_d.strftime('%Y%m%d')}&end_de={end_d.strftime('%Y%m%d')}"
           f"&page_count=20")
    try:
        raw = requests.get(url, timeout=10).json()
        items = raw.get("list", []) if raw.get("status") == "000" else []
    except:
        items = []

    events = []
    for item in items:
        rpt = str(item.get("report_nm", ""))
        for kw, etype, signal, weight, label in _TRIGGERS:
            if kw in rpt:
                events.append({
                    "type":     etype,
                    "signal":   signal,
                    "weight":   weight,
                    "label":    label,
                    "title":    rpt,
                    "date":     item.get("rcept_dt", ""),
                    "rcept_no": item.get("rcept_no", ""),
                })
                break

    _fs(ck, events)
    return events


# ════════════════════════════════════════════════════════════
# 5.  거시경제 컨텍스트 (ECOS + yfinance)
# ════════════════════════════════════════════════════════════
def get_macro(ecos_key: str) -> dict:
    ck = "macro_ctx_v2" # 캐시 키를 갱신하여 새 지표 즉시 반영
    if cached := _fg(ck, TTL_MAC):
        return cached

    m: dict = {}

    # USD/KRW
    try:
        hist = yf.Ticker("KRW=X").history(period="5d")
        if not hist.empty:
            m["usd_krw"] = round(float(hist["Close"].iloc[-1]), 2)
            if len(hist) >= 2:
                prv = float(hist["Close"].iloc[-2])
                m["usd_krw_chg"] = round((m["usd_krw"] - prv) / prv * 100, 3)
            hist52 = yf.Ticker("KRW=X").history(period="1y")
            if not hist52.empty:
                m["usd_krw_52h"] = round(float(hist52["High"].max()), 2)
                m["usd_krw_52l"] = round(float(hist52["Low"].min()), 2)
    except:
        pass

    # --- Korean Indices via ECOS (Primary) or yfinance (Fallback) ---
    if ecos_key:
        try:
            # KOSPI (ECOS: 901Y002 / 0001000)
            url = f"https://ecos.bok.or.kr/api/StatisticSearch/{ecos_key}/json/kr/1/5/901Y002/D/20240101/20261231/0001000"
            r = requests.get(url, timeout=5).json()
            if "StatisticSearch" in r and r["StatisticSearch"]["list_total_count"] > 0:
                rows = r["StatisticSearch"]["row"]
                m["kospi"] = round(float(rows[-1]["DATA_VALUE"]), 2)
                if len(rows) >= 2:
                    prv = float(rows[-2]["DATA_VALUE"])
                    m["kospi_chg"] = round((m["kospi"] - prv) / prv * 100, 3)
            
            # KOSDAQ (ECOS: 901Y002 / 0042000)
            url = f"https://ecos.bok.or.kr/api/StatisticSearch/{ecos_key}/json/kr/1/5/901Y002/D/20240101/20261231/0042000"
            r = requests.get(url, timeout=5).json()
            if "StatisticSearch" in r and r["StatisticSearch"]["list_total_count"] > 0:
                rows = r["StatisticSearch"]["row"]
                m["kosdaq"] = round(float(rows[-1]["DATA_VALUE"]), 2)
                if len(rows) >= 2:
                    prv = float(rows[-2]["DATA_VALUE"])
                    m["kosdaq_chg"] = round((m["kosdaq"] - prv) / prv * 100, 3)
        except Exception as e:
            print(f"ECOS Index Fetch Error: {e}")

    # Fallback to yfinance if ECOS failed or not provided
    if "kospi" not in m:
        try:
            ks = yf.Ticker("^KS11").history(period="5d")
            if not ks.empty:
                m["kospi"] = round(float(ks["Close"].iloc[-1]), 2)
                if len(ks) >= 2:
                    prv = float(ks["Close"].iloc[-2])
                    m["kospi_chg"] = round((m["kospi"] - prv) / prv * 100, 3)
        except: pass

    if "kosdaq" not in m:
        try:
            kq = yf.Ticker("^KQ11").history(period="5d")
            if not kq.empty:
                m["kosdaq"] = round(float(kq["Close"].iloc[-1]), 2)
                if len(kq) >= 2:
                    prv = float(kq["Close"].iloc[-2])
                    m["kosdaq_chg"] = round((m["kosdaq"] - prv) / prv * 100, 3)
        except: pass

    # S&P 500 (^GSPC)
    try:
        sp = yf.Ticker("^GSPC").history(period="5d")
        if not sp.empty:
            m["sp500"] = round(float(sp["Close"].iloc[-1]), 2)
            if len(sp) >= 2:
                prv = float(sp["Close"].iloc[-2])
                m["sp500_chg"] = round((m["sp500"] - prv) / prv * 100, 3)
    except:
        pass

    # US 10Y Treasury Yield (^TNX)
    try:
        tnx = yf.Ticker("^TNX").history(period="5d")
        if not tnx.empty:
            m["us10y"] = round(float(tnx["Close"].iloc[-1]), 3)
            if len(tnx) >= 2:
                prv = float(tnx["Close"].iloc[-2])
                m["us10y_chg"] = round((m["us10y"] - prv), 3) # 단위가 %이므로 포인트 등락
    except:
        pass

    # NASDAQ (^IXIC)
    try:
        ndq = yf.Ticker("^IXIC").history(period="5d")
        if not ndq.empty:
            m["nasdaq"] = round(float(ndq["Close"].iloc[-1]), 2)
            if len(ndq) >= 2:
                prv = float(ndq["Close"].iloc[-2])
                m["nasdaq_chg"] = round((m["nasdaq"] - prv) / prv * 100, 3)
    except:
        pass

    # VIX (^VIX) - 시장 공포지수
    try:
        vix = yf.Ticker("^VIX").history(period="5d")
        if not vix.empty:
            m["vix"] = round(float(vix["Close"].iloc[-1]), 2)
            if len(vix) >= 2:
                prv = float(vix["Close"].iloc[-2])
                m["vix_chg"] = round((m["vix"] - prv) / prv * 100, 3)
    except:
        pass

    # WTI Crude Oil (CL=F) - 국제 유가
    try:
        wti = yf.Ticker("CL=F").history(period="5d")
        if not wti.empty:
            m["wti"] = round(float(wti["Close"].iloc[-1]), 2)
            if len(wti) >= 2:
                prv = float(wti["Close"].iloc[-2])
                m["wti_chg"] = round((m["wti"] - prv) / prv * 100, 3)
    except:
        pass

    # Dollar Index (DX-Y.NYB) - 달러 인덱스
    try:
        dxy = yf.Ticker("DX-Y.NYB").history(period="5d")
        if not dxy.empty:
            m["dxy"] = round(float(dxy["Close"].iloc[-1]), 2)
            if len(dxy) >= 2:
                prv = float(dxy["Close"].iloc[-2])
                m["dxy_chg"] = round((m["dxy"] - prv) / prv * 100, 3)
    except:
        pass

    # Cryptocurrency (BTC, ETH, USDT)
    for coin, ticker in [("btc", "BTC-USD"), ("eth", "ETH-USD"), ("usdt", "USDT-USD")]:
        try:
            c_hist = yf.Ticker(ticker).history(period="5d")
            if not c_hist.empty:
                m[coin] = round(float(c_hist["Close"].iloc[-1]), 2)
                if len(c_hist) >= 2:
                    prv = float(c_hist["Close"].iloc[-2])
                    m[f"{coin}_chg"] = round((m[coin] - prv) / prv * 100, 3)
        except:
            pass

    # Fear & Greed Index (Simple Estimation based on VIX)
    # VIX 15 이하: Greed (75), 15-20: Neutral (50), 20-30: Fear (25), 30+: Extreme Fear (10)
    if "vix" in m:
        v = m["vix"]
        if v <= 15:   m["fear_greed"] = 75
        elif v <= 20: m["fear_greed"] = 55
        elif v <= 30: m["fear_greed"] = 35
        else:         m["fear_greed"] = 15
    else:
        m["fear_greed"] = 50

    if ecos_key:
        # 기준금리 (ECOS 722Y001 / 0101000 / MM)
        try:
            now = datetime.now()
            sm  = (now - timedelta(days=90)).strftime("%Y%m")
            em  = now.strftime("%Y%m")
            url = (f"https://ecos.bok.or.kr/api/StatisticSearch/"
                   f"{ecos_key}/json/kr/1/5/722Y001/MM/{sm}/{em}/0101000")
            rows = requests.get(url, timeout=10).json() \
                           .get("StatisticSearch", {}).get("row", [])
            if rows:
                m["base_rate"]        = float(rows[-1].get("DATA_VALUE", 0))
                m["base_rate_period"] = rows[-1].get("TIME", "")
        except:
            pass

        # 반도체 수출 YoY (ECOS 901Y018 — 수출입금액)
        try:
            now = datetime.now()
            sm  = (now - timedelta(days=400)).strftime("%Y%m")
            em  = now.strftime("%Y%m")
            url = (f"https://ecos.bok.or.kr/api/StatisticSearch/"
                   f"{ecos_key}/json/kr/1/24/901Y018/MM/{sm}/{em}/064")
            rows = requests.get(url, timeout=10).json() \
                           .get("StatisticSearch", {}).get("row", [])
            if len(rows) >= 13:
                cur_v  = float(rows[-1].get("DATA_VALUE", 0) or 0)
                prv_v  = float(rows[-13].get("DATA_VALUE", 0) or 0)
                if prv_v:
                    m["semi_export_yoy"]    = round((cur_v - prv_v) / prv_v * 100, 2)
                    m["semi_export_period"] = rows[-1].get("TIME", "")
        except:
            pass

    _fs(ck, m)
    return m


# ════════════════════════════════════════════════════════════
# 6.  신호 생성 (회사 유형별 맞춤)
# ════════════════════════════════════════════════════════════
def _build_signal(quant: dict, events: list,
                  macro: dict, ctype: str) -> dict:
    score   = quant.get("score", 50)
    ev_wt   = sum(e["weight"] for e in events)
    krw     = macro.get("usd_krw", 1350)

    if score >= 75:   sig, lbl = "overweight",   "비중 확대"
    elif score >= 55: sig, lbl = "hold",          "보유"
    else:             sig, lbl = "underweight",   "비중 축소"

    reasons = []
    if quant.get("data_available"):
        reasons.append(f"퀀트 {score}/100 ({quant.get('grade','?')}등급)")

    # 이벤트 보정
    if ev_wt >= 3:
        sig, lbl = "event_buy", "이벤트 기반 매수"
        reasons.append("대형 이벤트 트리거: " + ", ".join(e["label"] for e in events[:2]))
    elif ev_wt <= -3:
        sig, lbl = "event_sell", "위험 신호 — 보유 재검토"
        reasons.append("리스크 공시: " + ", ".join(e["label"] for e in events[:2]))
    elif events:
        reasons.append(events[0]["label"])

    # IDM: 환율 민감도
    if ctype == "IDM":
        if krw >= 1380:
            reasons.append(f"USD/KRW {krw} — 수출 수혜 구간")
            if sig == "hold":
                sig, lbl = "overweight", "비중 확대"
        elif krw <= 1280:
            reasons.append(f"USD/KRW {krw} — 원화강세 수출 불리")

    # EQUIPMENT: 수주 공시 최우선
    if ctype == "EQUIPMENT" and any(e["type"] == "supply_contract" for e in events):
        sig, lbl = "event_buy", "이벤트 기반 매수 (수주 계약)"

    # 반도체 수출 YoY
    semi_yoy = macro.get("semi_export_yoy")
    if semi_yoy is not None:
        if ctype in ("IDM", "EQUIPMENT"):
            reasons.append(f"반도체 수출 YoY {semi_yoy:+.1f}%")

    return {"signal": sig, "signal_label": lbl,
            "signal_reason": " | ".join(reasons) if reasons else "데이터 분석 완료"}


# ════════════════════════════════════════════════════════════
# 7.  메인 API
# ════════════════════════════════════════════════════════════
def analyze_fundamental(stock_code: str, corp_name: str, corp_code: str,
                        dart_key: str, ecos_key: str,
                        induty_code: str = "") -> dict:
    """
    4-Pillar 펀더멘탈 분석 실행.
    출력 포맷:
      [대상 식별] → [데이터 트리거 확인] → [핵심 축 분석] → [실행 가능한 신호]
    """
    # ── [대상 식별] ──
    ctype, ctype_label = classify_company(corp_name, induty_code)

    # ── [데이터 트리거 확인] + [핵심 축 분석] ──
    fin  = fetch_financials(corp_code, dart_key) if (corp_code and dart_key) else {}
    qnt  = compute_quant(fin) if fin else {"score": 50, "data_available": False}
    evts = scan_disclosures(corp_code, dart_key) if (corp_code and dart_key) else []
    mac  = get_macro(ecos_key or "")

    # ── [실행 가능한 신호] ──
    sig  = _build_signal(qnt, evts, mac, ctype)

    axes = []
    if qnt.get("data_available"):      axes.append("Quant")
    if evts:                           axes.append("Event-Driven")
    if mac:                            axes.append("Macro")

    return {
        # 대상 식별
        "company_type":       ctype,
        "company_type_label": ctype_label,
        # Quant
        "quant":              qnt,
        # Event-Driven
        "events":             evts[:5],
        "event_score":        sum(e["weight"] for e in evts),
        # Macro
        "macro":              mac,
        # 신호
        "signal":             sig["signal"],
        "signal_label":       sig["signal_label"],
        "signal_reason":      sig["signal_reason"],
        # 메타
        "axes_used":          axes,
        "generated_at":       datetime.now().isoformat(),
    }
