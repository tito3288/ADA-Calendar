# ADA Calendar branding

- Full logo: supplied Alpha Dog Agency artwork in `alpha-dog-white.png`, unchanged. The self-contained `public/brand/alpha-dog-mint.svg` applies the app's exact `#bde4cf` to its existing alpha mask. No lettering or contours are regenerated.
- Dog icon: built-in image-generation tool, derived from that logo, then sized into PNG and ICO browser assets. No API-key/CLI generation was used.
- Outputs: `public/brand/alpha-dog-mint.svg`, `public/brand/dog-icon.png`, `src/app/icon.png`, `src/app/apple-icon.png`, `src/app/favicon.ico`. The older `public/icon.svg` URL now serves the same dog artwork.
- Rebuild packaged assets with `node scripts/prepare-brand-assets.mjs` after both source images are present. This is asset packaging, not part of the production runtime.

## Dog extraction prompt

Create a faithful dog-only app icon extracted from the supplied Alpha Dog Agency logo. Use the distinctive front-facing floppy-eared dog head silhouette from the LEFT of this exact logo as the reference. Remove ALL words/letters including every part of "alphadog" and "agency", and repair any text-overlap cutouts so the dog is a single uninterrupted recognizable silhouette. Preserve the original dog's characteristic outer contour and left/right ear shape, do not invent a different breed or facial features. Solid flat pale mint green #BDE4CF dog on a true transparent alpha background. No square tile/background, text, letter a, eyes, decorative lines, stroke, gradients, shadows, textures or 3D. Centered on a square canvas; dog large, about 84 percent of canvas height/width with safe even padding. Clean bold simple silhouette suitable for favicon legibility at 16 and 32px.

## Final dog rendering prompt

Edit this dog-only icon. Keep the exact same dog outline, ear shapes, proportions, centered composition, and safe padding. Change only rendering: flat solid mint #BDE4CF silhouette with no shading or texture on a completely uniform solid dark charcoal #111416 square background. Remove the entire checkerboard and replace every background pixel with dark charcoal. No transparency, no checkers, no gradients, no shadows, no text, no eye or nose details, no border, no rounded-corner container. A crisp simple one-color dog logo on a plain dark square suitable for 16px and 32px favicon. Preserve silhouette geometry exactly from the reference.

The first transparent-image attempt rendered a checkerboard instead of true alpha. The final icon deliberately uses a solid charcoal tile; the full wordmark uses the original source mask for true transparency and exact fidelity.
