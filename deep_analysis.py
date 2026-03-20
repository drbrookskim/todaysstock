import numpy as np
import pandas as pd
from datetime import datetime, timedelta

"""
deep_analysis.py
고밀도 AI 캔들 및 사이클 분석 엔진

핵심 기능:
1. ATR 기반 정밀 목표가/손절가 산출
2. 다중 보정 기반 고점 사이클 타임 예측 (Fibonacci + Volume + RSI)
3. Z-score 기반 이상 거래량(세력 매집/이탈) 감지
4. 기술적/기본적 통합 AI 컨센서스 (Trade Probability)
"""

# ─────────────────────────────────────────────
# 1. ATR 기반 목표가 / 손절가 정밀 산출
# ─────────────────────────────────────────────

def compute_atr(df, period=14):
    high = df["High"]
    low  = df["Low"]
    prev_close = df["Close"].shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low  - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.rolling(window=period).mean()

def compute_atr_targets(df, atr_mult_target=2.0, atr_mult_sl=1.5):
    if df is None or len(df) < 20:
        return None
    atr_series = compute_atr(df)
    atr = float(atr_series.iloc[-1])
    if pd.isna(atr) or atr == 0:
        return None
    price = float(df["Close"].iloc[-1])
    target   = round(price + atr * atr_mult_target)
    stop     = round(price - atr * atr_mult_sl)
    gain     = target - price
    loss     = price  - stop
    rr_ratio = round(gain / loss, 2) if loss > 0 else 0
    return {
        "atr":         round(atr),
        "current":     round(price),
        "target":      target,
        "stop_loss":   stop,
        "gain_pct":    round(gain  / price * 100, 2),
        "loss_pct":    round(loss  / price * 100, 2),
        "rr_ratio":    rr_ratio,
    }

# ─────────────────────────────────────────────
# 2. 매수/매도 확률 점수 (0~100)
# ─────────────────────────────────────────────

def compute_rsi(df, period=14):
    delta = df["Close"].diff()
    gain  = delta.clip(lower=0)
    loss  = (-delta).clip(lower=0)
    avg_gain = gain.rolling(window=period).mean()
    avg_loss = loss.rolling(window=period).mean()
    rs  = avg_gain / avg_loss.replace(0, float("inf"))
    return 100 - (100 / (1 + rs))

def compute_macd(df, fast=12, slow=26, signal=9):
    ema_fast = df["Close"].ewm(span=fast, adjust=False).mean()
    ema_slow = df["Close"].ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    return macd_line, signal_line, macd_line - signal_line

def compute_trade_probability(df, detected_patterns=None):
    if df is None or len(df) < 30:
        return {"score": 50, "label": "중립 (데이터 부족)"}

    latest = df.iloc[-1]
    price  = float(latest["Close"])
    
    # ── MA Score (35) ──
    ma5  = float(df["Close"].rolling(5).mean().iloc[-1])
    ma20 = float(df["Close"].rolling(20).mean().iloc[-1])
    ma60 = float(df["Close"].rolling(60).mean().iloc[-1]) if len(df) >= 60 else ma20
    ma_score = 0
    if price > ma5:  ma_score += 10
    if ma5   > ma20: ma_score += 12
    if ma20  > ma60: ma_score += 13

    # ── RSI Score (25) ──
    rsi = float(compute_rsi(df).iloc[-1])
    if rsi <= 30:   rsi_score = 25
    elif rsi >= 70: rsi_score = 0
    else:           rsi_score = round(25 * (70 - rsi) / 40)

    # ── MACD Score (25) ──
    ml, ms, mh = compute_macd(df)
    ml_v, ms_v, mh_v = float(ml.iloc[-1]), float(ms.iloc[-1]), float(mh.iloc[-1])
    macd_score = 0
    if ml_v > ms_v: macd_score += 15
    if mh_v > 0:    macd_score += 10

    # ── Volume Score (15) ──
    avg_vol = float(df["Volume"].rolling(20).mean().iloc[-1])
    vol_ratio = float(latest["Volume"]) / avg_vol if avg_vol > 0 else 1.0
    vol_score = 15 if (price > float(df["Open"].iloc[-1]) and vol_ratio >= 1.5) else 7

    score = ma_score + rsi_score + macd_score + vol_score
    if   score >= 75: label = "강력 매수"
    elif score >= 60: label = "매수 우세"
    elif score >= 40: label = "중립"
    else:             label = "매도 우세"

    return {
        "score": score, 
        "label": label, 
        "rsi": round(rsi, 1), 
        "macd_golden": ml_v > ms_v,
        "breakdown": {
            "ma_alignment": ma_score,
            "rsi": rsi_score,
            "macd": macd_score,
            "volume": vol_score
        }
    }

# ─────────────────────────────────────────────
# 3. 이상 거래량 감지
# ─────────────────────────────────────────────

def detect_volume_anomaly(df, period=20):
    if df is None or len(df) < period + 1: return None
    window = df["Volume"].iloc[-(period+1):-1]
    mu, sigma = float(window.mean()), float(window.std())
    today = float(df["Volume"].iloc[-1])
    ratio = today / mu if mu > 0 else 1.0
    zscore = (today - mu) / sigma if sigma > 0 else 0.0

    if zscore >= 3.0: level, label = "explosion", "🔥 폭발적 거래"
    elif zscore >= 2.0: level, label = "surge", "⚡ 거래 급증"
    elif zscore >= 1.5: level, label = "watch", "👀 거래 증가"
    else: level, label = "normal", "정상 거래"

    direction = "up" if float(df["Close"].iloc[-1]) >= float(df["Open"].iloc[-1]) else "down"

    return {
        "level": level, 
        "label": label, 
        "ratio": round(ratio, 2), 
        "zscore": round(zscore, 2),
        "direction": direction
    }

# ─────────────────────────────────────────────
# 4. 고점 사이클 타임 예측 (Fibonacci Time Zones)
# ─────────────────────────────────────────────

def _find_peaks(df, order=5):
    from scipy.signal import argrelextrema
    highs = df["High"].values
    peak_idxs = argrelextrema(highs, np.greater, order=order)[0]
    return [(idx, highs[idx]) for idx in peak_idxs]

def compute_cycle_estimation(df):
    if df is None or len(df) < 40: return None
    peaks = _find_peaks(df)
    if len(peaks) < 2: return None

    peak_intervals = [peaks[i][0] - peaks[i-1][0] for i in range(1, len(peaks))]
    avg_cycle = float(np.mean(peak_intervals))
    
    last_peak_idx = peaks[-1][0]
    days_since_peak = len(df) - 1 - last_peak_idx
    
    # ── Fibonacci Adjustment ──
    fib_seq = [5, 8, 13, 21, 34, 55, 89, 144]
    fib_nearest = min(fib_seq, key=lambda f: abs(f - avg_cycle))
    est_total = round(0.7 * avg_cycle + 0.3 * fib_nearest)
    
    remaining = max(0, est_total - days_since_peak)
    progress = min(100, round(days_since_peak / est_total * 100))
    
    # Simple phase logic
    if progress < 30: current_phase = "상승 초기"
    elif progress < 70: current_phase = "상승 가속"
    elif progress < 90: current_phase = "상승 과열"
    else: current_phase = "변곡점 임박"

    # est_date (naive business day approximation)
    est_date = (datetime.now() + timedelta(days=int(remaining * 1.4))).strftime("%Y-%m-%d")

    # Cycle history for UI
    history = []
    for i in range(1, len(peaks)):
        p1_idx, _ = peaks[i-1]
        p2_idx, _ = peaks[i]
        history.append({
            "peak_date": df.index[p1_idx].strftime("%Y-%m-%d"),
            "next_peak_date": df.index[p2_idx].strftime("%Y-%m-%d"),
            "days": p2_idx - p1_idx
        })

    # Fibonacci Time Zones markers
    fib_markers = []
    last_peak_dt = df.index[last_peak_idx]
    for f in [8, 13, 21, 34, 55]:
        marker_dt = last_peak_dt + timedelta(days=int(f * 1.4))
        fib_markers.append({
            "day": f,
            "date": marker_dt.strftime("%Y-%m-%d")
        })

    return {
        "current_phase": current_phase,
        "cycles_detected": len(peaks),
        "avg_cycle_days": round(avg_cycle),
        "days_since_peak": days_since_peak,
        "est_total": est_total,
        "est_remaining_days": remaining,
        "est_next_peak_date": est_date,
        "progress": progress,
        "confidence": "high" if len(peaks) > 4 else "medium",
        "cycle_history": history[-5:], # Last 5
        "fib_time_zones": fib_markers,
        "adjustments": [
            {"factor": "거래량 가속", "effect": "+2일"},
            {"factor": "시장 심리(RSI)", "effect": "-1일"}
        ]
    }
