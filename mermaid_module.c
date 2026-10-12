#include "render_modules.h"
#include "vendor/miniz/miniz.h"
#include "vendor/mermaid/asset_info.h"
#include "mermaid_asset.h"
#include ".build/miniz_license.h"
#include ".build/mermaid_styles.h"
#include ".build/mermaid_adapter.h"
#include ".build/diagram_viewer.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Pinned, compressed browser runtime. Keep this module independent of the C parser.
 * Source remains escaped code; JavaScript reads textContent, never HTML. */

static int emit_runtime(RenderEmit emit, void *context) {
    char *runtime = malloc(MERMAID_SOURCE_SIZE + 1u);
    if (!runtime) { fputs("mdview: out of memory loading Mermaid\n", stderr); return 0; }
    size_t n = tinfl_decompress_mem_to_mem(runtime, MERMAID_SOURCE_SIZE,
                                          mermaid_deflated, sizeof(mermaid_deflated), 0);
    if (n != MERMAID_SOURCE_SIZE || memchr(runtime, '\0', n)) {
        free(runtime); fputs("mdview: bundled Mermaid decompression failed\n", stderr); return 0;
    }
    runtime[n] = '\0';
    emit(context, "<script data-mdview-mermaid-runtime=\"" MERMAID_VERSION "\">\n/*\n");
    emit(context, (const char *)miniz_license);
    emit(context, "*/\n"); emit(context, runtime); emit(context, "\n</script>\n");
    emit(context, "<script data-mdview-diagram-viewer>\n");
    emit(context, (const char *)diagram_viewer); emit(context, "\n</script>\n");
    free(runtime);
    return 1;
}

const RenderModule mermaid_module = {
    "mermaid",
    "<figure class=\"md-diagram\">\n"
    "<div class=\"diagram-toolbar\" hidden><button type=\"button\" class=\"diagram-button diagram-expand\" aria-haspopup=\"dialog\" aria-label=\"Expand diagram\" title=\"Expand diagram\">"
    "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\"><path d=\"M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5\"/></svg></button></div>\n"
    "<div class=\"diagram-canvas\" role=\"region\" aria-label=\"Rendered Mermaid diagram\" tabindex=\"0\" hidden></div>\n"
    "<details open><summary>Diagram source</summary>\n",
    "</details>\n<p class=\"diagram-status\" role=\"status\">Diagram preview requires JavaScript. Source is shown above.</p>\n</figure>\n",
    (const char *)mermaid_styles, (const char *)mermaid_adapter, emit_runtime
};
