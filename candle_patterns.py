"""
캔들 패턴 인식 엔진
NotebookLM "성공 투자를 위한 캔들 패턴과 시스템 트레이딩 전략" 기반

12개 주요 패턴 감지:
  상승 신호: 망치형, 역망치형, 잠자리형 도지, 상승 장악형, 관통형, 샛별형, 적삼병
  하락 신호: 교수형, 유성형, 비석형 도지, 하락 장악형, 흑운형, 석별형, 흑삼병
"""

import pandas as pd
import numpy as np


# ─────────────────────────────────────────────
# 유틸리티 함수
# ─────────────────────────────────────────────

def _body(row):
    """캔들 몸통 크기 (절대값)"""
    return abs(row["Close"] - row["Open"])


def _upper_shadow(row):
    """윗꼬리 길이"""
    return row["High"] - max(row["Open"], row["Close"])


def _lower_shadow(row):
    """아랫꼬리 길이"""
    return min(row["Open"], row["Close"]) - row["Low"]


def _is_bullish(row):
    """양봉 (종가 > 시가)"""
    return row["Close"] > row["Open"]


def _is_bearish(row):
    """음봉 (시가 > 종가)"""
    return row["Open"] > row["Close"]


def _candle_range(row):
    """캔들 전체 범위 (고가 - 저가)"""
    return row["High"] - row["Low"]


def _avg_volume(df, period=20):
    """평균 거래량"""
    if len(df) < period:
        return df["Volume"].mean()
    return df["Volume"].iloc[-period:].mean()


def _is_near_low(df, row, lookback=20):
    """최근 N일 저점 부근인지 (하락 추세 바닥)"""
    if len(df) < lookback:
        return False
    recent = df.iloc[-lookback:]
    low_zone = recent["Low"].min()
    price_range = recent["High"].max() - low_zone
    if price_range == 0:
        return False
    return (row["Close"] - low_zone) / price_range < 0.3


def _is_near_high(df, row, lookback=20):
    """최근 N일 고점 부근인지 (상승 추세 고점)"""
    if len(df) < lookback:
        return False
    recent = df.iloc[-lookback:]
    high_zone = recent["High"].max()
    price_range = high_zone - recent["Low"].min()
    if price_range == 0:
        return False
    return (high_zone - row["Close"]) / price_range < 0.3


def _trend_down(df, lookback=5):
    """최근 N일 하락 추세 여부"""
    if len(df) < lookback + 1:
        return False
    recent = df.iloc[-(lookback + 1):]
    return recent["Close"].iloc[0] > recent["Close"].iloc[-1]


def _trend_up(df, lookback=5):
    """최근 N일 상승 추세 여부"""
    if len(df) < lookback + 1:
        return False
    recent = df.iloc[-(lookback + 1):]
    return recent["Close"].iloc[-1] > recent["Close"].iloc[0]


# ─────────────────────────────────────────────
# 단일 캔들 패턴 (1봉)
# ─────────────────────────────────────────────

def detect_hammer(df):
    """망치형 (Hammer) — 하락 추세 바닥에서 상승 반전 신호"""
    if len(df) < 6:
        return None
    row = df.iloc[-1]
    body = _body(row)
    lower = _lower_shadow(row)
    upper = _upper_shadow(row)
    cr = _candle_range(row)

    if cr == 0:
        return None

    # 조건: 아랫꼬리 >= 몸통*2, 윗꼬리 짧음, 하락 추세
    if (lower >= body * 2
            and upper <= body * 0.5
            and body / cr < 0.4
            and _trend_down(df.iloc[:-1])):
        return {
            "name": "망치형 (Hammer)",
            "name_en": "Hammer",
            "signal": "bullish",
            "description": "하락 추세 바닥에서 강한 매수세 유입. 장중 급락 후 회복하여 반전 가능성.",
            "confidence": 0.7 if _is_near_low(df, row) else 0.5,
        }
    return None


def detect_hanging_man(df):
    """교수형 (Hanging Man) — 상승 추세 고점에서 하락 반전 신호"""
    if len(df) < 6:
        return None
    row = df.iloc[-1]
    body = _body(row)
    lower = _lower_shadow(row)
    upper = _upper_shadow(row)
    cr = _candle_range(row)

    if cr == 0:
        return None

    if (lower >= body * 2
            and upper <= body * 0.5
            and body / cr < 0.4
            and _trend_up(df.iloc[:-1])):
        return {
            "name": "교수형 (Hanging Man)",
            "name_en": "Hanging Man",
            "signal": "bearish",
            "description": "상승 추세 고점에서 매수세 약화 경고. 추세 전환 가능성 주시.",
            "confidence": 0.6 if _is_near_high(df, row) else 0.4,
        }
    return None


def detect_shooting_star(df):
    """유성형 (Shooting Star) — 상승 추세 고점에서 강력한 하락 반전"""
    if len(df) < 6:
        return None
    row = df.iloc[-1]
    body = _body(row)
    upper = _upper_shadow(row)
    lower = _lower_shadow(row)
    cr = _candle_range(row)

    if cr == 0:
        return None

    if (upper >= body * 2
            and lower <= body * 0.5
            and body / cr < 0.4
            and _trend_up(df.iloc[:-1])):
        return {
            "name": "유성형 (Shooting Star)",
            "name_en": "Shooting Star",
            "signal": "bearish",
            "description": "고점에서 강한 매도 저항. 매수세가 가격을 올렸으나 밀려남. 강력한 하락 신호.",
            "confidence": 0.75 if _is_near_high(df, row) else 0.55,
        }
    return None


def detect_inverted_hammer(df):
    """역망치형 (Inverted Hammer) — 하락 추세에서 상승 반전 가능성"""
    if len(df) < 6:
        return None
    row = df.iloc[-1]
    body = _body(row)
    upper = _upper_shadow(row)
    lower = _lower_shadow(row)
    cr = _candle_range(row)

    if cr == 0:
        return None

    if (upper >= body * 2
            and lower <= body * 0.5
            and body / cr < 0.4
            and _trend_down(df.iloc[:-1])):
        return {
            "name": "역망치형 (Inverted Hammer)",
            "name_en": "Inverted Hammer",
            "signal": "bullish",
            "description": "하락 중 장중 상승 시도 포착. 다음 날 양봉 확인 시 반전 신호.",
            "confidence": 0.55 if _is_near_low(df, row) else 0.4,
        }
    return None


def detect_dragonfly_doji(df):
    """잠자리형 도지 (Dragonfly Doji) — 하락 바닥에서 강력한 매수 신호"""
    if len(df) < 6:
        return None
    row = df.iloc[-1]
    body = _body(row)
    lower = _lower_shadow(row)
    upper = _upper_shadow(row)
    cr = _candle_range(row)

    if cr == 0:
        return None

    # 도지: 몸통이 전체 범위의 5% 이하
    if (body / cr <= 0.05
            and lower >= cr * 0.6
            and upper <= cr * 0.1
            and _trend_down(df.iloc[:-1])):
        return {
            "name": "잠자리형 도지 (Dragonfly Doji)",
            "name_en": "Dragonfly Doji",
            "signal": "bullish",
            "description": "시가=종가=고가 부근. 하락 거부 의지가 강력. 추세 전환 가능성 매우 높음.",
            "confidence": 0.8 if _is_near_low(df, row) else 0.6,
        }
    return None


def detect_gravestone_doji(df):
    """비석형 도지 (Gravestone Doji) — 상승 고점에서 하락 반전"""
    if len(df) < 6:
        return None
    row = df.iloc[-1]
    body = _body(row)
    lower = _lower_shadow(row)
    upper = _upper_shadow(row)
    cr = _candle_range(row)

    if cr == 0:
        return None

    if (body / cr <= 0.05
            and upper >= cr * 0.6
            and lower <= cr * 0.1
            and _trend_up(df.iloc[:-1])):
        return {
            "name": "비석형 도지 (Gravestone Doji)",
            "name_en": "Gravestone Doji",
            "signal": "bearish",
            "description": "시가=종가=저가 부근. 고점에서 매도 압력이 압도적. 하락 반전 경고.",
            "confidence": 0.75 if _is_near_high(df, row) else 0.55,
        }
    return None


# ─────────────────────────────────────────────
# 2개 캔들 조합 패턴
# ─────────────────────────────────────────────

def detect_bullish_engulfing(df):
    """상승 장악형 (Bullish Engulfing)"""
    if len(df) < 7:
        return None
    prev = df.iloc[-2]
    curr = df.iloc[-1]

    if (_is_bearish(prev)
            and _is_bullish(curr)
            and curr["Open"] <= prev["Close"]
            and curr["Close"] >= prev["Open"]
            and _body(curr) > _body(prev)
            and _trend_down(df.iloc[:-2])):
        return {
            "name": "상승 장악형 (Bullish Engulfing)",
            "name_en": "Bullish Engulfing",
            "signal": "bullish",
            "description": "매수세가 매도세를 완전히 압도. 전일 음봉을 감싸는 양봉 출현. 강력한 반전 신호.",
            "confidence": 0.8 if _is_near_low(df, curr) else 0.65,
        }
    return None


def detect_bearish_engulfing(df):
    """하락 장악형 (Bearish Engulfing)"""
    if len(df) < 7:
        return None
    prev = df.iloc[-2]
    curr = df.iloc[-1]

    if (_is_bullish(prev)
            and _is_bearish(curr)
            and curr["Open"] >= prev["Close"]
            and curr["Close"] <= prev["Open"]
            and _body(curr) > _body(prev)
            and _trend_up(df.iloc[:-2])):
        return {
            "name": "하락 장악형 (Bearish Engulfing)",
            "name_en": "Bearish Engulfing",
            "signal": "bearish",
            "description": "매도세가 시장을 완전히 장악. 전일 양봉을 감싸는 음봉 출현. 하락 반전 경고.",
            "confidence": 0.8 if _is_near_high(df, curr) else 0.65,
        }
    return None


def detect_piercing_line(df):
    """관통형 (Piercing Line) — 하락 추세에서 상승 반전"""
    if len(df) < 7:
        return None
    prev = df.iloc[-2]
    curr = df.iloc[-1]

    prev_mid = (prev["Open"] + prev["Close"]) / 2

    if (_is_bearish(prev)
            and _is_bullish(curr)
            and curr["Open"] < prev["Low"]
            and curr["Close"] > prev_mid
            and curr["Close"] < prev["Open"]
            and _trend_down(df.iloc[:-2])):
        return {
            "name": "관통형 (Piercing Line)",
            "name_en": "Piercing Line",
            "signal": "bullish",
            "description": "갭하락 출발 후 전일 음봉 50% 이상 회복. 하락 에너지 소진 신호.",
            "confidence": 0.65 if _is_near_low(df, curr) else 0.5,
        }
    return None


def detect_dark_cloud_cover(df):
    """흑운형 (Dark Cloud Cover) — 상승 추세에서 하락 반전"""
    if len(df) < 7:
        return None
    prev = df.iloc[-2]
    curr = df.iloc[-1]

    prev_mid = (prev["Open"] + prev["Close"]) / 2

    if (_is_bullish(prev)
            and _is_bearish(curr)
            and curr["Open"] > prev["High"]
            and curr["Close"] < prev_mid
            and curr["Close"] > prev["Open"]
            and _trend_up(df.iloc[:-2])):
        return {
            "name": "흑운형 (Dark Cloud Cover)",
            "name_en": "Dark Cloud Cover",
            "signal": "bearish",
            "description": "갭상승 출발 후 전일 양봉 50% 이하로 하락. 상승 분위기 반전 경고.",
            "confidence": 0.65 if _is_near_high(df, curr) else 0.5,
        }
    return None


# ─────────────────────────────────────────────
# 3개 캔들 조합 패턴
# ─────────────────────────────────────────────

def detect_morning_star(df):
    """샛별형 (Morning Star) — 하락 추세에서 강력한 상승 반전"""
    if len(df) < 8:
        return None
    d1 = df.iloc[-3]
    d2 = df.iloc[-2]
    d3 = df.iloc[-1]

    d1_mid = (d1["Open"] + d1["Close"]) / 2

    if (_is_bearish(d1)
            and _body(d1) > 0
            and _body(d2) < _body(d1) * 0.3
            and _is_bullish(d3)
            and d3["Close"] > d1_mid
            and _trend_down(df.iloc[:-3])):
        return {
            "name": "샛별형 (Morning Star)",
            "name_en": "Morning Star",
            "signal": "bullish",
            "description": "긴 음봉 → 작은 별 → 긴 양봉. 매도세 소멸 후 매수세 유입. 신뢰도 높은 반전 신호.",
            "confidence": 0.85 if _is_near_low(df, d3) else 0.7,
        }
    return None


def detect_evening_star(df):
    """석별형 (Evening Star) — 상승 추세에서 강력한 하락 반전"""
    if len(df) < 8:
        return None
    d1 = df.iloc[-3]
    d2 = df.iloc[-2]
    d3 = df.iloc[-1]

    d1_mid = (d1["Open"] + d1["Close"]) / 2

    if (_is_bullish(d1)
            and _body(d1) > 0
            and _body(d2) < _body(d1) * 0.3
            and _is_bearish(d3)
            and d3["Close"] < d1_mid
            and _trend_up(df.iloc[:-3])):
        return {
            "name": "석별형 (Evening Star)",
            "name_en": "Evening Star",
            "signal": "bearish",
            "description": "긴 양봉 → 작은 별 → 긴 음봉. 매수세 고갈 후 매도세 확인. 신뢰도 높은 하락 신호.",
            "confidence": 0.85 if _is_near_high(df, d3) else 0.7,
        }
    return None


def detect_three_white_soldiers(df):
    """적삼병 (Three White Soldiers) — 바닥에서 강력한 상승 전환"""
    if len(df) < 8:
        return None
    d1 = df.iloc[-3]
    d2 = df.iloc[-2]
    d3 = df.iloc[-1]

    if (_is_bullish(d1) and _is_bullish(d2) and _is_bullish(d3)
            and d2["Close"] > d1["Close"]
            and d3["Close"] > d2["Close"]
            and d2["Open"] > d1["Open"] and d2["Open"] < d1["Close"]
            and d3["Open"] > d2["Open"] and d3["Open"] < d2["Close"]
            and _body(d1) > 0 and _body(d2) > 0 and _body(d3) > 0):
        return {
            "name": "적삼병 (Three White Soldiers)",
            "name_en": "Three White Soldiers",
            "signal": "bullish",
            "description": "양봉 3연속 출현, 종가가 계속 고점 갱신. 강력한 상승 추세 전환.",
            "confidence": 0.85,
        }
    return None


def detect_three_black_crows(df):
    """흑삼병 (Three Black Crows) — 고점에서 강력한 하락 전환"""
    if len(df) < 8:
        return None
    d1 = df.iloc[-3]
    d2 = df.iloc[-2]
    d3 = df.iloc[-1]

    if (_is_bearish(d1) and _is_bearish(d2) and _is_bearish(d3)
            and d2["Close"] < d1["Close"]
            and d3["Close"] < d2["Close"]
            and d2["Open"] < d1["Open"] and d2["Open"] > d1["Close"]
            and d3["Open"] < d2["Open"] and d3["Open"] > d2["Close"]
            and _body(d1) > 0 and _body(d2) > 0 and _body(d3) > 0):
        return {
            "name": "흑삼병 (Three Black Crows)",
            "name_en": "Three Black Crows",
            "signal": "bearish",
            "description": "음봉 3연속, 종가가 계속 저점 갱신. 본격 하락세 전환 경고.",
            "confidence": 0.85,
        }
    return None


# ─────────────────────────────────────────────
# 종합 분석 함수
# ─────────────────────────────────────────────

ALL_DETECTORS = [
    # 단일 캔들
    detect_hammer,
    detect_hanging_man,
    detect_shooting_star,
    detect_inverted_hammer,
    detect_dragonfly_doji,
    detect_gravestone_doji,
    # 2개 캔들
    detect_bullish_engulfing,
    detect_bearish_engulfing,
    detect_piercing_line,
    detect_dark_cloud_cover,
    # 3개 캔들
    detect_morning_star,
    detect_evening_star,
    detect_three_white_soldiers,
    detect_three_black_crows,
]


def analyze_candle_patterns(df):
    """
    OHLCV DataFrame을 분석하여 감지된 캔들 패턴과 종합 판단을 반환합니다.

    Returns:
        dict: {
            "patterns": [...],         감지된 패턴 리스트
            "trend": "bullish" | "bearish" | "neutral",
            "trend_label": "상승세" | "하락세" | "중립",
            "trend_strength": 0~100,   추세 강도
            "buy_report": {...} | None, 매수 리포트
            "sell_report": {...} | None, 매도 리포트
            "recent_candles": [...],   최근 5일 캔들 데이터
        }
    """
    if df is None or len(df) < 10:
        return {
            "patterns": [],
            "trend": "neutral",
            "trend_label": "중립",
            "trend_strength": 50,
            "buy_report": None,
            "sell_report": None,
            "recent_candles": [],
        }

    # ── 패턴 감지 ──
    detected = []
    for detector in ALL_DETECTORS:
        result = detector(df)
        if result is not None:
            detected.append(result)

    # ── 거래량 분석 ──
    avg_vol = _avg_volume(df)
    latest_vol = float(df.iloc[-1]["Volume"])
    volume_surge = latest_vol / avg_vol if avg_vol > 0 else 1.0

    # 거래량 급증 시 신뢰도 보너스
    if volume_surge >= 1.5:
        for p in detected:
            p["confidence"] = min(1.0, p["confidence"] + 0.1)
            p["volume_surge"] = True
        volume_note = f"거래량 {volume_surge:.1f}배 급증 (신뢰도 ↑)"
    else:
        for p in detected:
            p["volume_surge"] = False
        volume_note = f"거래량 평균 수준 ({volume_surge:.1f}배)"

    # ── 종합 판단 ──
    bullish_score = sum(p["confidence"] for p in detected if p["signal"] == "bullish")
    bearish_score = sum(p["confidence"] for p in detected if p["signal"] == "bearish")
    total_score = bullish_score + bearish_score

    if total_score == 0:
        trend = "neutral"
        trend_label = "중립 (패턴 미감지)"
        trend_strength = 50
    elif bullish_score > bearish_score:
        trend = "bullish"
        trend_label = "상승세"
        trend_strength = min(95, int(50 + (bullish_score / total_score) * 50))
    elif bearish_score > bullish_score:
        trend = "bearish"
        trend_label = "하락세"
        trend_strength = min(95, int(50 + (bearish_score / total_score) * 50))
    else:
        trend = "neutral"
        trend_label = "중립 (상승/하락 균형)"
        trend_strength = 50

    # ── 이동평균선 계산 ──
    df["_MA5"] = df["Close"].rolling(window=5).mean()
    df["_MA10"] = df["Close"].rolling(window=10).mean()
    df["_MA20"] = df["Close"].rolling(window=20).mean()

    # ── 최근 캔들 데이터 (시각화용) ──
    recent_count = min(10, len(df))
    recent_candles = []
    for i in range(-recent_count, 0):
        row = df.iloc[i]
        candle = {
            "date": df.index[i].strftime("%m/%d"),
            "open": int(float(row["Open"])),
            "high": int(float(row["High"])),
            "low": int(float(row["Low"])),
            "close": int(float(row["Close"])),
            "volume": int(float(row["Volume"])),
            "is_bullish": bool(row["Close"] > row["Open"]),
        }
        # 이동평균선 값 (NaN이면 null)
        for ma_col, ma_key in [("_MA5", "ma5"), ("_MA10", "ma10"), ("_MA20", "ma20")]:
            val = row.get(ma_col)
            candle[ma_key] = round(float(val)) if pd.notna(val) else None
        recent_candles.append(candle)

    latest = df.iloc[-1]
    current_price = float(latest["Close"])

    # ── 매수 리포트 ──
    buy_report = None
    bullish_patterns = [p for p in detected if p["signal"] == "bullish"]
    if bullish_patterns:
        best = max(bullish_patterns, key=lambda p: p["confidence"])

        # 매수가 산정: 공격적 = 현재 종가, 보수적 = 고가 돌파 시점
        aggressive_price = int(current_price)
        conservative_price = int(float(latest["High"]))

        # 손절가: 패턴 캔들 조합의 최저점
        stop_loss_lookback = 3
        recent_lows = [float(df.iloc[i]["Low"]) for i in range(-stop_loss_lookback, 0)]
        stop_loss = int(min(recent_lows))

        # 목표가: 손절 대비 2:1 리스크/리워드 비율
        risk = current_price - stop_loss
        target_price = int(current_price + risk * 2) if risk > 0 else int(current_price * 1.05)

        buy_report = {
            "signal_strength": round(best["confidence"] * 100),
            "primary_pattern": best["name"],
            "aggressive_entry": aggressive_price,
            "conservative_entry": conservative_price,
            "stop_loss": stop_loss,
            "target_price": target_price,
            "risk_reward": "1:2",
            "volume_note": volume_note,
            "entry_tip": "패턴 확인 후 다음 날 양봉 출현 또는 고가 돌파 시 진입 권장",
        }

    # ── 매도 리포트 (보유자 관점: 하락 신호 감지 → 매도 권고) ──
    sell_report = None
    bearish_patterns = [p for p in detected if p["signal"] == "bearish"]
    if bearish_patterns:
        best = max(bearish_patterns, key=lambda p: p["confidence"])

        # 즉시 매도가: 현재 종가
        sell_price = int(current_price)
        # 보수적 매도가: 최근 저점 이탈 시 (지지선 붕괴 확인 후)
        conservative_sell = int(float(latest["Low"]))

        # 손절가 (보유자 관점): 아직 매도하지 못했을 때의 최대 허용 손실
        # → 최근 저점 아래로 일정 비율 (ATR 기반 또는 최근 변동폭 기반)
        recent_lows = [float(df.iloc[i]["Low"]) for i in range(-5, 0)]
        recent_highs = [float(df.iloc[i]["High"]) for i in range(-5, 0)]
        recent_range = max(recent_highs) - min(recent_lows)
        # 손절가 = 최근 5일 최저점 - 변동폭의 30% (하방 여유)
        stop_loss_sell = int(min(recent_lows) - recent_range * 0.3)

        # 목표가 (예상 하락 도달가): 하락 신호 기반 예상 하락폭
        # 최근 고점 → 현재가까지의 하락폭만큼 추가 하락 예상
        recent_high_max = max(recent_highs)
        decline_from_high = recent_high_max - current_price
        target_sell = int(current_price - decline_from_high) if decline_from_high > 0 else int(current_price * 0.95)

        sell_report = {
            "signal_strength": round(best["confidence"] * 100),
            "primary_pattern": best["name"],
            "sell_price": sell_price,
            "conservative_sell": conservative_sell,
            "stop_loss": stop_loss_sell,
            "target_price": target_sell,
            "risk_reward": "1:2",
            "volume_note": volume_note,
            "exit_tip": "패턴 완성 다음 날 음봉 확인 또는 저점 이탈 시 매도 권장",
        }

    return {
        "patterns": detected,
        "trend": trend,
        "trend_label": trend_label,
        "trend_strength": trend_strength,
        "buy_report": buy_report,
        "sell_report": sell_report,
        "recent_candles": recent_candles,
        "volume_note": volume_note,
    }
