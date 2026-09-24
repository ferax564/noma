# @ferax564/noma-paperdom-core

PaperDOM JSON model and transaction engine. Noma maintains it as a fork of
[`ferax564/paperDOM`](https://github.com/ferax564/paperDOM) (MIT); the fork
base is recorded in `PAPERDOM_FORK_BASE_COMMIT`. The sources live in the CLI's
`src/paperdom-*.ts` and are type-checked and tested there.

Host policy (server-derived actors, stale revision mapping) lives in Noma's
`applyHostedPaperDomTransaction`. This package re-exports the CLI kernel
without dual-write copies.
