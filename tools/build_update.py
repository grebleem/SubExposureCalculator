#!/usr/bin/env python3
"""Builds the PixInsight update repository in updates/.

Creates the package zip (the script placed at src/scripts/SubExposureCalculator/,
which PixInsight extracts into its installation folder) and writes updates.xri
with the matching SHA-1 checksum.

Usage:  python3 tools/build_update.py            (release date = today)
        python3 tools/build_update.py 20261111   (explicit release date)
"""
import datetime
import glob
import hashlib
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "src", "SubExposureCalculator.js")
OUT = os.path.join(ROOT, "updates")
INSTALL_PATH = "src/scripts/SubExposureCalculator/SubExposureCalculator.js"

source = open(SCRIPT, encoding="utf-8").read()
version = re.search(r'var SEC_VERSION = "([^"]+)"', source).group(1)
date = sys.argv[1] if len(sys.argv) > 1 else datetime.date.today().strftime("%Y%m%d")
package = "SubExposureCalculator-%s-%s.zip" % (version, date)

os.makedirs(OUT, exist_ok=True)
for old in glob.glob(os.path.join(OUT, "SubExposureCalculator-*.zip")):
    os.remove(old)

# Fixed timestamp so the same source always gives the same checksum.
info = zipfile.ZipInfo(INSTALL_PATH, date_time=(int(date[:4]), int(date[4:6]), int(date[6:8]), 0, 0, 0))
info.compress_type = zipfile.ZIP_DEFLATED
info.external_attr = 0o644 << 16
with zipfile.ZipFile(os.path.join(OUT, package), "w") as z:
    z.writestr(info, source.encode("utf-8"))

sha1 = hashlib.sha1(open(os.path.join(OUT, package), "rb").read()).hexdigest()

xri = """<?xml version="1.0" encoding="UTF-8"?>
<xri version="1.0">
   <description>
      <p>
         SubExposureCalculator by Bastiaan Meelberg: sky-limited sub-exposure times
         from your own raw frames. https://github.com/grebleem/SubExposureCalculator
      </p>
   </description>
   <platform os="all" arch="noarch" version="1.8.8:9.9.9">
      <package fileName="%(package)s" sha1="%(sha1)s" type="script" releaseDate="%(date)s">
         <title>
            SubExposureCalculator script version %(version)s
         </title>
         <remove>
            %(install)s
         </remove>
         <description>
            <p>
               Measures read noise, conversion gain and sky background from raw bias,
               flat and light frames, and calculates the sub-exposure time needed to
               make read noise insignificant. Works for mono and one-shot-colour cameras.
            </p>
            <p>
               After installation the script is available at
               SCRIPT &gt; Utilities &gt; SubExposureCalculator.
            </p>
            <p>
               Copyright (c) 2026 Bastiaan Meelberg. Released under the MIT License.
            </p>
         </description>
      </package>
   </platform>
</xri>
""" % {"package": package, "sha1": sha1, "date": date, "version": version, "install": INSTALL_PATH}
open(os.path.join(OUT, "updates.xri"), "w", encoding="utf-8").write(xri)
print("Built", package, "sha1", sha1)
