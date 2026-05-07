import QRCode from "qrcode";

/**
 * Render a QR code as an SVG string for the given URL. Caller can drop the
 * string into HTML via dangerouslySetInnerHTML or inline `<img src>` after
 * base64-encoding. SVG keeps the QR sharp at any size.
 */
export async function qrSvgFor(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    // Without `width`, the qrcode lib emits an SVG carrying only viewBox.
    // In the CaptureModal that collapses to 0×0 because the wrapper
    // doesn't size flex children. Force width/height attrs on the root.
    width: 200,
  });
}
