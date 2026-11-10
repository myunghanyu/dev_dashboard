# Dev Dashboard

`~/develop` 아래 git 레포, Claude Code 세션, GitHub Actions를 한 화면에 모아 보는 macOS용 Electron 앱입니다. 메뉴 막대에는 Claude 남은 사용량이 배터리처럼 표시됩니다.

## 탭

| 탭 | 내용 |
|---|---|
| 개요 | 현재 작업 중인 레포, 최근 작업한 레포, 커밋 추이, 레포별 작업량 비율과 커밋 수 |
| 티켓 | 티켓마다 브랜치를 만들고(체크아웃하지 않음) 앱에서 바로 커밋·푸시·완료 처리 |
| 릴리즈 PR | `develop`(없으면 `dev`) → `main`(없으면 `master`)으로 갈 모든 작성자의 커밋을 모아 PR 본문 초안 생성. 복사, AI로 다듬기, `gh pr create` 지원 |
| 기능 이력 · 세션 | 커밋을 기능 단위로 묶은 이력과 Claude 세션 목록. Claude와 함께 만든 커밋 표시 |
| 리포트 | 기간별 `[레포] - 기능: 요약` 텍스트 Export(클립보드·파일), Claude AI 요약 |
| GitHub Actions | 최근 30일 안에 활동한 레포의 워크플로 실행 기록(60초마다 갱신) |
| 레포 분류 | 레포를 FE / BE / Module로 태깅하면 모든 화면에 반영 |

## Claude 사용량

- 상단 막대와 메뉴 막대에 5시간 · 주간 남은 %가 표시됩니다.
- **플랜 한도 기준:** Claude Code가 status line에 `rate_limits`를 넘겨주면 `statusline.sh`가 `~/.claude/dev-dashboard-usage.json`에 저장하고, 앱은 그 값을 그대로 씁니다.
- **로컬 기준(대체 방식):** 한도 정보가 없는 계정이면 `~/.claude/projects`의 세션 기록에서 토큰을 셉니다(입력 + 출력 + 캐시 쓰기, 캐시 읽기 제외). 상단의 **한도 설정** 버튼으로 정한 한도 대비 남은 %가 표시됩니다. 서버가 실제로 재는 값과는 다를 수 있습니다.

status line 연결 (`~/.claude/settings.json`):

```json
{ "statusLine": { "type": "command", "command": "~/develop/dev-dashboard/statusline.sh" } }
```

## 필요한 것

- macOS, Node.js
- `git`
- [`gh`](https://cli.github.com/): 로그인한 상태여야 합니다. Actions 탭과 릴리즈 PR 탭에서 씁니다.
- `claude` CLI: AI 요약과 AI로 다듬기에서 씁니다.
- `jq`: `statusline.sh`에서 씁니다.

## 실행

```sh
npm install
npm start          # 개발 모드로 실행
npm run check      # 자가 점검 (node collect.js)
npm run release    # 점검 → 패키징 → 서명 → /Applications/Dev Dashboard.app 설치 및 실행
```

창을 닫아도 앱은 메뉴 막대에 남아 있습니다. 종료는 메뉴 막대 메뉴에서 할 수 있습니다.

## 구조

| 파일 | 역할 |
|---|---|
| `collect.js` | 데이터 수집(git, Claude 세션, gh, 사용량, 티켓, 릴리즈 초안). 직접 실행하면 자가 점검을 돌립니다 |
| `main.js` | Electron 메인 프로세스: IPC, 메뉴 막대 표시, 설정 저장 |
| `preload.js` | 렌더러에 노출하는 `api` |
| `index.html` | UI 전체(HTML, CSS, JS가 한 파일에 있음) |
| `statusline.sh` | Claude Code status line 스크립트 |
| `release.sh` | 앱 빌드와 설치 |

티켓, 레포 분류, 사용량 한도 설정은 `~/Library/Application Support/dev-dashboard/`에 저장됩니다.
