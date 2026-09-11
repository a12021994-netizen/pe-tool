#!/usr/bin/env python3
"""將 Google Drive 資料夾內的投顧報告 PDF 依內容重新命名，並搬移到目的資料夾。

命名規則：股票代碼-股票名稱-YYYYMM-券商名稱.pdf

用法：
    python rename_pdfs.py \
        --source-folder-id <來源資料夾ID> \
        --target-folder-id <目的資料夾ID> \
        [--dry-run]

需要環境變數 GDRIVE_SA_KEY，內容是 Google service account 的 JSON 金鑰全文。
券商辨識與擷取規則放在同目錄的 brokers.yaml，之後要支援新券商只要改設定檔即可。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
from pathlib import Path

import yaml
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

SCOPES = ["https://www.googleapis.com/auth/drive"]
CONFIG_PATH = Path(__file__).parent / "brokers.yaml"


def get_drive_service():
    raw = os.environ.get("GDRIVE_SA_KEY")
    if not raw:
        sys.exit("環境變數 GDRIVE_SA_KEY 未設定（應該放 service account JSON 金鑰全文）")
    info = json.loads(raw)
    creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def load_brokers() -> list[dict]:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return data["brokers"]


def list_pdfs(service, folder_id: str) -> list[dict]:
    query = f"'{folder_id}' in parents and mimeType='application/pdf' and trashed=false"
    files: list[dict] = []
    page_token = None
    while True:
        resp = (
            service.files()
            .list(
                q=query,
                fields="nextPageToken, files(id, name, parents)",
                pageToken=page_token,
                pageSize=200,
            )
            .execute()
        )
        files.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return files


MAX_PAGES = 2  # 有些券商的股票代碼/名稱標題其實印在第二頁，保守多讀一頁

# 農曆/中文數字月份轉阿拉伯數字，給 date style "cjk_month" 用（例如「九月 04, 2026」）
CJK_MONTH_NUM = {
    "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6,
    "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12,
}


def extract_report_text(service, file_id: str, max_pages: int = MAX_PAGES) -> str:
    import pdfplumber

    request = service.files().get_media(fileId=file_id)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    buf.seek(0)
    with pdfplumber.open(buf) as pdf:
        pages = pdf.pages[:max_pages]
        return "\n".join(p.extract_text() or "" for p in pages)


def broker_haystack(broker: dict, content_text: str, filename: str) -> str:
    """大多數券商規則是比對 PDF 內容；如果 brokers.yaml 裡該券商設定
    source: filename，就改比對原始檔名（有些券商發出來的檔名本身就已經包含
    股票代碼/名稱/日期，直接從檔名抓比重新解析 PDF 內容更準）。"""
    return filename if broker.get("source") == "filename" else content_text


def detect_broker(content_text: str, filename: str, brokers: list[dict]) -> dict | None:
    for broker in brokers:
        haystack = broker_haystack(broker, content_text, filename)
        for keyword in broker["match"]["contains"]:
            if keyword in haystack:
                return broker
    return None


def parse_date(text: str, date_rule: dict) -> str | None:
    """依 date_rule 裡的 style 解析出報告日期，回傳 YYYYMM，抓不到回傳 None。"""
    match = re.search(date_rule["pattern"], text)
    if not match:
        return None

    style = date_rule.get("style", "slash")
    if style in ("slash", "cjk", "compact"):
        # 三種都是 3 個 group：年、月、日（cjk 分隔符是「年/月/日」，compact 是
        # 像「20260907」這種西元年月日連在一起、沒有分隔符號的格式）
        year, month = match.group(1), match.group(2).zfill(2)
        return f"{year}{month}"
    if style == "roc7":
        # 民國年格式的 7 位數字，例如 1150904 = 民國115年09月04日
        raw = match.group(1)
        roc_year, month = int(raw[:3]), raw[3:5]
        return f"{roc_year + 1911}{month}"
    if style == "cjk_month":
        # 中文數字月份，例如「九月 04, 2026」
        month_name = match.group(1).rstrip("月")
        month = CJK_MONTH_NUM.get(month_name)
        if month is None:
            return None
        year = match.group(3)
        return f"{year}{str(month).zfill(2)}"
    raise ValueError(f"未知的 date style: {style}")


def extract_one(text: str, rule: dict) -> str | None:
    """依 rule 的 pattern 搜尋文字，回傳指定 group（預設第 1 組）的內容。"""
    match = re.search(rule["pattern"], text)
    if not match:
        return None
    return match.group(rule.get("group", 1))


def extract_fields(content_text: str, filename: str, broker: dict) -> tuple[str, str, str] | None:
    """回傳 (股票代碼, 股票名稱, YYYYMM)，抓不到就回傳 None。"""
    text = broker_haystack(broker, content_text, filename)
    extract = broker["extract"]

    code = extract_one(text, extract["code"])
    name = extract_one(text, extract["name"])
    if code is None or name is None:
        return None

    yyyymm = parse_date(text, extract["date"])
    if yyyymm is None:
        return None

    return code.strip(), name.strip(), yyyymm


def sanitize(part: str) -> str:
    # Google Drive 檔名不能有 / ，順手把常見會搞亂檔名的符號清掉
    return re.sub(r'[\\/:*?"<>|]', "", part).strip()


def build_filename(code: str, name: str, yyyymm: str, display_name: str) -> str:
    return f"{sanitize(code)}-{sanitize(name)}-{yyyymm}-{sanitize(display_name)}.pdf"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-folder-id", required=True, help="放原始 PDF 的資料夾 ID")
    parser.add_argument("--target-folder-id", required=True, help="改名完要搬過去的資料夾 ID")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只印出預計的改名結果，不會真的呼叫 Drive API 更動檔案",
    )
    args = parser.parse_args()

    brokers = load_brokers()
    service = get_drive_service()

    files = list_pdfs(service, args.source_folder_id)
    print(f"在來源資料夾找到 {len(files)} 個 PDF")

    ok, skipped = 0, 0
    for f in files:
        file_id, old_name = f["id"], f["name"]
        try:
            text = extract_report_text(service, file_id)
        except Exception as exc:  # noqa: BLE001
            print(f"[略過] {old_name}：讀取 PDF 內容失敗（{exc}）")
            skipped += 1
            continue

        broker = detect_broker(text, old_name, brokers)
        if broker is None:
            print(f"[略過] {old_name}：沒有任何券商規則命中，可能要在 brokers.yaml 新增規則")
            skipped += 1
            continue

        fields = extract_fields(text, old_name, broker)
        if fields is None:
            print(f"[略過] {old_name}：命中券商「{broker['name']}」但抓不到股票代碼/名稱/日期")
            skipped += 1
            continue

        code, name, yyyymm = fields
        new_name = build_filename(code, name, yyyymm, broker["display_name"])
        print(f"{old_name}  ->  {new_name}")

        if not args.dry_run:
            old_parents = ",".join(f.get("parents", []))
            service.files().update(
                fileId=file_id,
                body={"name": new_name},
                addParents=args.target_folder_id,
                removeParents=old_parents,
                fields="id, name, parents",
            ).execute()
        ok += 1

    print(f"\n完成：{ok} 個處理成功，{skipped} 個略過。")
    if args.dry_run:
        print("這是 dry-run，沒有真的更動 Google Drive 上的任何檔案。")


if __name__ == "__main__":
    main()
