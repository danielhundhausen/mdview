#ifndef MDVIEW_WATCH_H
#define MDVIEW_WATCH_H

/* Render returns an allocated absolute HTML path, or NULL on failure.
 * link_output is the final preview path when output is a staging file. */
typedef char *(*WatchRender)(const char *input, const char *output,
                             const char *link_output, unsigned long revision);
int watch_preview(const char *input, const char *output,
                  int (*launch)(const char *url),
                  WatchRender render);

#endif
