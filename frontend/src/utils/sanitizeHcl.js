// Robust sanitizer to convert colorized/highlighted HTML back into plain HCL text.
// Ensures no HTML or inline style fragments are persisted into file content.
export default function sanitizeHcl(input) {
  if (!input) return '';
  // Fast path: if no HTML-ish content, skip expensive DOM parsing
  if (!/<[a-z]|&[a-z]+;|style=/i.test(input)) {
    return input.replace(/\n{3,}/g, '\n\n').trim();
  }
  try {
    const div = document.createElement('div');
    div.innerHTML = input;
    let text = div.textContent || div.innerText || '';

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
    let text = String(input || '').replace(/<[^>]+>/g, '');
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
    text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return text;
  }
}
