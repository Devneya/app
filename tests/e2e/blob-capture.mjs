/* global URL, Blob, window, btoa, console */

// Capture locally created bytes before a short-lived worker or frame disappears.
// Return the original URL synchronously; do not pause or replay provider work.
export async function installBlobCapture(page, receive) {
  await page.exposeBinding("__devneyaCaptureBlob", (_source, payload) => receive(payload));
  await page.addInitScript(() => {
    const original = URL.createObjectURL;
    URL.createObjectURL = function (...args) {
      const url = Reflect.apply(original, this, args);
      const blob = args[0];
      if (blob instanceof Blob) {
        blob.arrayBuffer().then(buffer => {
          const bytes = new Uint8Array(buffer);
          const parts = [];
          for (let offset = 0; offset < bytes.length; offset += 8192) {
            parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
          }
          return window.__devneyaCaptureBlob({ url, contentType: blob.type, base64: btoa(parts.join("")) });
        }).catch(error => window.__devneyaCaptureBlob({ url,
          error: { name: error.name, message: error.message, stack: error.stack } })
          .catch(bindingError => console.error("Blob source capture failed", { url, error, bindingError })));
      }
      return url;
    };
  });
}
