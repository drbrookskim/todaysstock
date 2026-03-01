# Error Correction Log — Frontend ↔ Backend Pipeline Audit

Date: 2026-03-01

---

## 전체 아키텍처 개요

| 레이어 | 역할 | 호스팅 |
|--------|------|--------|
| 프론트엔드 | `client/index.html`, `app.js`, `style.css` | Cloudflare Pages |
| 백엔드 API | `app.py` (Flask + Gunicorn) | Render (free tier) |
| 인증 / DB | Supabase (JWT 토큰 기반 RLS) | Supabase Cloud |
| 주가 데이터 소스 1 | 한국 공공데이터포털 `data.go.kr` | 외부 API |
| 주가 데이터 소스 2 (폴백) | `yfinance` (Yahoo Finance) | 외부 API |

프론트엔드 `app.js`의 `API_BASE_URL`은 `https://todaysstock.onrender.com`으로 고정되어 있으며,  
모든 `/api/*` 요청은 Render 백엔드로 향합니다.

---

## 발견 및 수정된 버그 목록

---

### 🔴 Bug #1 — `NameError: ticker is not defined` in `get_stock_data()`

**파일**: `app.py`, 약 306번째 줄  
**심각도**: 🔴 Critical (모든 종목 조회를 HTTP 500으로 만드는 치명적 버그)  
**발견 방법**: Render `/api/stock` 요청이 empty body 또는 HTML 500을 반환하는 것을 `curl`로 확인.

**원인**:
```python
# get_stock_data() 함수 내부 - ticker 변수가 미정의 상태로 사용됨
info = yf.Ticker(ticker).info   # ← ticker는 download_stock_df() 스코프에만 존재
```
`ticker` 변수 (예: `"005930.KS"`)는 `download_stock_df()` 함수 내에서만 지역 변수로 정의되어 있음.  
`get_stock_data()` 함수에서 동일 변수를 사용하려 하지만 스코프가 달라 `NameError`가 발생.

**수정 내용**:
```python
# get_stock_data() 함수 상단에 초기값 및 ticker 정의 추가
industry = "분류되지 않음"
translated_desc = "기업 상세 정보를 불러오는 중 오류가 발생했습니다."
suffix = ".KS" if market == "KOSPI" else ".KQ"
ticker = code + suffix        # ← 이제 이 스코프에서도 정의됨
```

---

### 🔴 Bug #2 — `industry` / `translated_desc` 초기화 없이 사용

**파일**: `app.py`, `get_stock_data()` 함수 전체  
**심각도**: 🔴 Critical (Bug #1과 결합하여 company_summary HTML 생성 시 NameError 발생)

**원인**:
```python
# industry는 첫 번째 try 블록에서만 설정될 수 있지만 기본값 없음
# try 블록이 예외 발생 시 industry가 미정의 → 다음 코드에서 NameError
if industry == "분류되지 않음" and en_industry:  # industry 미정의라면 NameError
```

**수정 내용**:
두 변수 모두 try 블록 전에 기본값으로 초기화:
```python
industry = "분류되지 않음"
translated_desc = "기업 상세 정보를 불러오는 중 오류가 발생했습니다."
```

---

### 🟡 Bug #3 — `data.go.kr` API 커버리지 부족 → 일부 종목 데이터 없음

**파일**: `app.py`, `download_stock_df()`  
**심각도**: 🟡 Medium (특정 종목만 영향, 앱 전체가 다운되지는 않음)

**원인**:
`data.go.kr`의 `getStockPriceInfo` API가 `likeSrtnCd` 파라미터로 조회 시  
루닛(247690), 에코프로비엠(247540) 등 일부 종목에 대해 `totalCount=0`을 반환.

**수정 내용**:
`data.go.kr` → 데이터 없을 경우 `yfinance`로 자동 폴백:
```python
# 1차: 공공데이터포털 API
if api_key:
    ... (data.go.kr 시도)
    if items: return df  # 성공 시 반환

# 2차 폴백: yfinance
suffix = ".KS" if market == "KOSPI" else ".KQ"
df = yf.download(ticker, ...)
return df
```

---

### 🟡 Bug #4 — Render 환경변수 `DATA_GO_KR_API_KEY` 미등록

**파일**: Render 대시보드 환경변수 설정  
**심각도**: 🟡 Medium (yfinance 폴백이 있으므로 앱이 0이 되지는 않지만 1차 소스 불가)

**원인**:
`.env` 파일에는 `DATA_GO_KR_API_KEY`가 설정되어 있지만,  
Render 서버에는 해당 환경 변수가 등록되지 않아 `download_stock_df()`가  
항상 yfinance 폴백 경로를 타게 됨.

**해결 방법** (수동 조치 필요):
1. [Render 대시보드](https://dashboard.render.com/) 접속
2. `todaysstock` 서비스 → **Environment** 탭
3. 다음 변수 추가:
   - Key: `DATA_GO_KR_API_KEY`
   - Value: `1e39f62ca2499c327a6ce7cb591e0352832be4558db2abe7230798da4a2ac1cf`
4. Save Changes → 자동 재배포

---

### 🟢 Bug #5 — JS 에러 메시지 "The string did not match the expected pattern"

**파일**: `client/static/app.js`, `fetchStock()` 함수  
**심각도**: 🟢 Minor UX (기능에는 영향 없으나 오해를 일으키는 메시지)

**원인**:
백엔드가 HTML 500 페이지를 반환할 때, JS 코드가 `res.json()`을 호출하면  
브라우저가 `TypeError: The string did not match the expected pattern`을 throw.

**수정 내용**:
JSON 파싱 전 `Content-Type` 검사 추가:
```javascript
const contentType = res.headers.get('content-type') || '';
if (!res.ok || !contentType.includes('application/json')) {
    showError('서버 연결 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
    return;
}
```

---

### 🟢 Bug #6 — 로컬 서버에서 `/static/app.js` 404

**파일**: `app.py`, `serve_static()` 라우트  
**심각도**: 🟢 Minor (로컬 개발 환경만 영향, Cloudflare 배포에는 무관)

**원인**:
Flask 앱을 `Flask(__name__)` 로 생성하면 `/static/` URL prefix를  
Flask 자체의 Built-in StaticFileHandler가 먼저 가로채어,  
`serve_static()` 커스텀 라우트에 도달하지 못함.

**수정 방법 (로컬 개발 전용)**:
```python
app = Flask(__name__, static_folder=None)  # 내장 static handler 비활성화
# 또는 FLASK_ENV=development 없이 python3 app.py 실행
```
> **참고**: Cloudflare Pages는 `client/` 폴더를 직접 정적 파일로 서빙하므로,  
> 이 버그는 프로덕션에서 발생하지 않음.

---

## 요약 수정 내역

| # | 파일 | 버그 종류 | 심각도 | 상태 |
|---|------|-----------|--------|------|
| 1 | `app.py` | `NameError: ticker` in `get_stock_data()` | 🔴 Critical | ✅ 수정 완료 |
| 2 | `app.py` | `industry`/`translated_desc` 초기화 누락 | 🔴 Critical | ✅ 수정 완료 |
| 3 | `app.py` | `data.go.kr` 커버리지 부족 → yfinance 폴백 없음 | 🟡 Medium | ✅ 수정 완료 |
| 4 | Render 환경변수 | `DATA_GO_KR_API_KEY` 미등록 | 🟡 Medium | ⚠️ 수동 조치 필요 |
| 5 | `app.js` | HTML 500 응답을 JSON으로 파싱 시 오류 | 🟢 Minor | ✅ 수정 완료 |
| 6 | `app.py` | 로컬 `/static/` 라우트 충돌 | 🟢 Minor | 📝 문서화 (프로덕션 무관) |

---

## 데이터 흐름 정상화 후 예상 동작

```
사용자 검색 (에코프로비엠)
    → JS fetchStock()
        → GET /api/stock?code=247540&market=KOSPI
            → download_stock_df("247540", "KOSPI")
                → [1차] data.go.kr → 결과 있으면 반환
                → [2차] yfinance "247540.KS" → 폴백
            → get_stock_data() → MA 계산, DART/Naver 업종 조회
        → JSON 응답 반환
    → renderResult() → 차트/분석 표시
```
