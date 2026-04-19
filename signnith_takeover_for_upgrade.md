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

## 5. 업데이트 및 디자인 프로토콜 (Version & Design)

Signnith는 브라우저 캐시 문제를 방지하고 프리미엄 UI를 유지하기 위해 아래 전략을 사용합니다.

1.  **버전 관리 (Cache Busting)**: 
    *   `client/sw.js`의 `CACHE_NAME`과 `client/index.html` 하단의 `app.js?v=XX` 버전을 동기화하여 업데이트 (현재 **v62**).
2.  **디자인 시스템 표준 (Rounded Model Type)**:
    *   신규 모달이나 카드 추가 시 반드시 `style.css`의 `--radius-modal: 32px` 변수를 사용하여 고곡률 라운드를 유지하십시오.
3.  **타이포그래피 및 가독성**:
    *   AI 리포트 내 핵심 수치는 시각적 균형을 위해 본문보다 약간 작은 비율(`v61` 정책)을 사용하며, 위젯 내 텍스트는 ROE 등 주요 지표와 폰트 스케일을 동기화(`v62` 정책)합니다.

---

## 6. 핵심 로직 및 유지보수 유의사항

1.  **인증 시스템 (Google-Only)**: 복잡한 회원가입 절차를 제거하고 구글 소셜 계정으로만 인증이 가능하도록 통합되었습니다. 변경 시 `app.js`의 `initAuth`를 참조하십시오.
2.  **딥 분석 엔진**: `candle_patterns.py`와 `app.js` 내의 `renderCycleTimelineChart` 등 핵심 로직은 서버와 클라이언트의 협업으로 작동합니다.
3.  **데이터 캐싱**: 서버 사이드 인메모리 캐시가 적용되어 있으므로, 데이터 정합성 이슈 발생 시 서버를 재시작하거나 캐시 TTL 정책을 확인하십시오.

---

## 7. 향후 고도화 로드맵 (Future Roadmap)

1.  **고성능 캐싱 레이어**: 현재의 In-memory 딕셔너리를 **Redis**로 교체하여 분산 환경 최적화.
2.  **LLM 뉴스 분석 통합**: OpenAI 또는 Claude API를 연동하여 실시간 공시를 인간 언어로 요약하는 기능 부활.
3.  **퀀트 백테스팅 엔진**: `deep_analysis.py`의 전략을 과거 데이터에 대입하여 실제 수익률 시뮬레이션 구현.
4.  **포트폴리오 대시보드**: 사용자의 보유 종목과 실시간 수익률을 글래스모피즘 카드로 시각화.

---

> [!CAUTION]
> **보안 및 환경 변수**: `SUPABASE_SERVICE_KEY`는 서버 환경 변수로만 관리하고, 클라이언트(`index.html`, `app.js`)에는 절대로 노출하지 마십시오.

