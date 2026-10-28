import io, os, sys

# 给 UTF-8 文本补 BOM + 统一 CRLF，让 Windows PowerShell 5.1 正确定位中文。
# 用法: python fix_bom.py <file> [<file> ...]
for path in sys.argv[1:]:
    with io.open(path, "r", encoding="utf-8-sig", newline="") as f:
        text = f.read()
    text = text.replace("\r\n", "\n").replace("\n", "\r\n")
    with io.open(path, "w", encoding="utf-8-sig", newline="") as f:
        f.write(text)
    with open(path, "rb") as f:
        head = f.read(3)
    print("%-52s %7d bytes  bom=%s" % (os.path.basename(path), os.path.getsize(path), head == b"\xef\xbb\xbf"))
