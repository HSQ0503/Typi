from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

VERSION = "0.3.0"
OUT = Path("dist") / f"typi-extension-v{VERSION}.zip"
FILES = [
    "manifest.json",
    "background.js",
    "content.js",
    "popup.html",
    "popup.js",
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "icons/icon-128.png",
]

OUT.parent.mkdir(exist_ok=True)
with ZipFile(OUT, "w", ZIP_DEFLATED) as z:
    for file in FILES:
        path = Path(file)
        if not path.exists():
            raise FileNotFoundError(file)
        z.write(path, path.as_posix())

print(f"Wrote {OUT}")
