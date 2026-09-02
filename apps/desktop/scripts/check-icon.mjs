#!/usr/bin/env node
/**
 * Check the icon before a package build depends on it.
 *
 * electron-builder is forgiving here in the worst way: given no icon it uses
 * Electron's default and says so in one line among hundreds, which is how the
 * first builds shipped with the generic icon without anyone noticing. This
 * fails instead, and says exactly what is wrong.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../build/icon.png", import.meta.url));

/**
 * Read a PNG's dimensions from its header.
 *
 * A PNG always opens with an 8-byte signature followed by the IHDR chunk,
 * whose first two fields are width and height as big-endian 32-bit integers.
 * That is all this needs, so it needs no image library.
 */
function pngSize(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    return undefined;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

let bytes;
try {
  bytes = await readFile(path);
} catch {
  console.error(
    `\nNo app icon at apps/desktop/build/icon.png\n\n` +
      `  Save the logo there as a square 1024x1024 PNG, then build again.\n` +
      `  See apps/desktop/build/README.md.\n`
  );
  process.exit(1);
}

const size = pngSize(bytes);
if (size === undefined) {
  console.error("\napps/desktop/build/icon.png is not a PNG. Export it as PNG and try again.\n");
  process.exit(1);
}
if (size.width !== size.height) {
  console.error(
    `\nThe app icon must be square; this one is ${size.width}x${size.height}.\n` +
      `Both platforms stretch a non-square icon rather than padding it.\n`
  );
  process.exit(1);
}
if (size.width < 512) {
  console.error(
    `\nThe app icon is ${size.width}x${size.width}; macOS needs at least 512x512 ` +
      `and looks best given 1024x1024.\n`
  );
  process.exit(1);
}

console.log(`app icon: ${size.width}x${size.height} PNG — good`);
