# Signnith 서비스 기능 명세서 (Feature List & Algorithms)

이 문서는 Signnith 서비스에서 제공하는 모든 기능과 그 이면에 작동하는 알고리즘 및 기술적 수식을 상세히 기록합니다.

---

## 1. 종목 탐색 및 기본 분석 (Search & Basic Analysis)

### 1-1. 실시간 데이터 스트리밍
*   **기능**: KRX(코스피, 코스닥) 전 종목에 대한 실시간 시세 및 이동평균선 데이터 제공.
*   **기술**: `yfinance` API를 활용한 데이터 패칭 및 서버 사이드 5분 TTL 캐싱.

### 1-2. 인터랙티브 캔들 차트
*   **기능**: `lightweight-charts`를 활용한 고성능 차트.
*   **지원 지표**: 5/10/20/60일 이동평균선(MA), 실시간 가격 매핑.

---

## 2. AI 캔들 패턴 매핑 엔진 (Candle Pattern Engine)

### 2-1. 알고리즘 원리
`candle_patterns.py`에서 작동하며, 각 캔들의 몸통(Body), 윗꼬리(Upper Shadow), 아랫꼬리(Lower Shadow)의 비율을 계산하여 패턴을 정의합니다.

*   **기초 수식**:
    *   `Body = |Close - Open|`
    *   `UpperShadow = High - max(Open, Close)`
    *   `LowerShadow = min(Open, Close) - Low`

### 2-2. 주요 패턴 정의 예시
| 패턴명 | 신호 | 알고리즘 조건 (Pseudo Code) |
| :--- | :--- | :--- |
| **망치형 (Hammer)** | 상승 | `Lower >= Body * 2` AND `Upper <= Body * 0.5` AND `Trend == Down` |
| **유성형 (Shooting Star)** | 하락 | `Upper >= Body * 2` AND `Lower <= Body * 0.5` AND `Trend == Up` |
| **상승 장악형 (Bullish Engulfing)** | 상승 | `Prev.Bearish` AND `Curr.Bullish` AND `Curr.Close > Prev.Open` AND `Curr.Open < Prev.Close` |
| **적삼병 (Three White Soldiers)** | 상승 | `3 Consecutive Bullish Candles` AND `Higher Highs & Higher Lows` |

---

## 3. 딥 분석 및 예측 엔진 (Deep Analysis Engine)

### 3-1. ATR 기반 변동성 목표가 산출
주가의 변동성(ATR)을 반영하여 현실적인 매매 범위를 설정합니다.
*   **수식**:
    *   `ATR (Average True Range)`: `14일간의 True Range 평균`
    *   `Aggressive Target = Close + (ATR * 2.0)`
    *   `Conservative Target = Close + (ATR * 1.0)`
    *   `Stop Loss = Close - (ATR * 1.5)`

### 3-2. 매수/매도 확률 점수 (Trade Probability)
기술적 지표를 가중치 방식으로 결합하여 0~100점의 점수를 산출합니다.
*   **가중치 체계 (Weights)**:
    1.  **이동평균선 배열 (35%)**: 정배열 상태 및 주가 위치 보정.
    2.  **RSI (25%)**: `100 - (100 / (1 + RS))` 수식을 사용하며, 과매도(30 이하) 구간에서 높은 가점.
    3.  **MACD (25%)**: 골든크로스 및 오실리에이터 강도 반영.
    4.  **거래량 (15%)**: 전일 대비 거래량 증가율 보정.

### 3-3. Z-score 기반 거래량 이상 탐지
평균 거래량에서 벗어난 '세력의 개입'이나 '매물 분출'을 감지합니다.
*   **수식**:
    *   `Z-score = (Current Volume - Avg Volume) / StdDev Volume`
    *   `Z >= 3.0`: 폭발적 거래 (Explosion)
    *   `Z >= 2.0`: 거래 급증 (Surge)

### 3-4. 피보나치 사이클 타임 예측
과거 고점들 사이의 간격을 분석하여 다음 변곡점의 시기를 예측합니다.
*   **수식**: `Next Peak = Last Peak + (Avg Cycle * 0.7 + Fibonacci Nearest * 0.3)`
*   **사용 피보나치 수열**: 8, 13, 21, 34, 55, 89일.

---

## 4. 펀더멘탈 퀀트 분석 (Fundamental Quant)

### 4-1. 업종별 벤치마크 스코어링
각 기업의 ROE, PER, PBR을 동일 업종 내 중앙값과 비교하여 상대적 가치를 평가합니다.
*   **분류 업종**: 반도체(IDM, 장비), 이차전지, 바이오, EV, 플랫폼, 금융 등.
*   **평가 알고리즘**:
    *   `Score = (ROE / Sector Mean ROE) * W1 + (Sector Mean PER / PER) * W2 + (Sector Mean PBR / PBR) * W3`
    *   성장성 지표(PEG) 반영: `PEG = PER / (EPS Growth Rate)` (1.0 미만 시 저평가)

---

## 5. 인프라 및 부가 기능 (Infrastructure)

*   **PWA (Progressive Web App)**: Service Worker를 활용한 로컬 리소스 캐싱 및 오프라인 접근 최적화.
*   **거시경제 시각화**: 한국은행 ECOS API 기반의 기준금리와 코스피 상관관계 분석 차트.
*   **보안 및 동기화**: Supabase Auth와 PostgreSQL을 활용한 사용자별 관심 종목(Bookmark) 및 프로필 데이터 관리.
