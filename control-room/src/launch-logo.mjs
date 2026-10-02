// Pure raster normalization. No environment, state, files, network or wallet access.
import sharp from 'sharp';
import { logoBytes } from './project-profile.mjs';

const MAX_UPLOAD_BYTES = 500 * 1024;
const MAX_PROFILE_BYTES = Math.floor((131072 - 'data:image/png;base64,'.length) / 4) * 3;
const fail = () => Object.assign(new Error('The logo could not be opened. Choose a PNG, JPEG, GIF or WebP image.'), { status: 400 });

export async function normalizeLaunchLogo(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw fail();
  const input = Buffer.from(bytes);
  const options = { limitInputPixels: 16_777_216, animated: false, failOn: 'error' };
  try {
    const metadata = await sharp(input, options).metadata();
    if (!['png', 'jpeg', 'gif', 'webp'].includes(metadata.format) || !metadata.width || !metadata.height) throw fail();
    for (const size of [256, 192, 128]) {
      const png = await sharp(input, options).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb').png({ compressionLevel: 9, palette: false, progressive: false }).toBuffer();
      if (png.length > MAX_PROFILE_BYTES) continue;
      const dataUrl = 'data:image/png;base64,' + png.toString('base64');
      logoBytes(dataUrl); // Enforce the existing strict CRC/chunk/RGB/pixel limits.
      return dataUrl;
    }
  } catch { throw fail(); }
  throw fail();
}
