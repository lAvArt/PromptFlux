# Contributing to PromptFlux

Thanks for contributing.

## Ground Rules

- Keep changes focused and small.
- Prefer reliability and privacy over feature breadth.
- Document user-visible behavior changes in `CHANGELOG.md`.
- Add/update tests when applicable.

## Dev Setup

```bash
cd electron-app
npm install

cd ../stt-service
pip install -r requirements.txt
```

## Branch and PR Flow

1. Fork and create a feature branch.
2. Make changes and run checks.
3. Open a PR with clear scope and screenshots/logs when relevant.

## Quality Checks

```bash
cd electron-app
npm run build

cd ../stt-service
python -m compileall .
```

## Commit Message Style

Use concise imperative messages:

- `fix(stt): handle wasapi loopback fallback`
- `feat(trigger): add press-to-talk mode`
- `docs(readme): expand installation and seo sections`

## Contribution License Terms

By submitting a contribution, you agree that:

1. Your contribution is licensed under AGPL-3.0 with the rest of this repository.
2. You grant the project maintainer the right to relicense your contribution in commercial and/or proprietary editions of PromptFlux.

If you do not agree with these terms, do not submit a contribution.

## What to Include in PRs

- Problem statement
- Proposed solution
- User impact
- Rollback risks
- Manual validation steps

## Security Bugs

Do not open public issues for sensitive vulnerabilities.
Follow `SECURITY.md`.
