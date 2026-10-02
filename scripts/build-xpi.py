import os, sys, zipfile, json

ROOT = r"E:\project\paper-pilot"
os.chdir(ROOT)
VER = sys.argv[1] if len(sys.argv) > 1 else "0.18.1"
OUT = "dist/paper-pilot-%s.xpi" % VER

TOP = ["bootstrap.js", "LICENSE", "NOTICE", "prefs.js", "README.md", "manifest.json"]
inc = [p for p in TOP if os.path.exists(p)]
for root in ["chrome", "locale"]:
    for dp, dn, fn in os.walk(root):
        for f in sorted(fn):
            p = os.path.join(dp, f).replace(os.sep, "/")
            inc.append(p)
inc.sort(key=lambda p: (p not in TOP, p))

names = set(inc)
print("待打包 %d 个文件" % len(inc))
bad = [p for p in inc if not os.path.exists(p)]
if bad:
    raise SystemExit("源文件缺失: %s" % bad)

# ZIP_DEFLATED；xpi 需从根开始，目录项可省
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for p in inc:
        z.write(p, p)
print("已生成", OUT, os.path.getsize(OUT), "bytes")

# 自检
with zipfile.ZipFile(OUT) as z:
    got = sorted(n for n in z.namelist() if not n.endswith("/"))
    assert got == sorted(inc), "包内清单不一致"
    mf = json.loads(z.read("manifest.json").decode("utf-8"))
    print("manifest version =", mf["version"], "| 包内条目", len(got))
