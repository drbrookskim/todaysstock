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
# 다중 캔들 (중기~장기) 반전 및 지속 패턴
# ─────────────────────────────────────────────
import numpy as np

def _find_local_extrema(df, order=3):
    """로컬 고점(Peaks)과 저점(Troughs) 검출"""
    highs = df['High'].values
    lows = df['Low'].values
    local_peaks = []
    local_troughs = []
    
    n = len(df)
    for i in range(order, n - order):
        if highs[i] == max(highs[i - order:i + order + 1]):
            local_peaks.append((i, highs[i]))
        if lows[i] == min(lows[i - order:i + order + 1]):
            local_troughs.append((i, lows[i]))
            
    return local_peaks, local_troughs

def detect_triple_bottom(df):
    """삼중 바닥형 (Triple Bottom)"""
    if len(df) < 20: return None
    peaks, troughs = _find_local_extrema(df, order=3)
    if len(troughs) < 3: return None
    
    t1, t2, t3 = troughs[-3:]
    v1, v2, v3 = t1[1], t2[1], t3[1]
    
    avg_v = (v1 + v2 + v3) / 3
    if abs(v1-avg_v)/avg_v < 0.03 and abs(v2-avg_v)/avg_v < 0.03 and abs(v3-avg_v)/avg_v < 0.03:
        current_close = float(df['Close'].iloc[-1])
        if current_close > v3 and (current_close - v3) / v3 < 0.08:
            return {
                "name": "삼중 바닥형 (Triple Bottom)",
                "name_en": "Triple Bottom",
                "signal": "bullish",
                "description": "3번의 바닥 지지 무사 확인. 강력한 매수세 유입 암시 및 상승 에너지 응축 중.",
                "confidence": 0.88,
                "type": "reversal"
            }
    return None

def detect_triple_top(df):
    """삼중 천장형 (Triple Top)"""
    if len(df) < 20: return None
    peaks, troughs = _find_local_extrema(df, order=3)
    if len(peaks) < 3: return None
    
    p1, p2, p3 = peaks[-3:]
    v1, v2, v3 = p1[1], p2[1], p3[1]
    
    avg_v = (v1 + v2 + v3) / 3
    if abs(v1-avg_v)/avg_v < 0.03 and abs(v2-avg_v)/avg_v < 0.03 and abs(v3-avg_v)/avg_v < 0.03:
        current_close = float(df['Close'].iloc[-1])
        if current_close < v3 and (v3 - current_close) / v3 < 0.08:
            return {
                "name": "삼중 천장형 (Triple Top)",
                "name_en": "Triple Top",
                "signal": "bearish",
                "description": "3번의 천장 저항 확인. 매수세 소진 및 강력한 매도 압력 형성.",
                "confidence": 0.88,
                "type": "reversal"
            }
    return None

def detect_double_bottom(df):
    """이중 바닥형 (Double Bottom / 쌍바닥)"""
    if len(df) < 15: return None
    peaks, troughs = _find_local_extrema(df, order=3)
    if len(troughs) < 2: return None
    
    t1, t2 = troughs[-2:]
    v1, v2 = t1[1], t2[1]
    
    if abs(v1 - v2) / max(v1, v2) < 0.03:
        current_close = float(df['Close'].iloc[-1])
        if current_close > v2 and (current_close - v2) / v2 < 0.08:
            return {
                "name": "이중 바닥형 (Double Bottom / 쌍바닥)",
                "name_en": "Double Bottom",
                "signal": "bullish",
                "description": "W자 형태의 전형적인 바닥 다지기. 하락 추세 종료 및 턴어라운드(Turn-around) 임박.",
                "confidence": 0.85,
                "type": "reversal"
            }
    return None

def detect_double_top(df):
    """이중 천장형 (Double Top / 쌍봉)"""
    if len(df) < 15: return None
    peaks, troughs = _find_local_extrema(df, order=3)
    if len(peaks) < 2: return None
    
    p1, p2 = peaks[-2:]
    v1, v2 = p1[1], p2[1]
    
    if abs(v1 - v2) / max(v1, v2) < 0.03:
        current_close = float(df['Close'].iloc[-1])
        if current_close < v2 and (v2 - current_close) / v2 < 0.08:
            return {
                "name": "이중 천장형 (Double Top / 쌍봉)",
                "name_en": "Double Top",
                "signal": "bearish",
                "description": "M자 형태의 전형적인 고점 패턴. 단단한 저항대 확인 및 단기 하방 압력 강세.",
                "confidence": 0.85,
                "type": "reversal"
            }
    return None

def detect_head_and_shoulders(df):
    """헤드 앤 숄더 (Head and Shoulders)"""
    if len(df) < 20: return None
    peaks, troughs = _find_local_extrema(df, order=3)
    if len(peaks) < 3: return None
    
    p1, p2, p3 = peaks[-3:]
    v1, v2, v3 = p1[1], p2[1], p3[1]
    
    if v2 > v1 and v2 > v3:
        if abs(v1 - v3) / max(v1, v3) < 0.05: # 양 어깨 높이가 비슷함
            current_close = float(df['Close'].iloc[-1])
            if current_close < v3:
                return {
                    "name": "헤드 앤 숄더 (Head & Shoulders)",
                    "name_en": "Head and Shoulders",
                    "signal": "bearish",
                    "description": "왼쪽 어깨, 머리, 오른쪽 어깨를 형성한 최고점 시그널. 강력한 하락세 전환 경고.",
                    "confidence": 0.90,
                }
    return None

def detect_inverse_head_and_shoulders(df):
    """역 헤드 앤 숄더 (Inverse Head and Shoulders)"""
    if len(df) < 20: return None
    peaks, troughs = _find_local_extrema(df, order=3)
    if len(troughs) < 3: return None
    
    t1, t2, t3 = troughs[-3:]
    v1, v2, v3 = t1[1], t2[1], t3[1]
    
    if v2 < v1 and v2 < v3:
        if abs(v1 - v3) / min(v1, v3) < 0.05:
            current_close = float(df['Close'].iloc[-1])
            if current_close > v3:
                return {
                    "name": "역 헤드 앤 숄더 (Inverse H&S)",
                    "name_en": "Inverse Head and Shoulders",
                    "signal": "bullish",
                    "description": "역 헤드 앤 숄더 패턴 완성 시도. 하락 추세의 종류와 강력한 상승세 시작 가능성.",
                    "confidence": 0.90,
                }
    return None

def detect_asc_desc_triangle(df):
    """상승/하락 삼각형 (Ascending/Descending Triangle)"""
    if len(df) < 20: return None
    peaks, troughs = _find_local_extrema(df, order=2)
    if len(peaks) < 3 or len(troughs) < 3: return None
    
    recent_peaks = [p[1] for p in peaks[-3:]]
    recent_troughs = [t[1] for t in troughs[-3:]]
    
    peak_diff = max(recent_peaks) - min(recent_peaks)
    trough_diff = max(recent_troughs) - min(recent_troughs)
    
    flat_peaks = peak_diff / np.mean(recent_peaks) < 0.02
    flat_troughs = trough_diff / np.mean(recent_troughs) < 0.02
    
    rising_troughs = recent_troughs[0] < recent_troughs[1] < recent_troughs[2]
    falling_peaks = recent_peaks[0] > recent_peaks[1] > recent_peaks[2]
    
    current_close = float(df['Close'].iloc[-1])
    
    if flat_peaks and rising_troughs:
        if current_close >= min(recent_peaks) * 0.98:
            return {
                "name": "상승 삼각형 (Ascending Triangle)",
                "name_en": "Ascending Triangle",
                "signal": "bullish",
                "description": "고점은 유지되지만 저점이 지속적으로 높아짐. 상단 돌파 시 매우 긍정적 기류.",
                "confidence": 0.85,
            }
            
    if flat_troughs and falling_peaks:
        if current_close <= max(recent_troughs) * 1.02:
            return {
                "name": "하락 삼각형 (Descending Triangle)",
                "name_en": "Descending Triangle",
                "signal": "bearish",
                "description": "저점은 수평이지만 고점은 점점 낮아짐. 하방 이탈 가능성 고조로 각별한 주의 요구.",
                "confidence": 0.85,
            }
    return None

def detect_rounding_bottom(df):
    """원형 바닥형 (Rounding Bottom)"""
    if len(df) < 40: return None
    recent = df.iloc[-40:]
    lows = recent['Low'].values
    
    x = np.arange(len(lows))
    coeffs = np.polyfit(x, lows, 2)
    a, b, c = coeffs
    
    if a > 0:
        vertex_x = -b / (2 * a)
        if 10 < vertex_x < 30:
            current_close = float(df['Close'].iloc[-1])
            min_low = float(min(lows))
            if current_close > min_low and (current_close - min_low) / min_low > 0.05:
                 return {
                    "name": "원형 바닥형 (Rounding Bottom)",
                    "name_en": "Rounding Bottom",
                    "signal": "bullish",
                    "description": "긴 시간 동안 완만하게 저점을 다진 U자 패턴. 안정적이고 강한 상승 추세의 시작점.",
                    "confidence": 0.85,
                    "type": "reversal"
                }
    return None

def detect_rounding_top(df):
    """원형 천장형 (Rounding Top)"""
    if len(df) < 40: return None
    recent = df.iloc[-40:]
    highs = recent['High'].values
    
    x = np.arange(len(highs))
    coeffs = np.polyfit(x, highs, 2)
    a, b, c = coeffs
    
    if a < 0:
        vertex_x = -b / (2 * a)
        if 10 < vertex_x < 30:
            current_close = float(df['Close'].iloc[-1])
            max_high = float(max(highs))
            if current_close < max_high and (max_high - current_close) / max_high > 0.05:
                 return {
                    "name": "원형 천장형 (Rounding Top)",
                    "name_en": "Rounding Top",
                    "signal": "bearish",
                    "description": "완만한 역 U자 곡선을 그리며 서서히 하락 전환. 매도 압력이 점진적으로 강해지는 중.",
                    "confidence": 0.85,
                    "type": "reversal"
                }
    return None

def detect_symmetrical_triangle(df):
    """대칭 삼각형 (Symmetrical Triangle)"""
    if len(df) < 20: return None
    peaks, troughs = _find_local_extrema(df, order=2)
    if len(peaks) < 3 or len(troughs) < 3: return None
    
    recent_peaks = [p[1] for p in peaks[-3:]]
    recent_troughs = [t[1] for t in troughs[-3:]]
    
    rising_troughs = recent_troughs[0] < recent_troughs[1] < recent_troughs[2]
    falling_peaks = recent_peaks[0] > recent_peaks[1] > recent_peaks[2]
    
    if rising_troughs and falling_peaks:
        current_close = float(df['Close'].iloc[-1])
        if current_close > recent_peaks[-1]:
            return {
                "name": "대칭 삼각형 상방 돌파 (Symmetrical Triangle Breakout)",
                "name_en": "Symmetrical Triangle Breakout",
                "signal": "bullish",
                "description": "힘의 균형을 이루며 수렴하던 삼각 패턴을 상방으로 강하게 뚫어냄. 강력한 매수 에너지 발생.",
                "confidence": 0.82,
            }
        elif current_close < recent_troughs[-1]:
            return {
                "name": "대칭 삼각형 하방 이탈 (Symmetrical Triangle Breakdown)",
                "name_en": "Symmetrical Triangle Breakdown",
                "signal": "bearish",
                "description": "힘의 균형이 깨지며 하방으로 이탈함. 단기적/중기적 하락 추세 전조 증상.",
                "confidence": 0.82,
            }
    return None

def detect_rectangle(df):
    """박스권 / 직사각형 패턴 (Rectangle)"""
    if len(df) < 20: return None
    peaks, troughs = _find_local_extrema(df, order=2)
    if len(peaks) < 3 or len(troughs) < 3: return None
    
    recent_peaks = [p[1] for p in peaks[-3:]]
    recent_troughs = [t[1] for t in troughs[-3:]]
    
    peak_diff = max(recent_peaks) - min(recent_peaks)
    trough_diff = max(recent_troughs) - min(recent_troughs)
    
    flat_peaks = peak_diff / np.mean(recent_peaks) < 0.02
    flat_troughs = trough_diff / np.mean(recent_troughs) < 0.02
    
    if flat_peaks and flat_troughs:
        current_close = float(df['Close'].iloc[-1])
        if current_close > max(recent_peaks):
             return {
                "name": "박스권 상단 돌파 (Rectangle Breakout)",
                "name_en": "Rectangle Breakout",
                "signal": "bullish",
                "description": "긴 횡보장(박스권)의 천장 저항을 폭발적으로 돌파. 에너지가 분출되는 강한 매수 시그널.",
                "confidence": 0.85,
            }
        elif current_close < min(recent_troughs):
            return {
                "name": "박스권 하단 이탈 (Rectangle Breakdown)",
                "name_en": "Rectangle Breakdown",
                "signal": "bearish",
                "description": "박스권 바닥이 무너짐. 매물벽이 두터워지고 추가 급락이 우려되는 매도 포지션.",
                "confidence": 0.85,
            }
    return None

def detect_wedge(df):
    """쐐기형 (Wedge)"""
    if len(df) < 20: return None
    peaks, troughs = _find_local_extrema(df, order=2)
    if len(peaks) < 3 or len(troughs) < 3: return None
    
    recent_peaks = [p[1] for p in peaks[-3:]]
    recent_troughs = [t[1] for t in troughs[-3:]]
    
    rising_troughs = recent_troughs[0] < recent_troughs[1] < recent_troughs[2]
    rising_peaks = recent_peaks[0] < recent_peaks[1] < recent_peaks[2]
    
    falling_troughs = recent_troughs[0] > recent_troughs[1] > recent_troughs[2]
    falling_peaks = recent_peaks[0] > recent_peaks[1] > recent_peaks[2]
    
    current_close = float(df['Close'].iloc[-1])
    
    if falling_peaks and falling_troughs:
        peak_slope = recent_peaks[-1] - recent_peaks[0]
        trough_slope = recent_troughs[-1] - recent_troughs[0]
        if peak_slope < trough_slope:
            if current_close > recent_peaks[-1]:
                return {
                    "name": "하락 쐐기형 돌파 (Falling Wedge Breakout)",
                    "name_en": "Falling Wedge",
                    "signal": "bullish",
                    "description": "하락 쐐기형의 빗장 저항을 뚫음. 강력한 브레이크아웃형 상승 추세 스타트.",
                    "confidence": 0.88,
                }
                
    if rising_peaks and rising_troughs:
         peak_slope = recent_peaks[-1] - recent_peaks[0]
         trough_slope = recent_troughs[-1] - recent_troughs[0]
         if trough_slope > peak_slope:
             if current_close < recent_troughs[-1]:
                 return {
                    "name": "상승 쐐기형 이탈 (Rising Wedge Breakdown)",
                    "name_en": "Rising Wedge",
                    "signal": "bearish",
                    "description": "상승 쐐기의 하단 지지선을 깨트림. 매수 에너지가 소진되어 단기 급락 위험 점증.",
                    "confidence": 0.88,
                }
def detect_flags_and_pennants(df):
    """상승/하락 깃발형 및 페넌트형 (Flags and Pennants)"""
    if len(df) < 25: return None
    # 깃대 (Pole) 감지 (최근 10~25일 사이의 빠르고 강한 변동성)
    pole_window = df.iloc[-25:-10]
    flag_window = df.iloc[-10:]
    
    pole_high = pole_window['High'].max()
    pole_low = pole_window['Low'].min()
    pole_trend = "bullish" if float(pole_window['Close'].iloc[-1]) > float(pole_window['Open'].iloc[0]) else "bearish"
    
    if (pole_high - pole_low) / pole_low < 0.15: # 깃대가 충분히 길지 않으면 패스
        return None
        
    flag_high = flag_window['High'].max()
    flag_low = flag_window['Low'].min()
    current_close = float(df['Close'].iloc[-1])
    
    # 작은 횡보(깃발) 구간
    if (flag_high - flag_low) / flag_low < 0.08: 
        if pole_trend == "bullish" and current_close > flag_high * 0.98:
            return {
                "name": "상승 깃발/페넌트형 (Bullish Flag/Pennant)",
                "name_en": "Bullish Flag",
                "signal": "bullish",
                "description": "강한 상승 후 짧은 기간의 휴지기(수렴). 응축된 에너지를 바탕으로 2차 급등 가능성 짙음.",
                "confidence": 0.86,
                "type": "continuation"
            }
        elif pole_trend == "bearish" and current_close < flag_low * 1.02:
            return {
                "name": "하락 깃발/페넌트형 (Bearish Flag/Pennant)",
                "name_en": "Bearish Flag",
                "signal": "bearish",
                "description": "강한 하락 후 짧은 반등/횡보(수렴). 하방 지지력이 약해 2차 급락 발생 확률 높음.",
                "confidence": 0.86,
                "type": "continuation"
            }
    return None

def detect_v_bottom(df):
    """V자형 반등 (V-Bottom)"""
    if len(df) < 10: return None
    recent_10 = df.iloc[-10:]
    min_idx = recent_10["Low"].idxmin()
    min_val = float(recent_10.loc[min_idx]["Low"])
    
    min_pos = df.index.get_loc(min_idx)
    current_pos = len(df) - 1
    
    if 1 <= current_pos - min_pos <= 4:
        pre_fall_high = float(df.iloc[min_pos - 5:min_pos]["High"].max())
        if (pre_fall_high - min_val) / pre_fall_high > 0.08:
            current_close = float(df['Close'].iloc[-1])
            if (current_close - min_val) / (pre_fall_high - min_val) > 0.5:
                return {
                    "name": "V자형 반등 (V-Bottom)",
                    "name_en": "V-Bottom",
                    "signal": "bullish",
                    "description": "단기 급락 후 과매도 구간(V자 계곡) 탈출. 강력한 재매수 유입 확인.",
                    "confidence": 0.80,
                }
    return None

def detect_near_miss_patterns(df):
    """
    명확한 조건에 부합하지 않아 확정 패턴이 없는 경우,
    조건 임계치를 완화하여 '형성될 가능성이 있는' 잠재 패턴을 반환.
    """
    if len(df) < 20: return None
    peaks, troughs = _find_local_extrema(df, order=3)
    
    current_close = float(df['Close'].iloc[-1])
    
    # 1. 쌍바닥 (Double Bottom) Near-Miss (오차 0.03 -> 0.08 완화)
    if len(troughs) >= 2:
        t1, t2 = troughs[-2:]
        v1, v2 = t1[1], t2[1]
        
        if abs(v1 - v2) / max(v1, v2) < 0.08:
            if current_close > v2 * 0.97: # 살짝 덜 올랐어도 인정 (잠재적)
                return {
                    "name": "잠재적 이중 바닥형 (Double Bottom 가능성)",
                    "name_en": "Double Bottom (Near-Miss)",
                    "signal": "bullish",
                    "description": "현재 뚜렷한 확정 패턴은 없으나, [이중 바닥형(쌍바닥)] 패턴이 형성될 가능성이 관측되고 있습니다. 지지선 이탈 여부를 주의 깊게 관찰하세요.",
                    "confidence": 0.45,
                    "type": "reversal"
                }

    # 2. 쌍봉 (Double Top) Near-Miss (오차 0.03 -> 0.08 완화)
    if len(peaks) >= 2:
        p1, p2 = peaks[-2:]
        v1, v2 = p1[1], p2[1]
        
        if abs(v1 - v2) / max(v1, v2) < 0.08:
            if current_close < v2 * 1.03:
                return {
                    "name": "잠재적 이중 천장형 (Double Top 가능성)",
                    "name_en": "Double Top (Near-Miss)",
                    "signal": "bearish",
                    "description": "현재 뚜렷한 확정 패턴은 없으나, [이중 천장형(쌍봉)] 패턴이 형성될 가능성이 관측되고 있습니다. 단기 고점 저항 돌파 여부 확인이 필요합니다.",
                    "confidence": 0.45,
                    "type": "reversal"
                }

    # 3. 헤드 앤 숄더 Near-Miss (어깨 오차 0.05 -> 0.12 완화)
    if len(peaks) >= 3:
        p1, p2, p3 = peaks[-3:]
        v1, v2, v3 = p1[1], p2[1], p3[1]
        
        if v2 > v1 and v2 > v3:
            if abs(v1 - v3) / max(v1, v3) < 0.12:
                if current_close < v3 * 1.04: 
                    return {
                        "name": "잠재적 헤드 앤 숄더 (H&S 가능성)",
                        "name_en": "Head and Shoulders (Near-Miss)",
                        "signal": "bearish",
                        "description": "현재 뚜렷한 확정 패턴은 없으나, 강력한 하단 압력 시그널인 [헤드 앤 숄더] 패턴이 형성될 조짐이 보입니다. 각별한 리스크 관리가 요구됩니다.",
                        "confidence": 0.45,
                        "type": "reversal"
                    }

    return None

def detect_fibonacci_retracement(df):
    """
    피보나치 되돌림 (Fibonacci Retracement)
    상승 구조(Swing Low -> Swing High) 파악 후 조정 구간에서 진입점 탐색.
    NotebookLM 전략: 38.2%, 61.8%, 78.6%, 88.6% 되돌림 시 진입.
    20일선 등 주요 이평선과 결합 시(Confluence) 신뢰도 상승.
    """
    lookback = min(60, len(df))
    if lookback < 20:
        return None
        
    recent = df.iloc[-lookback:-1] # 전일까지의 파동
    current = df.iloc[-1]
    
    # 1. 상승 구조 판별
    min_idx = recent["Low"].idxmin()
    max_idx = recent["High"].idxmax()
    
    if min_idx >= max_idx:
        return None # 하락 구조이거나 스윙 로우가 스윙 하이보다 나중에 나옴 (상승 파동 아님)
        
    swing_low = recent.loc[min_idx, "Low"]
    swing_high = recent.loc[max_idx, "High"]
    wave_range = swing_high - swing_low
    
    if wave_range == 0:
        return None
        
    curr_price = current["Close"]
    drawdown = swing_high - curr_price
    retracement_pct = drawdown / wave_range
    
    # 2. 피보나치 레벨 (진입, 손절)
    fib_levels = {
        "38.2% (충동적)": (0.382, 0.618),
        "61.8% (골든존)": (0.618, 0.886),
        "78.6% (기관)": (0.786, 1.13),
        "88.6% (딥)": (0.886, 1.13)
    }
    
    tolerance = 0.04 # 4% 오차 허용
    matched_level = None
    stop_loss_pct = None
    
    for name, (entry, stop) in fib_levels.items():
        if abs(retracement_pct - entry) <= tolerance:
            matched_level = name
            stop_loss_pct = stop
            break
            
    if not matched_level:
        return None
        
    # 3. 컨플루언스 (MA20 지지 여부)
    ma20 = df["Close"].iloc[-20:].mean() if len(df) >= 20 else 0
    has_confluence = False
    if ma20 > 0:
        ma_diff = abs(curr_price - ma20) / curr_price
        if ma_diff <= 0.03: # 3% 이내 근접 시
            has_confluence = True
            
    target_1 = swing_high + (wave_range * 0.272)
    target_2 = swing_high + (wave_range * 0.618)
    stop_loss_price = swing_high - (wave_range * stop_loss_pct)
    
    desc = f"강한 상승 파동 이후 피보나치 {matched_level} 되돌림 도달."
    if has_confluence:
        desc += " 20일 이평선 지지가 맞물려(Confluence) 신뢰도가 매우 높습니다."
    else:
        desc += " 이동평균선과 다소 이격이 있어 1차 분할 매수만 권장합니다."
        
    return {
        "name": "피보나치 되돌림 (Fibonacci)",
        "name_en": "Fibonacci Retracement",
        "signal": "bullish",
        "description": desc,
        "confidence": 0.85 if has_confluence else 0.65,
        "fib_data": {
            "level": matched_level,
            "stop_loss": stop_loss_price,
            "target_1": target_1,
            "target_2": target_2
        }
    }


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
    # 다중 캔들 및 특수 패턴
    detect_triple_bottom,
    detect_triple_top,
    detect_double_bottom,
    detect_double_top,
    detect_head_and_shoulders,
    detect_inverse_head_and_shoulders,
    detect_asc_desc_triangle,
    detect_v_bottom,
    detect_rounding_bottom,
    detect_rounding_top,
    detect_symmetrical_triangle,
    detect_rectangle,
    detect_wedge,
    detect_flags_and_pennants,
    detect_fibonacci_retracement,
]


def analyze_recent_week(df):
    """최근 5거래일(1주일) 동안의 일별 캔들 분석 코멘트 생성"""
    if len(df) < 5:
        return []

    recent_5 = df.tail(5)
    prev_5 = df.shift(1).tail(5) # 전일 데이터
    
    analysis_list = []
    
    for i in range(5):
        row = recent_5.iloc[i]
        prev_row = prev_5.iloc[i]
        
        # Datetime Format Check (Pandas Index)
        try:
            date_str = row.name.strftime("%m/%d")
        except AttributeError:
            date_str = str(row.name)[-5:] if isinstance(row.name, str) else str(row.name)

        open_p = float(row["Open"])
        close_p = float(row["Close"])
        high_p = float(row["High"])
        low_p = float(row["Low"])
        
        prev_open_p = float(prev_row["Open"]) if pd.notna(prev_row["Open"]) else open_p
        prev_close_p = float(prev_row["Close"]) if pd.notna(prev_row["Close"]) else close_p
        prev_high_p = float(prev_row["High"]) if pd.notna(prev_row["High"]) else high_p
        
        body = abs(close_p - open_p)
        upper_wick = high_p - max(open_p, close_p)
        lower_wick = min(open_p, close_p) - low_p
        
        desc = ""
        is_bullish = close_p > open_p
        is_bearish = close_p < open_p
        
        if is_bullish:
            desc += "양봉"
            if high_p > prev_high_p:
                desc += " (전일 고점 돌파)"
        elif is_bearish:
            desc += "음봉"
            prev_mid = (prev_open_p + prev_close_p) / 2
            if prev_close_p > prev_open_p and close_p < prev_mid:
                desc += " (전일 양봉의 절반 이탈)"
        else:
            desc += "십자도지(보합)"
            
        # 꼬리 분석 (몸통보다 1.5배 이상 길면 특징적이라고 판단)
        if body > 0:
            if upper_wick > body * 1.5:
                desc += ", 긴 윗꼬리 (단기 매도 압력)"
            if lower_wick > body * 1.5:
                desc += ", 긴 아랫꼬리 (저점 매수세 유입)"
        else:
            # 도지 캔들의 경우
            if upper_wick > (high_p - low_p) * 0.4:
                desc += ", 윗꼬리 도지"
            elif lower_wick > (high_p - low_p) * 0.4:
                desc += ", 아랫꼬리 도지"

        analysis_list.append({
            "date": date_str,
            "desc": desc
        })
        
    return analysis_list

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

    # ── 잠재적 패턴 (Near-Miss) 감지 ──
    if not detected:
        near_miss = detect_near_miss_patterns(df)
        if near_miss:
            detected.append(near_miss)

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
        trend_label = "상승세 (저항선 부근 분할 매도로 수익 실현 고려)"
        trend_strength = min(95, int(50 + (bullish_score / total_score) * 50))
    elif bearish_score > bullish_score:
        trend = "bearish"
        trend_label = "하락세 (섣부른 물타기 금지, 지지선 반등 확인 후 접근)"
        trend_strength = min(95, int(50 + (bearish_score / total_score) * 50))
    else:
        trend = "neutral"
        trend_label = "중립 (방향성 탐색 중, 관망 권고)"
        trend_strength = 50

    # ── 이동평균선 계산 ──
    df["_MA5"] = df["Close"].rolling(window=5).mean()
    df["_MA10"] = df["Close"].rolling(window=10).mean()
    df["_MA20"] = df["Close"].rolling(window=20).mean()
    df["_MA60"] = df["Close"].rolling(window=60).mean()
    df["_MA120"] = df["Close"].rolling(window=120).mean()

    # ── 최근 캔들 데이터 (시각화용) ──
    recent_count = min(60, len(df))
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
        for ma_col, ma_key in [("_MA5", "ma5"), ("_MA10", "ma10"), ("_MA20", "ma20"), ("_MA60", "ma60"), ("_MA120", "ma120")]:
            val = row.get(ma_col)
            candle[ma_key] = round(float(val)) if pd.notna(val) else None
        recent_candles.append(candle)

    latest = df.iloc[-1]
    current_price = float(latest["Close"])

    # ── 매수 리포트 ──
    bullish_patterns = [p for p in detected if p["signal"] == "bullish"]
    if bullish_patterns:
        best_buy = max(bullish_patterns, key=lambda p: p["confidence"])
        buy_signal_strength = round(best_buy["confidence"] * 100)
        buy_primary_pattern = best_buy["name"]
        buy_primary_desc = best_buy["description"]

        # 매수가 산정: 공격적 = 현재 종가(바로 진입), 보수적 = 20일 이평선 또는 최근 저점 부근 눌림목 대기
        aggressive_price = int(current_price)
        ma20_val = float(latest.get("_MA20", 0)) if pd.notna(latest.get("_MA20")) else 0
        recent_low = float(latest["Low"])
        
        # 보수적 매수가: 20일선이 계산되어 있고 20일선 위에 주가가 있다면 20일선 타겟, 아니면 최근 저점
        if ma20_val > 0 and current_price > ma20_val:
            conservative_price = int(ma20_val * 1.01) # 20일선 살짝 위에서 지지 매수
        else:
            conservative_price = int(recent_low) if recent_low < current_price else int(current_price * 0.98)

        # 손절가: 진입 근거가 된 최근 3일 최저점 혹은 20일선 이탈 중 더 타이트한 가격
        stop_loss_lookback = 3
        recent_lows = [float(df.iloc[i]["Low"]) for i in range(-stop_loss_lookback, 0)]
        pattern_low = min(recent_lows)
        
        if ma20_val > 0 and pattern_low > ma20_val:
            stop_loss = int(ma20_val * 0.99) # 20일선 약간 아래
        else:
            stop_loss = int(pattern_low)

        # 목표가: 라운드 피겨(Round Figure) 저항선 적용 또는 손익비 1:2
        risk = current_price - stop_loss
        base_target = current_price + risk * 2 if risk > 0 else current_price * 1.05
        
        # 피보나치 전략 데이터 반영 (다른 패턴보다 우선)
        fib_patterns = [p for p in bullish_patterns if "fib_data" in p]
        if fib_patterns:
            fib_data = fib_patterns[0]["fib_data"]
            conservative_price = int(current_price) # 피보나치 타점은 현재가 자체가 보수적 지지선
            stop_loss = int(fib_data["stop_loss"])
            base_target = fib_data["target_1"]
            fib_msg = f" [투사 목표가] 1차: {int(fib_data['target_1']):,}원 / 2차: {int(fib_data['target_2']):,}원"
            if "투사 목표가" not in buy_primary_desc:
                buy_primary_desc += fib_msg
        
        # 라운드 피겨 계산 (예: 12000 -> 11900 부근 매스팅)
        magnitude = 10 ** (len(str(int(base_target))) - 1)
        if magnitude >= 1000:
            round_target = (int(base_target) // magnitude + 1) * magnitude
            target_price = int(round_target * 0.99) # 라운드 피겨 약간 아래 (저항 전 매도)
        else:
            target_price = int(base_target)
    else:
        buy_signal_strength = 30
        buy_primary_pattern = "강한 매수 패턴 미감지"
        buy_primary_desc = "현재 뚜렷한 상승 반전 및 지속 패턴이 발견되지 않았습니다. 지지선에서 강한 양봉이 출현하는지 관망이 필요합니다."
        
        aggressive_price = "보류"
        conservative_price = "보류"
        stop_loss = "보류"
        target_price = "보류"

    buy_report = {
        "signal_strength": buy_signal_strength,
        "primary_pattern": buy_primary_pattern,
        "primary_pattern_desc": buy_primary_desc,
        "aggressive_entry": aggressive_price,
        "conservative_entry": conservative_price,
        "stop_loss": stop_loss,
        "target_price": target_price,
        "risk_reward": "1:2",
        "volume_note": volume_note,
        "entry_tip": "뚜렷한 패턴 부재 시, 이전 저점 부근에서의 지지 여부를 최우선으로 확인하세요.",
    }

    # ── 매도 리포트 (보유자 관점: 하락 신호 감지 → 매도 권고) ──
    bearish_patterns = [p for p in detected if p["signal"] == "bearish"]
    if bearish_patterns:
        best_sell = max(bearish_patterns, key=lambda p: p["confidence"])
        sell_signal_strength = round(best_sell["confidence"] * 100)
        sell_primary_pattern = best_sell["name"]
        sell_primary_desc = best_sell["description"]

        # 즉시 매도가: 현재 종가 (손실 최소화/수익 실현)
        sell_price = int(current_price)
        # 보수적 매도가: 라운드 피겨 저항선 적용 (저항 전에 미리 매도)
        recent_high = float(latest["High"])
        base_sell = recent_high if recent_high > current_price else current_price * 1.05
        magnitude = 10 ** (len(str(int(base_sell))) - 1)
        if magnitude >= 1000:
            round_target = (int(base_sell) // magnitude + 1) * magnitude
            conservative_sell = int(round_target * 0.99) # 라운드 피겨 1~2호가 아래
        else:
            conservative_sell = int(base_sell)

        # 손절가 (보유자 관점): 아직 매도하지 못했을 때의 최대 허용 손실
        # 20일 이평선을 최종 마지노선으로 강력히 설정 (핵심 원칙)
        ma20_val = float(latest.get("_MA20", 0)) if pd.notna(latest.get("_MA20")) else 0
        if ma20_val > 0 and current_price > ma20_val:
            stop_loss_sell = int(ma20_val * 0.99)
        else:
            recent_lows = [float(df.iloc[i]["Low"]) for i in range(-5, 0)]
            recent_highs = [float(df.iloc[i]["High"]) for i in range(-5, 0)]
            recent_range = max(recent_highs) - min(recent_lows)
            stop_loss_sell = int(min(recent_lows) - recent_range * 0.3) # 하방 여유

        # 목표가 (예상 하락 지지점): 매도 후 주가가 어디까지 열려있는가 (60일선 지지 기반)
        ma60_val = float(latest.get("_MA60", 0)) if pd.notna(latest.get("_MA60")) else 0
        if ma60_val > 0 and current_price > ma60_val:
            target_sell = int(ma60_val * 1.01) # 60일선 부근 지지 예상
        else:
            recent_high_max = max(recent_highs)
            decline_from_high = recent_high_max - current_price
            target_sell = int(current_price - decline_from_high) if decline_from_high > 0 else int(current_price * 0.95)
    else:
        sell_signal_strength = 30
        sell_primary_pattern = "강한 매도 패턴 미감지"
        sell_primary_desc = "현재 뚜렷한 하락 반전 패턴이 발견되지 않았습니다. 기존 보유자는 추세가 꺾이기 전까지 홀딩을 고려해볼 수 있습니다."
        
        sell_price = "보류"
        conservative_sell = "보류"
        stop_loss_sell = "보류"
        target_sell = "보류"

    sell_report = {
        "signal_strength": sell_signal_strength,
        "primary_pattern": sell_primary_pattern,
        "primary_pattern_desc": sell_primary_desc,
        "sell_price": sell_price,
        "conservative_sell": conservative_sell,
        "stop_loss": stop_loss_sell,
        "target_price": target_sell,
        "risk_reward": "1:2",
        "volume_note": volume_note,
        "exit_tip": "강한 하락 패턴이 없다면 이전 고점 돌파 여부를 지켜보며 분할 매도를 고려하세요.",
    }

    return {
        "patterns": detected,
        "trend": trend,
        "trend_label": trend_label,
        "trend_strength": trend_strength,
        "buy_report": buy_report,
        "sell_report": sell_report,
        "recent_candles": recent_candles,
        "recent_week_analysis": analyze_recent_week(df),
        "volume_note": volume_note,
    }
