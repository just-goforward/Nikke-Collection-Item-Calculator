# Current EXP placeholder optical alignment

## Finding

Chromium screenshots at DPR 1 confirmed the reported upper bias on tablet and desktop layouts. Across Korean, Japanese, and English, the `0` glyph had 12px above and 13px below its ink bounds, placing its ink center 0.5px above the captured input center.

Mobile did not share that defect. Korean and Japanese were already 0.5px below the center and English was centered, so a global correction would have made mobile worse.

## Change

- Tablet and desktop input line height: 21px to 20px.
- Mobile input line height: unchanged at 19.5px.
- Input height, padding, font size, width, and surrounding layout: unchanged.
- Applied identically to Korean, Japanese, and English.

The line-height change moves the rasterized numeral down by one physical pixel. An even-height numeral inside the odd-sized captured raster cannot occupy an exact half-pixel center at DPR 1, so the correction intentionally removes the reported upper bias without changing control dimensions.

## Evidence

- Before: `ko-*.png`, `ja-*.png`, `en-*.png`
- After: `after-ko-*.png`, `after-ja-*.png`, `after-en-*.png`
- Measurements: `metrics.json`
