#!/usr/bin/env python3
"""index.html と pages/ を、1 ファイルの HTML にまとめる。

CSS・JS・ページ画像・サムネイルをすべて埋め込むため、
出力された HTML 1 つだけをメールに添付したり共有フォルダに置いたりすれば、
そのままダブルクリックで読める。

使い方:
    python tools/build_single.py
    python tools/build_single.py --out 社内報.html

サイズは元のページ画像に比例する（base64 化で約 1.37 倍）。
軽くしたい場合は別ディレクトリに低解像度で書き出してからビルドする:
    python tools/pdf2book.py "元.pdf" --no-pdf --out pages-light --width 1400 --quality 74
    python tools/build_single.py --pages pages-light --out "軽量版.html"
"""

import argparse
import base64
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def read_text(*parts):
    with io.open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
        return fh.read()


def data_uri(path):
    with open(path, "rb") as fh:
        return "data:image/webp;base64," + base64.b64encode(fh.read()).decode("ascii")


def js_safe(text):
    """埋め込んだ文字列の中の </script> でタグが閉じてしまうのを防ぐ。"""
    return text.replace("</", "<\\/")


def main():
    ap = argparse.ArgumentParser(description="1 ファイル版の HTML を書き出します")
    ap.add_argument("--out", default=None, help="出力ファイル名 (既定: <タイトル>.html)")
    ap.add_argument("--pages", default="pages", help="ページデータのディレクトリ (既定: pages)")
    args = ap.parse_args()

    pages_dir = os.path.join(ROOT, args.pages)
    book_js = read_text(args.pages, "book.js")
    prefix = "window.BOOK_DATA = "
    if not book_js.startswith(prefix):
        sys.exit("pages/book.js の形式が想定と異なります")
    data = json.loads(book_js[len(prefix):].rstrip(";"))

    count = data["pageCount"]
    full, thumb = {}, {}
    for n in range(1, count + 1):
        name = "p%03d.webp" % n
        full[str(n)] = data_uri(os.path.join(pages_dir, "full", name))
        thumb[str(n)] = data_uri(os.path.join(pages_dir, "thumb", name))
        if n % 10 == 0 or n == count:
            print("  埋め込み %d / %d ページ" % (n, count))

    html = read_text("index.html")

    # 外部参照をすべて中身に置き換える
    html = html.replace(
        '<link rel="icon" type="image/webp" href="pages/thumb/p001.webp">',
        '<link rel="icon" type="image/webp" href="' + thumb["1"] + '">',
    )
    html = html.replace(
        '<link rel="stylesheet" href="assets/css/style.css">',
        "<style>\n" + read_text("assets", "css", "style.css") + "\n</style>",
    )

    images = "window.BOOK_IMG=" + js_safe(json.dumps(
        {"full": full, "thumb": thumb}, ensure_ascii=False, separators=(",", ":"))) + ";"
    payload = "window.BOOK_DATA=" + js_safe(json.dumps(
        data, ensure_ascii=False, separators=(",", ":"))) + ";"
    html = html.replace(
        '<script src="pages/book.js"></script>',
        "<script>\n" + images + "\n" + payload + "\n</script>",
    )
    html = html.replace(
        '<script src="assets/js/flipbook.js"></script>',
        "<script>\n" + js_safe(read_text("assets", "js", "flipbook.js")) + "\n</script>",
    )

    for leftover in ("assets/css/style.css", "assets/js/flipbook.js", "pages/book.js"):
        if leftover in html:
            sys.exit("外部参照が残っています: " + leftover)

    out = args.out or (data["title"] + ".html")
    out_path = os.path.join(ROOT, out)
    with io.open(out_path, "w", encoding="utf-8") as fh:
        fh.write(html)

    print("完了: %s  (%.1f MB / %d ページ)" % (out, os.path.getsize(out_path) / 1048576, count))


if __name__ == "__main__":
    main()
