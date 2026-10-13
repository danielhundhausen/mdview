CC ?= cc
CFLAGS ?= -O2 -std=c99 -Wall -Wextra -Wpedantic
PREFIX ?= /usr/local

.PHONY: all clean test test-js install uninstall
all: mdview

SOURCES = mdview.c watch.c render_modules.c mermaid_module.c math_module.c code_module.c vendor/miniz/miniz_tinfl.c
MINIZ_HEADERS = $(wildcard vendor/miniz/*.h)
MINIZ_FLAGS = -DMINIZ_NO_ZLIB_APIS -DMINIZ_NO_ARCHIVE_APIS -DMINIZ_NO_DEFLATE_APIS
ASSET_HEADERS = mermaid_asset.h math_asset.h .build/miniz_license.h .build/mermaid_styles.h .build/mermaid_adapter.h .build/diagram_viewer.h .build/code_styles.h .build/code_adapter.h .build/highlight_runtime.h .build/highlight_license.h .build/watch_adapter.h .build/heading_styles.h .build/heading_adapter.h .build/math_styles.h .build/math_adapter.h .build/math_license.h

mdview: $(SOURCES) render_modules.h watch.h $(ASSET_HEADERS) vendor/mermaid/asset_info.h vendor/math/asset_info.h $(MINIZ_HEADERS)
	$(CC) $(CPPFLAGS) $(MINIZ_FLAGS) $(CFLAGS) $(LDFLAGS) -o $@ $(SOURCES)

.build/embed_asset: tools/embed_asset.c
	mkdir -p .build
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o $@ $<

mermaid_asset.h: vendor/mermaid/mermaid-12.1.0.deflate .build/embed_asset
	.build/embed_asset $< mermaid_deflated $@

math_asset.h: vendor/math/mathjax-tex-svg-3.2.2.deflate .build/embed_asset
	.build/embed_asset $< math_deflated $@

.build/math_license.h: vendor/math/LICENSE .build/embed_asset
	.build/embed_asset $< math_license $@ --text

.build/math_styles.h: math_styles.css .build/embed_asset
	.build/embed_asset $< math_styles $@ --text

.build/miniz_license.h: vendor/miniz/LICENSE .build/embed_asset
	.build/embed_asset $< miniz_license $@ --text

.build/mermaid_styles.h: mermaid_styles.css .build/embed_asset
	.build/embed_asset $< mermaid_styles $@ --text

.build/code_styles.h: code_styles.css .build/embed_asset
	.build/embed_asset $< code_styles $@ --text

.build/heading_styles.h: heading_styles.css .build/embed_asset
	.build/embed_asset $< heading_styles $@ --text

.build/highlight_runtime.h: vendor/highlight/highlight.min.js .build/embed_asset
	.build/embed_asset $< highlight_runtime $@ --text

.build/highlight_license.h: vendor/highlight/LICENSE .build/embed_asset
	.build/embed_asset $< highlight_license $@ --text

.build/%.h: %.js .build/embed_asset
	.build/embed_asset $< $* $@ --text

test: mdview
	python3 tests/test_mdview.py ./mdview

test-js: mdview
	node tests/test_mermaid.mjs ./mdview
	node tests/test_math.mjs ./mdview
	node tests/test_code.mjs ./mdview
	node tests/test_watch.mjs
	node tests/test_headings.mjs ./mdview

install: mdview
	install -d "$(DESTDIR)$(PREFIX)/bin"
	install -m 755 mdview "$(DESTDIR)$(PREFIX)/bin/mdview"

uninstall:
	rm -f "$(DESTDIR)$(PREFIX)/bin/mdview"

clean:
	rm -f mdview $(ASSET_HEADERS) .build/embed_asset
