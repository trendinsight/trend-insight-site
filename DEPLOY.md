# 배포 규칙 (DEPLOY.md)

## 원칙 — 배포는 커밋으로만

이 저장소는 Cloudflare Workers Builds에 연결되어 있다.
**main 브랜치에 푸시하면 자동으로 빌드·배포된다 (약 1분).**
그 외의 배포 경로는 전부 금지다.

| 하는 것 | 안 하는 것 |
|---|---|
| GitHub Contents/Git Data API로 파일 커밋 | 루트에서 `wrangler deploy` |
| 대시보드에서 버전 롤백 (사고 복구 시) | `wrangler deploy --name trend-insight-site` |
| 하위 사이트는 각자 폴더의 `wrangler.jsonc`로 | 임시 폴더에 파일 몇 개만 두고 배포 |

## 왜 위험한가

루트 `wrangler.jsonc` 의 `assets.directory` 는 `"."` 이다.
`wrangler deploy` 는 **실행 시점의 그 디렉터리에 실제로 있는 파일**만 애셋 번들로 올린다.
저장소 전체가 없는 곳에서 실행하면:

- 번들에 없는 페이지 → 전부 **빈 본문 404** (브라우저는 자체 오류 페이지를 띄움)
- `worker.js` 가 빠지면 → `/api/*`, KV 기반 `/data/*.json` 까지 전부 죽음
- 홈(`/`)만 엣지 캐시로 잠시 살아 있어 **겉보기엔 멀쩡해 보인다** → 발견이 늦어짐

## 사고 이력

**2026-07-31 ~ 08-01 (약 20시간)**

- 원인: 저장소 전체가 없는 디렉터리에서 `wrangler deploy` 1회 실행 →
  수동 버전 `d69c28a8` 이 프로덕션 트래픽 100% 를 가져감
- 증상: `gauge.html` 등 전 페이지, 모든 `/api/*`, `/data/market-gauge.json` 이 빈 404.
  홈만 캐시로 7월 중순 모습 표시. GitHub 빌드는 409건 전부 성공 상태였음
- 복구: 대시보드 > Workers > trend-insight-site > 배포 > 버전 기록에서
  직전 main 빌드(`b10a2683`) `···` > **롤백**

## 사고 시 복구 절차

1. Cloudflare 대시보드 > Compute(Workers) > `trend-insight-site` > **배포** 탭
2. **활성 배포**의 버전이 "수동으로 배포됨 / Wrangler" 이면 이 사고다
3. 버전 기록에서 가장 최근 `main` 빌드 버전의 `···` > **롤백** > 확인
4. 검증: `/`, `/gauge.html`, `/data/market-gauge.json`, `/api/risk/rules` 가 모두 200인지 확인

## 하위 사이트

`character-insight/`, `family-album/`, `cat-meow/` 는 각자 별도 Worker이며
자체 `wrangler.jsonc` 를 갖고 있다. 루트 `.assetsignore` 에 등록되어 있으니 건드리지 말 것.
이들도 배포는 마찬가지로 main 커밋으로만 한다.


## 보드 데이터 동적 레이어 (2026-10-02~)

보드형 페이지의 데이터(`data/{board}.json`)는 **재배포 없이** API로 갱신할 수 있다.

- 게시: `python tools/ti_board.py push thesis-board board.json --skill investment-thesis`
  (인증 = config.json의 `git_token`. 클라우드 세션처럼 GitHub가 막힌 곳에서도 동작)
- 조회: `GET /data/{board}.json` → KV 게시본이 있으면 그것(`x-board-source: kv`), 없으면 저장소 정적 파일
- 되돌리기: `ti_board.py rollback {board}` (직전 본) / `ti_board.py reset {board}` (저장소 정적 파일로)
- 목록·이력: `GET /api/board/` , D1 `ti-brain.board_log`
- **섞어 써도 안전**: KV 게시 뒤에 git 커밋으로 정적 파일이 바뀌면 정적 쪽이 더 최신으로 판정되어
  자동으로 정적을 서빙한다(KV 본은 `:prev`로 보관). 항상 "마지막에 올린 것"이 보인다.
- 페이지 HTML 자체를 바꿀 때는 여전히 git 커밋(위 원칙) 경로를 쓴다.
