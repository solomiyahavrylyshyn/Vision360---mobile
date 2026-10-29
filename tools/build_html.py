"""Python port of build.js (the standalone HTML part only; Vercel builds dist/ itself). usage: build_html.py <repo> [out]"""
import json, os, re, sys
root = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(root, "Vision360-Mobile-Prototype.html")
src = lambda p: open(os.path.join(root, "src", p), encoding="utf-8").read()
parts = json.loads(src("screens.json"))
css, js, shell = src("app.css"), src("app.js"), src("shell.html")
esc = lambda s: re.sub(r"</script>", r"<\\/script>", s, flags=re.I)
chunks, meta = [], []
def push(p, id, kind, body, title=None, desc=None):
    cls = "overlay" if kind == "overlay" else "screen"
    attrs = "" if kind == "overlay" else ' data-tabs="%s"' % ("on" if p.get("hasTab") else "off")
    chunks.append('<div class="%s" id="%s"%s>\n%s\n</div>' % (cls, id, attrs, body))
    m = {"id": id, "title": title or p.get("title"), "desc": desc or p.get("desc"), "section": p.get("section")}
    if kind != "overlay":
        m["tabs"] = bool(p.get("hasTab"))
    m["sb"] = bool(p.get("sbDark")); m["overlay"] = kind == "overlay"
    if m["section"] is None: del m["section"]
    meta.append(m)
for p in parts:
    if "base" in p:
        if p["id"] == "ov-job-actions":
            push(p, "ov-job-actions", "overlay", p["overlay"], "Job actions menu", "En route / Equipment / Assets / Completed")
        else:
            push(p, "inv-sent", "page", p["base"], "Invoice sent", "Sent state with a chase action")
            push(p, "ov-inv-share", "overlay", p["overlay"], "Invoice share menu", "Email / SMS / print / edit")
    else:
        push(p, p["id"], p.get("kind"), p.get("body"))
shell = shell.replace("/*__CSS__*/", css, 1).replace("<!--SCREENS-->", "\n\n".join(chunks), 1)
shell = shell.replace("/*__JS__*/", "window.__SCREENS__=" + esc(json.dumps(meta, ensure_ascii=False, separators=(",", ":"))) + ";\n" + js, 1)
BASE_HEAD = """<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Vision 360">"""
i = shell.index("</style>") + 8
doc = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n%s\n%s\n%s\n</head>\n<body>\n%s\n</body>\n</html>\n" % (BASE_HEAD, "", shell[:i], shell[i:])
open(out, "w", encoding="utf-8").write(doc)
print("wrote", out, len(doc) // 1024, "KB", len(meta), "screens")
