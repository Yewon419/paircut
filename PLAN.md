# cutdesk 계획

빛뜰(@windgarden_gardener) 릴스 전용 Windows 데스크톱 편집기. CapCut의 작업 흐름을 따르되 이름·로고는 따로 쓴다.
기준 문서: `Desktop\PROJECT\윈드가든인스타\CONTI_RULES.md`, `CHARACTER.md`, `board\board.json`.

## 구조
- Electron + React + TypeScript, 상태는 zustand(`src/store.ts`, 스냅샷 undo/redo)
- 미리보기: `<video>`/`<img>` + canvas 합성(`src/engine/player.ts`)
- 내보내기: 같은 프로젝트 JSON → ffmpeg `filter_complex`(`shared/exportGraph.ts`), 로컬 ffmpeg(`CUTDESK_FFMPEG`로 경로 변경 가능)
- 배치 규칙은 `shared/project.ts`의 `placeVisual` 하나를 미리보기와 내보내기가 같이 쓴다(9:16 꽉 채우기, 레터박스 없음)
- 로컬 파일은 `media://` 프로토콜(Range·CORS 지원)로 읽는다. CORS가 없으면 캔버스가 오염돼 픽셀 읽기와 WebGL이 막힌다

## Phase
1. 타임라인 컷 편집: 가져오기, 다중 트랙, 이동·트림·분할·삭제, 자석, 확대, 미리보기, undo/redo, 저장/열기, MP4 내보내기, 클립 위치·확대 (완료)
2. 텍스트·자막 + 빛뜰 자막·배지 프리셋 + 운영 보드 콘티 불러오기 + SRT
3. 효과·전환·필터·속도·오디오 + 콘티 규칙 실시간 점검(15~35초, 컷 2초, 두 줄·16자·초당 12자, 안전 영역)

## 검증
- `npm test` = 빌드 + `scripts/e2e-export.mjs`(실제 ffmpeg 출력의 픽셀·음량 검사) + `scripts/e2e-ui.mjs`(Electron 실행, 미리보기 캔버스와 내보낸 프레임 비교, 분할·되돌리기·드래그·트림)
- `npm run typecheck`, `npm run lint`

## 알려진 한계
- 아이폰 HDR(HLG·돌비비전) 영상은 미리보기와 내보내기 색이 다를 수 있다(톤매핑 미처리)
- 앱을 연 직후 첫 영상 프레임은 최대 1초 정도 늦게 뜬다
