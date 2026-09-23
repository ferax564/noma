"""Stdlib unittest suite for the native Python seed.

Runs without pytest: `python -m unittest discover -s tests` from the package root.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from noma_seed import collect_ids, patch_source, PatchError  # noqa: E402
from noma_seed.conformance import run  # noqa: E402

CORPUS = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "examples", "conformance")
)


class ConformanceTest(unittest.TestCase):
    def test_all_seed_covered_fixtures_pass(self):
        results = run(CORPUS)
        self.assertTrue(results, "no fixtures discovered")
        failures = [f"{r.name}: {r.error}" for r in results if r.status != "pass"]
        self.assertEqual(failures, [], "\n".join(failures))


class IdsTest(unittest.TestCase):
    def test_heading_slug(self):
        self.assertEqual(collect_ids("# Risks\n")["canonical"], ["risks"])

    def test_frontmatter_aliases_attach_to_first_h1(self):
        src = "---\naliases: [demo, intro]\n---\n\n# Aliases\n\nbody\n"
        out = collect_ids(src)
        self.assertEqual(out["canonical"], ["aliases"])
        self.assertEqual(sorted(out["aliases"]["aliases"]), ["demo", "intro"])

    def test_code_fence_suppresses_directives(self):
        src = "# Demo\n\n```\n::x{id=\"y\"}\n::\n```\n"
        self.assertEqual(collect_ids(src)["canonical"], ["demo"])


class ParserRulesTest(unittest.TestCase):
    def test_unicode_slugs_match_reference(self):
        from noma_seed.parser import slugify

        self.assertEqual(slugify("日本語"), "日本語")
        self.assertEqual(slugify("Привет мир"), "привет-мир")
        self.assertEqual(slugify("Café au lait"), "cafe-au-lait")
        self.assertEqual(slugify("Straße"), "strae")
        self.assertEqual(slugify("???"), "")

    def test_empty_slug_falls_back_to_section(self):
        self.assertEqual(collect_ids("# ???\n\n## !!!\n")["canonical"], ["section", "section-2"])

    def test_quoted_values_stay_strings_and_escapes(self):
        from noma_seed.parser import parse_attrs

        attrs = {k: v for k, v, _ in parse_attrs('id=2024 v="1.10" n=3 t="a \\"b\\" \\\\ \\d"')}
        self.assertEqual(attrs, {"id": "2024", "v": "1.10", "n": 3, "t": 'a "b" \\ \\d'})

    def test_heading_braces_need_key_value(self):
        self.assertEqual(collect_ids("# Set {a, b}\n")["canonical"], ["set-a-b"])
        self.assertEqual(collect_ids('# Real {id="r"}\n')["canonical"], ["r"])

    def test_leading_thematic_break_is_not_frontmatter(self):
        src = "---\n\n# Kept\n\n---\n"
        self.assertEqual(collect_ids(src)["canonical"], ["kept"])

    def test_tilde_and_long_fences(self):
        src = '~~~\n::a{id="x"}\n~~~\n\n````\n```\n::b{id="y"}\n```\n````\n'
        self.assertEqual(collect_ids(src)["canonical"], [])


class PatchTest(unittest.TestCase):
    def test_crlf_preserved(self):
        src = '::claim{id="x"}\r\nold\r\n::\r\n'
        out = patch_source(src, {"op": "replace_body", "id": "x", "content": "a\nb"})
        self.assertEqual(out, '::claim{id="x"}\r\na\r\nb\r\n::\r\n')

    def test_update_attribute_keeps_other_tokens(self):
        src = "::card{id=\"c\" tone=warning}\nb\n::\n"
        out = patch_source(src, {"op": "update_attribute", "id": "c", "key": "note", "value": "it's \"x\""})
        self.assertEqual(out, '::card{id="c" tone=warning note="it\'s \\"x\\""}\nb\n::\n')

    def test_update_attribute(self):
        src = '::claim{id="x" confidence=0.5}\nbody\n::\n'
        out = patch_source(src, {"op": "update_attribute", "id": "x", "key": "confidence", "value": 0.95})
        self.assertEqual(out, '::claim{id="x" confidence=0.95}\nbody\n::\n')

    def test_replace_body(self):
        src = '::claim{id="c1" confidence=0.5}\nOld.\n::\n'
        out = patch_source(src, {"op": "replace_body", "id": "c1", "content": "New."})
        self.assertEqual(out, '::claim{id="c1" confidence=0.5}\nNew.\n::\n')

    def test_target_missing(self):
        with self.assertRaises(PatchError) as ctx:
            patch_source("::claim{id=\"c1\"}\nb\n::\n", {"op": "replace_body", "id": "nope", "content": "x"})
        self.assertEqual(ctx.exception.code, "target_missing")

    def test_id_attribute_protected(self):
        with self.assertRaises(PatchError) as ctx:
            patch_source('::claim{id="c1"}\nb\n::\n', {"op": "update_attribute", "id": "c1", "key": "id", "value": "c2"})
        self.assertEqual(ctx.exception.code, "id_attribute_protected")


if __name__ == "__main__":
    unittest.main()
