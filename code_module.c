#include "render_modules.h"
#include ".build/code_styles.h"
#include ".build/code_adapter.h"
#include ".build/highlight_runtime.h"
#include ".build/highlight_license.h"

static int emit_runtime(RenderEmit emit, void *context) {
    emit(context, "<script data-mdview-highlight-runtime=\"11.12.0\">\n/*\n");
    emit(context, (const char *)highlight_license);
    emit(context, "*/\n");
    emit(context, (const char *)highlight_runtime);
    emit(context, "\n</script>\n");
    return 1;
}

/* Shared decoration for every block, including other modules' source. */
const RenderModule code_module = {
    NULL,
    "<div class=\"md-code-block\">\n"
    "<div class=\"code-toolbar\" hidden>"
    "<button type=\"button\" class=\"code-copy\" aria-label=\"Copy code\" title=\"Copy code\" data-state=\"idle\">"
    "<svg class=\"code-icon code-icon-copy\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\"><rect x=\"9\" y=\"9\" width=\"11\" height=\"11\" rx=\"2\"/><path d=\"M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4\"/></svg>"
    "<svg class=\"code-icon code-icon-success\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\"><path d=\"m5 12 4 4L19 6\"/></svg>"
    "<svg class=\"code-icon code-icon-error\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\"><path d=\"m6 6 12 12M6 18 18 6\"/></svg></button>"
    "<span class=\"code-status\" role=\"status\" aria-live=\"polite\"></span></div>\n",
    "</div>\n",
    (const char *)code_styles, (const char *)code_adapter, emit_runtime
};
