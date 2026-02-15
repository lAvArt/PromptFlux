# Development Plan

## Current Focus (v0.1.x)

- Windows stability and packaging quality
- Trigger mode polish and wake-word tuning
- Audio device compatibility hardening
- Documentation and release process maturity

## Release Workflow

1. Update `CHANGELOG.md`
2. Build installer (`npm run dist:win`)
3. Smoke test install on clean machine
4. Create GitHub release with notes and checksums

## Documentation Workflow

- Keep README aligned with shipped behavior
- Record major technical choices in `docs/DECISIONS.md`
- Update architecture doc for protocol/runtime changes

## Public Repo Hygiene

- Use issue templates and PR template
- Maintain security policy
- Keep license and contribution terms explicit
