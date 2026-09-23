"""The SDK's PatchErrorCode literal must match the reference engine exactly."""

from __future__ import annotations

import re
from pathlib import Path
from typing import get_args

from noma_agent_sdk import PatchErrorCode

REPO_ROOT = Path(__file__).resolve().parents[3]


def _union(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    body = re.search(r"export type PatchErrorCode =([^;]+);", text)
    assert body, f"PatchErrorCode union not found in {path}"
    return set(re.findall(r'"([a-z_]+)"', body.group(1)))


def test_patch_error_codes_match_reference_engine() -> None:
    engine = _union(REPO_ROOT / "src" / "patch.ts")
    assert set(get_args(PatchErrorCode)) == engine
    assert {"invalid_attribute_key", "invalid_attribute_value", "unbalanced_fence_content"} <= engine


def test_patch_error_codes_match_ts_sdk() -> None:
    ts_sdk = _union(REPO_ROOT / "packages" / "agent-sdk" / "src" / "types.ts")
    assert set(get_args(PatchErrorCode)) == ts_sdk
