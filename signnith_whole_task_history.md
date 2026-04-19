# Signnith 서비스 개발 전체 이력 (Whole Task History)

이 문서는 AI 기반 주식 종목 검색 및 분석 플랫폼 **Signnith (Stock Finder)**의 탄생부터 현재(v49)까지의 모든 개발 과정을 기록합니다.

---

## 1. 프로젝트 초기 단계 (Foundation Phase)

### [Phase 1] 서비스 기획 및 기초 구축
*   **목적**: 단순 종목 검색을 넘어 AI가 기술적/기본적 분석을 종합하여 리포트를 제공하는 전문가형 대시보드 구축.
*   **기술 스택 선정**:
    *   **Backend**: Flask (Lightweight & Fast API)
    *   **Frontend**: Vanilla JS + CSS (성능 최적화 및 자유로운 디자인 커스텀)
    *   **Data Source**: yfinance (주가), DART API (공시/재무), ECOS (거시경제)
    *   **Infrastructure**: Supabase (Auth/DB), Render (Server)

---

## 2. 핵심 분석 엔진 개발 (Core Engine)

### [Phase 2] 캔들 패턴 및 딥 분석 엔진
*   **캔들 패턴 엔진**: 12종(현재 37종 이상)의 주요 캔들 패턴 탐지 로직 구축.
*   **Deep Analysis v1**: ATR(Average True Range)을 활용한 변동성 기반 목표가/손절가 산출 로직 적용.
*   **통합 스코어링**: MA, RSI, MACD, Volume을 가중 결합한 'Trade Probability' 엔진 개발.

### [Phase 3] 펀더멘탈 및 매크로 통합
*   **DART XBRL 연동**: 기업별 재무제표를 파싱하여 업종별 벤치마크 점수 산출 기능 추가.
*   **거시경제 지표**: 한국은행 ECOS API를 연동하여 금리, 환율, 산업 사이클 시각화.

---

## 3. UI/UX 진화 및 디자인 고도화 (Design Evolution)

### [Phase 4] 대시보드 레이아웃 혁신
*   **Dash-UX 도입**: 카드 기반의 대시보드 레이아웃으로 전환하여 정보 밀도 최적화.
*   **시각적 매핑**: 캔들 차트 위에 AI가 탐지한 패턴을 직접 표시하는 'Visual Mapping' 기능 구현.

### [Phase 5] 프리미엄 글래스모피즘 시스템 (v44 ~ v49)
*   **v44 & v45 (Slate Glass)**: 서비스 전체 타일을 'Slate(rgba(148, 163, 184))' 톤의 글래스모피즘으로 통일.
*   **v46 (Theme-Aware)**: 
    *   **Light Mode**: 화이트 글래스모피즘 (순백색 배경 및 높은 투명도).
    *   **Dark Mode**: 다크 블루이쉬 글래스모피즘 (깊은 바다 톤의 투명 배경).
*   **v47 & v48 (Modal Refinement)**: 도움말 모달과 내부 카드의 디자인을 대시보드와 완전히 동기화. 닫기 버튼 UX 개선.
*   **v49 (The Premium Label)**: AI 리포트 타이틀 옆에 42px 크기의 시인성 높은 **BUY/SELL 프리미엄 라벨** 적용.

---

## 4. 인프라 및 최적화 (Optimization)

### [Phase 6] 캐싱 및 성능 최적화
*   **멀티 레이어 캐싱**: 
    *   **L1**: 서버 사이드 인메모리 TTL 캐시 (5분).
    *   **L2**: 클라이언트 사이드 Service Worker 캐시 (v45~v49).
*   **PWA 지원**: 오프라인 지원 및 모바일 홈 화면 설치 기능(PWA) 완성.

### [Phase 7] 사용자 권한 및 보안
*   **Supabase 통합**: 구글 로그인 연동 및 관리자 승인 시스템(Profile RLS 연동) 구축.

---

> [!TIP]
> **현재 상태 (v49)**: 모든 UI가 프리미엄 글래스모피즘으로 통일되었으며, AI 분석 결과물이 직관적인 라벨과 차트 매핑을 통해 전문가급 사용자 경험을 제공하고 있습니다.
