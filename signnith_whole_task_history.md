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

### [Phase 5] 프리미엄 글래스모피즘 및 시스템 표준화 (v44 ~ v62)
*   **v44 & v45 (Slate Glass)**: 서비스 전체 타일을 'Slate' 톤의 글래스모피즘으로 통일.
*   **v46 (Theme-Aware)**: 라이트/다크 모드별 전용 글래스모피즘 스타일 적용.
*   **v50 ~ v56 (Layout & Data Fixes)**: 사이드바 핀 기능, 모바일 전용 UI 최적화, 거시지표 차트 범례 추가 및 데이터 로딩 문제 해결.
*   **v57 (UI/UX Standard & Auth)**: 
    *   **Rounded Model Type**: 모든 모달에 32px 고곡률 라운드 스타일 적용하여 디자인 정체성 확립.
    *   **Google-Only Auth**: 복잡한 회원가입 절차를 제거하고 구글 계정 전용 로그인 시스템으로 통합.
*   **v58 ~ v60 (Corporate Identity)**: 하단 푸터(Copyright & Contact us) 추가 및 레이아웃 너비 최적화.
*   **v61 & v62 (Typography Refinement)**: 
    *   **v61**: AI 리포트 내 가격 폰트 크기를 30% 축소하여 시각적 비중 조정.
    *   **v62**: 사이클 타임라인의 폰트 크기를 ROE 등 주요 지표와 동기화하여 가독성 통일.

---

## 4. 인프라 및 최적화 (Optimization)

### [Phase 6] 캐싱 및 성능 최적화
*   **멀티 레이어 캐싱**: 서버 사이드 TTL 캐시와 Service Worker 기반 클라이언트 캐싱 결합.
*   **PWA 지원**: 설치 가능 앱(A2HS) 및 오프라인 접근성 확보.

### [Phase 7] 사용자 권한 및 보안
*   **Supabase 통합**: 구글 로그인 연동 및 관리자 전용 승인 시스템(Profile RLS) 구축.
*   **보안 강화**: 일반 이메일 가입 절차를 폐쇄하고 검증된 소셜 계정만 허용.

---

> [!TIP]
> **현재 상태 (v62)**: 모든 UI가 32px 라운드 시스템으로 표준화되었으며, AI 리포트와 분석 위젯들이 디자인 시스템에 맞춰 정밀하게 최적화된 프리미엄 버전입니다.

