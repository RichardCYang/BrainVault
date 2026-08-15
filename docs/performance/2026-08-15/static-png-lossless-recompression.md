# Static PNG lossless recompression

Date: 2026-08-15

## Optimization target

Several bundled PNG assets used inefficient deflate/filter choices. The largest case was `public/img/icon_origin.png`; the normal application icon and three default cover images also had measurable lossless savings available.

## Change

Only the PNG image-data compression representation was changed. Every optimized file keeps the same dimensions, 8-bit RGB/RGBA color model, pixel values, and original non-IDAT chunk data. No route, API, database schema, persistence format, authentication/authorization behavior, upload/restore flow, dependency, or runtime setting changed.

Optimized files:

| Asset | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| `public/img/icon_origin.png` | 1,959,371 B | 1,191,026 B | 768,345 B (39.21%) |
| `public/img/icon_normal.png` | 56,015 B | 51,866 B | 4,149 B (7.41%) |
| `public/img/default_cover/coverimg2.png` | 2,059,661 B | 2,029,303 B | 30,358 B (1.47%) |
| `public/img/default_cover/coverimg4.png` | 2,404,820 B | 2,399,466 B | 5,354 B (0.22%) |
| `public/img/default_cover/coverimg5.png` | 2,401,103 B | 2,317,231 B | 83,872 B (3.49%) |

Total uncompressed static-asset reduction: **892,078 bytes**.

## Reproducible regression protection

`tests/static-png-lossless-optimization.node.test.mjs` uses only Node built-ins to:

- validate the PNG signature and every chunk CRC;
- inflate and reverse all PNG scanline filters;
- reconstruct exact RGBA pixel bytes and compare their SHA-256 values with the pre-optimization baseline;
- verify dimensions and RGB/RGBA color type are unchanged;
- verify no ancillary PNG metadata chunks were introduced;
- verify every optimized file remains smaller than its original byte size.

This makes the optimization independently reproducible without relying on ImageMagick, browser screenshots, or a visual-only comparison.
