#!/usr/bin/env python3
"""Integration tests; browser launch is tested with a stub, never a real browser."""
import os
from pathlib import Path
import random
import stat
import subprocess
import sys
import tempfile
import unittest
import hashlib
import json
import time
import signal
import select
from contextlib import contextmanager
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from html.parser import HTMLParser

PROGRAM = str(Path(sys.argv.pop(1)).resolve())


class Structure(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []

    def handle_starttag(self, tag, attrs):
        if tag not in {"meta", "base", "img", "hr", "br", "input"}:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if not self.stack or self.stack.pop() != tag:
            raise AssertionError(f"unbalanced HTML: {tag}")


class MdviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mdview-test-")
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def run_cmd(self, *args, stdin=None, env=None):
        return subprocess.run([PROGRAM, *map(str, args)], input=stdin, text=True,
                              capture_output=True, cwd=self.root, env=env, timeout=10)

    def render(self, source):
        path = self.root / "input.md"
        path.write_text(source, encoding="utf-8")
        output = self.root / "out.html"
        result = self.run_cmd("--no-open", "-o", output, path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), str(output))
        html = output.read_text()
        parser = Structure()
        parser.feed(html)
        self.assertEqual(parser.stack, [])
        return html.split("<main>\n", 1)[1].split("</main>", 1)[0]

    @contextmanager
    def watching(self, source, *args, env=None):
        log = self.root / "watch.log"
        with log.open("w") as errors:
            process = subprocess.Popen([PROGRAM, "--watch", *map(str, args), str(source)],
                                       stdout=subprocess.PIPE, stderr=errors, text=True,
                                       cwd=self.root, env=env)
            try:
                ready, _, _ = select.select([process.stdout], [], [], 5)
                self.assertTrue(ready, "watch did not print its preview URL")
                url = process.stdout.readline().strip()
                self.assertTrue(url.startswith("http://127.0.0.1:"), log.read_text())
                yield process, url
            finally:
                if process.poll() is None:
                    process.send_signal(signal.SIGINT)
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                    self.fail("watch did not stop on SIGINT")
            self.assertEqual(process.returncode, 0, log.read_text())

    def fetch(self, url):
        with urlopen(url, timeout=2) as response:
            return response.read().decode("utf-8")

    def await_preview(self, url, text):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            html = self.fetch(url)
            if text in html:
                return html
            time.sleep(.05)
        self.fail(f"preview did not update to {text!r}")

    def test_watch_updates_and_atomic_saves(self):
        source = self.root / "live.md"
        source.write_text("# First")
        output = self.root / "live.html"
        with self.watching(source, "--no-open", "-o", output) as (process, url):
            html = self.fetch(url)
            self.assertIn("<h1>First</h1>", html)
            self.assertIn("data-mdview-watch", html)
            origin = url.rsplit("/", 1)[0]
            revision = int(self.fetch(origin + "/revision"))
            # Same length and timestamps: watch must detect the actual edit.
            original_stat = source.stat()
            source.write_text("# Other")
            os.utime(source, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
            self.await_preview(url, "<h1>Other</h1>")
            self.assertGreater(int(self.fetch(origin + "/revision")), revision)
            replacement = self.root / "save.md"
            replacement.write_text("# Atomic save\n\n```js\nconst n = 1;\n```")
            replacement.replace(source)
            html = self.await_preview(url, "<h1>Atomic save</h1>")
            self.assertIn('data-mdview-highlight-runtime="11.12.0"', html)
            self.assertEqual(output.read_text(), html)
            self.assertIsNone(process.poll())
            self.assertEqual(list(self.root.glob("*.watch-*")), [])
        with self.assertRaises((URLError, ConnectionError)):
            self.fetch(url)

    def test_watch_keeps_last_preview_and_recovers(self):
        source = self.root / "live.md"
        source.write_text("# Good")
        with self.watching(source, "--no-open") as (process, url):
            initial = self.fetch(url)
            source.write_bytes(b"bad\0text")
            time.sleep(.9)
            self.assertEqual(self.fetch(url), initial)
            self.assertIsNone(process.poll())
            source.write_text("> " * 70 + "deep")
            time.sleep(.9)
            self.assertEqual(self.fetch(url), initial)
            source.unlink()
            time.sleep(.4)
            self.assertEqual(self.fetch(url), initial)
            source.write_text("# Recovered")
            self.await_preview(url, "<h1>Recovered</h1>")
            self.assertIsNone(process.poll())
        self.assertIn("keeping the last preview", (self.root / "watch.log").read_text())

    def test_watch_temporary_output(self):
        source = self.root / "live.md"
        source.write_text("# Live")
        env = dict(os.environ, TMPDIR=str(self.root))
        with self.watching(source, "--no-open", env=env) as (_, url):
            outputs = list(self.root.glob("mdview-*.html"))
            self.assertEqual(len(outputs), 1)
            output = outputs[0]
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            source.write_text("# Updated")
            self.await_preview(url, "<h1>Updated</h1>")
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        self.assertTrue(output.exists())
        self.assertIn("<h1>Updated</h1>", output.read_text())

    def test_watch_serves_local_assets_and_limits_access(self):
        directory = self.root / "space # & ü"
        directory.mkdir()
        source = directory / "notes.md"
        source.write_text("![Image](image%20%23%20%C3%BC.svg)\n\n[More](more.md)")
        asset = directory / "image # ü.svg"
        asset.write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
        (directory / "more.md").write_text("More notes")
        outside = self.root / "private.txt"
        outside.write_text("Not served")
        (directory / "outside.txt").symlink_to(outside)
        output = self.root / "out.html"
        output.write_text("Old")
        output.chmod(0o640)
        with self.watching(source, "--no-open", "-o", output) as (_, url):
            origin = url.rsplit("/", 1)[0]
            asset_url = origin + "/files" + quote(str(asset))
            with urlopen(asset_url, timeout=2) as response:
                self.assertEqual(response.headers.get_content_type(), "image/svg+xml")
                self.assertEqual(response.read().decode(), asset.read_text())
                self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(self.fetch(origin + "/files" + quote(str(directory / "more.md"))), "More notes")
            for path in (outside, directory / "outside.txt", directory / ".." / "private.txt"):
                with self.assertRaises(HTTPError) as error:
                    self.fetch(origin + "/files" + quote(str(path)))
                self.assertEqual(error.exception.code, 404)
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(url, headers={"Host": "untrusted.example"}), timeout=2)
            self.assertEqual(error.exception.code, 403)
            with urlopen(Request(url, method="HEAD"), timeout=2) as response:
                self.assertEqual(response.read(), b"")
                self.assertEqual(int(response.headers["Content-Length"]), output.stat().st_size)
            source.write_text("# Updated")
            self.await_preview(url, "<h1>Updated</h1>")
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o640)

    def test_watch_launches_browser_only_once(self):
        launcher = self.root / ("open" if sys.platform == "darwin" else "xdg-open")
        launcher.write_text('#!/bin/sh\nprintf "%s\\n" "$#" "$1" >> "$LAUNCH_RECORD"\n')
        launcher.chmod(0o755)
        record = self.root / "record"
        env = dict(os.environ, PATH=str(self.root), TMPDIR=str(self.root), LAUNCH_RECORD=str(record))
        source = self.root / "live.md"
        source.write_text("# First")
        with self.watching(source, env=env) as (_, url):
            source.write_text("# Second")
            self.await_preview(url, "<h1>Second</h1>")
            self.assertEqual(record.read_text().splitlines(), ["1", url])

    def test_watch_rejects_stdin_and_input_overwrite(self):
        result = self.run_cmd("--watch", "--no-open", "-", stdin="# Test")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("standard input", result.stderr)
        source = self.root / "live.md"
        source.write_text("# Source")
        result = self.run_cmd("--watch", "--no-open", "-o", source, source)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(source.read_text(), "# Source")
        self.assertNotEqual(self.run_cmd("--watch", "--no-open", self.root).returncode, 0)

    def test_headings_and_paragraphs(self):
        html = self.render("# Title\n\nHello\nworld\n\nSecond\n------\n\n### Third ###\n\n---\n")
        self.assertIn("<h1>Title</h1>", html)
        self.assertIn("<p>Hello\nworld</p>", html)
        self.assertIn("<h2>Second</h2>", html)
        self.assertIn("<h3>Third</h3>", html)
        self.assertIn("<hr>", html)

    def test_inline(self):
        html = self.render("**bold** *italic* _also_ ~~gone~~ ***both***\n\n"
                           "*outer **inner** text* and **outer *inner***\n\n"
                           "**code `**` text**\n\n"
                           "word_in_word \\*literal\\* `a < b` `` `code` ``\n\n"
                           "line  \nnext\\\nlast")
        for expected in ("<strong>bold</strong>", "<em>italic</em>", "<em>also</em>",
                         "<del>gone</del>", "<em><strong>both</strong></em>",
                         "<em>outer <strong>inner</strong> text</em>",
                         "<strong>outer <em>inner</em></strong>",
                         "<strong>code <code>**</code> text</strong>",
                         "word_in_word", "*literal*", "<code>a &lt; b</code>",
                         "<code>`code`</code>", "<br>"):
            self.assertIn(expected, html)

    def test_code_blocks(self):
        html = self.render("```c\nif (a < b) {\n  puts(\"hi\");\n}\n```\n\n"
                           "~~~\n**literal**\n~~~\n\n    indented\n    code\n")
        self.assertIn('<pre><code class="language-c">if (a &lt; b)', html)
        self.assertIn("<pre><code>**literal**\n</code></pre>", html)
        self.assertIn("<pre><code>indented\ncode\n</code></pre>", html)
        self.assertIn("<pre><code>unclosed\n</code></pre>", self.render("```\nunclosed"))

    def test_lists_and_tasks(self):
        html = self.render("- one\n- two\n  - nested\n  - child\n\n"
                           "3. third\n4. fourth\n\n- [ ] todo\n- [x] done\n\nAfter")
        self.assertEqual(html.count("<ul>"), 3)
        self.assertIn('<ol start="3">', html)
        self.assertIn("<p>nested</p>", html)
        self.assertIn('<input type="checkbox" disabled> ', html)
        self.assertIn('<input type="checkbox" disabled checked> ', html)
        self.assertTrue(html.endswith("<p>After</p>\n"))

    def test_quotes(self):
        html = self.render("> quote\n>\n> > nested\n>\n> - item\n\nOutside")
        self.assertEqual(html.count("<blockquote>"), 2)
        self.assertIn("<p>nested</p>", html)
        self.assertTrue(html.endswith("<p>Outside</p>\n"))

    def test_mermaid_module(self):
        html = self.render("```mermaid\nflowchart LR\n  A[Read] --> B[Render]\n```\n\n"
                           "~~~mermaid\nsequenceDiagram\n  Alice->>Bob: Hello\n~~~\n")
        self.assertEqual(html.count('<figure class="md-diagram">'), 2)
        self.assertEqual(html.count("<details open>"), 2)
        self.assertEqual(html.count('aria-label="Expand diagram" title="Expand diagram"'), 2)
        self.assertNotIn('>Expand <span', html)
        self.assertIn("Alice-&gt;&gt;Bob: Hello", html)
        full = (self.root / "out.html").read_text()
        self.assertEqual(full.count('<script type="module">'), 2)
        self.assertNotIn("await import(", full)
        self.assertEqual(full.count('data-mdview-mermaid-runtime="12.1.0"'), 1)
        self.assertIn("securityLevel:'strict'", full)
        raw = (self.root / "out.html").read_bytes()
        runtime = raw.split(b'<script data-mdview-mermaid-runtime="12.1.0">\n', 1)[1].split(b"*/\n", 1)[1].split(b"\n</script>", 1)[0]
        manifest = json.loads((Path(__file__).resolve().parents[1] / "vendor/mermaid/manifest.json").read_text())
        self.assertEqual(hashlib.sha256(runtime).hexdigest(), manifest["source_sha256"])

    def test_mermaid_escaping_and_unclosed_fence(self):
        html = self.render("```mermaid\nflowchart LR\n</script><script>alert(1)</script>\n")
        self.assertIn("&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;", html)
        self.assertIn("</figure>", html)
        full = (self.root / "out.html").read_text()
        self.assertEqual(full.count("</script>"), 5)
        self.assertNotIn("<script>alert(1)", full)

    def test_mermaid_in_nested_blocks(self):
        html = self.render("> ```mermaid\n> flowchart TD\n>   A --> B\n> ```\n\n"
                           "- diagram\n\n  ```mermaid\n  flowchart LR\n    C --> D\n  ```\n")
        self.assertEqual(html.count('<figure class="md-diagram">'), 2)
        self.assertEqual((self.root / "out.html").read_text().count('data-mdview-mermaid-runtime="12.1.0"'), 1)

    def test_module_assets_are_conditional(self):
        for source in ("", "# Plain Markdown", "Use `inline code`.",
                       "> No blocks\n\n- just a list", "<pre><code>raw HTML</code></pre>"):
            with self.subTest(source=source):
                self.render(source)
                full = (self.root / "out.html").read_text()
                self.assertNotIn("<script", full)
                self.assertNotIn(".md-code-block{", full)
                self.assertNotIn(".hljs-keyword", full)
                self.assertNotIn(".md-diagram{", full)
        for source in ("```c\nputs(\"hello\");\n```", "```mermaid-extra\nA --> B\n```",
                       "```mermaid.js\nA --> B\n```",
                       "````text\n```mermaid\nA --> B\n```\n````"):
            self.render(source)
            full = (self.root / "out.html").read_text()
            self.assertIn('data-mdview-highlight-runtime="11.12.0"', full)
            self.assertNotIn("data-mdview-mermaid-runtime", full)
            self.assertNotIn("cdn.jsdelivr.net", full)
            self.assertNotIn(".md-diagram{", full)

    def test_code_assets_and_controls(self):
        html = self.render("```js\nconst value = '<tag> & ü';\n```\n\n"
                           "~~~unknown\nraw\n~~~\n\n    indented\n\n```\n```")
        self.assertEqual(html.count('<div class="md-code-block">'), 4)
        self.assertEqual(html.count('class="code-copy" aria-label="Copy code"'), 4)
        self.assertEqual(html.count('class="code-toolbar" hidden'), 4)
        self.assertEqual(html.count('role="status" aria-live="polite"'), 4)
        self.assertEqual(html.count('title="Copy code" data-state="idle"'), 4)
        self.assertEqual(html.count('class="code-icon code-icon-copy"'), 4)
        self.assertEqual(html.count('class="code-icon code-icon-success"'), 4)
        self.assertEqual(html.count('class="code-icon code-icon-error"'), 4)
        self.assertNotIn('>Copy</button>', html)
        self.assertIn("const value = &#39;&lt;tag&gt; &amp; ü&#39;;\n", html)
        self.assertIn('<pre><code></code></pre>', html)
        full = (self.root / "out.html").read_text()
        self.assertEqual(full.count('data-mdview-highlight-runtime="11.12.0"'), 1)
        self.assertEqual(full.count('<script type="module">'), 1)
        self.assertEqual(full.count('.md-code-block{'), 2)  # screen and print styles
        self.assertNotIn('<script src=', full)
        self.assertNotIn('<link rel="stylesheet"', full)
        runtime = full.split('<script data-mdview-highlight-runtime="11.12.0">\n', 1)[1].split('*/\n', 1)[1].split('\n</script>', 1)[0]
        vendor = Path(__file__).resolve().parents[1] / "vendor/highlight"
        asset = (vendor / "highlight.min.js").read_bytes()
        manifest = json.loads((vendor / "manifest.json").read_text())
        self.assertEqual(runtime.encode(), asset)
        self.assertEqual(hashlib.sha256(asset).hexdigest(), manifest["asset_sha256"])
        upstream = asset.replace(b'/\\x3c!--/', b'/<!--/').replace(b'/\\x3cscript', b'/<script')
        self.assertEqual(hashlib.sha256(upstream).hexdigest(), manifest["source_sha256"])
        # Avoid HTML's script double-escaped state when embedding regex literals.
        self.assertNotIn('<!--', runtime)
        self.assertNotIn('<script', runtime.lower())
        self.assertNotIn('</script', runtime.lower())

    def test_indented_code_activates_assets(self):
        self.render("    line one\n\n    line two\n")
        full = (self.root / "out.html").read_text()
        self.assertEqual(full.count('data-mdview-highlight-runtime="11.12.0"'), 1)
        self.assertEqual(full.count('class="code-copy"'), 1)

    def test_nested_and_mermaid_code_controls(self):
        html = self.render("> ```python\n> print(1)\n> ```\n\n"
                           "- example\n\n  ```js\n  const a = 2;\n  ```\n\n"
                           "```mermaid\nflowchart LR\nA --> B\n```\n")
        self.assertEqual(html.count('class="code-copy"'), 3)
        self.assertIn('<details open><summary>Diagram source</summary>\n<div class="md-code-block">', html)
        full = (self.root / "out.html").read_text()
        self.assertEqual(full.count('data-mdview-highlight-runtime="11.12.0"'), 1)
        self.assertEqual(full.count('data-mdview-mermaid-runtime="12.1.0"'), 1)

    def test_code_escaping_and_unclosed_fences(self):
        html = self.render('```html\n</code></pre></script><script>alert("x")</script>\n& ü\n')
        self.assertIn('&lt;/code&gt;&lt;/pre&gt;&lt;/script&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;\n&amp; ü\n', html)
        self.assertEqual(html.count('class="code-copy"'), 1)
        self.assertNotIn('<script>', html)
        full = (self.root / "out.html").read_text()
        self.assertEqual(full.count('</script>'), 2)

    def test_links_images_and_autolinks(self):
        html = self.render('[**link**](https://example.com/a_(b) "title") '
                           '![photo](<images/a b.png> "caption") '
                           '<https://example.com> <me@example.com> '
                           '[a [nested] label](local.html)')
        self.assertIn('<a href="https://example.com/a_(b)" title="title"><strong>link</strong></a>', html)
        self.assertIn('<img src="images/a b.png" title="caption" alt="photo" loading="lazy">', html)
        self.assertIn('<a href="mailto:me@example.com">me@example.com</a>', html)
        self.assertIn('<a href="local.html">a [nested] label</a>', html)

    def test_html_and_unsafe_urls(self):
        html = self.render('<script>alert("x")</script>\n\n'
                           '[bad](javascript:alert(1)) ![bad](data:image/svg+xml,evil) '
                           '[ok](HTTPS://example.com) [safe](a\"b.html)')
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)
        self.assertNotIn("javascript:", html)
        self.assertNotIn("data:image", html)
        self.assertIn('href="HTTPS://example.com"', html)
        self.assertIn('href="a&quot;b.html"', html)

    def test_tables(self):
        html = self.render("| Left | Center | Right |\n| :--- | :---: | ---: |\n"
                           "| **bold** | x | 3 |\n| a\\|b | y | 4 |\n")
        self.assertIn('<th style="text-align:center">Center</th>', html)
        self.assertIn('<td style="text-align:right">3</td>', html)
        self.assertIn("<strong>bold</strong>", html)
        self.assertIn("a|b", html)

    def test_relative_asset_base_and_title(self):
        folder = self.root / "space # & ü"
        folder.mkdir()
        path = folder / "a & b.md"
        path.write_text("![asset](image.png)")
        output = self.root / "out.html"
        result = self.run_cmd("--no-open", "-o", output, path)
        self.assertEqual(result.returncode, 0, result.stderr)
        html = output.read_text()
        self.assertIn("<title>a &amp; b.md</title>", html)
        self.assertIn('space%20%23%20%26%20%C3%BC/">', html)

    def test_temporary_file(self):
        path = self.root / "input.md"
        path.write_text("# Temporary")
        env = dict(os.environ, TMPDIR=str(self.root))
        result = self.run_cmd("--no-open", path, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = Path(result.stdout.strip())
        self.assertEqual(output.parent, self.root)
        self.assertEqual(output.suffix, ".html")
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
        self.assertIn("<h1>Temporary</h1>", output.read_text())
        other = self.run_cmd("--no-open", path, env=env)
        self.assertNotEqual(result.stdout, other.stdout)

    def test_browser_launch(self):
        launcher = self.root / ("open" if sys.platform == "darwin" else "xdg-open")
        launcher.write_text('#!/bin/sh\nprintf "%s\\n" "$#" "$1" > "$LAUNCH_RECORD"\nexit "${LAUNCH_STATUS:-0}"\n')
        launcher.chmod(0o755)
        record = self.root / "record"
        env = dict(os.environ, PATH=str(self.root), TMPDIR=str(self.root), LAUNCH_RECORD=str(record))
        source = self.root / "input; touch PWN.md"
        source.write_text("# Test")
        result = self.run_cmd(source, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(record.read_text().splitlines(), ["1", result.stdout.strip()])
        self.assertFalse((self.root / "PWN.md").exists())
        env["LAUNCH_STATUS"] = "1"
        failure = self.run_cmd(source, env=env)
        self.assertNotEqual(failure.returncode, 0)
        self.assertIn("browser launcher failed", failure.stderr)
        self.assertTrue(Path(failure.stdout.strip()).exists())

    def test_stdin_empty_bom_crlf_and_unicode(self):
        output = self.root / "stdin.html"
        result = self.run_cmd("--no-open", "-o", output, "-", stdin="# Héllo 🌍\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("<h1>Héllo 🌍</h1>", output.read_text())
        self.assertEqual(self.render(""), "")
        self.assertIn("<h1>Title</h1>", self.render("\ufeff# Title\r\n\r\nBody\r\n"))

    def test_errors(self):
        for args in ([], ["missing.md"], ["--unknown"], ["-o"], ["a.md", "b.md"]):
            result = self.run_cmd(*args)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(result.stderr)
        self.assertEqual(self.run_cmd("--help").returncode, 0)
        version = self.run_cmd("--version")
        self.assertEqual(version.returncode, 0)
        self.assertEqual(version.stdout.strip(), "mdview 0.0.5")
        path = self.root / "nul.md"
        path.write_bytes(b"a\0b")
        self.assertIn("NUL", self.run_cmd("--no-open", path).stderr)
        path.write_text("# Test")
        self.assertNotEqual(self.run_cmd("--no-open", "-o", path, path).returncode, 0)
        self.assertEqual(path.read_text(), "# Test")
        alias = self.root / "alias.html"
        alias.symlink_to(path)
        self.assertNotEqual(self.run_cmd("--no-open", "-o", alias, path).returncode, 0)
        self.assertEqual(path.read_text(), "# Test")
        result = self.run_cmd("--no-open", "-o", self.root / "missing" / "out.html", path)
        self.assertNotEqual(result.returncode, 0)
        env = dict(os.environ, TMPDIR=str(self.root / "missing"))
        self.assertNotEqual(self.run_cmd("--no-open", path, env=env).returncode, 0)
        nested = self.run_cmd("--no-open", "-o", self.root / "out.html", "-", stdin="> " * 70 + "deep")
        self.assertNotEqual(nested.returncode, 0)
        self.assertIn("nesting", nested.stderr)

    def test_filename_option_terminator(self):
        path = self.root / "--strange.md"
        path.write_text("# Strange")
        result = self.run_cmd("--no-open", "-o", "out.html", "--", path.name)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_malformed_random_input(self):
        rng = random.Random(42)
        for _ in range(100):
            source = "".join(rng.choice("abc\n\n *~`_[]()!<>\\|:#-'\"0123\t") for _ in range(rng.randrange(300)))
            self.render(source)


if __name__ == "__main__":
    unittest.main()
