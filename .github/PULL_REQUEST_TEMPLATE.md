## What

<!-- One or two sentences: what changes and why. Link the issue if there is one. -->

## How to verify

<!-- Commands or clicks a reviewer can repeat. -->

## Checklist

- [ ] `npm run lint` and `npm test` pass locally
- [ ] Client changes: `npm run build` succeeds
- [ ] No secrets, kubeconfigs or tokens in the diff
- [ ] Security-relevant change (auth, validation, Electron, Docker, CI)? Described the threat it addresses above
- [ ] `CHANGELOG.md` updated under **Unreleased**
- [ ] Docs updated (`README.md`, `website/docs.html`) if behaviour or configuration changed
