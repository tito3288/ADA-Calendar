import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// Packaging only: the full lockup retains the supplied PNG's exact alpha mask;
// the dog artwork is generated separately and only resized for browser formats.
const root = path.resolve(import.meta.dirname, "..");
const brandDir = path.join(root, "public/brand");
await mkdir(brandDir, { recursive: true });
const logo = await readFile(path.join(root, "assets/brand/alpha-dog-white.png"));
const { width, height } = await sharp(logo).metadata();
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><mask id="logo" mask-type="alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${logo.toString("base64")}"/></mask></defs><rect width="${width}" height="${height}" fill="#bde4cf" mask="url(#logo)"/></svg>\n`;
await writeFile(path.join(brandDir, "alpha-dog-mint.svg"), logoSvg);

const dogPath = path.join(root, "assets/brand/dog-icon-source.png");
const dog = sharp(dogPath);
await dog.clone().resize(512, 512).png().toFile(path.join(root, "src/app/icon.png"));
await dog.clone().resize(180, 180).png().toFile(path.join(root, "src/app/apple-icon.png"));
await dog.clone().resize(512, 512).png().toFile(path.join(brandDir, "dog-icon.png"));

// ICO supports PNG payloads. Supply native small sizes rather than a huge image
// that every browser has to downsample independently.
const sizes = [16, 32, 48];
const frames = await Promise.all(sizes.map((size) => dog.clone().resize(size, size).ensureAlpha().png().toBuffer()));
const header = Buffer.alloc(6 + frames.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
for (let i = 0; i < frames.length; i++) {
  const entry = 6 + i * 16;
  header[entry] = sizes[i];
  header[entry + 1] = sizes[i];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frames[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += frames[i].length;
}
await writeFile(path.join(root, "src/app/favicon.ico"), Buffer.concat([header, ...frames]));
const icon = await readFile(path.join(brandDir, "dog-icon.png"));
await writeFile(path.join(root, "public/icon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><image width="512" height="512" href="data:image/png;base64,${icon.toString("base64")}"/></svg>\n`);
console.log("Prepared mint logo, dog icon, Apple touch icon, and 16/32/48px favicon.");
