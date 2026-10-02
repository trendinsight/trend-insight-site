#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Trend Insight 보드 데이터 게시 헬퍼 — git 커밋/재배포 없이 /data/{board}.json 을 즉시 갱신.

서버: worker.js 의 /api/board/* (KV 저장, 저장소 정적 파일은 폴백).
인증: config.json 의 git_token (저장소 push 권한) — 기존 스킬 config 그대로 재사용.

CLI
  python ti_board.py pull  thesis-board [-o board.json]     # 현재 서빙 중인 본문 받기
  python ti_board.py push  thesis-board board.json [--skill investment-thesis]
  python ti_board.py meta  thesis-board                      # 출처(kv|static)·갱신 시각
  python ti_board.py list                                    # API로 올라간 보드 목록
  python ti_board.py rollback thesis-board                   # 직전 본으로
  python ti_board.py reset    thesis-board                   # KV 본 내리고 저장소 정적 파일로

모듈
  from ti_board import pull, push
  store = pull("new-high", default={"weeks": []})
  ... 병합 ...
  push("new-high", store, skill="new-high-radar")
"""
import argparse, glob, json, os, sys, urllib.error, urllib.request

DEFAULT_SITE = "https://trend-insight-site.sungsangkyung77.workers.dev"
UA = "ti-board/1.0"


def _cfg_candidates():
    c = []
    if os.environ.get("TREND_INSIGHT_CONFIG"):
        c.append(os.environ["TREND_INSIGHT_CONFIG"])
    home = os.path.expanduser("~")
    c.append(os.path.join(home, ".trend-insight", "config.json"))
    c += sorted(glob.glob(os.path.join(home, ".claude", "skills", "synced", "*", "trend-insight-publisher", "config.json")))
    c += sorted(glob.glob(os.path.join(home, ".claude", "skills", "trend-insight-publisher", "config.json")))
    c.append("/mnt/user-data/uploads/config.json")
    return c


def load_config(path=None):
    for p in ([path] if path else _cfg_candidates()):
        if p and os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                cfg = json.load(f)
            if cfg.get("git_token"):
                return cfg
    return {}


def _site(cfg):
    return (cfg.get("site_url") or DEFAULT_SITE).rstrip("/")


def _req(method, url, token=None, body=None, skill=None, timeout=60):
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if skill:
        headers["X-Board-Source-Skill"] = skill
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), dict(e.headers)


class BoardError(RuntimeError):
    pass


def pull(name, default=None, cfg=None):
    """현재 서빙 중인 보드 JSON(dict/list). 없으면 default (None이면 예외)."""
    cfg = cfg if cfg is not None else load_config()
    st, txt, _ = _req("GET", f"{_site(cfg)}/api/board/{name}")
    if st == 200:
        return json.loads(txt)
    if st == 404 and default is not None:
        return default
    raise BoardError(f"pull {name}: HTTP {st} {txt[:200]}")


def push(name, data, skill=None, cfg=None):
    """보드 JSON 전체 교체. data는 dict/list 또는 JSON 문자열/bytes. 성공 시 메타 dict."""
    cfg = cfg if cfg is not None else load_config()
    tok = cfg.get("git_token")
    if not tok:
        raise BoardError("config.json에 git_token 없음 (TREND_INSIGHT_CONFIG 또는 ~/.trend-insight/config.json)")
    if isinstance(data, (dict, list)):
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    else:
        body = data
    st, txt, _ = _req("POST", f"{_site(cfg)}/api/board/{name}", tok, body, skill)
    if st != 200:
        raise BoardError(f"push {name}: HTTP {st} {txt[:300]}")
    return json.loads(txt)


def _simple(method, name, op="", cfg=None, auth=True):
    cfg = cfg if cfg is not None else load_config()
    path = f"{_site(cfg)}/api/board/{name}" + (f"/{op}" if op else "")
    st, txt, _ = _req(method, path, cfg.get("git_token") if auth else None)
    if st != 200:
        raise BoardError(f"{method} {path}: HTTP {st} {txt[:300]}")
    return json.loads(txt)


def meta(name, cfg=None):
    return _simple("GET", name, "meta", cfg, auth=False)


def rollback(name, cfg=None):
    return _simple("POST", name, "rollback", cfg)


def reset(name, cfg=None):
    return _simple("DELETE", name, "", cfg)


def list_boards(cfg=None):
    cfg = cfg if cfg is not None else load_config()
    st, txt, _ = _req("GET", f"{_site(cfg)}/api/board/")
    if st != 200:
        raise BoardError(f"list: HTTP {st} {txt[:200]}")
    return json.loads(txt)


def main():
    ap = argparse.ArgumentParser(description="Trend Insight 보드 데이터 게시 (재배포 없음)")
    ap.add_argument("cmd", choices=["pull", "push", "meta", "list", "rollback", "reset"])
    ap.add_argument("name", nargs="?")
    ap.add_argument("file", nargs="?")
    ap.add_argument("-o", "--out")
    ap.add_argument("--skill")
    ap.add_argument("--config")
    a = ap.parse_args()
    cfg = load_config(a.config)
    try:
        if a.cmd == "list":
            out = list_boards(cfg)
        elif not a.name:
            sys.exit("보드 이름이 필요합니다 (예: thesis-board)")
        elif a.cmd == "pull":
            d = pull(a.name, cfg=cfg)
            if a.out:
                with open(a.out, "w", encoding="utf-8") as f:
                    json.dump(d, f, ensure_ascii=False, indent=1)
                out = {"ok": True, "saved": a.out}
            else:
                out = d
        elif a.cmd == "push":
            if not a.file:
                sys.exit("업로드할 JSON 파일 경로가 필요합니다")
            with open(a.file, "rb") as f:
                out = push(a.name, f.read(), a.skill, cfg)
        elif a.cmd == "meta":
            out = meta(a.name, cfg)
        elif a.cmd == "rollback":
            out = rollback(a.name, cfg)
        else:
            out = reset(a.name, cfg)
    except BoardError as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
