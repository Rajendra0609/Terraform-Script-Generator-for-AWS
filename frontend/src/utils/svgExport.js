/**
 * svgExport.js
 * ----------------------------------------------------------------------
 * Client-side export helpers for the AWS architecture diagram. No new
 * npm packages are introduced by this feature — everything here uses
 * browser-native APIs:
 *
 *   - SVG export:   the generated SVG string, downloaded as-is.
 *   - PNG export:   the SVG rasterized onto a <canvas> (via an off-DOM
 *                   <img>), then canvas.toBlob('image/png').
 *   - PDF export:   the same canvas re-encoded as a JPEG data URL, then
 *                   wrapped in a hand-built single-page PDF that embeds
 *                   the JPEG bytes directly as a /DCTDecode image
 *                   XObject. JPEG bytes are valid PDF image-stream
 *                   content with no further encoding/compression step,
 *                   which is what makes a dependency-free PDF encoder
 *                   possible here.
 *   - Draw.io/XML:  the generated .drawio XML string, downloaded as-is.
 */

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadSvg(svgString, filename) {
  triggerDownload(new Blob([svgString], { type: 'image/svg+xml' }), filename);
}

export function downloadDrawio(xmlString, filename) {
  triggerDownload(new Blob([xmlString], { type: 'application/xml' }), filename);
}

/** Rasterizes an SVG string onto a canvas at the given pixel scale. */
export function svgToCanvas(svgString, width, height, scale = 2) {
  return new Promise((resolve, reject) => {
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(width * scale));
        canvas.height = Math.max(1, Math.ceil(height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(url);
        resolve(canvas);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not rasterize the diagram (the browser refused to load the SVG as an image).'));
    };
    img.src = url;
  });
}

export async function downloadPng(svgString, width, height, filename, scale = 2) {
  const canvas = await svgToCanvas(svgString, width, height, scale);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG export failed (canvas.toBlob returned null).');
  triggerDownload(blob, filename);
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Assembles a minimal single-page PDF (see file header for the technique). */
function buildSinglePageImagePdf(jpegBytes, pixelW, pixelH, pageW, pageH) {
  const encoder = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = [0];
  const push = (str) => { const b = encoder.encode(str); chunks.push(b); offset += b.length; };
  const pushBytes = (b) => { chunks.push(b); offset += b.length; };

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
  ];
  const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objects.push(
    `<< /Type /XObject /Subtype /Image /Width ${pixelW} /Height ${pixelH} /ColorSpace /DeviceRGB `
    + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n__BINARY__\nendstream`
  );

  push('%PDF-1.4\n');
  objects.forEach((obj, i) => {
    offsets.push(offset);
    const num = i + 1;
    if (obj.includes('__BINARY__')) {
      const [pre, post] = obj.split('__BINARY__');
      push(`${num} 0 obj\n${pre}`);
      pushBytes(jpegBytes);
      push(post + '\nendobj\n');
    } else {
      push(`${num} 0 obj\n${obj}\nendobj\n`);
    }
  });

  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const bytes = new Uint8Array(total);
  let pos = 0;
  chunks.forEach(c => { bytes.set(c, pos); pos += c.length; });
  return bytes;
}

export async function downloadPdf(svgString, width, height, filename, scale = 2) {
  const canvas = await svgToCanvas(svgString, width, height, scale);
  const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const jpegBytes = dataUrlToBytes(jpegDataUrl);
  // PDF page sized in points, 1:1 with our SVG's own coordinate units — good
  // enough for a documentation/review export (not a print-precision layout).
  const pdfBytes = buildSinglePageImagePdf(jpegBytes, canvas.width, canvas.height, width, height);
  triggerDownload(new Blob([pdfBytes], { type: 'application/pdf' }), filename);
}
