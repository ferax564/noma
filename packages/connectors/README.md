# @ferax564/noma-connectors

Provider adapters, migration and ownership contracts.

This package is an extraction boundary over the published `@ferax564/noma-cli` kernel. Domain logic lives in `src/enterprise-*.ts` once; this package re-exports the public surface without dual-write copies.
