# Bundled Mermaid

`mermaid-12.1.0.deflate` contains Mermaid's complete standalone browser bundle,
compressed as raw DEFLATE. The original bundle has no dynamic imports and
includes upstream third-party license notices. Those notices are retained in
the compressed data and emitted with the runtime in generated HTML.

Source: https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.min.js

`manifest.json` records sizes and SHA-256 checksums for both representations.
`asset_info.h` records the decompression buffer size. `make` generates the C
array locally with `tools/embed_asset.c`; builds do not download any assets.

To update: fetch a pinned standalone bundle, verify it has no external imports
or closing `</script` sequences, compress with raw DEFLATE, update the manifest
and size header, and run the C, adapter, and offline rendering tests.
