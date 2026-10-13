# Bundled MathJax

`mathjax-tex-svg-3.2.2.deflate` contains MathJax's TeX-to-SVG browser bundle,
compressed as raw DEFLATE. SVG output inlines its glyph paths, so rendered
mathematics needs no web fonts, stylesheets, or other external files and
follows the document's text color in both themes.

Source: https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js

`manifest.json` records sizes and SHA-256 checksums for the upstream bundle,
the embedded asset, and the compressed representation. `asset_info.h` records
the decompression buffer size. `make` generates the C array locally with
`tools/embed_asset.c`; builds do not download any assets.

The only change to the upstream JavaScript is replacing `<!--` inside one
regular expression with `\x3c!--`. This equivalent escape prevents the HTML
parser from entering the script double-escaped state when the bundle is
inlined. Integration tests verify the transformed asset and the reconstructed
upstream checksums.

To update: fetch a pinned standalone `tex-svg` bundle, verify it has no
external imports or closing `</script` sequences, apply the transformation
above, compress with raw DEFLATE, update the manifest and size header, and run
the C, adapter, and offline rendering tests.
