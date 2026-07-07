#!/usr/bin/env python3
"""Read-only CRM5 Mission Engine status probe for the Agent Rider static app.

The app invokes this script through the existing same-origin /store/terminal/run
endpoint. Credentials are intentionally not embedded here; the script reads the
existing local YAML config or environment variables.
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

DEFAULT_CONFIGS = [
    "/root/agent-work/op-panel/CRM智慧診斷中心/db_connection.yaml",
    "/root/agent-work/gen_CRM_data/code_CTN_promition_and_games/db_connection.yaml",
    "/root/agent-work/db/sync_to_redis/db_connection.yaml",
]
DEFAULT_SECTION = "ch-crm5"
DB = "MISSION_ENGINE"
TIMEOUT_SECONDS = 35


def read_yaml_section(path: str, section: str) -> dict[str, str]:
    """Parse a simple top-level YAML mapping section without external deps."""
    values: dict[str, str] = {}
    if not path or not os.path.exists(path):
        return values
    in_block = False
    base_indent: int | None = None
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            if not in_block:
                if re.match(rf"^\s*{re.escape(section)}\s*:\s*(?:#.*)?$", raw):
                    in_block = True
                continue
            if raw.strip() == "" or raw.lstrip().startswith("#"):
                continue
            indent = len(raw) - len(raw.lstrip(" "))
            if base_indent is None:
                base_indent = indent
            if indent < base_indent or (indent == 0 and re.match(r"^\S[^:]*:\s*", raw)):
                break
            match = re.match(r"\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*(?:#.*)?$", raw)
            if match:
                key, value = match.groups()
                values[key] = value.strip().strip('"\'')
    return values


def load_config() -> tuple[dict[str, str], str]:
    config_path = os.environ.get("CRM5_CH_CONFIG", "").strip()
    section = os.environ.get("CRM5_CH_SECTION", DEFAULT_SECTION).strip() or DEFAULT_SECTION
    candidates = [config_path] if config_path else DEFAULT_CONFIGS
    file_values: dict[str, str] = {}
    used_path = ""
    for path in candidates:
        file_values = read_yaml_section(path, section)
        if file_values:
            used_path = path
            break

    cfg = dict(file_values)
    # Environment overrides. Prefer a full URL if supplied, otherwise host/port.
    env_map = {
        "host": "CRM5_CH_HOST",
        "port": "CRM5_CH_PORT",
        "user": "CRM5_CH_USER",
        "password": "CRM5_CH_PASSWORD",
        "url": "CRM5_CH_URL",
    }
    for key, env_name in env_map.items():
        val = os.environ.get(env_name, "").strip()
        if val:
            cfg[key] = val
    cfg.setdefault("port", "8123")
    return cfg, used_path


def ch_request(url: str, user: str, password: str, sql: str) -> str:
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    req = urllib.request.Request(
        url,
        data=sql.encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Basic {token}",
            "Content-Type": "text/plain; charset=utf-8",
        },
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
        return resp.read().decode("utf-8", "replace")


def json_each_row(text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))
    return rows


def run_query(url: str, user: str, password: str, sql: str) -> list[dict[str, Any]]:
    sql = sql.strip().rstrip(";") + " FORMAT JSONEachRow"
    return json_each_row(ch_request(url, user, password, sql))


def first_row(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return rows[0] if rows else {}


def main() -> int:
    started = time.time()
    cfg, config_path = load_config()
    url = cfg.get("url") or f"http://{cfg.get('host', '')}:{cfg.get('port', '8123')}/"
    user = cfg.get("user") or cfg.get("username") or ""
    password = cfg.get("password", "")

    if not url or not user or not password or "http://:" in url:
        print(json.dumps({
            "ok": False,
            "error": "CRM5 ClickHouse credentials are not configured. Set CRM5_CH_URL/CRM5_CH_USER/CRM5_CH_PASSWORD or provide ch-crm5 in db_connection.yaml.",
            "configPath": config_path,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        }, ensure_ascii=False))
        return 2

    queries = {
        "meta": f"""
            SELECT
              version() AS clickhouse_version,
              timezone() AS server_timezone,
              formatDateTime(toTimeZone(now(), 'Asia/Taipei'), '%F %T') AS now_taipei,
              formatDateTime(now(), '%F %T') AS now_server
        """,
        "tableStats": f"""
            SELECT
              name AS table_name,
              engine,
              total_rows,
              total_bytes
            FROM system.tables
            WHERE database = '{DB}'
              AND name IN ('MISSION_JOB_HISTORY', 'JOB_SEMAPHORE', 'JOB_EXEC_LOG')
            ORDER BY table_name
        """,
        "kpis": f"""
            WITH
              (SELECT count() FROM {DB}.JOB_SEMAPHORE FINAL WHERE status = 'running') AS running_jobs,
              (SELECT count() FROM {DB}.JOB_SEMAPHORE FINAL WHERE status = 'running' AND last_heartbeat < now() - INTERVAL 5 MINUTE) AS stale_running_jobs,
              (SELECT count() FROM {DB}.JOB_EXEC_LOG WHERE start_time >= now() - INTERVAL 30 MINUTE) AS runs_30m,
              (SELECT count() FROM {DB}.JOB_EXEC_LOG WHERE start_time >= now() - INTERVAL 30 MINUTE AND result_code != 'success') AS failures_30m,
              (SELECT count() FROM {DB}.JOB_EXEC_LOG WHERE start_time >= now() - INTERVAL 24 HOUR AND result_code != 'success') AS failures_24h,
              (SELECT countDistinct(concat(mission_code, ':', job_code)) FROM {DB}.MISSION_JOB_HISTORY FINAL WHERE status = 'enabled' AND effective_start_time <= now() AND effective_end_time >= now()) AS active_job_defs,
              (SELECT max(end_time) FROM {DB}.JOB_EXEC_LOG) AS latest_end_time
            SELECT
              running_jobs,
              stale_running_jobs,
              runs_30m,
              failures_30m,
              failures_24h,
              active_job_defs,
              formatDateTime(toTimeZone(latest_end_time, 'Asia/Taipei'), '%F %T') AS latest_end_time_taipei
        """,
        "resultBuckets30m": f"""
            SELECT
              result_code,
              count() AS runs,
              max(formatDateTime(toTimeZone(end_time, 'Asia/Taipei'), '%F %T')) AS latest_end_taipei
            FROM {DB}.JOB_EXEC_LOG
            WHERE start_time >= now() - INTERVAL 30 MINUTE
            GROUP BY result_code
            ORDER BY runs DESC, result_code
        """,
        "resultBuckets24h": f"""
            SELECT
              result_code,
              count() AS runs
            FROM {DB}.JOB_EXEC_LOG
            WHERE start_time >= now() - INTERVAL 24 HOUR
            GROUP BY result_code
            ORDER BY runs DESC, result_code
        """,
        "semaphore": f"""
            SELECT
              mission_code,
              job_code,
              status,
              formatDateTime(toTimeZone(start_time, 'Asia/Taipei'), '%F %T') AS start_taipei,
              formatDateTime(toTimeZone(last_heartbeat, 'Asia/Taipei'), '%F %T') AS heartbeat_taipei,
              dateDiff('second', last_heartbeat, now()) AS heartbeat_age_sec,
              dateDiff('second', start_time, now()) AS running_age_sec,
              process_id
            FROM {DB}.JOB_SEMAPHORE FINAL
            ORDER BY status = 'running' DESC, last_heartbeat DESC
            LIMIT 80
        """,
        "recentFailures": f"""
            SELECT
              mission_code,
              job_code,
              result_code,
              formatDateTime(toTimeZone(start_time, 'Asia/Taipei'), '%F %T') AS start_taipei,
              formatDateTime(toTimeZone(end_time, 'Asia/Taipei'), '%F %T') AS end_taipei,
              dateDiff('second', start_time, end_time) AS duration_sec,
              left(replaceRegexpAll(exec_log, '\\s+', ' '), 220) AS exec_log_snip
            FROM {DB}.JOB_EXEC_LOG
            WHERE start_time >= now() - INTERVAL 24 HOUR
              AND result_code != 'success'
            ORDER BY start_time DESC
            LIMIT 30
        """,
        "longestRecent": f"""
            SELECT
              mission_code,
              job_code,
              result_code,
              formatDateTime(toTimeZone(start_time, 'Asia/Taipei'), '%F %T') AS start_taipei,
              formatDateTime(toTimeZone(end_time, 'Asia/Taipei'), '%F %T') AS end_taipei,
              dateDiff('second', start_time, end_time) AS duration_sec
            FROM {DB}.JOB_EXEC_LOG
            WHERE start_time >= now() - INTERVAL 1 HOUR
            ORDER BY duration_sec DESC
            LIMIT 20
        """,
        "recentRuns": f"""
            SELECT
              mission_code,
              job_code,
              result_code,
              formatDateTime(toTimeZone(start_time, 'Asia/Taipei'), '%F %T') AS start_taipei,
              formatDateTime(toTimeZone(end_time, 'Asia/Taipei'), '%F %T') AS end_taipei,
              dateDiff('second', start_time, end_time) AS duration_sec
            FROM {DB}.JOB_EXEC_LOG
            ORDER BY start_time DESC
            LIMIT 40
        """,
    }

    output: dict[str, Any] = {
        "ok": True,
        "database": DB,
        "source": {
            "host": cfg.get("host", "from CRM5_CH_URL" if cfg.get("url") else ""),
            "port": cfg.get("port", ""),
            "user": user,
            "configPath": config_path,
        },
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
    try:
        output["meta"] = first_row(run_query(url, user, password, queries["meta"]))
        output["tableStats"] = run_query(url, user, password, queries["tableStats"])
        output["kpis"] = first_row(run_query(url, user, password, queries["kpis"]))
        output["resultBuckets30m"] = run_query(url, user, password, queries["resultBuckets30m"])
        output["resultBuckets24h"] = run_query(url, user, password, queries["resultBuckets24h"])
        output["semaphore"] = run_query(url, user, password, queries["semaphore"])
        output["recentFailures"] = run_query(url, user, password, queries["recentFailures"])
        output["longestRecent"] = run_query(url, user, password, queries["longestRecent"])
        output["recentRuns"] = run_query(url, user, password, queries["recentRuns"])
        output["elapsedMs"] = round((time.time() - started) * 1000)
        print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
        return 0
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:600]
        print(json.dumps({
            "ok": False,
            "error": f"ClickHouse HTTP {exc.code}: {body}",
            "source": {"host": cfg.get("host", ""), "port": cfg.get("port", ""), "user": user, "configPath": config_path},
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        }, ensure_ascii=False))
        return 1
    except Exception as exc:  # noqa: BLE001 - CLI probe should surface JSON errors to UI.
        print(json.dumps({
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "source": {"host": cfg.get("host", ""), "port": cfg.get("port", ""), "user": user, "configPath": config_path},
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
