# Image to SVG Converter

Converts raster images to compact SVG in the browser. Nothing is uploaded.

**[Open the app](https://med-vedi.github.io/image-to-svg-converter/)**

```sh
npm install
npm run dev        # development server
npm run build      # type-check and build static files to dist/
npm test           # unit tests
npm run test:e2e   # browser tests (first run: npx playwright install chromium)
```

`dist/` is plain static files with relative paths, so it can be hosted from any folder on any static host.

## How transparency is handled

Tracing is done by [VTracer](https://github.com/visioncortex/vtracer) (via `vtracer-wasm`) in a Web Worker. `src/core/alpha.ts` prepares the pixels first:

- **Hard edges** (logos, cut-outs): alpha is snapped to on or off, which avoids halos around shapes.
- **Soft regions** (shadows, glows): traced as four stacked layers whose opacities add up to the source alpha.
- **Small transparent areas**: VTracer ignores transparency unless whole scanlines are clear, so a 2px transparent border is added before tracing and hidden with the `viewBox`.
- **Opaque images**: passed through untouched, so no transparency is introduced.

## Background removal

`src/core/background.ts` takes the median colour of the image border as the background and clears every pixel close to it, including inside shapes such as the counter of a "Q". Turning off "Also inside shapes" clears only what connects to the image border, which keeps enclosed details of the same colour. Soft edge pixels are resolved to pure subject colour or clear, which avoids halos. For the Logo and Illustration types, colours that are only a blend of the background and a stronger subject colour are resolved: past the halfway point they snap to that colour and below it they are cleared, so thin strokes in a soft image stay one solid colour and small holes in text stay open. It works on flat or near-flat backgrounds. It runs without an ML model to keep the app small, so it can't cut a subject out of a busy photo; in that case the image is left as it was and the UI says so.

## `vtracer-wasm` differs from the VTracer CLI

`src/core/settings.ts` accounts for these. Passing CLI-style values produces blobs instead of corners and a single flat colour:

- `cornerThreshold` and `spliceThreshold` are radians, not degrees.
- `colorPrecision` is the number of bits to discard, not to keep.

## License

[MIT](LICENSE)
