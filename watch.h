#ifndef MDVIEW_WATCH_H
#define MDVIEW_WATCH_H

/* Render returns an allocated absolute HTML path, or NULL on failure. */
int watch_preview(const char *input, const char *output,
                  int (*launch)(const char *url),
                  char *(*render)(const char *, const char *, unsigned long));

#endif
