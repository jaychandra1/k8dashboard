# Microsoft Store images

Everything for Partner Center → K8Board → **Store listings → English (United
States)**. The captions, the listing text and the other fields are in
[docs/store/listing/STORE-LISTING.md](../docs/store/listing/STORE-LISTING.md).

| Partner Center section → slot | Upload |
|---|---|
| **Screenshots** (Desktop), in this order | `screenshots/dark/01-cluster-dashboard.png` … `08-cloud-integrations.png` (or the same names from `screenshots/light/`; use one set throughout) |
| **Store logos → 9:16 Poster art** | `images/poster-art-720x1080.png` and `images/poster-art-1440x2160.png` |
| **Store logos → 1:1 Box art** | `images/box-art-1080x1080.png` and `images/box-art-2160x2160.png` |
| **Store display images → 1:1 App tile icon** | `images/store-tile-icon-300x300.png`, `-150x150.png`, `-71x71.png` |
| **Windows and Xbox image → 16:9 Super hero art** | `images/super-hero-art-1920x1080.png` and `images/super-hero-art-3840x2160.png` |
| Xbox images, trailers | Leave empty: K8Board isn't on Xbox, and there's no trailer. |

The screenshots are 1920 × 1080 PNGs of K8Board's own UI on its built-in
sample cluster (`demo-cluster`), so they show sample data, never a real
environment. The logos and art are rendered from `build/source/k8board-icon.svg`.

To regenerate them:

```bash
npm run build
npx electron scripts/capture-screenshots.cjs --store   # screenshots
npx electron scripts/render-store-art.cjs              # logos and art
```
