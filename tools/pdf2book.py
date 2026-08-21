#!/usr/bin/env python3
"""PDF をデジタルブック用のページ画像 + メタデータに変換する。

使い方:
    python tools/pdf2book.py "Mysealake 2026年夏号.pdf"
    python tools/pdf2book.py book.pdf --width 2000 --quality 82 --title "社内報 春号"

出力:
    pages/full/pNNN.webp   ページ画像（ビューアが表示するもの）
    pages/thumb/pNNN.webp  サムネイル（ページ一覧・スライダー用）
    pages/book.js          ページ数・寸法・本文テキスト・リンク座標

pages/book.js は fetch を使わない素の JS ファイルとして書き出すため、
index.html をファイルから直接開いても（file:// でも）動作する。

依存: PyMuPDF (pip install pymupdf)
"""

import argparse
import io
import json
import os
import sys
import time

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("PyMuPDF が必要です:  pip install pymupdf")


def main():
    ap = argparse.ArgumentParser(description="PDF をデジタルブック用に変換します")
    ap.add_argument("pdf", help="変換元の PDF ファイル")
    ap.add_argument("--out", default="pages", help="出力ディレクトリ (既定: pages)")
    ap.add_argument("--width", type=int, default=1600, help="ページ画像の横幅 px (既定: 1600)")
    ap.add_argument("--thumb-width", type=int, default=260, help="サムネイルの横幅 px (既定: 260)")
    ap.add_argument("--quality", type=int, default=80, help="WebP 品質 1-100 (既定: 80)")
    ap.add_argument("--thumb-quality", type=int, default=70, help="サムネイルの WebP 品質 (既定: 70)")
    ap.add_argument("--title", default=None, help="表示タイトル (既定: PDF のファイル名)")
    ap.add_argument("--no-text", action="store_true", help="本文テキストを埋め込まない（検索を無効化）")
    ap.add_argument("--no-pdf", action="store_true",
                    help="元 PDF へのダウンロードリンクを付けない（PDF を同梱しない場合）")
    args = ap.parse_args()

    if not os.path.isfile(args.pdf):
        sys.exit("PDF が見つかりません: " + args.pdf)

    full_dir = os.path.join(args.out, "full")
    thumb_dir = os.path.join(args.out, "thumb")
    os.makedirs(full_dir, exist_ok=True)
    os.makedirs(thumb_dir, exist_ok=True)

    doc = fitz.open(args.pdf)
    title = args.title or os.path.splitext(os.path.basename(args.pdf))[0]
    pages = []
    started = time.time()

    for index, page in enumerate(doc):
        number = index + 1
        rect = page.rect

        scale = args.width / rect.width
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        with open(os.path.join(full_dir, "p%03d.webp" % number), "wb") as fh:
            fh.write(pix.pil_tobytes(format="WEBP", quality=args.quality, method=4))

        tscale = args.thumb_width / rect.width
        tpix = page.get_pixmap(matrix=fitz.Matrix(tscale, tscale), alpha=False)
        with open(os.path.join(thumb_dir, "p%03d.webp" % number), "wb") as fh:
            fh.write(tpix.pil_tobytes(format="WEBP", quality=args.thumb_quality, method=4))

        # リンクはページ内の相対座標 (0-1) で持たせ、表示サイズに依存させない
        links = []
        for link in page.get_links():
            uri = link.get("uri")
            if not uri:
                continue
            lr = link["rect"]
            links.append({
                "uri": uri,
                "x": round((lr.x0 - rect.x0) / rect.width, 5),
                "y": round((lr.y0 - rect.y0) / rect.height, 5),
                "w": round(lr.width / rect.width, 5),
                "h": round(lr.height / rect.height, 5),
            })

        pages.append({
            "n": number,
            "w": round(rect.width, 2),
            "h": round(rect.height, 2),
            "text": "" if args.no_text else " ".join(page.get_text().split()),
            "links": links,
        })

        if number % 10 == 0 or number == doc.page_count:
            print("  %d / %d ページ  (%.1f 秒)" % (number, doc.page_count, time.time() - started))

    data = {
        "title": title,
        "pageCount": doc.page_count,
        "pdf": None if args.no_pdf else os.path.basename(args.pdf),
        "toc": [{"level": lv, "title": tt, "page": pg} for lv, tt, pg in doc.get_toc()],
        "pages": pages,
    }

    with io.open(os.path.join(args.out, "book.js"), "w", encoding="utf-8") as fh:
        fh.write("window.BOOK_DATA = ")
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";")

    total = sum(
        os.path.getsize(os.path.join(d, f))
        for d in (full_dir, thumb_dir)
        for f in os.listdir(d)
    )
    print("完了: %d ページ / 画像 %.1f MB → %s" % (doc.page_count, total / 1048576, args.out))


if __name__ == "__main__":
    main()
