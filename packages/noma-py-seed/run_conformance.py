#!/usr/bin/env python3
"""CLI: run the native Python seed against the shared conformance corpus.

Usage:
    python run_conformance.py [path/to/examples/conformance]

Defaults to the repo's `examples/conformance` relative to this file. Exits 0 when
every seed-covered fixture passes, 1 otherwise.
"""

from __future__ import annotations

import os
import sys

from noma_seed.conformance import run


def default_corpus() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", "examples", "conformance"))


def main(argv: list[str]) -> int:
    corpus = argv[1] if len(argv) > 1 else default_corpus()
    results = run(corpus)
    passed = 0
    for res in results:
        label = os.path.relpath(res.name, os.path.dirname(corpus))
        if res.status == "pass":
            passed += 1
            print(f"PASS  {label}")
        else:
            print(f"FAIL  {label}  — {res.error}")
    print(f"\n{len(results)} seed-covered fixtures, {passed} passed")
    return 0 if passed == len(results) and results else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
