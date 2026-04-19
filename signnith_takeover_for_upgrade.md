# Signnith 서비스 인수인계 및 업그레이드 가이드 (Takeover Guide)

이 문서는 Signnith 서비스의 유지보수, 배포 환경 관리 및 향후 고도화 작업을 위한 명세서입니다.

---

## 1. 시스템 아키텍처 개요

*   **Backend**: Flask (Python) - Render를 통한 호스팅
*   **Frontend**: Vanilla HTML/JS/CSS - 클라이언트 사이드 자산
*   **Database/Auth**: Supabase (PostgreSQL 및 GoTrue 관리형 인증)
*   **PWA**: Service Worker (`sw.js`) 기반 오프라인/캐싱 전략

---

## 2. 환경 변수 및 외부 API 설정

서비스 운영을 위해 아래의 환경 변수 설정이 필수적입니다.

| 변수명 | 설명 | 비고 |
| :--- | :--- | :--- |
| `SUPABASE_URL` | Supabase 프로젝트 URL | API 통신 및 DB 연결용 |
| `SUPABASE_KEY` | Supabase Anon Key | 클라이언트 사이드 공개 키 |
| `SUPABASE_SERVICE_KEY` | Supabase Service Role Key | 서버 사이드 관리자용 (RLS 우회) |
| `DART_API_KEY` | 전자공시시스템(DART) API 키 | 공시 및 재무데이터 패칭용 |
| `ECOS_KEY` | 한국은행 경제통계시스템 API 키 | 기준금리 등 거시지표 패칭용 |
| `FLASK_SECRET_KEY` | Flask 세션 암호화 키 | 보안용 무작위 문자열 |

---

## 3. 배포 가이드 (Deployment)

### 3-1. Backend (Render.com)
*   **Build Command**: `pip install -r requirements.txt`
*   **Start Command**: `gunicorn app:app`
*   **Health Check Path**: `/api/health` (구현 필요 시 추가 권장)

### 3-2. Frontend / Static Assets
*   **호스팅**: GitHub Pages 또는 Cloudflare Pages 권장.
*   **주의사항**: `index.html` 내의 API endpoint URL (`http://localhost:8000` vs `https://your-api.render.com`) 설정을 배포 환경에 맞춰야 함.

---

## 4. 데이터베이스 스키마 (Supabase)

현재 사용 중인 주요 테이블 구조입니다.

*   **`profiles`**: 사용자 권한 관리
    *   `id` (uuid, primary key): Supabase Auth 연동
    *   `email` (text)
    *   `role` (text): 'admin' 또는 'user'
    *   `is_approved` (boolean): 관리자 승인 여부
*   **`bookmarks`**: 관심 종목 저장
    *   `id` (int8, primary key)
    *   `user_id` (uuid): `profiles.id` 외래키
    *   `symbol` (text): 종목코드 (예: '005930')

---

## 5. 업데이트 프로토콜 (Version Control)

Signnith는 브라우저 캐시 문제를 방지하기 위해 **vXX 쿼리 스트링 전략**을 사용합니다.

1.  **CSS/JS 수정 시**: 
    *   `client/sw.js` 내의 `CACHE_NAME` 버전을 올림 (예: `waiting-for-the-peak-v50`).
    *   `client/index.html` 하단의 script 태그 버전을 올림 (예: `app.js?v=50`).
2.  **서버 코드 수정 시**: Render에 Push 시 자동 빌드 및 배포됨.

---

## 6. 향후 고도화 로드맵 (Future Roadmap)

1.  **고성능 캐싱 레이어**: 현재의 In-memory 딕셔너리를 **Redis**로 교체하여 다중 서버 환경에서의 데이터 정밀도 향상.
2.  **LLM 뉴스 분석 통합**: OpenAI GPT-4 또는 Claude API를 연동하여 실시간 공시 및 뉴스 전문을 인간 언어로 요약/평가하는 기능.
3.  **퀀트 백테스팅 엔진**: `deep_analysis.py`의 전략(ATR targets 등)을 과거 데이터에 대입하여 실제 수익률을 시뮬레이션하는 페이지 추가.
4.  **포트폴리오 관리**: 사용자가 보유 종목과 매수 단가를 입력하면 실시간 손익을 글래스모피즘 카드로 시각화.

---

> [!CAUTION]
> **보안 주의**: `SUPABASE_SERVICE_KEY`는 RLS를 무시하는 마스터 키이므로 절대로 클라이언트 사이드 코드(JS)에 노출되지 않도록 서버 사이드 환경 변수로만 관리하십시오.
