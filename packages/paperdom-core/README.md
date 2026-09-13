# @ferax564/noma-paperdom-core

Pinned PaperDOM JSON model and transaction engine, extracted from
[`ferax564/paperDOM`](https://github.com/ferax564/paperDOM) at the commit in
`PAPERDOM_UPSTREAM_COMMIT`.

Host policy (server-derived actors, stale revision mapping) lives in Noma's
`applyHostedPaperDomTransaction`. This package re-exports the CLI kernel
without dual-write copies.
