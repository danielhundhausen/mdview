# Highlight.js browser runtime

Pinned Highlight.js **11.12.0** common-language browser build, BSD-3-Clause.
Upstream and license URLs and SHA-256 checksums are recorded in `manifest.json`.
The full upstream license is included both here and in generated HTML.

The only changes to the upstream JavaScript are replacing `<!--` and `<script`
inside regex literals with `\x3c!--` and `\x3cscript`. These equivalent escapes
prevent the HTML parser from entering the script double-escaped state when
the bundle is inlined. Integration tests verify the transformed asset and the
reconstructed upstream checksums.

The Makefile embeds this file into the executable using the C asset helper.
Only documents containing fenced or indented code include the runtime, code
styles, and copy adapter. Building and viewing require no network or Node.js.
