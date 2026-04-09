# Signnith 서비스 기술 명세서 (Implemented Technologies)

본 문서는 **'Signnith (Stock Search Service)'**의 구현에 사용된 모든 기술 스택, 데이터 소스, 그리고 독자적인 엔지니어링 기법을 체계적으로 정리한 사양서입니다.

---

## 1. 🏗️ 전체 아키텍처 (System Architecture)
- **Backend Infrastructure**: Python 기반의 경량화된 고성능 API 서버.
- **Frontend Architecture**: **Zero-Framework (Vanilla JS/HTML/CSS)** 전략을 통해 브라우저 하드웨어를 직접 제어하는 고속 렌더링 시스템.
- **Data Pipeline**: 실시간 금융 데이터 수집과 기술적 지표 연산이 결합된 하이브리드 엔진.

## 2. 🐍 백엔드 및 데이터 엔지니어링 (Backend & Data Logic)
### **핵심 언어 및 라이브러리**
- **Python 3.10+**: 시스템 전반의 핵심 언어. 가독성과 강력한 데이터 처리 라이브러리 활용.
- **Pandas & NumPy**: 대규모 시각적 차트 데이터 연산(MA, ATR 등)의 고속 처리를 위한 벡터화 알고리즘 구현.

### **멀티 소스 데이터 인프라 (Data Ingestion)**
- **yfinance (Yahoo Finance)**: 글로벌 전 주식 종목의 실시간 OHLCV 및 배당 히스토리 수집.
- **Open DART (금융감독원 API)**: 기업별 공식 설립일, CEO 정보, 본사 주소, 홈페이지 주소 등 **공적 기업 데이터**의 정밀 매핑.
- **한국은행 (ECOS Open API)**: 국가 기준금리, 실시간 환율, 소비자물가지수 등 **거시경제(Macro) 핵심 지표** 로딩.
- **공공데이터포털 (data.go.kr)**: 한국 거래소 종목 마스터 정보 및 시세 데이터의 **신뢰성 검증(Cross-check)** 시스템 구축.

### **지능형 분석 엔진 (Analysis Engine)**
- **기술적 지표 연산**: 5/20/60/120 이동평균선(MA) 및 변동폭(ATR) 기반의 최적 매매가이드 자동 산출.
- **패턴 식별 알고리즘**: `candle_patterns.py` 내의 독적 비교 엔진을 통한 기술적 분석 자동화.

## 3. 🎨 프론트엔드 및 사용성 공학 (Frontend & UI Engineering)
### **핵심 기술 (Web Standard)**
- **Semantic HTML5 & Modern CSS3**: `backdrop-filter`(유리효과), `CSS Variables`(동적 테마), `Grid/Flex`를 활용한 풀 리스폰시브 레이아웃.
- **Vanilla JavaScript (ES6+)**: 프레임워크 오버헤드를 제거한 가벼운 실행 파일 구성 및 직접적인 DOM 조작.

### **데이터 시각화 기술 (Visualization)**
- **Lightweight Charts (TradingView)**: 캔들 데이터, 거래량, 다중 이동평균선 시각화. 차트 커스텀 렌더링 및 줌/드래그 최적화.
- **Chart Legend Interaction**: `subscribeCrosshairMove` 이벤트를 통한 실시간 데이터 오버레이 시스템.

### **상태 관리 및 네비게이션**
- **Section-based SPA**: 사이드바 기반의 무중단 탭 전환 및 스크롤 위치 보존 로직.
- **UI Persistence**: 검색 데이터와 관심종목 정보를 세션 내내 유지하기 위한 Context 관리 기법.

## 4. ⚡ 고도화된 UI 인터랙션 (Interaction Design)
- **Workout-style Component System**: 데이터 가독성을 극대화한 구획화된 레이아웃 설계.
- **Premium Aesthetics**:
    - **White Glow Hover**: 마우스 반응 시 흰색 테두리와 60% 투명도의 빛 산란 효과.
    - **Scan-Beam Animation**: 차트 데이터 로딩 시 실제 분석이 진행되는 듯한 시각적 스캔 가이드 빔.
    - **Lazy-Unfolding**: 차트가 우측으로 하나씩 그려지며 펼쳐지는 금융 대시보드 전용 애니메이션.

## 5. 🛡️ 보안 및 시스템 안정화 (System Stability)
- **Auth Simulation**: 핀테크 서비스의 보안성을 고려한 Guest/User별 기능 차단 및 로그인 유도 인프라.
- **Error Handling**: API 타임아웃 방어로직(`fetchWithTimeout`) 및 데이터 소스 미가용 시 Fallback 시세 제공.

---
**Technical Milestone Version**: v1.0.0 (Finalized)
