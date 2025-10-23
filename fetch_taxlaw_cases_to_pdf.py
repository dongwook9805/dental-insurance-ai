#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Download 판례 PDFs from taxlaw.nts.go.kr by iterating ntstDcmId ranges.

Example:
  python fetch_taxlaw_cases_to_pdf.py \
    --out ./pdf_out \
    --start 200000000000014300 \
    --end   200000000000014350 \
    --delay 0.5

The script uses the same JSON APIs that the 웹사이트 employs:
  - ASIQTB002PR01 : 상세 데이터를 가져와 첨부파일 정보(dcmHwpEditorDVOList 포함)를 조회
  - ACMCMA001MR02 : fleId/fleSn 을 이용해 다운로드 정보를 확인 (fleDwldUri 등)
  - /downloadPDFFile.do : HWP 첨부파일을 PDF 로 변환해 내려주는 엔드포인트
If PDF 변환이 실패하면 해당 사건은 "skipped" 처리합니다.
"""

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import requests

BASE = "https://taxlaw.nts.go.kr"
ACTION_URL = BASE + "/action.do"
DETAIL_ACTION = "ASIQTB002PR01"
FILE_INFO_ACTION = "ACMCMA001MR02"
PDF_DOWNLOAD_PATH = "/downloadPDFFile.do"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/117.0 Safari/537.36"
)


def build_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    return session


def sanitize_filename(text: str, max_len: int = 180) -> str:
    text = text or "판례"
    text = text.replace("/", "_").replace("\\", "_").replace(":", "_")
    text = text.replace("*", "_").replace("?", "_").replace("\"", "_")
    text = text.replace("<", "_").replace(">", "_").replace("|", "_")
    text = " ".join(text.split())
    return text[:max_len] or "판례"


def request_action(session: requests.Session, action_id: str, payload: dict) -> dict:
    data = {
        "actionId": action_id,
        "paramData": json.dumps(payload, ensure_ascii=False),
    }
    resp = session.post(ACTION_URL, data=data, timeout=15)
    resp.raise_for_status()
    result = resp.json()
    if result.get("status") != "SUCCESS":
        raise RuntimeError(f"action {action_id} failed: {result.get('status')}")
    return result.get("data", {})


def fetch_detail(session: requests.Session, ntst_id: str, group_code: Optional[str]) -> Optional[dict]:
    dcm_dvo = {"ntstDcmId": ntst_id}
    if group_code:
        dcm_dvo["ntstDcmGrpCd"] = group_code
    data = request_action(session, DETAIL_ACTION, {"dcmDVO": dcm_dvo})
    return data.get(DETAIL_ACTION)


def fetch_file_info(session: requests.Session, fle_id: str, fle_sn: int) -> Optional[dict]:
    payload = {"fleId": fle_id, "fleSn": fle_sn}
    data = request_action(session, FILE_INFO_ACTION, payload)
    items = data.get(FILE_INFO_ACTION)
    if not items:
        return None
    return items[0]


def download_pdf(session: requests.Session, fle_id: str, fle_sn: int, out_path: Path, min_kb: int) -> bool:
    params = {"fleId": fle_id, "fleSn": str(fle_sn)}
    resp = session.get(BASE + PDF_DOWNLOAD_PATH, params=params, timeout=20)
    if resp.status_code != 200:
        return False
    data = resp.content
    if not data.startswith(b"%PDF") or len(data) < min_kb * 1024:
        return False
    out_path.write_bytes(data)
    return True


def resolve_filename(ntst_id: str, detail: dict) -> str:
    dvo = detail.get("dcmDVO", {}) if detail else {}
    title = sanitize_filename(dvo.get("ntstDcmTtl", ""))
    date = dvo.get("ntstDcmRgtDt") or ""
    case_no = dvo.get("ntstPrdgHpnnNoCntn") or ""
    parts = [part for part in [date, case_no, title, ntst_id] if part]
    return sanitize_filename("_".join(parts)) or ntst_id


def fetch_case(session: requests.Session, ntst_id: int, out_dir: Path, min_kb: int, group_code: Optional[str]) -> bool:
    ntst_str = str(ntst_id)
    try:
        detail = fetch_detail(session, ntst_str, group_code)
    except Exception as exc:
        print(f"    detail fetch error: {exc}", file=sys.stderr)
        return False
    if not detail:
        return False

    attachments = detail.get("dcmHwpEditorDVOList") or []
    target = None
    for item in attachments:
        if item.get("dcmFleTy") in {"hwp", "pdf"}:
            target = item
            break
    if not target:
        return False

    fle_id = target.get("dcmFleId")
    fle_sn = target.get("dcmFleSn")
    if not fle_id or fle_sn is None:
        return False

    filename = resolve_filename(ntst_str, detail) + ".pdf"
    out_path = out_dir / filename

    if download_pdf(session, fle_id, fle_sn, out_path, min_kb):
        return True

    # Fallback attempt via file info (may provide download URI)
    try:
        info = fetch_file_info(session, fle_id, fle_sn)
        if info and info.get("fleDwldUri"):
            alt_url = requests.compat.urljoin(BASE, info["fleDwldUri"])
            resp = session.get(alt_url, timeout=20)
            if resp.status_code == 200 and resp.content.startswith(b"%PDF") and len(resp.content) >= min_kb * 1024:
                out_path.write_bytes(resp.content)
                return True
    except Exception as exc:
        print(f"    fallback download error: {exc}", file=sys.stderr)

    return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Download taxlaw 판례 PDFs by ntstDcmId")
    parser.add_argument("--out", required=True, help="Output directory")
    parser.add_argument("--start", type=int, required=True, help="Start ntstDcmId (inclusive)")
    parser.add_argument("--end", type=int, required=True, help="End ntstDcmId (inclusive)")
    parser.add_argument("--delay", type=float, default=0.5, help="Delay between requests (seconds)")
    parser.add_argument("--min-kb", type=int, default=10, help="Minimum PDF size in KB")
    parser.add_argument("--group", default="01", help="ntstDcmGrpCd (default: 01)")
    parser.add_argument(
        "--log",
        default=None,
        help="Optional log file path (messages will also be appended here)",
    )
    parser.add_argument(
        "--log-dir",
        default="./log",
        help="Directory to place timestamped log files when --log is omitted (default: ./log)",
    )
    args = parser.parse_args()

    if args.start > args.end:
        print("start must be <= end", file=sys.stderr)
        raise SystemExit(1)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    log_file = None
    if args.log:
        log_path = Path(args.log)
    else:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        log_path = Path(args.log_dir) / f"{timestamp}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = log_path.open("a", encoding="utf-8")
    log_file.write(f"# Command: {' '.join(map(str, sys.argv))}\n")
    log_file.flush()

    def log(message: str, *, err: bool = False) -> None:
        print(message, file=sys.stderr if err else sys.stdout, flush=True)
        if log_file:
            log_file.write(message + "\n")
            log_file.flush()

    session = build_session()
    total = args.end - args.start + 1
    saved = skipped = 0

    for idx, ntst_id in enumerate(range(args.start, args.end + 1), start=1):
        success = False
        try:
            success = fetch_case(session, ntst_id, out_dir, args.min_kb, args.group)
        except Exception as exc:
            log(f"[{idx}/{total}] {ntst_id} error: {exc}", err=True)
        if success:
            saved += 1
            log(f"[{idx}/{total}] {ntst_id} saved")
        else:
            skipped += 1
            log(f"[{idx}/{total}] {ntst_id} skipped")
        time.sleep(args.delay)

    log(f"[DONE] saved={saved}, skipped={skipped}, total={total}")

    log_file.close()


if __name__ == "__main__":
    main()
