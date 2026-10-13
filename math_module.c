#include "render_modules.h"
#include "vendor/miniz/miniz.h"
#include "vendor/math/asset_info.h"
#include "math_asset.h"
#include ".build/miniz_license.h"
#include ".build/math_license.h"
#include ".build/math_styles.h"
#include ".build/math_adapter.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Pinned, compressed browser runtime. Keep this module independent of the C parser.
 * Source remains escaped text; JavaScript reads textContent, never HTML. */

static int emit_runtime(RenderEmit emit, void *context) {
    char *runtime = malloc(MATH_SOURCE_SIZE + 1u);
    if (!runtime) { fputs("mdview: out of memory loading MathJax\n", stderr); return 0; }
    size_t n = tinfl_decompress_mem_to_mem(runtime, MATH_SOURCE_SIZE,
                                           math_deflated, sizeof(math_deflated), 0);
    if (n != MATH_SOURCE_SIZE || memchr(runtime, '\0', n)) {
        free(runtime); fputs("mdview: bundled MathJax decompression failed\n", stderr); return 0;
    }
    runtime[n] = '\0';
    /* Configuration must be in place before the runtime defines MathJax. */
    emit(context, "<script data-mdview-math-config>\n"
                  "window.MathJax={tex:{tags:'none'},svg:{fontCache:'local'},"
                  "options:{enableMenu:false},startup:{typeset:false}};\n</script>\n");
    emit(context, "<script data-mdview-math-runtime=\"" MATH_VERSION "\">\n/*\n");
    emit(context, (const char *)miniz_license);
    emit(context, "\n*/\n/*\n");
    emit(context, (const char *)math_license);
    emit(context, "\n*/\n");
    emit(context, runtime); emit(context, "\n</script>\n");
    free(runtime);
    return 1;
}

const RenderModule math_module = {
    "math",
    "<figure class=\"md-math-block\">\n"
    "<div class=\"math-canvas\" role=\"region\" aria-label=\"Rendered mathematics\" tabindex=\"0\" hidden></div>\n"
    "<details open><summary>Math source</summary>\n",
    "</details>\n<p class=\"math-status\" role=\"status\">Math preview requires JavaScript. Source is shown above.</p>\n</figure>\n",
    (const char *)math_styles, (const char *)math_adapter, emit_runtime
};
