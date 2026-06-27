# Contributing

Thanks for your interest in reinsjs.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Pull requests

- All changes go through a PR — `master` is protected and doesn't accept direct pushes.
- CI (typecheck, tests, build) must pass.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit and PR
  titles (`feat:`, `fix:`, `chore:`, `docs:`…). Releases and the changelog are
  generated automatically from these by release-please.

## Releases

Merging to `master` opens (or updates) a release PR. Merging that release PR tags a
version and publishes to npm automatically via trusted publishing (OIDC) —
maintainers don't publish by hand and there is no NPM token to manage.
