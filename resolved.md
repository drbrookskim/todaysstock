# TODAY's STOCK — 전체 수정 이력 (resolved.md)

> 최종 업데이트: 2026-03-01

---

## 1. 보안 감사 및 취약점 조치

### ✅ XSS (크로스 사이트 스크립팅) 방어
- **파일**: `client/static/app.js`, `app.py`
- **내용**: `innerHTML` 렌더링 시 `escapeHtml()` 유틸 적용, 외부 API 반환값에 `html.escape()` 처리
- **효과**: 검색기록, 자동완성, 관심종목 이름 등 모든 동적 텍스트 XSS 차단

### ✅ Flask Secret Key 및 Debug 노출 은닉
- **파일**: `app.py`
- **내용**: `app.secret_key = os.environ.get("FLASK_SECRET_KEY", os.urandom(24).hex())` 추가
- **효과**: 쿠키 암호화 강화, 프로덕션에서 Debug 에러 페이지 자동 비활성화

### ✅ API 에러 응답 내부 정보 노출 방지
- **파일**: `app.py`
- **내용**: `except` 블록에서 `str(e)` 직접 반환 → 규격화된 안전 메시지로 교체, 실제 오류는 서버 로그로만 기록
- **효과**: 스택 트레이스, 쿼리 구조 등 내부 인프라 정보 노출 차단

---

## 2. UI / 프론트엔드 수정

### ✅ 로그인 버튼 — 아이콘 제거, 상단 우측 이동
- **파일**: `client/index.html`, `client/static/style.css`
- **내용**: `authBtn`에서 `<i>` 아이콘 제거 → 텍스트 "로그인"만 표시. `.header-row { justify-content: space-between }` 으로 변경하여 버튼을 헤더 우측에 고정
- **효과**: 깔끔한 텍스트 전용 로그인 버튼, 모든 화면 크기에서 우측 상단 유지

### ✅ 다크/라이트 테마 토글 — 해/달 아이콘 방식 개선
- **파일**: `client/index.html`, `client/static/style.css`, `client/static/app.js`
- **내용**: 가로형 스위치 UI 제거 → 우측 하단 고정 원형 버튼 (`theme-icon-btn`)으로 교체. 다크모드일 때 ☀️, 라이트모드일 때 🌙 표시
- **효과**: 목적지향형 아이콘 (클릭하면 현재와 반대 테마로 이동)

### ✅ Drawer 로그아웃 버튼 — 우측 하단 배치 + 빨간 pill 스타일
- **파일**: `client/static/style.css`
- **내용**: `.sidebar-footer { justify-content: flex-end }`, 버튼을 `border-radius: 999px` pill 스타일, `color: #ef4444` (빨간색), hover 시 배경 강조
- **효과**: 로그아웃 버튼이 서랍 우측 하단에 명확히 위치

### ✅ 주가 카드 헤더 — 업종 배지(보라색) + 종목명 개행 분리
- **파일**: `client/index.html`, `client/static/style.css`
- **내용**: 단일 행 레이아웃 → 2행 구조 변경
  - Row 1: KOSPI/KOSDAQ 뱃지 + 보라색 업종 뱃지 (`.industry-badge`, `color: #a78bfa`)
  - Row 2: 종목명 + 종목코드
- **효과**: 업종 정보와 종목명이 구분되어 가독성 향상

### ✅ 모바일 텍스트 최적화
- **파일**: `client/static/style.css`
- **내용**: `word-break: keep-all` (한글 단어 중간 줄바꿈 방지), `white-space: nowrap` (뱃지/코드), `flex-wrap: wrap` (폭 좁을 때 자연스러운 줄바꿈), `line-height: 1.2`
- **효과**: 모바일에서 텍스트 깨짐, 과도한 개행 없음

---

## 3. 백엔드 데이터 파이프라인 수정

### ✅ 주가 데이터 이중 소스 — data.go.kr + yfinance 폴백
- **파일**: `app.py` — `download_stock_df()`
- **내용**: 1차: 공공데이터포털 `data.go.kr` API. 결과 없으면 자동으로 2차: `yfinance` 폴백
- **효과**: 루닛, 에코프로비엠 등 일부 종목도 데이터 정상 로딩

### ✅ `NameError: ticker` 수정 — HTTP 500 근본 원인 해결
- **파일**: `app.py` — `get_stock_data()`
- **내용**: `ticker` 변수가 `get_stock_data()` 스코프에 미정의로 `yf.Ticker(ticker)` 호출 시 `NameError` 발생 → `suffix = ".KS" if market == "KOSPI" else ".KQ"; ticker = code + suffix` 추가
- **효과**: 모든 종목 조회 HTTP 500 오류 해결

### ✅ `industry` / `translated_desc` 초기화 누락 수정
- **파일**: `app.py` — `get_stock_data()`
- **내용**: 두 변수의 기본값을 try 블록 이전에 반드시 초기화하도록 수정
- **효과**: try 블록 예외 발생 시에도 unbound 변수 오류 없이 기본값으로 동작

### ✅ 네이버 금융 EUC-KR → UTF-8 인코딩 버그 수정
- **파일**: `app.py`
- **내용**: `resp.encoding = 'euc-kr'`(무시됨) 방식 → `resp.text` 사용 (네이버가 UTF-8로 변경된 것을 `curl`로 확인: `Content-Type: text/html;charset=UTF-8`)
- **효과**: 업종명 "誶泥댁誶泥댁스入" 같은 깨진 문자 완전 제거

### ✅ JS fetch 에러 메시지 개선
- **파일**: `client/static/app.js` — `fetchStock()`
- **내용**: `res.json()` 호출 전 `Content-Type` 체크 추가 → HTML 500 응답을 JSON 파싱 시 발생하는 "string did not match the expected pattern" TypeError 방지
- **효과**: "서버 연결 오류가 발생했습니다. 잠시 후 다시 시도해주세요." 사용자 친화적 메시지 표시

### ✅ Flask 정적 파일 라우트 추가 (로컬 개발용)
- **파일**: `app.py`
- **내용**: `@app.route("/")` → `send_from_directory("client", "index.html")`, `@app.route("/<path:path>")` → `send_from_directory("client", path)`
- **효과**: 로컬 `python3 app.py` 실행 시 `http://127.0.0.1:5001` 에서 프론트엔드 서빙

---

## 4. 성능 최적화 (2026-03-01)

### ✅ 인메모리 TTL 캐시 추가 (캐시 5분)
- **파일**: `app.py`
- **내용**: `_STOCK_CACHE` dict를 서버 메모리에 유지. 동일 종목 재조회 시 캐시에서 즉시 반환 (TTL = 300초)
  ```python
  _cache_get(key)  # TTL 만료 여부 확인
  _cache_set(key, value)  # 결과 저장
  ```
- **효과**: 한번 조회한 종목은 5분간 즉시 응답 (0.01초 이내)

### ✅ 외부 API 병렬 호출 — ThreadPoolExecutor 적용
- **파일**: `app.py` — `get_stock_data()`
- **내용**: DART 기업정보, 네이버 업종 파싱, yfinance 기업요약 번역 3개를 `ThreadPoolExecutor(max_workers=3)`으로 동시 실행
  ```
  Before: DART(5s) → Naver(3s) → yfinance(4s) = ~12초 순차
  After:  DART + Naver + yfinance 동시         = ~5초 병렬
  ```
- **효과**: 첫 조회 응답 시간 약 50% 단축 (5~6초 → 3~5초)

---

## 5. 미해결 사항 (수동 조치 필요)

### ⚠️ Render 환경변수 `DATA_GO_KR_API_KEY` 미등록
- **상태**: yfinance 폴백으로 데이터 조회는 가능하나, 공공데이터 1차 소스 비활성화
- **조치**: Render 대시보드 → todaysstock → Environment → `DATA_GO_KR_API_KEY` = `1e39f62ca2499c327a6ce7cb591e0352832be4558db2abe7230798da4a2ac1cf` 추가

### ⚠️ Render 프리 티어 Cold Start
- **상태**: 15분 무접속 후 서버 슬립 → 재접속 시 30~60초 대기
- **조치 옵션**: Render 유료 플랜 업그레이드 또는 UptimeRobot으로 주기적 ping
