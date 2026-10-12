#ifndef MDVIEW_RENDER_MODULES_H
#define MDVIEW_RENDER_MODULES_H

#include <stddef.h>

/* Modules decorate escaped fenced code and supply optional browser assets.
 * They never receive raw HTML or own the Markdown parser's buffers. */
typedef void (*RenderEmit)(void *context, const char *text);
typedef struct {
    const char *language;
    const char *before_code;
    const char *after_code;
    const char *styles;
    const char *script;
    int (*emit_runtime)(RenderEmit emit, void *context);
} RenderModule;

typedef struct { unsigned used; } RenderModules;

const RenderModule *render_module_find(RenderModules *state, const char *language,
                                       size_t length);
void render_modules_styles(const RenderModules *state, RenderEmit emit, void *context);
int render_modules_scripts(const RenderModules *state, RenderEmit emit, void *context);

extern const RenderModule mermaid_module;

#endif
