/*!
 * TypeButter v2.2.0 — single-file implementation (2026-ready)
 * Original TYPEBUTTER v1.3 by David Hudson (@_davidhudson) + Joel Richardson (@richardson_joel)
 * License: CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/)
 *
 * ----------------------------------------------------------------------------
 * TL;DR
 * ----------------------------------------------------------------------------
 * - Library mode: you provide pair/n-gram overrides (context-dependent supported).
 * - Auto mode: experimental, headline-oriented. Uses Canvas + (optional) raster
 *   ink-edge sampling to estimate/adjust inter-glyph gaps.
 *
 * Key properties:
 * - Unicode-safe grapheme segmentation (Intl.Segmenter fallback)
 * - Idempotent (unwraps its own output before re-applying)
 * - Font-ready gating (document.fonts.ready or fonts.load)
 * - MutationObserver + ResizeObserver (optional)
 * - Batching: one replacement per text node (DocumentFragment)
 * - Caching: graphemes, widths, glyph ink edges, pair adjustments (LRU)
 * - Optional jQuery wrapper (auto-installs when jQuery is present)
 *
 * ----------------------------------------------------------------------------
 * IMPORTANT LIMITS
 * ----------------------------------------------------------------------------
 * - Any per-glyph wrapping can disrupt shaping/ligatures for some scripts.
 *   This is designed primarily for Latin display/headline use.
 * - Prefer browser-native kerning whenever possible (CSS font-kerning, etc.).
 */
(function (root, factory) {
  "use strict";
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TypeButter = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ------------------------------------------------------------
  // Version
  // ------------------------------------------------------------
  const VERSION = "2.2.0";

  // ------------------------------------------------------------
  // Environment
  // ------------------------------------------------------------
  const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

  // ------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------
  function asArray(v) { return Array.isArray(v) ? v : [v]; }
  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function now() { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }
  function noop() {}

  function isPlainObject(x) {
    return !!x && typeof x === "object" &&
      (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
  }

  function deepMerge(target, source) {
    // Last-wins deep merge for plain objects. Arrays/other types overwritten.
    if (!isPlainObject(target)) target = {};
    if (!isPlainObject(source)) return target;

    const out = { ...target };
    for (const k of Object.keys(source)) {
      const sv = source[k];
      const tv = out[k];
      if (isPlainObject(tv) && isPlainObject(sv)) out[k] = deepMerge(tv, sv);
      else out[k] = sv;
    }
    return out;
  }

  // ------------------------------------------------------------
  // LRU Cache
  // ------------------------------------------------------------
  class LRUCache {
    constructor(maxEntries) {
      this.maxEntries = Math.max(50, maxEntries | 0);
      this._map = new Map();
    }
    get(key) {
      const v = this._map.get(key);
      if (v === undefined) return undefined;
      this._map.delete(key);
      this._map.set(key, v);
      return v;
    }
    set(key, value) {
      if (this._map.has(key)) this._map.delete(key);
      this._map.set(key, value);
      if (this._map.size > this.maxEntries) {
        const first = this._map.keys().next();
        if (!first.done) this._map.delete(first.value);
      }
    }
    clear() { this._map.clear(); }
    get size() { return this._map.size; }
  }

  // ------------------------------------------------------------
  // Grapheme splitting (Unicode-safe)
  // ------------------------------------------------------------
  const hasSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter !== "undefined";
  let _segmenter = null;

  function splitGraphemes(text) {
    if (!text) return [];
    if (hasSegmenter) {
      if (!_segmenter) _segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const out = [];
      for (const seg of _segmenter.segment(text)) out.push(seg.segment);
      return out;
    }
    return Array.from(text); // surrogate-safe fallback (not full EGC)
  }

  // ------------------------------------------------------------
  // Debug styles
  // ------------------------------------------------------------
  let _debugInjected = false;
  function ensureDebugStyles() {
    if (!isBrowser || _debugInjected) return;
    const style = document.createElement("style");
    style.setAttribute("data-typebutter-style", "1");
    style.textContent = `
[data-tb-wrapper].tb-debug-overlay .tb-kern {
  outline: 1px dashed currentColor;
  outline-offset: 1px;
}
[data-tb-wrapper].tb-debug-overlay .tb-kern::after {
  content: attr(data-tb-delta);
  font-size: 10px;
  opacity: 0.65;
  margin-left: 0.25em;
}
/* Visual mode is headline-oriented: make containing block predictable */
[data-tb-visual-root] {
  position: relative;
  display: inline-block;
  vertical-align: baseline;
}
.tb-visual-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  white-space: inherit;
}
`;
    document.head.appendChild(style);
    _debugInjected = true;
  }

  function debugLog(enabled, ...args) {
    if (!enabled) return;
    // eslint-disable-next-line no-console
    console.log("[TypeButter]", ...args);
  }

  // ------------------------------------------------------------
  // Font/style helpers
  // ------------------------------------------------------------
  function normalizeFontFamilyKey(fontFamily) {
    const first = (fontFamily || "").split(",")[0]?.trim() || (fontFamily || "").trim();
    const unquoted = first.replace(/^["']|["']$/g, "");
    const safe = unquoted.replace(/[^\p{L}\p{N}\s_-]/gu, "");
    return safe.replace(/\s+/g, "-").toLowerCase();
  }

  function normalizeLegacyWeight(fontWeight) {
    const w = String(fontWeight || "").toLowerCase().trim();
    if (w === "700") return "bold";
    if (w === "400") return "normal";
    if (w === "bold" || w === "bolder") return "bold";
    if (w === "normal" || w === "lighter") return "normal";
    const n = parseInt(w, 10);
    if (Number.isFinite(n)) return n >= 600 ? "bold" : "normal";
    return "normal";
  }

  function normalizeLegacyStyle(fontStyle) {
    const s = String(fontStyle || "").toLowerCase().trim();
    if (s === "italic" || s === "oblique") return s;
    return "normal";
  }

  function safePxToEm(px, fontSizePx) {
    if (!Number.isFinite(px) || !Number.isFinite(fontSizePx) || fontSizePx <= 0) return 0;
    return px / fontSizePx;
  }

  function getComputedFontDescriptor(el) {
    const cs = getComputedStyle(el);
    const fontFamily = cs.fontFamily || "sans-serif";
    const fontSizePx = parseFloat(cs.fontSize || "16") || 16;
    const letterSpacing = cs.letterSpacing;
    const letterSpacingPx = (letterSpacing === "normal") ? 0 : (parseFloat(letterSpacing) || 0);
    const dir = cs.direction === "rtl" ? "rtl" : "ltr";

    const fontStretch = cs.fontStretch || "normal";
    const fontVariantLigatures = cs.fontVariantLigatures || "normal";
    const fontVariationSettings = cs.fontVariationSettings || "normal";
    const fontOpticalSizing = cs.fontOpticalSizing || "auto";

    return {
      fontFamily,
      fontSizePx,
      fontWeight: String(cs.fontWeight || "400"),
      fontStyle: cs.fontStyle || "normal",
      fontStretch,
      fontVariantLigatures,
      fontVariationSettings,
      fontOpticalSizing,
      letterSpacingPx,
      textTransform: cs.textTransform || "none",
      whiteSpace: cs.whiteSpace || "normal",
      direction: dir
    };
  }

  function buildFontDescriptorKey(desc) {
    const familyKey = normalizeFontFamilyKey(desc.fontFamily);
    return [
      familyKey,
      `sz:${desc.fontSizePx.toFixed(3)}`,
      `w:${desc.fontWeight}`,
      `st:${desc.fontStyle}`,
      `str:${desc.fontStretch}`,
      `var:${desc.fontVariationSettings}`,
      `opsz:${desc.fontOpticalSizing}`
    ].join("|");
  }

  function buildCSSFontShorthandForFontsLoad(el) {
    // Used for document.fonts.load — may include line-height safely.
    const cs = getComputedStyle(el);
    const style = cs.fontStyle || "normal";
    const variant = cs.fontVariant || "normal";
    const weight = String(cs.fontWeight || "400");
    const stretch = cs.fontStretch || "normal";
    const size = cs.fontSize || "16px";
    const lineHeight = (cs.lineHeight && cs.lineHeight !== "normal") ? `/${cs.lineHeight}` : "";
    const family = cs.fontFamily || "sans-serif";
    return `${style} ${variant} ${weight} ${stretch} ${size}${lineHeight} ${family}`;
  }

  function buildCanvasFont(el) {
    // Canvas font property does NOT reliably accept line-height.
    const cs = getComputedStyle(el);
    const style = cs.fontStyle || "normal";
    const variant = cs.fontVariant || "normal";
    const weight = String(cs.fontWeight || "400");
    const stretch = cs.fontStretch || "normal";
    const size = cs.fontSize || "16px";
    const family = cs.fontFamily || "sans-serif";
    return `${style} ${variant} ${weight} ${stretch} ${size} ${family}`;
  }

  async function awaitFontsReady(roots, options) {
    if (!isBrowser) return;
    const fonts = document.fonts;
    if (!fonts) return;

    const timeoutMs = options.fontLoading.timeoutMs;
    const strategy = options.fontLoading.strategy;
    const sampleText = options.fontLoading.sampleText || "AVATAR To WA fi fl";

    const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    if (strategy === "ready") {
      await Promise.race([fonts.ready, timeout(timeoutMs)]);
      return;
    }

    // strategy === "load": attempt to load fonts used by targets
    const fontStrings = new Set();
    for (const root of roots) {
      const scope = (root instanceof Document) ? root : root;
      const els = Array.from(scope.querySelectorAll?.(options.selector) || []);
      for (const el of els) {
        fontStrings.add(buildCSSFontShorthandForFontsLoad(el));
      }
    }

    const loads = [];
    for (const font of fontStrings) {
      loads.push(fonts.load(font, sampleText));
    }

    await Promise.race([Promise.allSettled(loads), timeout(timeoutMs)]);
  }

  // ------------------------------------------------------------
  // Library lookup (pairs + n-grams, with fallbacks)
  // ------------------------------------------------------------
  function getFontTables(library, fontFamilyKey) {
    if (!library) return null;
    const font = library[fontFamilyKey];
    if (!font || typeof font !== "object") return null;
    return font;
  }

  function resolveStyleTables(fontTables, styleKey) {
    if (!fontTables) return null;

    // Ordered list of tables to try:
    // 1) exact style
    // 2) normal-normal
    // 3) wildcard "*"
    // 4) all remaining tables in key order
    const out = [];
    if (fontTables[styleKey] && typeof fontTables[styleKey] === "object") out.push(fontTables[styleKey]);
    if (fontTables["normal-normal"] && typeof fontTables["normal-normal"] === "object") out.push(fontTables["normal-normal"]);
    if (fontTables["*"] && typeof fontTables["*"] === "object") out.push(fontTables["*"]);

    for (const k of Object.keys(fontTables)) {
      if (k === styleKey || k === "normal-normal" || k === "*") continue;
      const t = fontTables[k];
      if (t && typeof t === "object") out.push(t);
    }

    return out.length ? out : null;
  }

  function resolveLibraryAdjustmentEm(library, fontFamilyKey, styleKey, graphemes, index, maxNGram) {
    // Longest match wins: n = maxNGram..2
    const fontTables = getFontTables(library, fontFamilyKey);
    if (!fontTables) return null;

    const tables = resolveStyleTables(fontTables, styleKey);
    if (!tables) return null;

    const maxLen = Math.max(2, Math.min(maxNGram, graphemes.length - index));
    for (let n = maxLen; n >= 2; n--) {
      const key = graphemes.slice(index, index + n).join("");
      for (const table of tables) {
        const v = table[key];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
    }
    return null;
  }

  // ------------------------------------------------------------
  // Canvas measurement / auto mode
  // ------------------------------------------------------------
  let _measureCtx = null;
  let _measureCanvas = null;

  function getMeasureContext() {
    if (_measureCtx) return _measureCtx;
    if (!isBrowser) throw new Error("Canvas measurement requires a browser environment.");

    if (typeof OffscreenCanvas !== "undefined") {
      const c = new OffscreenCanvas(1, 1);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable.");
      _measureCtx = ctx;
      _measureCanvas = c;
      return ctx;
    }

    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D context unavailable.");
    _measureCtx = ctx;
    _measureCanvas = canvas;
    return ctx;
  }

  function ensureRasterSurface(w, h) {
    if (!_measureCanvas) return;
    if (_measureCanvas.width !== w) _measureCanvas.width = w;
    if (_measureCanvas.height !== h) _measureCanvas.height = h;
  }

  function measureWidthPx(ctx, fontKey, fontCSS, text, widthCache) {
    const k = `w|${fontKey}|${text}`;
    const cached = widthCache.get(k);
    if (cached !== undefined) return cached;
    ctx.font = fontCSS;
    const w = ctx.measureText(text).width || 0;
    widthCache.set(k, w);
    return w;
  }

  function computeNativeKernPx(ctx, fontKey, fontCSS, a, b, widthCache) {
    // kernPx = width("AB") - width("A") - width("B")
    const wA = measureWidthPx(ctx, fontKey, fontCSS, a, widthCache);
    const wB = measureWidthPx(ctx, fontKey, fontCSS, b, widthCache);
    const wAB = measureWidthPx(ctx, fontKey, fontCSS, a + b, widthCache);
    return wAB - wA - wB;
  }

  function getGlyphInkEdgesPx(ctx, fontKey, fontCSS, desc, glyph, opts, inkCache) {
    // Returns { left, right, empty } in CSS px space (NOT supersampled px).
    const ss = opts.rasterSupersample;
    const alphaThr = opts.rasterAlphaThreshold;
    const k = `ink|${fontKey}|ss:${ss}|thr:${alphaThr}|g:${glyph}`;
    const cached = inkCache.get(k);
    if (cached !== undefined) return cached;

    // Whitespace is treated as empty ink
    if (!glyph || /^\s+$/u.test(glyph)) {
      const v = { left: 0, right: 0, empty: true };
      inkCache.set(k, v);
      return v;
    }

    ctx.font = fontCSS;

    // Generous size estimate: glyph width + some padding for overhangs
    const w = Math.ceil((ctx.measureText(glyph).width || 0) + (desc.fontSizePx * 1.5) + 16);
    const h = Math.ceil(desc.fontSizePx * 3 + 16);

    const W = Math.max(32, w * ss);
    const H = Math.max(32, h * ss);

    ensureRasterSurface(W, H);

    // Clear & setup
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Supersample: draw in CSS px coordinates under a scale transform
    ctx.setTransform(ss, 0, 0, ss, 0, 0);
    ctx.font = fontCSS;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#000";

    const pad = 8;
    const baselineY = pad + desc.fontSizePx;
    ctx.fillText(glyph, pad, baselineY);

    // Scan alpha
    const img = ctx.getImageData(0, 0, W, H);
    const data = img.data;

    let minX = Infinity;
    let maxX = -Infinity;

    for (let y = 0; y < H; y++) {
      const row = y * W * 4;
      for (let x = 0; x < W; x++) {
        const a = data[row + x * 4 + 3];
        if (a > alphaThr) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }

    if (minX === Infinity) {
      const v = { left: 0, right: 0, empty: true };
      inkCache.set(k, v);
      return v;
    }

    const left = minX / ss;
    const right = maxX / ss;
    const v = { left, right, empty: false };
    inkCache.set(k, v);
    return v;
  }

  function isBasicLatinish(g) {
    // Headline-safe default: ASCII letters/numbers and a handful of punctuation.
    return /^[A-Za-z0-9&@#$%*+\-_=:'".,!?()\[\]{}\/\\]+$/u.test(g);
  }

  function computeAutoDeltaEm(el, desc, options, a, b, baseSpacingEm, caches) {
    const auto = options.auto;

    // RTL policy (default skip)
    if (desc.direction === "rtl" && auto.rtl === "skip") return null;

    // Per-grapheme allow gate
    if (auto.allowGrapheme && typeof auto.allowGrapheme === "function") {
      if (!auto.allowGrapheme(a) || !auto.allowGrapheme(b)) return null;
    } else if (auto.onlyBasicLatin) {
      if (!isBasicLatinish(a) || !isBasicLatinish(b)) return null;
    }

    if (auto.skipWhitespacePairs && (/^\s$/u.test(a) || /^\s$/u.test(b))) return null;

    const fontKey = buildFontDescriptorKey(desc);
    const fontCSS = buildCanvasFont(el);

    // Cache key includes band + baseline + baseSpacingEm
    const key = `auto|alg:${auto.algorithm}|base:${auto.baseline}|ls:${baseSpacingEm.toFixed(5)}|${fontKey}|ss:${auto.rasterSupersample}|thr:${auto.rasterAlphaThreshold}|min:${auto.minGapEm}|max:${auto.maxGapEm}|${a}|${b}`;
    const cached = caches.autoCache.get(key);
    if (cached !== undefined) return cached;

    const ctx = getMeasureContext();

    const baseKernPx = (auto.baseline === "native")
      ? computeNativeKernPx(ctx, fontKey, fontCSS, a, b, caches.widthCache)
      : 0;

    // Fast mode: just return native kerning advance as the delta
    if (auto.algorithm === "advanceKern") {
      const em = baseKernPx / desc.fontSizePx;
      caches.autoCache.set(key, em);
      return em;
    }

    // Banding mode uses ink edges
    const wA = measureWidthPx(ctx, fontKey, fontCSS, a, caches.widthCache);
    const eA = getGlyphInkEdgesPx(ctx, fontKey, fontCSS, desc, a, auto, caches.inkCache);
    const eB = getGlyphInkEdgesPx(ctx, fontKey, fontCSS, desc, b, auto, caches.inkCache);

    if (eA.empty || eB.empty) {
      caches.autoCache.set(key, 0);
      return 0;
    }

    const baseSpacingPx = baseSpacingEm * desc.fontSizePx;

    // Approx ink-gap when B follows A with baseKern + baseSpacing applied:
    // gap = (advanceA + baseKern + baseSpacing + inkLeftB) - inkRightA
    const gapPx = (wA + baseKernPx + baseSpacingPx + eB.left) - eA.right;

    const minGapPx = auto.minGapEm * desc.fontSizePx;
    const maxGapPx = auto.maxGapEm * desc.fontSizePx;

    let deltaPx = 0;
    if (gapPx < minGapPx) deltaPx = (minGapPx - gapPx);
    else if (gapPx > maxGapPx) deltaPx = -(gapPx - maxGapPx);

    // Return delta in em to add on top of baseSpacingEm
    const deltaEm = (baseKernPx + deltaPx) / desc.fontSizePx;
    caches.autoCache.set(key, deltaEm);
    return deltaEm;
  }

  // ------------------------------------------------------------
  // DOM application (idempotent)
  // ------------------------------------------------------------
  const WRAPPER_ATTR = "data-tb-wrapper";
  const VISUAL_ROOT_ATTR = "data-tb-visual-root";

  // Store original text without DOM bloat
  const ORIGINAL_TEXT = (typeof WeakMap !== "undefined") ? new WeakMap() : null;

  // Common ligature pairs (heuristic)
  const KNOWN_LIGATURE_PAIRS = new Set(["ff", "fi", "fl", "ffi", "ffl", "st", "ct"]);

  // Shared caches (per JS file)
  const GRAPHEME_CACHE = new LRUCache(2000);
  const AUTO_CACHE = new LRUCache(3000);
  const WIDTH_CACHE = new LRUCache(6000);
  const INK_CACHE = new LRUCache(4000);

  function setOrig(el, text) {
    if (ORIGINAL_TEXT) ORIGINAL_TEXT.set(el, text);
    try { el.__tbOrig = text; } catch (_) {}
  }

  function getOrig(el) {
    if (!el) return null;
    if (ORIGINAL_TEXT) {
      const v = ORIGINAL_TEXT.get(el);
      if (typeof v === "string") return v;
    }
    if (typeof el.__tbOrig === "string") return el.__tbOrig;
    return null;
  }

  function shouldSkipTextNode(node, options) {
    const p = node.parentElement;
    if (!p) return true;

    // Skip in ignored subtrees (ancestor-aware)
    if (p.closest && p.closest(options.ignoreSelectorCombined)) return true;

    // Avoid processing inside our own wrappers (idempotency safety)
    if (p.closest && p.closest(`[${WRAPPER_ATTR}],[${VISUAL_ROOT_ATTR}]`)) return true;

    return false;
  }

  function unwrapExisting(root) {
    if (!isBrowser) return;

    const scope = (root instanceof Document) ? root : root;

    const wrappers = scope.querySelectorAll?.(`[${WRAPPER_ATTR}]`) || [];
    wrappers.forEach((w) => {
      const el = /** @type {HTMLElement} */ (w);
      const orig = getOrig(el) ?? el.textContent ?? "";
      if (ORIGINAL_TEXT) ORIGINAL_TEXT.delete(el);
      el.replaceWith(document.createTextNode(orig));
    });

    const visuals = scope.querySelectorAll?.(`[${VISUAL_ROOT_ATTR}]`) || [];
    visuals.forEach((v) => {
      const el = /** @type {HTMLElement} */ (v);
      const orig = getOrig(el) ?? el.textContent ?? "";
      if (ORIGINAL_TEXT) ORIGINAL_TEXT.delete(el);
      el.replaceWith(document.createTextNode(orig));
    });
  }

  function applyToRoot(root, options, state) {
    if (!isBrowser) return { processedElements: 0, processedTextNodes: 0 };

    // Update cache sizes if options change
    GRAPHEME_CACHE.maxEntries = Math.max(50, options.cacheMaxEntries | 0);
    AUTO_CACHE.maxEntries = Math.max(50, options.cacheMaxEntries | 0);
    WIDTH_CACHE.maxEntries = Math.max(50, options.cacheMaxEntries | 0);
    INK_CACHE.maxEntries = Math.max(50, options.cacheMaxEntries | 0);

    state.suppressMutations = true;
    try { unwrapExisting(root); } finally { state.suppressMutations = false; }

    const scope = (root instanceof Document) ? root : root;
    const targets = Array.from(scope.querySelectorAll?.(options.selector) || []);

    let processedElements = 0;
    let processedTextNodes = 0;

    for (const el of targets) {
      if (options.baseLetterSpacing != null) {
        el.style.letterSpacing = options.baseLetterSpacing;
      }
      const r = applyToElement(el, options, state);
      if (r.processedTextNodes > 0) processedElements++;
      processedTextNodes += r.processedTextNodes;
    }

    return { processedElements, processedTextNodes };
  }

  function applyToElement(rootEl, options, state) {
    // Cache computed style per actual text parent (nested font changes respected)
    const descCache = new WeakMap();

    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.length === 0) return NodeFilter.FILTER_REJECT;
        if (shouldSkipTextNode(node, options)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    /** @type {Text[]} */
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(/** @type {Text} */ (n));

    let processedTextNodes = 0;

    const caches = {
      autoCache: AUTO_CACHE,
      widthCache: WIDTH_CACHE,
      inkCache: INK_CACHE
    };

    for (const textNode of textNodes) {
      const parentEl = textNode.parentElement;
      if (!parentEl) continue;

      let desc = descCache.get(parentEl);
      if (!desc) {
        desc = getComputedFontDescriptor(parentEl);
        descCache.set(parentEl, desc);
      }

      const tt = String(desc.textTransform || "none").toLowerCase();
      const raw = textNode.nodeValue || "";

      // legacy option: actually uppercase DOM text (NOT recommended)
      if (options.compatibility.legacyTextTransformUppercase && tt === "uppercase") {
        textNode.nodeValue = raw.toUpperCase();
      }

      const raw2 = textNode.nodeValue || "";

      // Auto mode safety: optionally skip long text nodes
      if (options.method === "auto" && options.auto.maxCharsPerNode != null) {
        if (raw2.length > options.auto.maxCharsPerNode) continue;
      }

      const matchText = (tt === "uppercase") ? raw2.toUpperCase() : raw2;

      let graphemes = GRAPHEME_CACHE.get(matchText);
      if (!graphemes) {
        graphemes = splitGraphemes(matchText);
        GRAPHEME_CACHE.set(matchText, graphemes);
      }
      if (graphemes.length < 2) continue;

      const rawGraphemes = splitGraphemes(raw2);

      const built = buildKernedFragment({
        parentEl,
        graphemes,
        rawGraphemes,
        desc,
        options,
        caches
      });

      if (!built) continue;

      state.suppressMutations = true;
      try {
        if (options.mode === "semantic") {
          const wrapper = document.createElement(options.wrapperTagName);
          wrapper.setAttribute(WRAPPER_ATTR, "1");
          if (options.debug.enabled && options.debug.overlay) wrapper.classList.add("tb-debug-overlay");
          wrapper.appendChild(built.fragment);

          setOrig(wrapper, raw2);

          textNode.replaceWith(wrapper);
        } else {
          // Visual overlay mode (headline-ish). If multiline likely and singleLineOnly, fall back to semantic.
          const isMultilineLikely = !(String(desc.whiteSpace || "").includes("nowrap"));
          if (options.visual.singleLineOnly && isMultilineLikely) {
            const wrapper = document.createElement(options.wrapperTagName);
            wrapper.setAttribute(WRAPPER_ATTR, "1");
            if (options.debug.enabled && options.debug.overlay) wrapper.classList.add("tb-debug-overlay");
            wrapper.appendChild(built.fragment);
            setOrig(wrapper, raw2);
            textNode.replaceWith(wrapper);
          } else {
            const visualRoot = document.createElement("span");
            visualRoot.setAttribute(VISUAL_ROOT_ATTR, "1");

            // Source text stays semantic/selectable; hide visually
            const source = document.createElement("span");
            source.textContent = raw2;
            source.style.color = "transparent";
            source.style.webkitTextFillColor = "transparent";
            source.style.userSelect = "text";

            // Overlay kerning
            const overlay = document.createElement("span");
            overlay.className = "tb-visual-overlay";
            overlay.setAttribute("aria-hidden", "true");
            overlay.appendChild(built.fragment);

            visualRoot.appendChild(source);
            visualRoot.appendChild(overlay);

            setOrig(visualRoot, raw2);

            textNode.replaceWith(visualRoot);
          }
        }
      } finally {
        state.suppressMutations = false;
      }

      processedTextNodes++;
    }

    debugLog(!!options.debug.log, "Applied element", rootEl, { processedTextNodes });
    return { processedTextNodes };
  }

  function buildKernedFragment(args) {
    const { parentEl, graphemes, rawGraphemes, desc, options, caches } = args;

    const fragment = document.createDocumentFragment();

    const fontFamilyKey = normalizeFontFamilyKey(desc.fontFamily);
    const styleKey = `${normalizeLegacyWeight(desc.fontWeight)}-${normalizeLegacyStyle(desc.fontStyle)}`;

    const dir = (options.direction === "auto") ? desc.direction : options.direction;
    const rtlPairOrder = options.rtlPairOrder;

    const baselineEm = options.compatibility.legacyLetterSpacingFactor
      ? (desc.letterSpacingPx * 0.064)
      : safePxToEm(desc.letterSpacingPx, desc.fontSizePx);

    // This is the baseline letter-spacing we want between this grapheme and the next,
    // BEFORE adding TypeButter adjustments (library or auto).
    const baseSpacingEm = baselineEm + options.defaultSpacingEm;

    const maxAdj = options.maxAdjustEm;
    const thr = options.thresholdEm;

    const ligaturesLikelyOn = String(desc.fontVariantLigatures || "normal").toLowerCase() !== "none";

    const autoWrapAll = (options.method === "auto") ? !!options.auto.wrapAll : false;

    // For library mode, allow n-grams >= 2
    const maxNGram = Math.max(2, options.maxNGram | 0);

    for (let i = 0; i < graphemes.length; i++) {
      const gMatch = graphemes[i] ?? "";
      const gRaw = rawGraphemes[i] ?? gMatch;
      const next = graphemes[i + 1];

      // Last grapheme: plain (or wrapped if autoWrapAll)
      if (!next) {
        if (autoWrapAll) {
          const span = document.createElement(options.kernTagName || "span");
          span.className = "tb-kern";
          span.textContent = gRaw;
          span.style.letterSpacing = `${baseSpacingEm}em`;
          fragment.appendChild(span);
        } else {
          fragment.appendChild(document.createTextNode(gRaw));
        }
        continue;
      }

      // Determine pair ordering for matching
      let pairA = gMatch;
      let pairB = next;
      if (dir === "rtl" && rtlPairOrder === "visual") {
        pairA = next;
        pairB = gMatch;
      }
      const pair = `${pairA}${pairB}`;

      // Ligature skip heuristic
      if (options.respectLigatures && ligaturesLikelyOn) {
        // NOTE: this is heuristic; do not rely for complex scripts.
        if (KNOWN_LIGATURE_PAIRS.has(pair)) {
          if (autoWrapAll) {
            const span = document.createElement(options.kernTagName || "span");
            span.className = "tb-kern";
            span.textContent = gRaw;
            span.style.letterSpacing = `${baseSpacingEm}em`;
            fragment.appendChild(span);
          } else {
            fragment.appendChild(document.createTextNode(gRaw));
          }
          continue;
        }
      }

      let deltaEm = null;

      if (options.method === "library") {
        // n-gram lookup uses logical order. For rtl/visual, fall back to pair-only.
        if (dir === "rtl" && rtlPairOrder === "visual") {
          // pair-only fallback against tables
          deltaEm = resolveLibraryAdjustmentEm(options.library, fontFamilyKey, styleKey, [pairA, pairB], 0, 2);
        } else {
          deltaEm = resolveLibraryAdjustmentEm(options.library, fontFamilyKey, styleKey, graphemes, i, maxNGram);
        }
      } else if (options.method === "auto") {
        deltaEm = computeAutoDeltaEm(parentEl, desc, options, gMatch, next, baseSpacingEm, caches);
      } else {
        deltaEm = null;
      }

      // If no adjustment, either wrap baseline (autoWrapAll) or emit raw text.
      if (deltaEm == null || !Number.isFinite(deltaEm)) {
        if (autoWrapAll) {
          const span = document.createElement(options.kernTagName || "span");
          span.className = "tb-kern";
          span.textContent = gRaw;
          span.style.letterSpacing = `${baseSpacingEm}em`;
          fragment.appendChild(span);
        } else {
          fragment.appendChild(document.createTextNode(gRaw));
        }
        continue;
      }

      const clamped = clamp(deltaEm, -maxAdj, maxAdj);
      const keep = autoWrapAll || Math.abs(clamped) >= thr;

      if (!keep) {
        fragment.appendChild(document.createTextNode(gRaw));
        continue;
      }

      const finalEm = baseSpacingEm + clamped;

      const span = document.createElement(options.kernTagName || "span");
      span.className = "tb-kern";
      span.textContent = gRaw;
      span.style.letterSpacing = `${finalEm}em`;

      if (options.debug.enabled && options.debug.overlay) {
        span.setAttribute("data-tb-delta", `${clamped >= 0 ? "+" : ""}${clamped.toFixed(3)}em`);
      }

      fragment.appendChild(span);
    }

    return { fragment };
  }

  // ------------------------------------------------------------
  // Enable gate (breakpoint/function)
  // ------------------------------------------------------------
  function resolveEnabled(enabled, root) {
    if (!isBrowser) return true;
    const width = window.innerWidth;

    if (typeof enabled === "boolean") return enabled;
    if (typeof enabled === "function") return !!enabled({ width, root });

    if (enabled && typeof enabled === "object") {
      const minOk = enabled.minWidth == null || width >= enabled.minWidth;
      const maxOk = enabled.maxWidth == null || width <= enabled.maxWidth;
      return minOk && maxOk;
    }
    return true;
  }

  // ------------------------------------------------------------
  // Controller (public API)
  // ------------------------------------------------------------
  const DEFAULTS = Object.freeze({
    root: isBrowser ? document : null,
    selector: "[data-typebutter]",
    enabled: true,

    method: "library", // "library" | "auto" | "none"
    mode: "semantic",  // "semantic" | "visual"
    wrapperTagName: "span",
    kernTagName: "span", // per-glyph wrapper tag (legacy TypeButter used <kern>)

    library: {},

    // Library n-gram length (>=2). Longest match wins.
    maxNGram: 2,

    defaultSpacingEm: 0,
    maxAdjustEm: 0.12,
    thresholdEm: 0.002,

    baseLetterSpacing: null,

    respectLigatures: true,

    direction: "auto",       // "auto" | "ltr" | "rtl"
    rtlPairOrder: "logical", // "logical" | "visual" (best-effort)

    observe: true,
    mutation: {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "dir", "lang"],
      debounceMs: 80
    },
    resize: {
      debounceMs: 80
    },

    fontLoading: {
      strategy: "ready", // "ready" | "load"
      timeoutMs: 4000,
      sampleText: "AVATAR To WA fi fl"
    },

    cacheMaxEntries: 2000,

    // Ignore subtree selector (ancestor-aware via closest())
    ignoreSelector: "[data-typebutter-ignore],script,style,textarea,input,select,option,pre,code,kbd,samp,noscript,svg,canvas",
    ignoreSelectorCombined: "", // computed

    auto: {
      // "advanceKern" = just reproduce Canvas-measured native kerning advances
      // "inkBand" = raster ink edge banding (headline-oriented)
      algorithm: "inkBand",

      // baseline used for ink gap computation
      // "none" = assume no kerning baseline
      // "native" = include Canvas-measured native kernPx as baseline
      baseline: "native",

      // headline safety knobs
      maxCharsPerNode: 120,
      wrapAll: false,
      onlyBasicLatin: true,
      allowGrapheme: null,
      skipWhitespacePairs: true,

      // rtl behavior
      rtl: "skip", // "skip" | "best-effort"

      // desired band (in em)
      minGapEm: 0.02,
      maxGapEm: 0.10,

      // raster sampling
      rasterSupersample: 6,
      rasterAlphaThreshold: 8
    },

    visual: {
      singleLineOnly: true
    },

    debug: {
      enabled: false,
      log: false,
      overlay: false
    },

    compatibility: {
      legacyLetterSpacingFactor: false,
      legacyTextTransformUppercase: false
    },

    onApplied: noop
  });

  function normalizeOptions(options) {
    const o = options || {};
    const merged = {
      ...DEFAULTS,
      ...o,
      mutation: { ...DEFAULTS.mutation, ...(o.mutation || {}) },
      resize: { ...DEFAULTS.resize, ...(o.resize || {}) },
      fontLoading: { ...DEFAULTS.fontLoading, ...(o.fontLoading || {}) },
      auto: { ...DEFAULTS.auto, ...(o.auto || {}) },
      visual: { ...DEFAULTS.visual, ...(o.visual || {}) },
      debug: { ...DEFAULTS.debug, ...(o.debug || {}) },
      compatibility: { ...DEFAULTS.compatibility, ...(o.compatibility || {}) }
    };

    merged.maxAdjustEm = Math.max(0, +merged.maxAdjustEm || 0);
    merged.thresholdEm = Math.max(0, +merged.thresholdEm || 0);
    merged.cacheMaxEntries = Math.max(50, merged.cacheMaxEntries | 0);

    merged.maxNGram = Math.max(2, merged.maxNGram | 0);

    if (!merged.wrapperTagName) merged.wrapperTagName = "span";
    if (!merged.kernTagName) merged.kernTagName = "span";

    // Normalize ignore selector
    const baseIgnore = merged.ignoreSelector || DEFAULTS.ignoreSelector;
    merged.ignoreSelectorCombined = `${baseIgnore},[${WRAPPER_ATTR}],[${VISUAL_ROOT_ATTR}]`;

    merged.auto.rasterSupersample = clamp(merged.auto.rasterSupersample | 0, 1, 10);
    merged.auto.rasterAlphaThreshold = clamp(merged.auto.rasterAlphaThreshold | 0, 0, 255);

    if (merged.debug.enabled) ensureDebugStyles();
    return merged;
  }

  class TypeButterController {
    constructor(options) {
      this._options = normalizeOptions(options);
      this._destroyed = false;

      this._mo = null;
      this._ro = null;

      this._applying = false;
      this._pending = false;
      this._lastApplyToken = 0;

      this._state = { suppressMutations: false };

      if (this._options.observe) this._attachObservers();
    }

    getOptions() { return this._options; }

    updateOptions(next) {
      if (this._destroyed) return;
      const prevObserve = this._options.observe;
      this._options = normalizeOptions({ ...this._options, ...(next || {}) });

      if (prevObserve !== this._options.observe) {
        this._detachObservers();
        if (this._options.observe) this._attachObservers();
      }
    }

    async apply() {
      if (this._destroyed || !isBrowser) return;

      const roots = asArray(this._options.root || document);
      for (const r of roots) {
        if (!resolveEnabled(this._options.enabled, r)) {
          this.reset();
          return;
        }
      }

      if (this._applying) {
        this._pending = true;
        return;
      }

      const token = ++this._lastApplyToken;
      this._applying = true;

      const t0 = now();
      try {
        await awaitFontsReady(roots, this._options);

        let processedElements = 0;
        let processedTextNodes = 0;

        for (const root of roots) {
          if (!resolveEnabled(this._options.enabled, root)) continue;
          const res = applyToRoot(root, this._options, this._state);
          processedElements += res.processedElements;
          processedTextNodes += res.processedTextNodes;
        }

        if (token === this._lastApplyToken) {
          this._options.onApplied({ processedElements, processedTextNodes });
        }

        debugLog(!!this._options.debug.log, "apply() done", {
          processedElements,
          processedTextNodes,
          ms: (now() - t0).toFixed(2)
        });
      } finally {
        this._applying = false;
        if (this._pending) {
          this._pending = false;
          requestAnimationFrame(() => this.apply());
        }
      }
    }

    reset() {
      if (this._destroyed || !isBrowser) return;
      const roots = asArray(this._options.root || document);
      this._state.suppressMutations = true;
      try {
        for (const root of roots) unwrapExisting(root);
      } finally {
        this._state.suppressMutations = false;
      }
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this._detachObservers();
      this.reset();
    }

    _attachObservers() {
      if (!isBrowser) return;
      const roots = asArray(this._options.root || document);
      const mutation = this._options.mutation;

      const schedule = this._debouncedRAF(mutation.debounceMs);

      this._mo = new MutationObserver((records) => {
        if (this._destroyed) return;
        if (this._state.suppressMutations) return;
        if (this._applying) return;

        // Ignore mutations inside our wrappers
        for (const r of records) {
          const t = r.target && r.target.nodeType === 1 ? r.target : r.target?.parentElement;
          if (t && t.closest && t.closest(`[${WRAPPER_ATTR}],[${VISUAL_ROOT_ATTR}]`)) return;
        }
        schedule();
      });

      for (const root of roots) {
        const target = (root instanceof Document) ? root.documentElement : root;
        if (!target) continue;
        this._mo.observe(target, {
          subtree: !!mutation.subtree,
          childList: !!mutation.childList,
          characterData: !!mutation.characterData,
          attributes: !!mutation.attributes,
          attributeFilter: mutation.attributeFilter || undefined
        });
      }

      if (typeof ResizeObserver !== "undefined") {
        const resize = this._options.resize;
        const scheduleResize = this._debouncedRAF(resize.debounceMs);

        this._ro = new ResizeObserver(() => {
          if (this._destroyed) return;
          if (this._state.suppressMutations) return;
          if (this._applying) return;
          scheduleResize();
        });

        for (const root of roots) {
          const el = (root instanceof Document) ? root.documentElement : root;
          if (el) this._ro.observe(el);
        }
      }
    }

    _detachObservers() {
      if (this._mo) this._mo.disconnect();
      if (this._ro) this._ro.disconnect();
      this._mo = null;
      this._ro = null;
    }

    _debouncedRAF(delayMs) {
      let timer = null;
      let raf = null;
      return () => {
        if (timer != null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          if (raf != null) cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => this.apply());
        }, Math.max(0, delayMs | 0));
      };
    }
  }

  // ------------------------------------------------------------
  // Global library helpers
  // ------------------------------------------------------------
  let _globalLibrary = {};

  function extendLibrary(lib) {
    // Deep merge; new values win.
    _globalLibrary = deepMerge(_globalLibrary, lib || {});
    return _globalLibrary;
  }

  function resetLibrary() { _globalLibrary = {}; }

  // ------------------------------------------------------------
  // Factory
  // ------------------------------------------------------------
  function create(options) {
    const o = normalizeOptions(options || {});
    if (!options || options.library == null) o.library = _globalLibrary;
    return new TypeButterController(o);
  }

  // ------------------------------------------------------------
  // jQuery wrapper (optional)
  // ------------------------------------------------------------
  function installJQuery(jQuery) {
    if (!jQuery || !jQuery.fn) return false;

    let jqController = null;

    jQuery.fn.typeButterReset = function () {
      resetLibrary();
      if (jqController) {
        jqController.destroy();
        jqController = null;
      }
      return this;
    };

    jQuery.fn.typeButterExtend = function (lib) {
      extendLibrary(lib);
      return this;
    };

    jQuery.fn.typeButter = function (options) {
      const settings = {
        elementName: "kern",          // legacy TypeButter used a custom tag for kerned glyphs
        "default-spacing": "0em",     // legacy default spacing
        callback: undefined,
        ...options
      };

      // Mark selection so controller selector can find it
      this.each(function () {
        jQuery(this).attr("data-typebutter-jq", "1");
      });

      const defaultSpacingEm = parseFloat(settings["default-spacing"]) || 0;

      if (!jqController) {
        jqController = create({
          selector: "[data-typebutter-jq]",
          library: _globalLibrary,
          observe: true,
          // jQuery plugin historically behaved closer to legacy math:
          compatibility: {
            legacyLetterSpacingFactor: true,
            legacyTextTransformUppercase: false
          }
        });
      }

      jqController.updateOptions({
        selector: "[data-typebutter-jq]",
        library: _globalLibrary,
        defaultSpacingEm,
        baseLetterSpacing: settings["default-spacing"],
        // elementName maps to the per-glyph wrapper tag
        kernTagName: settings.elementName || "kern",
        observe: true,
        onApplied: () => {
          if (typeof settings.callback === "function") settings.callback();
        }
      });

      jqController.apply();
      return this;
    };

    return true;
  }

  // Auto-install jQuery wrapper
  if (isBrowser) {
    const jq = window.jQuery || window.$;
    if (jq && jq.fn) installJQuery(jq);
  }

  // ------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------
  const TypeButter = {
    VERSION,

    create,
    TypeButterController,

    extendLibrary,
    resetLibrary,

    installJQuery,

    __test__: {
      LRUCache,
      splitGraphemes,
      normalizeFontFamilyKey,
      buildFontDescriptorKey,
      deepMerge
    }
  };

  return TypeButter;
});
