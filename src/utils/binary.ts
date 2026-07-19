/**
 * Binary conversion helpers using the existing browser-native algorithms.
 */

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await blobToDataUrl(blob);
  return dataUrl.split(',')[1] || dataUrl;
}

export function base64ToBlob(base64: string, mimeType: string = 'application/octet-stream'): Blob {
  const binary = atob(base64);
  let index = binary.length;
  const bytes = new Uint8Array(index);

  while (index--) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(',');
  const mimeMatch = parts[0] ? parts[0].match(/:(.*?);/) : null;
  const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const base64 = parts.length > 1 ? parts[1] : parts[0];

  return base64ToBlob(base64, mimeType);
}