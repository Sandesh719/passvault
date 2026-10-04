/**
 * Builds the icon sources Android needs from the one logo the project already
 * has.
 *
 * Three images rather than one, because Android's adaptive icons composite a
 * foreground over a background and then crop the result to whatever shape the
 * launcher prefers — circle, squircle, rounded square. Only the middle 66 of
 * the 108dp canvas is guaranteed to survive that crop, so a logo drawn edge to
 * edge loses its corners on most phones. The foreground here is scaled into
 * that safe zone deliberately.
 *
 * The background is the app's own `--color-ground` rather than the white the
 * template shipped: a dark mark on white looked like a different product from
 * the one that opens.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, "../../desktop/build/icon.png");
const OUT = resolve(here, "../assets");

/** Matches --color-ground in the stylesheet, so the icon and the app agree. */
const GROUND = { r: 0x0e, g: 0x11, b: 0x17, alpha: 1 };

/**
 * How much of the foreground canvas the mark fills.
 *
 * Not the safe-zone fraction: the generator already insets the foreground by
 * 16.7%, which is exactly what maps a 108dp canvas onto the 72dp a launcher
 * actually shows. Scaling for the safe zone here as well shrank the mark to
 * roughly a third of the icon. This is the margin inside that, so the logo
 * sits comfortably rather than touching the mask.
 */
const MARK_FRACTION = 0.82;

async function centred(size, markSize, background) {
  const mark = await sharp(SOURCE).resize(markSize, markSize, { fit: "contain" }).toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background }
  })
    .composite([{ input: mark, gravity: "centre" }])
    .png();
}

await mkdir(OUT, { recursive: true });

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

// Legacy launchers draw this as-is, so it carries its own background.
await (await centred(1024, Math.round(1024 * 0.78), GROUND)).toFile(`${OUT}/icon-only.png`);

// Adaptive: foreground inside the safe zone, background a flat colour.
await (await centred(1024, Math.round(1024 * MARK_FRACTION), TRANSPARENT)).toFile(
  `${OUT}/icon-foreground.png`
);
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: GROUND } })
  .png()
  .toFile(`${OUT}/icon-background.png`);

// The splash is mostly background: launchers crop it hard on tall screens.
for (const name of ["splash.png", "splash-dark.png"]) {
  await (await centred(2732, 480, GROUND)).toFile(`${OUT}/${name}`);
}

console.log(`wrote icon and splash sources to ${OUT}`);
