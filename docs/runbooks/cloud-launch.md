# Noma Cloud technical-preview launch

This runbook prepares and launches the self-hosted Noma Cloud technical preview. It does not authorize a production deployment by itself.

## Release scope

The launch target is v0.17.0. The public npm packages and GitHub Releases are currently at v0.15.0; v0.16.0 was prepared in the repository but was never tagged or published. v0.17.0 therefore contains the v0.16 conformance/spec work and the post-v0.16 Cloud collaboration platform.

Launch Noma Cloud with these labels:

- self-hosted technical preview;
- deterministic local hybrid retrieval with exact citations and abstention;
- proof-first human/agent collaboration;
- connector, recipe, SSO/SCIM, retention, and realtime contracts that require deployment-specific adapters or operations where documented.

Do not describe this release as a managed SaaS, a turnkey enterprise identity suite, provider-synchronized connectors, a hosted-LLM answer engine, autonomous scheduled agents, or CRDT collaboration.

## No-go conditions

Do not tag or deploy when any of these is true:

- `npm run test:full` fails;
- `npm audit --audit-level=high` or `npm audit --omit=dev --audit-level=high` reports a vulnerability;
- the Docker image does not build, start, pass `/healthz`, persist a document across restart, or stop cleanly;
- `npm run release -- check` reports version drift;
- the release tag, changelog section, package versions, MCP registry descriptor, or README status disagree;
- production secrets, a persistent volume, a backup destination, a reverse-proxy TLS endpoint, or a named rollback owner are missing;
- a viewer can mutate connector/recipe state, a user can see another workspace's custom recipe, or an agent can exceed its grants or budget;
- backup digest corruption or a stale document hash is accepted;
- there is no staging soak or restore rehearsal.

## Build and verification

Run from a clean checkout of the release candidate:

```bash
npm ci
python3 -m pip install -e 'packages/agent-sdk-py[test]'
npx puppeteer browsers install chrome
npm run test:full
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
docker build -t noma-cloud:0.17.0 .
```

The release workflow runs the same full gate before it creates a manually dispatched tag or publishes any npm package.

## Production configuration

Use files or a secret manager, not shell history, for the two required secrets:

```text
NODE_ENV=production
PORT=3000
NOMA_PUBLIC_DIR=/app/dist
NOMA_CLOUD_DATA_DIR=/data/noma/documents
NOMA_CLOUD_DB=/data/noma/noma-cloud.sqlite
NOMA_CLOUD_ACCESS_TOKEN_FILE=/data/noma/secrets/access-token
NOMA_CLOUD_INVITATION_CODE_FILE=/data/noma/secrets/invitation-code
```

Set `NOMA_CLOUD_TRUST_PROXY=1` only when the app is behind a controlled reverse proxy that overwrites forwarded client headers. Set `NOMA_CLOUD_SSO_TRUST_SECRET` only between that trusted identity gateway and Noma. Never expose the SSO assertion route directly as an identity provider callback.

Mount `/data/noma` on persistent storage. Monitor free space because SQLite, immutable revisions, platform audit records, local indexes, and WAL files grow with use.

## Staging smoke test

1. Deploy the exact candidate image to a staging hostname with production security enabled.
2. Confirm unauthenticated Cloud/API requests fail and `GET /healthz` returns `200` with `{"ok":true,"storage":"sqlite"}`.
3. Register an owner with the invitation code, sign out, and sign in again with the returned user token.
4. Create a space and page, edit it, reload it, and verify the hash and immutable revision changed.
5. Send two writes with the same old hash; exactly one may succeed and the other must return `409 document_conflict`.
6. Add a viewer. Confirm the viewer can retrieve cited evidence but cannot save, synchronize connector sources, or trigger an editor-scoped custom recipe.
7. Ask an answerable and an unanswerable question. Verify exact block/version citations for the first and `insufficient_evidence` with no citations for the second.
8. Create a scoped agent, grant one page, and verify an ungranted page is absent from search and LLM export.
9. Proof and propose a block patch. Verify the proposer cannot self-approve, a different editor can approve, and apply fails after an intervening page edit.
10. Export a backup, reject a tampered digest, import the clean bundle as a plan, and rehearse a restore into a disposable database.
11. Restart the container and verify users, pages, permissions, revisions, agent metadata, and search survive.
12. Send `SIGTERM`; verify the process stops cleanly and the next start passes `/healthz`.

Keep staging up for at least one working day with representative documents. Record failed searches, stale answers, permission denials, response latency, database growth, and operator interventions.

## Backup and restore

Use `ezkeel backup <app>` when the deployment is managed by EZKeel. For a direct VPS deployment, use SQLite's online backup command or stop the service before copying the database; do not copy only the main database file while a live WAL is active.

Retain:

- the SQLite backup;
- exported deterministic `.noma` bundles;
- the two secret files in a separate secret backup;
- the exact image digest and Git commit;
- restore instructions and the last successful rehearsal time.

The in-app retention/legal-hold endpoint currently governs platform metadata. It does not replace infrastructure backup retention for canonical documents and immutable revisions.

## Deployment and rollback

Preview EZKeel intent first:

```bash
ezkeel up --dry-run
ezkeel doctor
```

After an operator explicitly approves the production target:

```bash
ezkeel up
ezkeel apps
ezkeel logs noma-cloud
```

Verify the public HTTPS health endpoint and repeat the critical smoke tests. If authentication, persistence, permission isolation, citation integrity, or error rate regresses:

```bash
ezkeel rollback noma-cloud
ezkeel logs noma-cloud
```

Restore data only when rollback cannot read the current schema or data is corrupt. A code rollback should normally keep the persistent volume intact.

## Package and release launch

The release commit must be on `main` and the working tree must be clean. Then use one release path:

```bash
git tag v0.17.0
git push origin main v0.17.0
```

or manually dispatch `.github/workflows/release.yml` with `tag=v0.17.0`. The workflow validates the version, runs the complete gate, creates a missing manual tag only after the gate passes, publishes missing npm versions, and creates the GitHub release from the v0.17.0 changelog slice.

After publication, verify all four npm packages, the GitHub release, MCP registry descriptor, GitHub Pages, container health, and the installation smoke test from `docs/runbooks/npm-publish.md`.

## Launch decision record

Before go-live, record:

- release commit and image digest;
- staging URL and smoke-test evidence;
- backup and restore-rehearsal timestamp;
- launch operator and rollback owner;
- accepted preview limitations;
- support channel and incident contact;
- go/no-go decision and timestamp.
