# cutdesk 계획

빛뜰(@windgarden_gardener) 릴스 전용 Windows 데스크톱 편집기. CapCut의 작업 흐름을 따르되 이름·로고는 따로 쓴다.
기준 문서: `Desktop\PROJECT\윈드가든인스타\CONTI_RULES.md`, `CHARACTER.md`, `board\board.json`.

## 구조
- Electron + React + TypeScript, 상태는 zustand(`src/store.ts`, 스냅샷 undo/redo)
- 미리보기: `<video>`/`<img>` + canvas 합성(`src/engine/player.ts`)
- 내보내기: 같은 프로젝트 JSON → ffmpeg `filter_complex`(`shared/exportGraph.ts`), 로컬 ffmpeg(`CUTDESK_FFMPEG`로 경로 변경 가능)
- 배치 규칙은 `shared/project.ts`의 `placeVisual` 하나를 미리보기와 내보내기가 같이 쓴다(9:16 꽉 채우기, 레터박스 없음)
- 로컬 파일은 `media://` 프로토콜(Range·CORS 지원)로 읽는다. CORS가 없으면 캔버스가 오염돼 픽셀 읽기와 WebGL이 막힌다
- 텍스트는 렌더러 캔버스가 Pretendard(Black·Bold·Medium, OFL, `src/fonts`)로 그린다(`src/engine/text.ts`). 미리보기는 그 비트맵을 그리고, 내보내기는 같은 함수로 출력 크기 PNG를 만들어 ffmpeg에 넘긴다(`src/exportTexts.ts`). 등장 효과(팝·페이드·올라오기) 시간값은 `shared/project.ts` 한 곳
- 배지 숫자는 토큰: `{D}`(올리는 날→복학일), `{월급}`, `{목표}`. 값은 프로젝트 `vars`, 콘티를 불러오면 보드 설정과 게시일로 채운다
- 운영 보드(`board.json`)는 읽기만 한다. 쓰지 않는다

## Phase
1. 타임라인 컷 편집: 가져오기, 다중 트랙, 이동·트림·분할·삭제, 자석, 확대, 미리보기, undo/redo, 저장/열기, MP4 내보내기, 클립 위치·확대 (완료)
2. 텍스트·자막 + 빛뜰 자막·배지 프리셋 + 운영 보드 콘티 불러오기 + SRT (완료)
3. 효과·전환·필터·속도·오디오 + 콘티 규칙 실시간 점검(15~35초, 컷 2초, 두 줄·16자·초당 12자, 안전 영역)

## 검증
- `npm test` = 빌드 + `scripts/e2e-export.mjs`(실제 ffmpeg 출력의 픽셀·음량 검사) + `scripts/e2e-ui.mjs`(Electron 실행, 미리보기 캔버스와 내보낸 프레임 비교(텍스트 포함), 분할·되돌리기·드래그·트림, 프리셋 추가·텍스트 수정, 실제 board.json p001 콘티 불러오기, SRT 내보내기·가져오기)
- `npm run typecheck`, `npm run lint`

## 알려진 한계
- 아이폰 HDR(HLG·돌비비전) 영상은 미리보기와 내보내기 색이 다를 수 있다(톤매핑 미처리)
- 앱을 연 직후 첫 영상 프레임은 최대 1초 정도 늦게 뜬다
- 영상 구간으로 재생 헤드를 옮기면 미리보기가 약 0.4초 늦게 바뀐다(영상 seek 동안 Chromium이 requestAnimationFrame을 미룸)
- ffmpeg 팝 효과는 `scale` 뒤 `format=rgba`를 고정해야 한다. 빠지면 overlay 때문에 yuva420p로 협상되고 `pad`가 홀수 크기를 짝수로 내려서 실패한다
