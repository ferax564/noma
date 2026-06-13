"""noma_seed — a partial, native-Python second implementation of the Noma format.

Covers the subset of the frozen v1.0 surface needed to seed an independent
conformance run: a parser, `noma ids`, and the `replace_body`,
`update_attribute`, and `add_block` patch ops. No dependency on the Node
reference implementation.
"""

from .ids import collect_ids
from .parser import parse, slugify
from .patch import PatchError, patch_source

__all__ = ["collect_ids", "parse", "slugify", "patch_source", "PatchError"]
