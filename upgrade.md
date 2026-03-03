# AI 분석 고도화 업그레이드 노트

> 파일: `candle_patterns.py`  
> 업데이트일: 2026-03-03  
> 함수: `compute_atr_targets()`, `compute_trade_probability()`, `detect_volume_anomaly()`  
> API 응답 키: `atr_targets`, `trade_probability`, `volume_anomaly`

---

## 1. ATR 기반 목표가 / 손절가 자동 산출

### 함수
`compute_atr_targets(df, atr_mult_target=2.0, atr_mult_sl=1.0)`

### 핵심 개념: ATR (Average True Range)
ATR은 최근 14일간 **시장이 자연스럽게 움직이는 일일 평균 변동폭**입니다.  
단순 고-저 범위가 아닌 전일 종가 갭을 포함하는 True Range의 이동평균입니다.

```
True Range = max(고가-저가, |고가-전일종가|, |저가-전일종가|)
ATR        = TR의 14일 이동평균
```

### 산출 공식
| 항목 | 공식 | 의미 |
|------|------|------|
| 목표가 | 현재가 + ATR × 2.0 | 자연 변동폭의 2배 상방 |
| 손절가 | 현재가 - ATR × 1.0 | 자연 변동폭의 1배 하방 |
| R:R 비율 | (목표가-현재가) / (현재가-손절가) | 기본값 2.0 (1:2) |

### 설계 근거
- 손절가를 ATR×1로 설정 → 시장 잡음(noise)에 의한 불필요한 손절 방지
- 목표가를 ATR×2로 설정 → 리스크 대비 보상 최소 1:2 확보
- 고정 퍼센트(%) 방식 대신 ATR 사용 → 종목의 **변동성에 자동 적응**

### 반환 예시 (삼성전자)
```json
{
  "atr": 3757,
  "current": 199686,
  "target": 213443,
  "stop_loss": 185929,
  "gain_pct": 6.89,
  "loss_pct": 3.44,
  "rr_ratio": 2.0
}
```

---

## 2. 매수/매도 확률 점수 (0~100)

### 함수
`compute_trade_probability(df, detected_patterns)`

### 가중치 구조

| 지표 | 가중치 | 만점 | 산출 방법 |
|------|--------|------|-----------|
| **MA 배열** | 35% | 35점 | 정배열(가격>MA5>MA20>MA60) 단계별 점수 |
| **RSI** | 25% | 25점 | 30이하=25점, 70이상=0점, 선형 보간 |
| **MACD** | 25% | 25점 | 골든크로스+13, 히스토그램 양수+7, 히스토그램 증가+5 |
| **거래량** | 15% | 15점 | 상승봉+거래량 증가 = 최대 15점 |
| **패턴 보너스** | — | ±5점 | 감지된 캔들 패턴 신뢰도 기반 가감 |

### MA 배열 점수 상세
```python
if price > ma5:   ma_score += 10   # 단기 추세 위
if ma5   > ma20:  ma_score += 12   # 단기 > 중기 정배열
if ma20  > ma60:  ma_score += 13   # 중기 > 장기 정배열
```

### RSI 점수 상세
```python
if rsi <= 30:  rsi_score = 25          # 과매도: 최대 점수
elif rsi >= 70: rsi_score = 0          # 과매수: 0점
else:           rsi_score = 25 * (70 - rsi) / 40   # 선형 보간
```

### MACD 점수 상세
| 조건 | 점수 | 설명 |
|------|------|------|
| MACD 라인 > 시그널 라인 | +13 | 골든크로스 |
| 히스토그램 > 0 | +7 | 모멘텀 양수 방향 |
| 히스토그램 증가 중 | +5 | 상승 가속 중 |

### 결과 레이블
| 범위 | 레이블 |
|------|--------|
| 75~100 | 강한 매수 |
| 60~74 | 매수 우세 |
| 40~59 | 중립 |
| 25~39 | 매도 우세 |
| 0~24 | 강한 매도 |

### 반환 예시 (삼성전자)
```json
{
  "score": 48,
  "label": "중립",
  "rsi": 71.3,
  "breakdown": {
    "ma_alignment": 22,
    "rsi": 0,
    "macd": 13,
    "volume": 15,
    "pattern_bonus": 0
  }
}
```

---

## 3. 이상 거래량 감지

### 함수
`detect_volume_anomaly(df, period=20)`

### 산출 방법
```
μ      = 최근 20일(오늘 제외) 평균 거래량
σ      = 최근 20일 거래량 표준편차
Z-score = (오늘 거래량 - μ) / σ
배율    = 오늘 거래량 / μ
```

Z-score는 통계적으로 **"평균에서 표준편차 몇 개 만큼 떨어져 있는가"**를 나타냅니다.  
단순 배율과 Z-score를 **동시에** 만족해야 레벨이 올라가므로 오탐이 적습니다.

### 심각도 레벨

| 레벨 | 조건 | 설명 |
|------|------|------|
| `normal` | Z < 1.5 또는 배율 < 1.5 | 정상 범위 |
| `watch` 👀 | Z ≥ 1.5 AND 배율 ≥ 1.5 | 주의: 평소보다 눈에 띄게 많음 |
| `surge` ⚡ | Z ≥ 2.0 AND 배율 ≥ 2.0 | 급증: 큰 손 관심 가능 |
| `explosion` 🔥 | Z ≥ 3.0 AND 배율 ≥ 3.0 | 폭발: 세력/뉴스 이벤트 의심 |

### 왜 Z-score만 단독으로 쓰지 않는가?
- 평소 거래량 변동이 작은 종목은 Z-score가 쉽게 높아짐 (오탐 가능)
- 배율 조건을 AND로 결합하여 **실제로 의미있는 증가**만 탐지

### 반환 예시 (삼성전자)
```json
{
  "level": "watch",
  "label": "👀 거래량 주의",
  "message": "평소 대비 1.8배 — 평균보다 유의미하게 많음. 추세 전환 가능성 모니터링.",
  "ratio": 1.79,
  "zscore": 3.25,
  "avg_volume": 9432100,
  "cur_volume": 16883400,
  "direction": "up"
}
```

---

## API 응답 구조 변경

`GET /api/analysis?code=005930&market=KOSPI` 응답에 아래 3개 키 추가:

```json
{
  "patterns": [...],
  "trend": "bullish",
  "buy_report": {...},
  "sell_report": {...},
  
  "atr_targets": {        ← NEW
    "target": 213443,
    "stop_loss": 185929,
    "rr_ratio": 2.0,
    ...
  },
  "trade_probability": {  ← NEW
    "score": 48,
    "label": "중립",
    "rsi": 71.3,
    ...
  },
  "volume_anomaly": {     ← NEW
    "level": "watch",
    "label": "👀 거래량 주의",
    "ratio": 1.79,
    ...
  }
}
```

---

## 다음 단계 (프론트엔드 반영)

- [ ] ATR 목표가/손절가를 분석 리포트 UI에 게이지(gauge) 형태로 표시
- [ ] 매수확률 점수를 0~100 프로그레스바 + 항목별 breakdown 표시
- [ ] 이상 거래량 레벨별 배지(badge) 표시 (정상/주의/급증/폭발)
