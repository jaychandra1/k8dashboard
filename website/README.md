# K8Board website (k8dashboard.in)

A static site: plain HTML with inline CSS and JS, no build step and no backend.

```
website/
├── index.html     # landing page and download section
├── get.html       # forwards to K8Board's Microsoft Store page (the only place the Store link lives)
├── docs.html      # user docs
├── privacy.html   # privacy policy (the Store listing links to /privacy)
├── terms.html     # terms of service
└── assets/        # icon, social preview image, light/dark screenshots
```

## Preview locally

```bash
npx serve website        # then open the printed URL
```

## Downloads go to the Microsoft Store only

Every download button on the site links to `get.html`, which forwards to the
Store. Windows is the only platform offered; the macOS and Linux cards say
"Coming soon" and have no download link.

**Before publishing**, open `get.html` and replace `REPLACE-WITH-STORE-ID` in
both links with K8Board's Store ID (Partner Center → K8Board → Product
management → Product identity; it looks like `9NXXXXXXXXXX`).

## What the site must not show

No GitHub addresses: no repository, release, issue or source links. Contact
is by email (`kubepilot.dashboard@gmail.com`). The Docker section of
`docs.html` keeps the published image name. `test/website-links.test.mjs`
checks all of this.

The privacy policy still names GitHub as a service the app contacts (the
update check, and the Trivy download for image scans), without a link: the
policy has to list every connection the app makes.

## Hosting

Any static host works. The privacy policy must stay reachable at
`https://k8dashboard.in/privacy`, the URL in the Store listing.
