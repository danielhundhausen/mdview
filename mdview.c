#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include "render_modules.h"

/* A deliberately small, dependency-free Markdown renderer. Raw HTML is escaped. */
typedef struct { char *s; size_t n, cap; } Buf;
typedef struct { char **v; size_t n; } Lines;
typedef struct { int kind; size_t indent, body; unsigned long start; } Marker;

static void die(const char *message) {
    fprintf(stderr, "mdview: %s\n", message);
    exit(EXIT_FAILURE);
}

static void *allocate(size_t n) {
    void *p = malloc(n ? n : 1);
    if (!p) die("out of memory");
    return p;
}

static void append_n(Buf *b, const char *s, size_t n) {
    if (n > (size_t)-1 - b->n - 1) die("document too large");
    size_t needed = b->n + n + 1;
    if (needed > b->cap) {
        size_t cap = b->cap ? b->cap : 256;
        while (cap < needed) {
            if (cap > (size_t)-1 / 2) { cap = needed; break; }
            cap *= 2;
        }
        char *p = realloc(b->s, cap);
        if (!p) die("out of memory");
        b->s = p; b->cap = cap;
    }
    memcpy(b->s + b->n, s, n);
    b->n += n; b->s[b->n] = '\0';
}

static void append(Buf *b, const char *s) { append_n(b, s, strlen(s)); }
static void emit(void *context, const char *s) { append(context, s); }
static void put(Buf *b, char c) { append_n(b, &c, 1); }

static char *copy_n(const char *s, size_t n) {
    char *p = allocate(n + 1);
    memcpy(p, s, n); p[n] = '\0';
    return p;
}

static void escape(Buf *b, const char *s, size_t n) {
    for (size_t i = 0; i < n; ++i) {
        switch (s[i]) {
        case '&': append(b, "&amp;"); break;
        case '<': append(b, "&lt;"); break;
        case '>': append(b, "&gt;"); break;
        case '"': append(b, "&quot;"); break;
        case '\'': append(b, "&#39;"); break;
        default: put(b, s[i]);
        }
    }
}

static int blank(const char *s) {
    while (*s && isspace((unsigned char)*s)) ++s;
    return !*s;
}

static size_t indent(const char *s) {
    size_t n = 0;
    while (s[n] == ' ') ++n;
    return n;
}

static Lines split_lines(const char *s) {
    Lines lines = {0}; size_t cap = 0;
    while (*s) {
        const char *end = strchr(s, '\n');
        size_t n = end ? (size_t)(end - s) : strlen(s);
        if (n && s[n - 1] == '\r') --n;
        if (lines.n == cap) {
            cap = cap ? cap * 2 : 32;
            char **v = realloc(lines.v, cap * sizeof(*v));
            if (!v) die("out of memory");
            lines.v = v;
        }
        /* Expand tabs to four-column stops before parsing indentation. */
        Buf line = {0};
        for (size_t i = 0; i < n; ++i) {
            if (s[i] == '\t') {
                size_t spaces = 4 - line.n % 4;
                while (spaces--) put(&line, ' ');
            } else put(&line, s[i]);
        }
        if (!line.s) line.s = copy_n("", 0);
        lines.v[lines.n++] = line.s;
        if (!end) break;
        s = end + 1;
    }
    return lines;
}

static void free_lines(Lines l) {
    for (size_t i = 0; i < l.n; ++i) free(l.v[i]);
    free(l.v);
}

/* Allow local paths and a small list of useful URL schemes. */
static int safe_url(const char *s, size_t n) {
    size_t i = 0;
    while (i < n && s[i] != ':' && s[i] != '/' && s[i] != '#' && s[i] != '?') {
        if ((unsigned char)s[i] < 32 || s[i] == 127) return 0;
        ++i;
    }
    if (i == n || s[i] != ':') return 1;
    const char *schemes[] = {"http", "https", "mailto", "file"};
    for (size_t j = 0; j < sizeof(schemes) / sizeof(*schemes); ++j) {
        if (strlen(schemes[j]) != i) continue;
        size_t k = 0;
        while (k < i && tolower((unsigned char)s[k]) == schemes[j][k]) ++k;
        if (k == i) return 1;
    }
    return 0;
}

static size_t closing(const char *s, size_t n, size_t from, const char *mark, size_t len) {
    for (size_t i = from; i + len <= n; ++i) {
        if (s[i] == '\\') { if (i + 1 < n) ++i; continue; }
        if (s[i] == '`') {
            size_t run = 1;
            while (i + run < n && s[i + run] == '`') ++run;
            size_t end = i + run;
            while (end < n) {
                if (s[end] != '`') { ++end; continue; }
                size_t count = 1;
                while (end + count < n && s[end + count] == '`') ++count;
                if (count == run) break;
                end += count;
            }
            if (end < n) i = end + run - 1;
            else i += run - 1;
            continue;
        }
        if (s[i] == mark[0]) {
            size_t count = 1;
            while (i + count < n && s[i + count] == mark[0]) ++count;
            if (count == len || (count == 3 && len < 3)) return i + count - len;
            i += count - 1;
        }
    }
    return n;
}

static void inline_md(Buf *out, const char *s, size_t n, unsigned depth, int links) {
    if (depth > 32) { escape(out, s, n); return; }
    for (size_t i = 0; i < n;) {
        if (s[i] == '\\' && i + 1 < n && ispunct((unsigned char)s[i + 1])) {
            escape(out, s + i + 1, 1); i += 2; continue;
        }
        if (s[i] == '\\' && i + 1 < n && s[i + 1] == '\n') {
            append(out, "<br>\n"); i += 2; continue;
        }
        if (s[i] == '\n') {
            if (i >= 2 && s[i - 1] == ' ' && s[i - 2] == ' ') append(out, "<br>");
            put(out, '\n'); ++i; continue;
        }
        if (s[i] == '`') {
            size_t run = 1;
            while (i + run < n && s[i + run] == '`') ++run;
            size_t end = i + run;
            for (; end < n; ++end) {
                if (s[end] != '`') continue;
                size_t count = 1;
                while (end + count < n && s[end + count] == '`') ++count;
                if (count == run) break;
                end += count - 1;
            }
            if (end < n) {
                size_t a = i + run, z = end;
                int nonspace = 0;
                for (size_t j = a; j < z; ++j) if (s[j] != ' ' && s[j] != '\n') nonspace = 1;
                if (z > a + 1 && s[a] == ' ' && s[z - 1] == ' ' && nonspace) { ++a; --z; }
                append(out, "<code>");
                for (size_t j = a; j < z; ++j) {
                    if (s[j] == '\n') put(out, ' '); else escape(out, s + j, 1);
                }
                append(out, "</code>"); i = end + run; continue;
            }
            escape(out, s + i, run); i += run; continue;
        }
        int image = s[i] == '!' && i + 1 < n && s[i + 1] == '[';
        if (links && (s[i] == '[' || image)) {
            size_t a = i + (image ? 2 : 1), end = a; unsigned nesting = 1;
            for (; end < n; ++end) {
                if (s[end] == '\\' && end + 1 < n) { ++end; continue; }
                if (s[end] == '[') ++nesting;
                if (s[end] == ']' && --nesting == 0) break;
            }
            if (end + 1 < n && s[end + 1] == '(') {
                size_t u = end + 2;
                while (u < n && isspace((unsigned char)s[u])) ++u;
                size_t v = u, tail;
                if (u < n && s[u] == '<') {
                    ++u; v = u;
                    while (v < n && s[v] != '>' && s[v] != '\n') ++v;
                    tail = v < n && s[v] == '>' ? v + 1 : n;
                } else {
                    unsigned parens = 0;
                    while (v < n) {
                        if (s[v] == '\\' && v + 1 < n) { v += 2; continue; }
                        if (s[v] == '(') ++parens;
                        if (s[v] == ')') { if (!parens) break; --parens; }
                        if (!parens && isspace((unsigned char)s[v])) break;
                        ++v;
                    }
                    tail = v;
                }
                while (tail < n && isspace((unsigned char)s[tail])) ++tail;
                size_t title_a = 0, title_z = 0;
                if (tail < n && (s[tail] == '"' || s[tail] == '\'')) {
                    char quote = s[tail++]; title_a = tail;
                    while (tail < n && s[tail] != quote) ++tail;
                    title_z = tail;
                    if (tail < n) ++tail;
                    while (tail < n && isspace((unsigned char)s[tail])) ++tail;
                }
                if (tail < n && s[tail] == ')') {
                    Buf url = {0};
                    for (size_t j = u; j < v; ++j) {
                        if (s[j] == '\\' && j + 1 < v && ispunct((unsigned char)s[j + 1])) ++j;
                        put(&url, s[j]);
                    }
                    if (safe_url(url.s ? url.s : "", url.n)) {
                        append(out, image ? "<img src=\"" : "<a href=\"");
                        escape(out, url.s ? url.s : "", url.n); put(out, '"');
                        if (title_z > title_a) {
                            append(out, " title=\""); escape(out, s + title_a, title_z - title_a); put(out, '"');
                        }
                        if (image) {
                            append(out, " alt=\""); escape(out, s + a, end - a); append(out, "\" loading=\"lazy\">");
                        } else {
                            put(out, '>'); inline_md(out, s + a, end - a, depth + 1, 0); append(out, "</a>");
                        }
                    } else inline_md(out, s + a, end - a, depth + 1, 0);
                    free(url.s); i = tail + 1; continue;
                }
            }
        }
        if (links && s[i] == '<') {
            size_t end = i + 1;
            while (end < n && s[end] != '>' && !isspace((unsigned char)s[end])) ++end;
            size_t len = end - i - 1;
            int web = (len >= 7 && !memcmp(s + i + 1, "http://", 7)) ||
                      (len >= 8 && !memcmp(s + i + 1, "https://", 8));
            int mail = len > 0 && memchr(s + i + 1, '@', len) && !memchr(s + i + 1, ':', len);
            if (end < n && s[end] == '>' && (web || mail)) {
                append(out, "<a href=\""); if (mail) append(out, "mailto:");
                escape(out, s + i + 1, len); append(out, "\">");
                escape(out, s + i + 1, len); append(out, "</a>"); i = end + 1; continue;
            }
        }
        if (s[i] == '*' || s[i] == '_' || (s[i] == '~' && i + 1 < n && s[i + 1] == '~')) {
            size_t run = 1;
            while (i + run < n && s[i + run] == s[i] && run < 3) ++run;
            if (s[i] == '~') run = 2;
            int word_underscore = s[i] == '_' && i && isalnum((unsigned char)s[i - 1]);
            if (!word_underscore && i + run < n && !isspace((unsigned char)s[i + run])) {
                size_t end = closing(s, n, i + run, s + i, run);
                while (end < n && (end == i + run || isspace((unsigned char)s[end - 1]) ||
                       (s[i] == '_' && end + run < n && isalnum((unsigned char)s[end + run]))))
                    end = closing(s, n, end + run, s + i, run);
                if (end < n) {
                    const char *open = s[i] == '~' ? "<del>" : run == 3 ? "<em><strong>" : run == 2 ? "<strong>" : "<em>";
                    const char *close = s[i] == '~' ? "</del>" : run == 3 ? "</strong></em>" : run == 2 ? "</strong>" : "</em>";
                    append(out, open); inline_md(out, s + i + run, end - i - run, depth + 1, links);
                    append(out, close); i = end + run; continue;
                }
            }
        }
        escape(out, s + i, 1); ++i;
    }
}

static Marker marker(const char *s) {
    Marker m = {0}; m.indent = indent(s); size_t i = m.indent;
    if ((s[i] == '-' || s[i] == '+' || s[i] == '*') && s[i + 1] == ' ') {
        m.kind = 1; m.body = i + 2;
    } else if (isdigit((unsigned char)s[i])) {
        size_t a = i; unsigned long value = 0;
        while (isdigit((unsigned char)s[i]) && i - a < 9) { value = value * 10 + (unsigned)(s[i] - '0'); ++i; }
        if ((s[i] == '.' || s[i] == ')') && s[i + 1] == ' ') {
            m.kind = 2; m.start = value; m.body = i + 2;
        }
    }
    if (m.kind) {
        size_t after = m.body;
        while (s[after] == ' ') ++after;
        if (after - m.body < 4) m.body = after;
    }
    return m;
}

static int heading(const char *s, size_t *body) {
    size_t i = indent(s); if (i > 3) return 0;
    size_t a = i;
    while (s[i] == '#') ++i;
    if (i == a || i - a > 6 || (s[i] && s[i] != ' ')) return 0;
    int level = (int)(i - a);
    while (s[i] == ' ') ++i;
    *body = i; return level;
}

static int rule(const char *s) {
    size_t i = indent(s); if (i > 3) return 0;
    char c = s[i]; if (c != '*' && c != '-' && c != '_') return 0;
    unsigned n = 0;
    for (; s[i]; ++i) {
        if (s[i] == c) ++n; else if (s[i] != ' ') return 0;
    }
    return n >= 3;
}

static size_t fence(const char *s, char *ch, size_t *body) {
    size_t i = indent(s); if (i > 3 || (s[i] != '`' && s[i] != '~')) return 0;
    size_t a = i; *ch = s[i];
    while (s[i] == *ch) ++i;
    if (i - a < 3) return 0;
    *body = i; return i - a;
}

static int setext(const char *s) {
    size_t i = indent(s); if (i > 3) return 0;
    char c = s[i]; if (c != '=' && c != '-') return 0;
    size_t a = i;
    while (s[i] == c) ++i;
    if (i == a || !blank(s + i)) return 0;
    return c == '=' ? 1 : 2;
}

static Lines cells(const char *s) {
    Buf text = {0};
    while (*s == ' ') ++s;
    size_t n = strlen(s);
    while (n && s[n - 1] == ' ') --n;
    if (n && s[0] == '|') { ++s; --n; }
    if (n && s[n - 1] == '|' && (n < 2 || s[n - 2] != '\\')) --n;
    /* Reuse line splitting after turning unescaped pipes into separators. */
    for (size_t i = 0; i < n; ++i) {
        if (s[i] == '\\' && i + 1 < n) { put(&text, s[i]); put(&text, s[++i]); }
        else put(&text, s[i] == '|' ? '\n' : s[i]);
    }
    put(&text, '\n');
    Lines l = split_lines(text.s); free(text.s); return l;
}

static int table_delimiter(const char *s) {
    Lines l = cells(s); int valid = l.n > 0 && strchr(s, '|') != NULL;
    for (size_t i = 0; valid && i < l.n; ++i) {
        const char *p = l.v[i]; while (*p == ' ') ++p;
        if (*p == ':') ++p;
        size_t dashes = 0; while (*p == '-') { ++p; ++dashes; }
        if (*p == ':') ++p;
        while (*p == ' ') ++p;
        if (dashes < 3 || *p) valid = 0;
    }
    free_lines(l); return valid;
}

static void table_row(Buf *out, const char *s, Lines align, int header) {
    Lines row = cells(s); append(out, "<tr>");
    for (size_t i = 0; i < align.n; ++i) {
        const char *tag = header ? "th" : "td";
        put(out, '<'); append(out, tag);
        const char *p = align.v[i]; while (*p == ' ') ++p;
        size_t n = strlen(p); while (n && p[n - 1] == ' ') --n;
        int left = *p == ':', right = n && p[n - 1] == ':';
        if (left || right) {
            append(out, " style=\"text-align:"); append(out, left && right ? "center" : right ? "right" : "left"); put(out, '"');
        }
        put(out, '>');
        if (i < row.n) {
            p = row.v[i]; while (*p == ' ') ++p;
            n = strlen(p); while (n && p[n - 1] == ' ') --n;
            inline_md(out, p, n, 0, 1);
        }
        append(out, "</"); append(out, tag); put(out, '>');
    }
    append(out, "</tr>\n"); free_lines(row);
}

static int block_start(const char *s) {
    size_t body; char ch;
    return blank(s) || heading(s, &body) || rule(s) || fence(s, &ch, &body) ||
           (indent(s) <= 3 && s[indent(s)] == '>') || marker(s).kind;
}

static void blocks(Buf *out, Lines l, unsigned depth, RenderModules *modules) {
    if (depth > 64) { die("Markdown nesting exceeds 64 levels"); }
    for (size_t i = 0; i < l.n;) {
        const char *s = l.v[i];
        if (blank(s)) { ++i; continue; }
        size_t body = 0; char ch = 0;
        size_t run = fence(s, &ch, &body);
        if (run) {
            const char *info = s + body; while (*info == ' ') ++info;
            size_t lang = 0;
            while (isalnum((unsigned char)info[lang]) || info[lang] == '-' || info[lang] == '_' || info[lang] == '+') ++lang;
            const RenderModule *module = (!info[lang] || isspace((unsigned char)info[lang]))
                ? render_module_find(modules, info, lang) : NULL;
            if (module) append(out, module->before_code);
            append(out, "<pre><code");
            if (lang) { append(out, " class=\"language-"); escape(out, info, lang); put(out, '"'); }
            put(out, '>'); ++i;
            while (i < l.n) {
                size_t b; char c; size_t close = fence(l.v[i], &c, &b);
                if (close >= run && c == ch && blank(l.v[i] + b)) { ++i; break; }
                size_t spaces = indent(l.v[i]), strip = indent(s);
                if (spaces < strip) strip = spaces;
                escape(out, l.v[i] + strip, strlen(l.v[i] + strip)); put(out, '\n'); ++i;
            }
            append(out, "</code></pre>\n");
            if (module) append(out, module->after_code);
            continue;
        }
        int h = heading(s, &body);
        if (h) {
            size_t n = strlen(s + body);
            while (n && s[body + n - 1] == ' ') --n;
            size_t end = n; while (end && s[body + end - 1] == '#') --end;
            if (end < n && end && s[body + end - 1] == ' ') {
                n = end; while (n && s[body + n - 1] == ' ') --n;
            }
            append(out, "<h"); put(out, (char)('0' + h)); put(out, '>');
            inline_md(out, s + body, n, 0, 1);
            append(out, "</h"); put(out, (char)('0' + h)); append(out, ">\n"); ++i; continue;
        }
        if (i + 1 < l.n && setext(l.v[i + 1]) && indent(s) < 4 && !rule(s) && !marker(s).kind && s[indent(s)] != '>') {
            h = setext(l.v[i + 1]); append(out, h == 1 ? "<h1>" : "<h2>");
            inline_md(out, s, strlen(s), 0, 1); append(out, h == 1 ? "</h1>\n" : "</h2>\n"); i += 2; continue;
        }
        if (rule(s)) { append(out, "<hr>\n"); ++i; continue; }
        if (indent(s) <= 3 && s[indent(s)] == '>') {
            Buf quoted = {0};
            while (i < l.n) {
                size_t k = indent(l.v[i]);
                if (k > 3 || l.v[i][k] != '>') break;
                ++k; if (l.v[i][k] == ' ') ++k;
                append(&quoted, l.v[i] + k); put(&quoted, '\n'); ++i;
            }
            Lines inner = split_lines(quoted.s); append(out, "<blockquote>\n");
            blocks(out, inner, depth + 1, modules); append(out, "</blockquote>\n"); free_lines(inner); free(quoted.s); continue;
        }
        if (indent(s) >= 4) {
            append(out, "<pre><code>"); size_t last = i;
            while (last < l.n && (blank(l.v[last]) || indent(l.v[last]) >= 4)) ++last;
            size_t end = last; while (end > i && blank(l.v[end - 1])) --end;
            for (; i < end; ++i) {
                const char *p = blank(l.v[i]) ? "" : l.v[i] + 4;
                escape(out, p, strlen(p)); put(out, '\n');
            }
            i = last; append(out, "</code></pre>\n"); continue;
        }
        Marker first = marker(s);
        if (first.kind) {
            if (first.kind == 1) append(out, "<ul>\n");
            else {
                char number[48]; snprintf(number, sizeof(number), "<ol start=\"%lu\">\n", first.start); append(out, number);
            }
            while (i < l.n) {
                Marker m = marker(l.v[i]);
                if (m.kind != first.kind || m.indent != first.indent) break;
                Buf item = {0}; const char *p = l.v[i] + m.body;
                int task = strlen(p) >= 3 && p[0] == '[' && p[2] == ']' &&
                           (p[1] == ' ' || p[1] == 'x' || p[1] == 'X') && (!p[3] || p[3] == ' ');
                append(out, task ? "<li class=\"task\">" : "<li>");
                if (task) {
                    append(out, p[1] == ' ' ? "<input type=\"checkbox\" disabled> " : "<input type=\"checkbox\" disabled checked> ");
                    p += 3; if (*p == ' ') ++p;
                }
                append(&item, p); put(&item, '\n'); ++i;
                while (i < l.n) {
                    if (blank(l.v[i])) {
                        size_t next = i; while (next < l.n && blank(l.v[next])) ++next;
                        if (next == l.n || indent(l.v[next]) < m.body) break;
                        put(&item, '\n'); ++i; continue;
                    }
                    size_t spaces = indent(l.v[i]);
                    if (spaces >= m.body) append(&item, l.v[i] + m.body);
                    else if (!block_start(l.v[i])) append(&item, l.v[i]);
                    else break;
                    put(&item, '\n'); ++i;
                }
                Lines inner = split_lines(item.s); blocks(out, inner, depth + 1, modules);
                free_lines(inner); free(item.s); append(out, "</li>\n");
                size_t next = i; while (next < l.n && blank(l.v[next])) ++next;
                if (next < l.n) {
                    Marker following = marker(l.v[next]);
                    if (following.kind == first.kind && following.indent == first.indent) i = next;
                }
            }
            append(out, first.kind == 1 ? "</ul>\n" : "</ol>\n"); continue;
        }
        if (i + 1 < l.n && strchr(s, '|') && table_delimiter(l.v[i + 1])) {
            Lines align = cells(l.v[i + 1]);
            append(out, "<div class=\"table-wrap\"><table>\n<thead>"); table_row(out, s, align, 1);
            append(out, "</thead>\n<tbody>\n"); i += 2;
            while (i < l.n && !blank(l.v[i]) && strchr(l.v[i], '|') && !block_start(l.v[i])) {
                table_row(out, l.v[i++], align, 0);
            }
            append(out, "</tbody></table></div>\n"); free_lines(align); continue;
        }
        Buf paragraph = {0};
        do {
            if (paragraph.n) put(&paragraph, '\n');
            append(&paragraph, l.v[i++]);
        } while (i < l.n && !block_start(l.v[i]) &&
                 !(i + 1 < l.n && (setext(l.v[i + 1]) || (strchr(l.v[i], '|') && table_delimiter(l.v[i + 1])))));
        append(out, "<p>"); inline_md(out, paragraph.s, paragraph.n, 0, 1); append(out, "</p>\n"); free(paragraph.s);
    }
}

static const char style[] =
    "/* Embedded reading styles; no external assets required. */\n"
    ":root{color-scheme:light dark;--canvas:#f2efe9;--paper:#fffdf9;--fg:#343630;--muted:#6f7369;--line:#e5dfd4;--surface:#f4f0e8;--accent:#a44832;--code-bg:#292f2b;--code-fg:#edf0e8}\n"
    "@media(prefers-color-scheme:dark){:root{--canvas:#171b19;--paper:#202522;--fg:#e9e7df;--muted:#b2b7ac;--line:#3c433c;--surface:#2a302b;--accent:#e9ac8e;--code-bg:#151a17;--code-fg:#edf0e8}}\n"
    "*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}\n"
    "body{margin:0;background:var(--canvas);color:var(--fg);font:1.0625rem/1.8 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Helvetica,Arial,sans-serif}\n"
    "::selection{background:var(--accent);color:var(--paper)}\n"
    "main{width:calc(100% - 3rem);max-width:54rem;margin:3rem auto;padding:3.5rem clamp(1.5rem,6vw,4.5rem) 4.5rem;background:var(--paper);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 48px #00000008;overflow-wrap:break-word}\n"
    "main>:first-child{margin-top:0}main>:last-child{margin-bottom:0}\n"
    "h1,h2{font-family:Georgia,\"Times New Roman\",serif;font-weight:400;line-height:1.15;letter-spacing:-.035em;text-wrap:balance}\n"
    "h1{font-size:2.8em;margin:0 0 .8em}main>h1:first-child::after{content:\"\";display:block;width:2.5rem;height:3px;background:var(--accent);margin:1.5rem 0 0}\n"
    "h2{font-size:1.9em;margin:1.7em 0 .65em}h3,h4,h5,h6{font-weight:650;line-height:1.4;margin:1.8em 0 .65em}h3{font-size:1.2em}h4{font-size:1.05em}h5{font-size:1em}h6{font-size:.9em;color:var(--muted)}\n"
    "p,ul,ol,pre,.table-wrap{margin:0 0 1.3em}main>h1:first-child+p{font-size:1.1em;line-height:1.7;color:var(--muted)}\n"
    "a{color:var(--accent);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:.2em}a:hover{text-decoration-thickness:2px}a:focus-visible{outline:2px solid var(--accent);outline-offset:4px;border-radius:2px}\n"
    "strong{font-weight:650}del{color:var(--muted)}ul,ol{padding-left:1.5em}li{padding-left:.3em;margin:.35em 0}li::marker{color:var(--accent)}li>p{margin:.25em 0}li>ul,li>ol{margin:.4em 0}\n"
    "code{font:.85em/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:.15em .35em;overflow-wrap:anywhere}\n"
    "pre{background:var(--code-bg);color:var(--code-fg);border-radius:8px;padding:1.25rem 1.5rem;overflow-x:auto;tab-size:4;line-height:1.65}pre code{background:none;color:inherit;border:0;padding:0;overflow-wrap:normal;white-space:pre}\n"
    "blockquote{margin:1.8em 0;padding:1rem 1.4rem;border-left:2px solid var(--accent);border-radius:0 6px 6px 0;background:var(--surface);font:1.12em/1.7 Georgia,\"Times New Roman\",serif}blockquote>:first-child{margin-top:0}blockquote>:last-child{margin-bottom:0}\n"
    "img{max-width:100%;height:auto;vertical-align:middle;border-radius:6px}hr{border:0;border-top:1px solid var(--line);margin:2.5rem 0}\n"
    ".table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:6px}table{width:100%;border-collapse:collapse;font-size:.92em}th,td{border-bottom:1px solid var(--line);padding:.75em 1em;text-align:left;vertical-align:top}th{font-weight:650;background:var(--surface)}tbody tr:last-child td{border-bottom:0}\n"
    ".task{list-style:none;position:relative}.task>input{position:absolute;left:-1.3em;top:.5em;width:1em;height:1em;margin:0;accent-color:var(--accent)}\n"
    "@media(max-width:600px){body{font-size:1rem;background:var(--paper)}main{width:100%;margin:0;padding:2rem 1.5rem 3rem;border:0;border-radius:0;box-shadow:none}h1{font-size:2.3em}pre{padding:1rem}}\n"
    "@media print{:root{color-scheme:light;--paper:#fff;--fg:#000;--muted:#444;--line:#ccc;--surface:#f5f5f5;--accent:#000;--code-bg:#f5f5f5;--code-fg:#000}body{background:#fff;font-size:11pt}main{width:100%;max-width:none;margin:0;padding:0;border:0;box-shadow:none}h1,h2,h3,h4,h5,h6{break-after:avoid}p,li{orphans:3;widows:3}pre,blockquote,tr,img{break-inside:avoid}pre,pre code{white-space:pre-wrap;overflow-wrap:anywhere}.table-wrap,pre{overflow:visible}thead{display:table-header-group}}\n";

static void file_url(Buf *b, const char *path) {
    static const char hex[] = "0123456789ABCDEF";
    append(b, "file://");
    for (const unsigned char *p = (const unsigned char *)path; *p; ++p) {
        if (isalnum(*p) || strchr("/-._~", *p)) put(b, (char)*p);
        else { put(b, '%'); put(b, hex[*p >> 4]); put(b, hex[*p & 15]); }
    }
}

static Buf read_input(const char *path) {
    int from_stdin = !strcmp(path, "-");
    FILE *f = from_stdin ? stdin : fopen(path, "rb");
    if (!f) { fprintf(stderr, "mdview: cannot read %s: %s\n", path, strerror(errno)); exit(1); }
    Buf b = {0}; char chunk[8192];
    while (!feof(f)) {
        size_t n = fread(chunk, 1, sizeof(chunk), f);
        if (ferror(f)) die("error reading input");
        if (memchr(chunk, '\0', n)) die("input contains NUL bytes; expected a text file");
        append_n(&b, chunk, n);
    }
    if (!from_stdin && fclose(f)) die("error closing input");
    if (!b.s) append(&b, "");
    return b;
}

static int open_browser(const char *path) {
    pid_t pid = fork();
    if (pid < 0) { fprintf(stderr, "mdview: cannot launch browser: %s\n", strerror(errno)); return 1; }
    if (pid == 0) {
#ifdef __APPLE__
        execlp("open", "open", path, (char *)NULL);
#else
        execlp("xdg-open", "xdg-open", path, (char *)NULL);
#endif
        fprintf(stderr, "mdview: cannot launch browser: %s\n", strerror(errno));
        _exit(127);
    }
    int status;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) { fprintf(stderr, "mdview: cannot wait for browser launcher: %s\n", strerror(errno)); return 1; }
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status)) {
        fprintf(stderr, "mdview: browser launcher failed; open the HTML file above manually\n"); return 1;
    }
    return 0;
}

static void usage(FILE *out) {
    fputs("Usage: mdview [--no-open] [-o FILE] INPUT.md\n"
          "\nRender Markdown to HTML and open it in your default browser.\n"
          "  -o, --output FILE  Save HTML to FILE instead of a temporary file\n"
          "      --no-open      Render and print the HTML path without opening it\n"
          "  -h, --help         Show this help\n"
          "      --version      Show version\n"
          "Use - for standard input, or -- before a filename beginning with -.\n", out);
}

int main(int argc, char **argv) {
    const char *input = NULL, *output = NULL; int launch = 1, options = 1;
    for (int i = 1; i < argc; ++i) {
        const char *arg = argv[i];
        if (options && !strcmp(arg, "--")) { options = 0; continue; }
        if (options && (!strcmp(arg, "--help") || !strcmp(arg, "-h"))) { usage(stdout); return 0; }
        if (options && !strcmp(arg, "--version")) { puts("mdview 0.0.2"); return 0; }
        if (options && !strcmp(arg, "--no-open")) { launch = 0; continue; }
        if (options && (!strcmp(arg, "--output") || !strcmp(arg, "-o"))) {
            if (++i == argc) die("--output requires a filename");
            output = argv[i]; continue;
        }
        if (options && arg[0] == '-' && arg[1]) { fprintf(stderr, "mdview: unknown option: %s\n", arg); usage(stderr); return 1; }
        if (input) die("expected one input file");
        input = arg;
    }
    if (!input) { usage(stderr); return 1; }
    if (output && strcmp(input, "-")) {
        struct stat in_stat, out_stat;
        if (!stat(input, &in_stat) && !stat(output, &out_stat) &&
            in_stat.st_dev == out_stat.st_dev && in_stat.st_ino == out_stat.st_ino)
            die("output would overwrite the Markdown input");
    }
    Buf source = read_input(input);
    char *base = !strcmp(input, "-") ? realpath(".", NULL) : realpath(input, NULL);
    if (!base) die("cannot resolve input directory");
    if (strcmp(input, "-")) {
        char *slash = strrchr(base, '/');
        if (slash) slash[1] = '\0';
    } else {
        size_t n = strlen(base);
        char *p = realloc(base, n + 2); if (!p) die("out of memory");
        base = p; if (!n || base[n - 1] != '/') { base[n] = '/'; base[n + 1] = '\0'; }
    }
    RenderModules modules = {0}; Buf rendered = {0};
    const char *content = source.s;
    if (source.n >= 3 && !memcmp(content, "\xEF\xBB\xBF", 3)) content += 3;
    Lines lines = split_lines(content); blocks(&rendered, lines, 0, &modules);
    free_lines(lines); free(source.s);
    Buf html = {0};
    append(&html, "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>");
    const char *title = strrchr(input, '/'); title = title ? title + 1 : input;
    if (!strcmp(input, "-")) title = "Markdown preview";
    escape(&html, title, strlen(title)); append(&html, "</title>\n<base href=\"");
    Buf url = {0}; file_url(&url, base); escape(&html, url.s, url.n); free(url.s); free(base);
    append(&html, "\">\n<style>"); append(&html, style);
    render_modules_styles(&modules, emit, &html);
    append(&html, "</style>\n</head>\n<body>\n<main>\n");
    if (rendered.n) append_n(&html, rendered.s, rendered.n);
    free(rendered.s);
    append(&html, "</main>\n");
    if (!render_modules_scripts(&modules, emit, &html)) { free(html.s); return 1; }
    append(&html, "</body>\n</html>\n");
    FILE *f; char *temporary = NULL;
    if (output) f = fopen(output, "wb");
    else {
        const char *tmp = getenv("TMPDIR"); if (!tmp || !*tmp) tmp = "/tmp";
        Buf path = {0}; append(&path, tmp); if (path.s[path.n - 1] != '/') put(&path, '/');
        append(&path, "mdview-XXXXXX.html"); temporary = path.s;
        int fd = mkstemps(temporary, 5);
        if (fd < 0) f = NULL;
        else {
            f = fdopen(fd, "wb");
            if (!f) { int saved = errno; close(fd); unlink(temporary); errno = saved; }
        }
        output = temporary;
    }
    if (!f) { fprintf(stderr, "mdview: cannot write %s: %s\n", output, strerror(errno)); free(temporary); free(html.s); return 1; }
    int failed = fwrite(html.s, 1, html.n, f) != html.n;
    if (fclose(f)) failed = 1;
    free(html.s);
    if (failed) {
        fprintf(stderr, "mdview: error writing %s\n", output);
        if (temporary) unlink(temporary);
        free(temporary); return 1;
    }
    char *absolute = realpath(output, NULL);
    if (!absolute) { free(temporary); die("cannot resolve output path"); }
    puts(absolute); fflush(stdout);
    int status = launch ? open_browser(absolute) : 0;
    free(absolute); free(temporary); return status;
}
