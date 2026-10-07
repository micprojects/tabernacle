import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

export function screenshotFiles(fixture) {
  return fixture.shots.flatMap(({ file }) => [
    file,
    file.replace('.png', '.webp'),
    file.replace('.png', '-ui.png'),
    file.replace('.png', '-ui.webp'),
  ]);
}

export async function verifyScreenshots(fixture, sources, destination) {
  const report = [];
  const { scale, outputScale, sourceOrigin, sourceSize } = fixture.capture;
  for (const shot of fixture.shots) {
    const { crop, image } = shot.composition;
    const w = Math.round(image.width * outputScale);
    const h = Math.round((crop.height / crop.width) * image.width) * outputScale;
    const source = join(sources, shot.sourceFile || shot.file.replace('.png', `@${scale}x.png`));
    const metadata = await sharp(source).metadata();
    assert.equal(metadata.width, sourceSize.width * scale);
    assert.equal(metadata.height, sourceSize.height * scale);
    const expected = await sharp(source)
      .extract({
        left: (crop.left - sourceOrigin.left) * scale,
        top: (crop.top - sourceOrigin.top) * scale,
        width: crop.width * scale,
        height: crop.height * scale,
      })
      .resize(w, h)
      .ensureAlpha()
      .raw()
      .toBuffer();
    const uiFile = shot.file.replace('.png', '-ui.png');
    const ui = await sharp(join(destination, uiFile))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(ui.info.width, w + outputScale * 2);
    assert.equal(ui.info.height, h + outputScale * 2);
    assert.equal(ui.data[3], 0, `${uiFile}: corners must be transparent`);
    const border = (ui.info.width + Math.floor(ui.info.width / 2)) * 4;
    assert.deepEqual(
      [...ui.data.subarray(border, border + 4)],
      [129, 153, 141, 255],
      `${uiFile}: missing fine green border`,
    );
    // Exclude only the rounded mask and frame. The entire rectangular interior
    // must match the real capture after the exporter's normal downsampling.
    const inset = 20 * outputScale;
    for (let y = inset; y < h - inset; y++) {
      const from = (y * w + inset) * 4;
      const to = ((y + outputScale) * ui.info.width + inset + outputScale) * 4;
      assert(
        ui.data
          .subarray(to, to + (w - 2 * inset) * 4)
          .equals(expected.subarray(from, from + (w - 2 * inset) * 4)),
        `${uiFile}: UI pixels changed`,
      );
    }
    for (const file of [shot.file, uiFile]) {
      const png = await sharp(join(destination, file))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const webp = await sharp(join(destination, file.replace('.png', '.webp')))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.deepEqual(png.info, webp.info);
      if (file === shot.file) {
        assert.equal(png.info.width, fixture.capture.width * outputScale);
        assert.equal(png.info.height, fixture.capture.height * outputScale);
      }
      // Lossless WebP can discard hidden RGB values where alpha is zero.
      if (!png.data.equals(webp.data)) {
        for (let i = 0; i < png.data.length; i += 4) {
          if (!png.data[i + 3]) png.data.fill(0, i, i + 3);
          if (!webp.data[i + 3]) webp.data.fill(0, i, i + 3);
        }
        assert(png.data.equals(webp.data), `${file}: WebP is not lossless`);
      }
    }
    report.push({
      file: shot.file,
      uiWidth: ui.info.width,
      uiHeight: ui.info.height,
      crop,
      verified: true,
    });
  }
  return report;
}

export async function createScreenshotPreviews(fixture, images, destination) {
  const uiTiles = await Promise.all(
    fixture.shots.map(async (shot, i) => ({
      input: await sharp(join(images, shot.file.replace('.png', '-ui.png')))
        .resize({ width: 360, height: 460, fit: 'inside' })
        .flatten({ background: shot.composition.dark ? '#29232f' : '#ffffff' })
        .extend({
          top: 20,
          bottom: 12,
          left: 12,
          right: 12,
          background: shot.composition.dark ? '#29232f' : '#ffffff',
        })
        .png()
        .toBuffer(),
      left: (i % 3) * 400 + 8,
      top: Math.floor(i / 3) * 520 + 8,
    })),
  );
  await sharp({
    create: {
      width: 1200,
      height: Math.ceil(fixture.shots.length / 3) * 520,
      channels: 4,
      background: '#edf0ed',
    },
  })
    .composite(uiTiles)
    .png()
    .toFile(join(destination, 'contact-sheet.png'));
  const promos = await Promise.all(
    fixture.shots.map(async (shot, i) => ({
      input: await sharp(join(images, shot.file)).resize(640, 400).png().toBuffer(),
      left: (i % 2) * 640,
      top: Math.floor(i / 2) * 400,
    })),
  );
  await sharp({
    create: {
      width: 1280,
      height: Math.ceil(fixture.shots.length / 2) * 400,
      channels: 4,
      background: '#fff',
    },
  })
    .composite(promos)
    .png()
    .toFile(join(destination, 'compositions.png'));
}

// Stage all bytes before touching destinations, then roll back if a write fails.
export async function publishScreenshots(files, images, destination) {
  await mkdir(destination, { recursive: true });
  const previous = new Map(),
    updated = [];
  const prepared = await Promise.all(
    files.map(async (file) => ({ file, data: await readFile(join(images, file)) })),
  );
  for (const { file } of prepared)
    previous.set(
      file,
      await readFile(join(destination, file)).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
    );
  try {
    for (const { file, data } of prepared) {
      const path = join(destination, file);
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, data);
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      updated.push(file);
    }
  } catch (error) {
    for (const file of updated) {
      const old = previous.get(file),
        path = join(destination, file);
      if (old === null) await rm(path, { force: true });
      else await writeFile(path, old);
    }
    throw error;
  }
}
