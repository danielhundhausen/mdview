#include "render_modules.h"
#include <limits.h>
#include <string.h>

/* Add fenced-code renderers here; each module brings its own assets. */
static const RenderModule *const registry[] = { &mermaid_module };
#define MODULE_COUNT (sizeof(registry) / sizeof(*registry))
typedef char modules_fit_bitset[MODULE_COUNT <= sizeof(unsigned) * CHAR_BIT ? 1 : -1];

const RenderModule *render_module_find(RenderModules *state, const char *language,
                                       size_t length) {
    for (size_t i = 0; i < MODULE_COUNT; ++i) {
        if (strlen(registry[i]->language) == length &&
            !memcmp(registry[i]->language, language, length)) {
            state->used |= 1u << i;
            return registry[i];
        }
    }
    return NULL;
}

void render_modules_styles(const RenderModules *state, RenderEmit emit, void *context) {
    for (size_t i = 0; i < MODULE_COUNT; ++i)
        if (state->used & (1u << i)) emit(context, registry[i]->styles);
}

int render_modules_scripts(const RenderModules *state, RenderEmit emit, void *context) {
    for (size_t i = 0; i < MODULE_COUNT; ++i) {
        if (!(state->used & (1u << i))) continue;
        if (registry[i]->emit_runtime && !registry[i]->emit_runtime(emit, context)) return 0;
        emit(context, "<script type=\"module\">\n");
        emit(context, registry[i]->script);
        emit(context, "\n</script>\n");
    }
    return 1;
}
