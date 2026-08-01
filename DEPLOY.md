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
