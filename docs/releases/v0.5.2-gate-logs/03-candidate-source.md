# Candidate source identity — preparation only

Recorded 2026-11-09. This is an uncommitted prepared-source snapshot, not a published RC identity.
Preparation parent: `71cfaf4629ec996845e09d23b7754c188551d487`. The orchestrator will record the resulting preparation commit,
then bind any public RC tag, remote runs, installed image digests and independent review to the
actual candidate commit. No candidate tag, Release, run or digest is claimed here.

## Included security provenance

- Legacy implementation: `ad2ab5b8370e25ed4f9a554e32d76c282a9dceb4`.
- Real HTTP/DB/SSH regression: `d784c8a0527819a70bfe5ca13f132c54fb30c4f2`.
- Alternate-port harness: `609239a85bc352ba4fa743c4077c9a04b055c060`.
- Final local phase 33 closure: `ca9818eed784461a89d84f97778058eec4237c5d`.
- Preserved v0.5.1 H2 fix: `b464cd3b2ed420f879e4b517b3582f297f67c67b` and its existing tests.

Each commit is an ancestor of the preparation parent (checked with `git merge-base --is-ancestor`).
Historical phase 33 PASS does not validate a public candidate.

## Stable baseline and compatibility inspection

The checkout has no local tags. It does have local v0.5.1 preparation source
`0e759d4d4193e0e5b834b46352592f6662d07bf7`, tree
`73010559dd65dbf3fe6fc703874027e95b75939c` (recomputed with `git rev-parse`).
The retained [v0.5.1 source record](../v0.5.1-gate-logs/06-rc-source.txt) records public RC
`eeacb80fcd3a88fdd5c68c6c351180be250f8170` with that same tree; the
[v0.5.1 gate](../v0.5.1-gate.md) records stable promotion of that validated candidate.
This inspection uses the local source object and retained public evidence; it does not pretend
that the absent local tag or public object was fetched or revalidated in this task.

`git diff <local-v0.5.1-source> HEAD --name-only -- <paths>` returned no changes for:

- `apps/control-plane/src/db`
- `apps/control-plane/src/env.ts`
- `apps/control-plane/src/config-version.ts`
- `apps/control-plane/src/routes/config.ts`
- `apps/control-plane/drizzle.config.ts`
- `install.sh`
- `infra`
- `deploy`
- `docker-compose.yml`
- `compose.yml`
- `.env.example`
- `pnpm-lock.yaml`
- `apps/control-plane/Dockerfile`
- `apps/web/Dockerfile`
- `apps/web/next.config.ts`
- `packages/config`

The database directory includes migration SQL, journal/snapshots and schema. No new migration,
configuration variable, installer/Compose configuration, image recipe or lockfile change was
found. The same comparison of `apps/control-plane/src/ai` and `packages/ai` returned no changes,
preserving H2 implementation/tests. Preparation modifies only manifest versions (parsed JSON
comparison confirms every other key unchanged), the existing release-state test and new release
evidence/docs. No dependency upgrade or production behavior change is introduced by preparation.
Installed backup restoration and data/BYOK preservation remain pending candidate UAT.

## Prepared files, SHA-256

These hashes identify the implementation-bearing prepared inputs and notes, excluding mutable
gate/provenance reports and orchestration state. They supplement, not replace, the later commit.

- `package.json`: `159e8be9fefd89ea26ff91f10468856011bb76af2115aa2dbe85b03d123f9ef3`
- `apps/control-plane/package.json`: `04735fed140c2b8edfed95c00fddedc9e2bce80337adc2324b8340bfd1cb42d7`
- `apps/site/package.json`: `de9815ff20ed1e8854e33833807624acd7d03ae5c2f8f3b54b0fa8863a740892`
- `apps/web/package.json`: `0ffaef5df0fc29a38c13727bafacf856122067d32d1ac53223e091c363140423`
- `packages/ai/package.json`: `ee5ccc854f5d6a7742bc3b7512e4174aad925beed1d581421bd266ee30faaf0c`
- `packages/config/package.json`: `7e381777bfd36c8cec244564d999cae1cc43030c208339a4c9e4a875911a8f92`
- `packages/docker/package.json`: `064e43fb66846021d79562004448658f97f42d7b7697b4e221c531a623065055`
- `packages/domain/package.json`: `495b1ad7c6c9d7bf41743ad22c2a9d681b3c439a61435458856d7f2c6647845e`
- `packages/git/package.json`: `0b6b8ff29da5736ac2e7b595d34df7a889c02e869f1dd6acd627509b5528e9ce`
- `packages/ssh/package.json`: `0a2207953641422b6dfb2c81bbcc5f18c4a5482c33f766659bc323a9012db65a`
- `packages/ui/package.json`: `23feadbb6c38cad474b5bed5ddfa8654f91b56a011815531852dafeaecd229b8`
- `tests/unit/scripts/check-release-version.test.ts`: `6b64063925909be9a4fe01038789137dc0256713418cec5b089ea37533e58aa5`
- `docs/releases/v0.5.2.md`: `d230ac45a3515a90869d9180eefe73cbdc98ae18cbb9b13d74bb0d61f2ef3829`
