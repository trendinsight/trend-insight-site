# trend-insight-site

> ## ⛔ 이 저장소 루트에서 `wrangler deploy` 를 실행하지 마세요
>
> 배포는 **main 브랜치 커밋 → Cloudflare Workers Builds 자동 배포**로만 합니다 (약 1분).
> 루트 `wrangler.jsonc` 의 `assets.directory` 가 `"."` 이므로, 저장소 전체 파일이 없는
> 디렉터리(임시 폴더·부분 클론)에서 `wrangler deploy` 를 돌리면 프로덕션 애셋 번들이
> 반쪽짜리로 교체되어 **사이트 전 페이지가 빈 404** 가 됩니다.
> 절차·사고 이력·복구 방법은 [DEPLOY.md](DEPLOY.md) 참고.

Stock investment
