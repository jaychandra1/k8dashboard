# Microsoft Store images

Everything Partner Center asks for under **Store listings**. The captions, the
listing text and where each field goes are in
[docs/store/listing/STORE-LISTING.md](../docs/store/listing/STORE-LISTING.md).

| Partner Center slot | File |
|---|---|
| Screenshots (Desktop), in this order | `screenshots/dark/01-…` to `08-…` (a light set with the same names is in `screenshots/light/`; use one set throughout) |
| 1:1 App tile icon (300 × 300) | `images/store-tile-icon-300x300.png` |
| 16:9 Super hero art (1920 × 1080) | `images/super-hero-art-1920x1080.png` |

The screenshots are 1920 × 1080 PNGs of K8Board's own UI on its built-in
sample cluster (`demo-cluster`), so they show sample data, never a real
environment. To retake them for a new release:

```bash
npm run build
npx electron scripts/capture-screenshots.cjs --store
```

The logos were rendered from `build/source/k8board-icon.svg`.
