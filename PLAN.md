# cutdesk 계획

빛뜰(@windgarden_gardener) 릴스 전용 Windows 데스크톱 편집기. CapCut의 작업 흐름을 따르되 이름·로고는 따로 쓴다.
기준 문서: `Desktop\PROJECT\윈드가든인스타\CONTI_RULES.md`, `CHARACTER.md`, `board\board.json`.

## 구조
- Electron + React + TypeScript, 상태는 zustand(`src/store.ts`, 스냅샷 undo/redo)
- 미리보기: `<video>`/`<img>` + canvas 합성(`src/engine/player.ts`)
- 내보내기: 같은 프로젝트 JSON → ffmpeg `filter_complex`(`shared/exportGraph.ts`), 로컬 ffmpeg(`CUTDESK_FFMPEG`로 경로 변경 가능)
- 배치 규칙은 `shared/project.ts`의 `placeVisual` 하나를 미리보기와 내보내기가 같이 쓴다(9:16 꽉 채우기, 레터박스 없음)
- 로컬 파일은 `media://` 프로토콜(Range·CORS 지원)로 읽는다. CORS가 없으면 캔버스가 오염돼 픽셀 읽기와 WebGL이 막힌다
- 클립 볼륨·페이드·속도: 미리보기는 요소마다 WebAudio GainNode(`audioGain`)와 `playbackRate`, 내보내기는 `setpts`·`atempo`·`volume`·`afade`(선형). 타임라인 길이는 `(out - in) / speed`, 소스 위치는 `sourceTime`
- 색 보정: `shared/color.ts`의 `gradePixel` 하나를 33³ 3D LUT로 뽑아, 미리보기는 WebGL2 3D 텍스처(`src/engine/grade.ts`), 내보내기는 `.cube` 파일 + ffmpeg `lut3d=interp=trilinear`(작업 폴더를 cwd로 두고 상대 이름으로 참조)
- 텍스트는 렌더러 캔버스가 Pretendard(Black·Bold·Medium, OFL, `src/fonts`)로 그린다(`src/engine/text.ts`). 미리보기는 그 비트맵을 그리고, 내보내기는 같은 함수로 출력 크기 PNG를 만들어 ffmpeg에 넘긴다(`src/exportTexts.ts`). 등장 효과(팝·페이드·올라오기) 시간값은 `shared/project.ts` 한 곳
- 배지 숫자는 토큰: `{D}`(올리는 날→복학일), `{월급}`, `{목표}`. 값은 프로젝트 `vars`, 콘티를 불러오면 보드 설정과 게시일로 채운다
- 운영 보드(`board.json`)는 읽기만 한다. 쓰지 않는다

## Phase
1. 타임라인 컷 편집: 가져오기, 다중 트랙, 이동·트림·분할·삭제, 자석, 확대, 미리보기, undo/redo, 저장/열기, MP4 내보내기, 클립 위치·확대 (완료)
2. 텍스트·자막 + 빛뜰 자막·배지 프리셋 + 운영 보드 콘티 불러오기 + SRT (완료)
3. 대표님 결정(2026-09-30): 흔들림·글리치 같은 화면 효과는 넣지 않는다(대비 톤, 규칙 2-2). 전환은 크로스 디졸브 하나
   - 3a 콘티 규칙 실시간 점검(`src/rules.ts`, 점검 탭, 안전 영역 가이드): 길이 15~35초, 메인 컷 2초, 두 줄(딴지 제외)·줄당 16자·초당 12자, 안전 영역, 배지 위치, 레터박스, 빈 화면, 무음 (완료)
   - 3b 오디오(클립 볼륨 0~200%·페이드 인/아웃)·속도(0.5~2배, 소리는 음높이 유지) (완료). 속도를 바꾸면 같은 트랙 뒤 클립이 따라 움직인다(다른 트랙의 자막은 그대로). 분할하면 안쪽 페이드는 0이 된다
   - 3c 색 보정(밝기·대비·채도·색온도) + 빛뜰 보정 프리셋(CHARACTER 2-1: 밝기 +20, 대비 -15, 빛뜰 톤 100 = 초록 채도 절반, 185~260° 파랑을 세룰리안 204.5°로 70% 당김) (완료). 흰색 중립은 자동 화이트밸런스 없이 색온도로 맞춘다. 그레인은 없다
     - 대표님 추가 지시(2026-10-01): 보정 프리셋 저장(앱 전체 공유, `localStorage` `cutdesk.colorPresets`, 같은 이름은 덮어씀)과 "모든 영상·사진 클립에 적용"(되돌리기 한 번) (완료)
   - 3c+ 앱 안 Claude(대표님 결정 2026-10-01: Agent SDK, 로그인된 Claude Code 구독, 기본 모델 Sonnet). 구현: 사이드 패널 Claude 탭, 도구 4개(get_state 압축 텍스트, edit 일괄·원자적·undo 1단계, screenshot 270x480, screenshot_app). 내장 도구·설정 파일·다른 MCP 없이 실행. 내보내기·저장·열기는 맡기지 않음
   - 3d 크로스 디졸브

## 검증
- `npm test` = 빌드 + `scripts/e2e-export.mjs`(실제 ffmpeg 출력의 픽셀·음량 검사) + `scripts/e2e-ui.mjs`(Electron 실행, 미리보기 캔버스와 내보낸 프레임 비교(텍스트 포함), 분할·되돌리기·드래그·트림, 프리셋 추가·텍스트 수정, 실제 board.json p001 콘티 불러오기, SRT 내보내기·가져오기, 콘티 규칙, 속도·볼륨·페이드, 색 보정의 미리보기·함수·내보내기 3자 비교)
- `npm run typecheck`, `npm run lint`

## 알려진 한계
- 아이폰 HDR(HLG·돌비비전) 영상은 미리보기와 내보내기 색이 다를 수 있다(톤매핑 미처리)
- 앱을 연 직후 첫 영상 프레임은 최대 1초 정도 늦게 뜬다
- 영상 구간으로 재생 헤드를 옮기면 미리보기가 약 0.4초 늦게 바뀐다(영상 seek 동안 Chromium이 requestAnimationFrame을 미룸)
- ffmpeg 팝 효과는 `scale` 뒤 `format=rgba`를 고정해야 한다. 빠지면 overlay 때문에 yuva420p로 협상되고 `pad`가 홀수 크기를 짝수로 내려서 실패한다
