// Robust sanitizer to convert colorized/highlighted HTML back into plain HCL text.
// Ensures no HTML or inline style fragments are persisted into file content.
//
// BUG-007 fix: the previous implementation used div.innerHTML = input which is a
// well-known DOM-based XSS vector — assigning user-controlled HTML to innerHTML causes
// the browser to parse and potentially execute event-handler payloads (e.g.
// <img onerror=...>, <svg onload=...>) before textContent is read. Replaced with
// DOMParser (which does NOT execute scripts or fire event handlers) for safe parsing,
// with a pure regex fallback for environments without DOMParser.

export default function sanitizeHcl(input) {
  if (!input) return '';
  // Fast path: if no HTML-ish content, skip expensive DOM parsing
  if (!/<[a-z]|&[a-z]+;|style=/i.test(input)) {
    return input.replace(/\n{3,}/g, '\n\n').trim();
  }
  try {
    // BUG-007 fix: use DOMParser instead of innerHTML assignment.
    // DOMParser parses HTML in an inert (non-rendering) document — event handlers
    // are never executed and no resources are fetched.
    const parser = new DOMParser();
    const doc = parser.parseFromString(input, 'text/html');
    let text = doc.body ? (doc.body.textContent || doc.body.innerText || '') : '';

    // Remove any remaining HTML tags
    text = text.replace(/<[^>]+>/g, '');

    // Remove inline CSS declarations and attribute fragments that may have leaked
    text = text.replace(/(?:["']?)?color:\s*#?[A-Fa-f0-9]{3,8}\s*;?/gi, '');
    text = text.replace(/(?:["']?)?color:\s*[a-z]+\s*;?/gi, '');
    text = text.replace(/(?:["']?)?font-weight:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?font-style:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?display:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?user-select:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?text-align:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?width:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?padding[a-z-]*:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?flex[a-z-]*:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?inline-block\s*;?/gi, '');
    text = text.replace(/style=\s*["'][^"']*["']/gi, '');
    text = text.replace(/\bclass=["'][^"']*["']/gi, '');

    // Remove stray "> that remain after stripping style/span attributes
    text = text.replace(/^">\s*/gm, '');
    text = text.replace(/\s*">$/gm, '');

    // Decode common HTML entities
    text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

    // Collapse excessive blank lines and trim
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return text;
  } catch (e) {
    // Pure-regex fallback — used only in non-browser environments (SSR / Jest)
    // where DOMParser is unavailable.  In production browsers DOMParser is
    // always present, so this path should never be reached there.
    //
    // BUG-023 fix: the previous fallback stripped tags *before* decoding
    // entities, meaning double-encoded payloads like &amp;lt;script&gt; could
    // survive.  We now decode entities FIRST so every encoded variant is
    // normalised to its literal form before tag-stripping.
    let text = String(input || '');

    // Step 1: decode HTML entities (two passes to handle double-encoding)
    function decodeEntities(s) {
      return s
        .replace(/&amp;/gi,  '&')
        .replace(/&lt;/gi,   '<')
        .replace(/&gt;/gi,   '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi,  "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&#([0-9]+);/gi,     (_, d) => String.fromCharCode(parseInt(d, 10)));
    }
    text = decodeEntities(decodeEntities(text));

    // Step 2: strip all HTML tags
    text = text.replace(/<[^>]+>/g, '');

    // Step 3: strip inline CSS fragments
    text = text.replace(/(?:["']?)?color:\s*#?[A-Fa-f0-9]{3,8}\s*;?/gi, '');
    text = text.replace(/(?:["']?)?color:\s*[a-z]+\s*;?/gi, '');
    text = text.replace(/(?:["']?)?font-weight:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?font-style:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?display:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?user-select:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?text-align:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?width:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?padding[a-z-]*:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?flex[a-z-]*:\s*[^;"'<>\n]+;?/gi, '');
    text = text.replace(/(?:["']?)?inline-block\s*;?/gi, '');
    text = text.replace(/style=\s*["'][^"']*["']/gi, '');
    text = text.replace(/\bclass=["'][^"']*["']/gi, '');
    text = text.replace(/^">\s*/gm, '');
    text = text.replace(/\s*">$/gm, '');
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return text;
  }
}
