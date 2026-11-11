# K8Board website (k8board.vercel.app)

A static site: plain HTML with inline CSS and JS, no build step and no backend.

```
website/
├── index.html     # landing page and download section
├── get.html       # forwards to K8Board's Microsoft Store page (the only place the Store link lives)
├── docs.html      # user docs
├── privacy.html   # privacy policy (the Store listing links to /privacy)
├── terms.html     # terms of service
├── vercel.json    # clean URLs (/privacy as well as /privacy.html)
└── assets/        # icon, social preview image, light/dark screenshots
    └── fonts/     # Figtree (SIL OFL 1.1, OFL.txt), the app's typeface where Proxima Nova isn't installed
```

The screenshots come from the app's demo cluster: `npm run build`, then
`npx electron scripts/capture-screenshots.cjs` (see the script's header).

## Preview locally

```bash
npx serve website        # then open the printed URL
```

## Downloads go to the Microsoft Store only

Every download button on the site links to `get.html`, which forwards to the
Store. Windows is the only platform offered; the macOS and Linux cards say
"Coming soon" and have no download link.

`get.html` holds K8Board's Store ID (`9N63V5DDVL9F`, from Partner Center →
K8Board → Product management → Product identity) in both of its links.

## What the site must not show

No GitHub addresses: no repository, release, issue or source links. Contact
is by email (`kubepilot.dashboard@gmail.com`). The Docker section of
`docs.html` keeps the published image name. `test/website-links.test.mjs`
checks all of this.

The privacy policy still names GitHub as a service the app contacts (the
Trivy download for image scans; on macOS and Linux builds, the update check),
without a link: the policy has to list every connection the app makes.

## Hosting

The site is on Vercel, with `website/` as the project's root directory.
`vercel.json` turns on clean URLs, so `/privacy`, `/terms`, `/docs` and `/get`
work as well as the `.html` addresses. The privacy policy must stay reachable
at `https://k8board.vercel.app/privacy.html`, the URL in the Store listing.
