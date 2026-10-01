# Markdown, in your browser

`mdview` turns a Markdown file into a readable HTML page.

## Formatting

Write **bold text**, *italics*, or ~~a correction~~. Link to
[a website](https://example.com "Example website") or include an image with
`![description](image.png)`.

> A blockquote can contain multiple paragraphs.
>
> And even a **little emphasis**.

## Lists

- One item
- Another item
  - A nested item
  - And a second

1. Build with `make`.
2. Run `./mdview example.md`.
3. Read in your browser.

- [x] Compile Markdown
- [x] Style the page
- [ ] Write your next document

## Code

```c
#include <stdio.h>

int main(void) {
    puts("Hello, Markdown!");
    return 0;
}
```

## Tables

| Feature | Status | Dependencies |
| :--- | :---: | ---: |
| Rendering | Ready | 0 |
| Browser launch | Ready | OS launcher |

---

The page follows your system's light or dark theme.
