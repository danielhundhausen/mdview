#include "render_modules.h"
#include "vendor/miniz/miniz.h"
#include "vendor/mermaid/asset_info.h"
#include "mermaid_asset.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Pinned, compressed browser runtime. Keep this module independent of the C parser.
 * Source remains escaped code; JavaScript reads textContent, never HTML. */
static const char styles[] =
    ".md-diagram{margin:1.6em 0;padding:1.25rem;background:var(--surface);border:1px solid var(--line);border-radius:8px}\n"
    ".diagram-canvas{overflow-x:auto;padding:.5rem 0 1rem}.diagram-canvas[hidden]{display:none}\n"
    ".diagram-canvas svg{display:block;margin:0 auto;height:auto;max-width:none}\n"
    ".diagram-canvas:focus-visible{outline:2px solid var(--accent);outline-offset:4px}\n"
    ".md-diagram details{margin:0}.md-diagram summary{font-size:.82em;color:var(--muted);cursor:pointer}\n"
    ".md-diagram details pre{margin:.75rem 0 0}.diagram-status{font-size:.85em;color:var(--muted);margin:.75rem 0 0}\n"
    "@media(max-width:600px){.md-diagram{padding:.85rem}}\n"
    "@media print{.md-diagram{break-inside:avoid}.md-diagram[data-rendered] details{display:none}.diagram-canvas{overflow:visible}.diagram-canvas svg{max-width:100%;width:100%!important}}\n";

static const char script[] =
    "<script type=\"module\">\n"
    "const figures = [...document.querySelectorAll('.md-diagram')];\n"
    "const media = matchMedia('(prefers-color-scheme: dark)');\n"
    "const source = f => f.querySelector('code').textContent;\n"
    "function unavailable(f, message) {\n"
    "  f.removeAttribute('data-rendered');\n"
    "  f.querySelector('.diagram-canvas').hidden = true;\n"
    "  f.querySelector('details').open = true;\n"
    "  const status = f.querySelector('.diagram-status');\n"
    "  status.textContent = message; status.hidden = false;\n"
    "}\n"
    "try {\n"
    "  const mermaid = globalThis.mermaid;\n"
    "  if (!mermaid) throw new Error('Bundled Mermaid runtime unavailable');\n"
    "  let generation = 0;\n"
    "  async function renderAll() {\n"
    "    const css = getComputedStyle(document.documentElement);\n"
    "    const color = name => css.getPropertyValue(name).trim();\n"
    "    const paper = color('--paper'), ink = color('--fg'), line = color('--line');\n"
    "    const surface = color('--surface'), accent = color('--accent');\n"
    "    mermaid.initialize({startOnLoad:false, securityLevel:'strict',\n"
    "      suppressErrorRendering:true, arrowMarkerAbsolute:true, theme:'base', fontFamily:'system-ui, sans-serif',\n"
    "      htmlLabels:false, flowchart:{htmlLabels:false,curve:'basis'},\n"
    "      secure:['secure','securityLevel','startOnLoad','suppressErrorRendering',\n"
    "        'theme','themeVariables','themeCSS','fontFamily','htmlLabels','flowchart','dompurifyConfig','arrowMarkerAbsolute'],\n"
    "      themeVariables:{darkMode:media.matches, background:paper,\n"
    "        primaryColor:surface, primaryTextColor:ink, primaryBorderColor:accent,\n"
    "        secondaryColor:paper, tertiaryColor:surface, lineColor:accent,\n"
    "        textColor:ink, mainBkg:surface, nodeBorder:accent,\n"
    "        clusterBkg:paper, clusterBorder:line, edgeLabelBackground:paper,\n"
    "        actorBkg:surface, actorBorder:accent, actorTextColor:ink,\n"
    "        actorLineColor:line, signalColor:ink, signalTextColor:ink,\n"
    "        noteBkgColor:surface, noteBorderColor:line, noteTextColor:ink}});\n"
    "    const current = ++generation;\n"
    "    for (const [index, f] of figures.entries()) {\n"
    "      try {\n"
    "        const {svg} = await mermaid.render('mdview-diagram-' + current + '-' + index, source(f));\n"
    "        const canvas = f.querySelector('.diagram-canvas');\n"
    "        canvas.innerHTML = svg; canvas.hidden = false;\n"
    "        const image = canvas.querySelector('svg');\n"
    "        image.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');\n"
    "        image.querySelectorAll('.node>path.outer-path').forEach(path => {\n"
    "          if (!/^M0,.*? a/.test(path.getAttribute('d'))) return;\n"
    "          const label = path.parentElement.querySelector('.label');\n"
    "          const position = label?.getAttribute('transform')?.match(/^translate\\([^,]+,\\s*(.+)\\)$/);\n"
    "          if (position) label.setAttribute('transform', 'translate(0, ' + position[1] + ')');\n"
    "        });\n"
    "        const width = image.viewBox.baseVal.width;\n"
    "        if (width > 0) {image.style.width = width + 'px'; image.style.maxWidth = 'none';}\n"
    "        if (!f.hasAttribute('data-rendered')) f.querySelector('details').open = false;\n"
    "        f.setAttribute('data-rendered', '');\n"
    "        f.querySelector('.diagram-status').hidden = true;\n"
    "      } catch (error) {\n"
    "        unavailable(f, 'Could not render this diagram. Check the source below.');\n"
    "        console.warn('mdview: Mermaid diagram failed', error);\n"
    "      }\n"
    "    }\n"
    "  }\n"
    "  let queue = Promise.resolve();\n"
    "  const schedule = () => {queue = queue.then(renderAll).catch(error => {\n"
    "    figures.forEach(f => unavailable(f, 'Diagram preview unavailable. Source is shown below.'));\n"
    "    console.warn('mdview: Mermaid rendering failed', error);\n"
    "  }); return queue;};\n"
    "  await schedule();\n"
    "  media.addEventListener('change', schedule);\n"
    "} catch (error) {\n"
    "  figures.forEach(f => unavailable(f, 'Could not initialize Mermaid. Source is shown below.'));\n"
    "  console.warn('mdview: Mermaid runtime unavailable', error);\n"
    "}\n"
    "</script>\n";

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
    free(runtime);
    return 1;
}

const RenderModule mermaid_module = {
    "mermaid",
    "<figure class=\"md-diagram\">\n"
    "<div class=\"diagram-canvas\" role=\"region\" aria-label=\"Rendered Mermaid diagram\" tabindex=\"0\" hidden></div>\n"
    "<details open><summary>Diagram source</summary>\n",
    "</details>\n<p class=\"diagram-status\" role=\"status\">Diagram preview requires JavaScript. Source is shown above.</p>\n</figure>\n",
    styles, script, emit_runtime
};
