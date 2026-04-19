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

### 3-1. AI 인지형 투자 매력도 (AI Investment Attractiveness)
기술적 지표, 퀀트 스코어, 매크로 지표를 종합하여 현재 해당 종목의 투자 매력도를 0~100점으로 산출합니다.
*   **알고리즘 구성**: `(Technical Prob * 0.4) + (Quant Score * 0.4) + (Macro Context * 0.2)`
*   **시각화**: 게이지 형태의 UI를 통해 '매우 높음', '보통', '낮음' 등으로 직관적 등급 제공.

### 3-2. 사이클 타임 및 예측 (Cycle Time Prediction)
과거의 저점-고점 간의 시간 간격(Time Series Periodicity)을 분석하여 다음 변곡점이 발생할 확률이 높은 시기를 예측합니다.
*   **핵심 수식**: `Inflection Point = Last Peak + (Average Cycle Duration * 0.8 + Last Cycle * 0.2)`
*   **피보나치 보정**: 예측된 날짜 근처의 피보나치 수열(21, 34, 55일 등)을 가중치로 대입하여 신뢰구간 산출.

### 3-3. 주간 캔들 인사이트 요약 (Weekly Candle Insight)
일봉 패턴의 조합과 주간 이동평균선의 이격도를 분석하여 다가올 주간의 흐름을 텍스트로 요약합니다.
*   **로직**: 5거래일간의 캔들 몸통/꼬리 비율과 이격도(`Price / MA20`)를 결합하여 심리 상태(장악, 잉태, 반전)를 문장형으로 생성.

### 3-4. ATR 기반 변동성 목표가 산출
주가의 변동성(ATR)을 반영하여 현실적인 매매 범위를 설정합니다.
*   **수식**:
    *   `ATR (Average True Range)`: `14일간의 True Range 평균`
    *   `Aggressive Target = Close + (ATR * 2.0)`
    *   `Conservative Target = Close + (ATR * 1.0)`
    *   `Stop Loss = Close - (ATR * 1.5)`

---

## 4. 펀더멘탈 퀀트 분석 (Fundamental Quant)

### 4-1. 업종별 벤치마크 스코어링
각 기업의 ROE, PER, PBR을 동일 업종 내 중앙값과 비교하여 가치를 평가합니다.
*   **평가 알고리즘**:
    *   `Score = (ROE / Sector Mean ROE) * W1 + (Sector Mean PER / PER) * W2 + (Sector Mean PBR / PBR) * W3`
    *   성장성 지표(PEG) 반영: `PEG = PER / (EPS Growth Rate)` (1.0 미만 시 저평가)

---

## 5. UI/UX 및 디자인 시스템 (Design System)

*   **Rounded Model System**: 모든 모달 및 팝업 인터페이스에 **32px 고곡률 라운드**를 적용하여 프리미엄 테마의 일관성 확보.
*   **Theme-Aware Glassmorphism**: 라이트/다크 모드에 최적화된 반투명 블러 효과 시스템.
*   **Google Auth Integration**: 복잡한 절차를 생략한 구글 소셜 계정 전용 로그인 시스템.
*   **Typography Sync**: 주요 지표(ROE 등)와 위젯(사이클 타임라인 등) 간의 폰트 크기 및 무게 조절을 통한 시각적 정합성 구현.
*   **통합 푸터**: 저작권 명시와 사용자 문의(`mailto`)를 포함한 서비스 최하단 레이아웃.

