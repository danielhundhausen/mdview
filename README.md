# mdview

A small Markdown-to-HTML compiler written in C. Run it on a Markdown file to
create a styled, temporary HTML page and open it in your default browser.
There are no rendering libraries or language-runtime dependencies.

## Install with Homebrew

```sh
brew install danielhundhausen/tap/mdview
mdview foo.md
```

The formula builds from source. On Linux, `xdg-open` must also be installed
through your system's package manager to open the browser.

## Build from source

```sh
make
./mdview foo.md
```

To use `mdview` from anywhere, install it into a directory on your `PATH`:

```sh
make install PREFIX="$HOME/.local"
# Add $HOME/.local/bin to PATH if it isn't already there.
mdview foo.md
```

The build needs a C99 compiler and Make. macOS uses `open`; Linux uses
`xdg-open`, which must be installed to launch your browser. The renderer itself
needs neither command when using `--no-open`.

## Usage

```sh
mdview notes.md                      # Render and open in your browser
mdview --no-open notes.md            # Render and print the temporary HTML path
mdview -o notes.html notes.md        # Save to a chosen file and open it
mdview --no-open -o notes.html notes.md
cat notes.md | mdview -              # Read standard input
mdview -- --strange-filename.md      # Filenames beginning with a dash
mdview --help
```

The command prints the absolute HTML path. Temporary files have a `.html`
extension, unique names, and owner-only permissions. They go into `TMPDIR`,
or `/tmp` when it is unset. They remain after the command exits so the browser
can read and reload them; delete them when you no longer need them. Explicit
output files are overwritten, except that overwriting the source is rejected.
Rendering is a snapshot: rerun the command after
editing the Markdown.

Relative images and links resolve against the source file's directory, even
when the HTML is in a temporary directory. For standard input, they resolve
against the current working directory. The generated page includes its own
CSS with a warm paper layout, serif headings, system fonts, light/dark themes,
accessible link focus indicators, responsive layout, and print styles. It uses no
JavaScript, web fonts, or remote stylesheets. Remote images can still be loaded
if the document references them.

## Markdown support

- ATX (`#`) and single-line Setext headings, paragraphs, and horizontal rules
- Bold, italics, combined emphasis, strikethrough, and punctuation escapes
- Inline code, fenced code with optional language labels, and indented code
- Bullet and numbered lists, nested lists, and task checkboxes
- Blockquotes, including nested blocks
- Inline links and images, optional quoted titles, and angle-bracket URL/email links
- Pipe tables with left, center, and right column alignment
- Hard line breaks from two trailing spaces or a trailing backslash
- UTF-8 text, optional UTF-8 BOM, and Unix/Windows line endings

This is a pragmatic Markdown subset, not a full CommonMark or GitHub Flavored
Markdown implementation. Reference-style links, footnotes, automatic heading
IDs, bare URL linking, syntax highlighting, and some complex delimiter/list/
table edge cases are not supported. Raw HTML is displayed as text. URL schemes
are limited to `http`, `https`, `mailto`, and `file`, plus relative paths.
Nesting is bounded to keep malformed documents from exhausting the C stack.

## Tests

```sh
make test
```

Tests require Python 3 and cover rendering, malformed input, CLI errors, asset
paths, temporary-file permissions, and browser launching with a stub command.
They do not open a real browser.

For a sanitizer build:

```sh
make clean
make CFLAGS='-g -O1 -std=c99 -Wall -Wextra -Wpedantic -fsanitize=address,undefined -fno-omit-frame-pointer'
make test
```

## License

MIT. See [LICENSE](LICENSE).
