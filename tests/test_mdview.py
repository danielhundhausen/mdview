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
        self.assertEqual(version.stdout.strip(), "mdview 0.0.1")
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
