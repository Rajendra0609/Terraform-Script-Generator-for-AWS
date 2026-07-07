// Robust clipboard copy helper used by every "Copy" button in the app.
//
// navigator.clipboard.writeText() silently REJECTS (throws, if awaited)
// in several situations that come up in real deployments, not just local
// dev over `localhost`:
//   - the page isn't served over HTTPS ("insecure context")
//   - the app is embedded in an iframe without the `clipboard-write`
//     permission policy
//   - older browsers / some in-app webviews don't implement the async
//     Clipboard API at all
//
// Any caller that did `await navigator.clipboard.writeText(text)` with no
// try/catch would surface that rejection as an uncaught error — this is
// exactly the bug reported against the Module Registry's Copy button, and
// it existed unguarded in several other panels too.
//
// copyToClipboard() tries the modern API first, falls back to the legacy
// `execCommand('copy')` approach via a hidden textarea, and resolves
// `false` (never throws) if both fail, so callers can show a friendly
// "copy it manually" message instead of an unhandled exception.
export async function copyToClipboard(text) {
  if (!text) return false;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    throw new Error('clipboard-api-unavailable');
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
