import os
import sys

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
for p in (_REPO_ROOT,):
    if p not in sys.path:
        sys.path.insert(0, p)
