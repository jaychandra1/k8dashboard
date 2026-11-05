// Save content as a local file through a temporary link. Browsers download it;
// the desktop app shows its "Save as" dialog.

/** data: string, Blob, or bytes (Uint8Array / ArrayBuffer). */
export function downloadFile(data, filename, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the download has started (immediately would cancel it).
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
