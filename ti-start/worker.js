/* Trend Insight Start — 입문자용 스타트 페이지 전용 주소
   본 사이트 Worker(trend-insight-site)에 서비스 바인딩(MAIN)으로 요청을 넘긴다.
   원래 요청 URL(호스트)을 그대로 넘기므로 로그인 쿠키·리다이렉트가 이 주소 안에서 유지된다.
   콘텐츠는 전부 본 사이트 저장소의 start.html 하나만 고치면 된다. */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/index") {
      url.pathname = "/start"; // 에셋 html_handling이 /start.html → /start 로 307 시키므로 최종 경로로 바로 요청
      req = new Request(url.toString(), req);
    }
    try {
      return await env.MAIN.fetch(req);
    } catch (e) {
      return Response.redirect("https://trend-insight-site.sungsangkyung77.workers.dev" + url.pathname + url.search, 302);
    }
  },
};
