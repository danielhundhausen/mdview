CC ?= cc
CFLAGS ?= -O2 -std=c99 -Wall -Wextra -Wpedantic
PREFIX ?= /usr/local

.PHONY: all clean test test-js install uninstall
all: mdview

SOURCES = mdview.c render_modules.c mermaid_module.c vendor/miniz/miniz_tinfl.c
MINIZ_HEADERS = $(wildcard vendor/miniz/*.h)
MINIZ_FLAGS = -DMINIZ_NO_ZLIB_APIS -DMINIZ_NO_ARCHIVE_APIS -DMINIZ_NO_DEFLATE_APIS

mdview: $(SOURCES) render_modules.h mermaid_asset.h vendor/mermaid/asset_info.h $(MINIZ_HEADERS)
	$(CC) $(CPPFLAGS) $(MINIZ_FLAGS) $(CFLAGS) $(LDFLAGS) -o $@ $(SOURCES)

.build/embed_asset: tools/embed_asset.c
	mkdir -p .build
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o $@ $<

mermaid_asset.h: vendor/mermaid/mermaid-12.1.0.deflate vendor/miniz/LICENSE .build/embed_asset
	.build/embed_asset vendor/mermaid/mermaid-12.1.0.deflate vendor/miniz/LICENSE $@

test: mdview
	python3 tests/test_mdview.py ./mdview

test-js: mdview
	node tests/test_mermaid.mjs ./mdview

install: mdview
	install -d "$(DESTDIR)$(PREFIX)/bin"
	install -m 755 mdview "$(DESTDIR)$(PREFIX)/bin/mdview"

uninstall:
	rm -f "$(DESTDIR)$(PREFIX)/bin/mdview"

clean:
	rm -f mdview mermaid_asset.h .build/embed_asset
