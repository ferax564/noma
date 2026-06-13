"""Run the native Python seed against the shared conformance corpus.

The seed claims coverage of a *subset* of the v1.0 surface: ID/alias collection
on the `valid/` fixtures, plus the `replace_body`, `update_attribute`, and
`add_block` patch ops (and their reachable error codes). It runs exactly those
fixtures from `examples/conformance/` and reports pass/fail per fixture.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

from .ids import collect_ids
from .patch import PatchError, patch_source

SEED_PATCH_OPS = {"replace_body", "update_attribute", "add_block"}


@dataclass
class Result:
    name: str
    status: str  # "pass" | "fail"
    error: str = ""


def _norm_ids(payload: dict) -> tuple[list[str], dict[str, list[str]]]:
    canonical = sorted(payload.get("canonical", []))
    aliases = {k: sorted(v) for k, v in payload.get("aliases", {}).items()}
    return canonical, aliases


def _check_valid(fixture: str) -> Result | None:
    ids_path = os.path.join(fixture, "expected.ids.json")
    if not os.path.exists(ids_path):
        return None
    source = _read(os.path.join(fixture, "input.noma"))
    got = collect_ids(source)
    with open(ids_path, encoding="utf-8") as fh:
        expected = json.load(fh)
    gc, ga = _norm_ids(got)
    ec, ea = _norm_ids(expected)
    if gc != ec:
        return Result(fixture, "fail", f"ids mismatch: got {gc}, expected {ec}")
    if ga != ea:
        return Result(fixture, "fail", f"aliases mismatch: got {ga}, expected {ea}")
    return Result(fixture, "pass")


def _check_patch(fixture: str) -> Result | None:
    patch_path = os.path.join(fixture, "patch.json")
    if not os.path.exists(patch_path):
        return None
    with open(patch_path, encoding="utf-8") as fh:
        raw = json.load(fh)
    ops = raw if isinstance(raw, list) else [raw]
    if any(o.get("op") not in SEED_PATCH_OPS for o in ops):
        return None  # outside the seed's declared coverage
    source = _read(os.path.join(fixture, "input.noma"))

    error_path = os.path.join(fixture, "expected.error.json")
    if os.path.exists(error_path):
        with open(error_path, encoding="utf-8") as fh:
            want = json.load(fh)["code"]
        try:
            cur = source
            for op in ops:
                cur = patch_source(cur, op)
        except PatchError as exc:
            if exc.code == want:
                return Result(fixture, "pass")
            return Result(fixture, "fail", f'error {exc.code!r}, expected {want!r}')
        return Result(fixture, "fail", f"expected error {want!r}, patch succeeded")

    post_path = os.path.join(fixture, "expected.post.noma")
    if not os.path.exists(post_path):
        return None
    cur = source
    try:
        for op in ops:
            cur = patch_source(cur, op)
    except PatchError as exc:
        return Result(fixture, "fail", f"unexpected error {exc.code}: {exc}")
    expected = _read(post_path)
    if cur != expected:
        return Result(fixture, "fail", "patch output mismatch")
    return Result(fixture, "pass")


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def run(corpus_root: str) -> list[Result]:
    results: list[Result] = []
    for track in ("valid", "patch", "patch-error"):
        track_dir = os.path.join(corpus_root, track)
        if not os.path.isdir(track_dir):
            continue
        for name in sorted(os.listdir(track_dir)):
            fixture = os.path.join(track_dir, name)
            if not os.path.exists(os.path.join(fixture, "input.noma")):
                continue
            res = _check_valid(fixture) if track == "valid" else _check_patch(fixture)
            if res is not None:
                results.append(res)
    return results
