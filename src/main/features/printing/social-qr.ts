import qrcode from 'qrcode-generator';

// Preserve UTF-8 URLs rather than the library's default single-byte encoding.
qrcode.stringToBytes = (value: string) =>
  Array.from(Buffer.from(value, 'utf8'));

export function createSocialQrDataUrl(url: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(url, 'Byte');
  qr.make();
  return qr.createDataURL(4, 16);
}
