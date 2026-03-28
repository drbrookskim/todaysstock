# 🛠️ AI 노드 탐색기 구현 및 트러블슈팅 요약 (Workaround summary)

오늘 작업한 "옵시디언 스타일 AI 노드 탐색기"의 주요 구현 내용과 기술적 문제 해결 과정을 정리한 문서입니다.

## 1. 주요 구현 기능 (Core Implementation)
- **지능형 노드 확장**: `react-force-graph-2d`를 활용하여 노드 클릭 시 연관 키워드 3개를 실시간으로 그래프에 추가하는 로직 구현.
- **이미지 및 오디오 연동**: Imagen 스타일의 추상적 아트 시각화 및 Gemini TTS 기반 오디오 가이드 UI(파형 애니메이션 포함) 제작.
- **프리미엄 UI**: Tailwind CSS와 Framer Motion을 결합한 다크 모드 Glassmorphism 인터페이스 적용.

## 2. 주요 기술적 이슈 및 해결 방법 (Workarounds)
### ⚠️ Tailwind CSS v4 호환성 이슈
- **문제**: Tailwind v4 전용 컴파일러와 기존 PostCSS 환경 간의 충돌로 인해 스타일이 적용되지 않거나 빌드 에러 발생 (`bg-dark-950` 등 커스텀 클래스 인식 불가).
- **해결**: 안정적인 **Tailwind CSS v3**로 다운그레이드하고, `tailwind.config.js`를 통해 명시적인 테마 변수를 정의하여 완벽한 스타일 복구.

### ⚠️ PostCSS 플러그인 설정
- **문제**: Vite 환경에서 Tailwind v4 엔진을 PostCSS 플러그인으로 직접 호출할 때 발생하는 오작동.
- **해결**: `@tailwindcss/postcss` 패키지 대신 정식 v3 연동 방식(`tailwindcss`, `autoprefixer`)으로 설정을 표준화하여 브라우저 렌더링 안정성 확보.

### ⚠️ 브라우저 세션 및 포트 충돌
- **문제**: 여러 작업 세션에서 Vite 서버가 중복 실행되어 포트 포워딩 혼선 발생.
- **해결**: `killall -9 node` 명령으로 기존 프로세스를 완전히 종료한 후, 특정 포트(`5200`)를 지정하여 깨끗한 환경에서 검증 수행.

---
**최종 상태**: 모든 기능이 정상 작동하며, 로컬 저장소에 커밋 및 GitHub 원격 저장소(`KIIMM22/aigraphview`) 연동 설정이 완료되었습니다.
