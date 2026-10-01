CC ?= cc
CFLAGS ?= -O2 -std=c99 -Wall -Wextra -Wpedantic
PREFIX ?= /usr/local

.PHONY: all clean test install uninstall
all: mdview

mdview: mdview.c
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o $@ $<

test: mdview
	python3 tests/test_mdview.py ./mdview

install: mdview
	install -d "$(DESTDIR)$(PREFIX)/bin"
	install -m 755 mdview "$(DESTDIR)$(PREFIX)/bin/mdview"

uninstall:
	rm -f "$(DESTDIR)$(PREFIX)/bin/mdview"

clean:
	rm -f mdview
