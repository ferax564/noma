# @ferax564/noma-document-core

AST, parser, validation, source patches, serialization.

This package is an extraction boundary over the published `@ferax564/noma-cli` kernel. Domain logic lives in `src/enterprise-*.ts` once; this package re-exports the public surface without dual-write copies.
