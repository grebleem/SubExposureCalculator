#!/usr/bin/env python3
"""Checks that updates/updates.xri and the package zips agree.

For every <package> in updates.xri it verifies that the file named by fileName
exists next to updates.xri and that its SHA-1 matches the sha1 attribute. A
mismatch breaks installation for every user, so run this after building and
before committing. The GitHub Pages workflow runs it before publishing.

Usage:  python3 tools/check_update.py            (checks updates/)
        python3 tools/check_update.py some/dir   (checks another folder)

Exit status 0 when everything matches, 1 otherwise.
"""
import hashlib
import os
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
folder = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "updates")
xri_path = os.path.join(folder, "updates.xri")

problems = []
try:
    root = ET.parse(xri_path).getroot()
except (OSError, ET.ParseError) as error:
    print("Cannot read %s: %s" % (xri_path, error))
    sys.exit(1)

referenced = set()
packages = root.findall(".//package")
if not packages:
    problems.append("updates.xri declares no packages")

for package in packages:
    name = package.get("fileName", "")
    expected = (package.get("sha1") or "").lower()
    if not name or os.path.basename(name) != name:
        problems.append("fileName %r must be a plain file name" % name)
        continue
    referenced.add(name)
    path = os.path.join(folder, name)
    if not os.path.isfile(path):
        problems.append("%s is declared but missing" % name)
        continue
    actual = hashlib.sha1(open(path, "rb").read()).hexdigest()
    if actual != expected:
        problems.append("%s sha1 is %s but updates.xri says %s" % (name, actual, expected))
    else:
        print("OK  %s  sha1 %s" % (name, actual))

for name in sorted(os.listdir(folder)):
    if name.endswith(".zip") and name not in referenced:
        print("Note: %s is not referenced by updates.xri" % name)

signature = root.find("Signature")
if signature is None:
    print("Note: updates.xri is unsigned")
else:
    print("Note: updates.xri is signed by %s" % signature.get("developerId"))

if problems:
    for problem in problems:
        print("ERROR: " + problem)
    sys.exit(1)
