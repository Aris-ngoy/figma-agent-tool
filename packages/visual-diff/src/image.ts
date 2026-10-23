// RGBA image decoding, encoding and resampling.
import { PNG } from "pngjs";
import { ComparisonError } from "./errors";

export type Image = { width: number; height: number; data: Uint8Array };

export function decodePng(bytes: Uint8Array, label: string): Image {
	try {
		const { width, height, data } = PNG.sync.read(Buffer.from(bytes));
		return { width, height, data };
	} catch (error) {
		throw new ComparisonError(
			`The ${label} image is not a valid PNG (${(error as Error).message}).`,
		);
	}
}

export function encodePng({ width, height, data }: Image): Uint8Array {
	const png = new PNG({ width, height });
	png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	// The Sub filter and default compression level keep large screenshots fast
	// to write; pngjs's defaults (adaptive filtering, level 9) are ~10x slower.
	return PNG.sync.write(png, { filterType: 1, deflateLevel: 6 });
}

/**
 * Resamples by area coverage: each target pixel averages the source pixels it
 * covers. Integer upscales replicate pixels exactly, so a 1x design scaled to
 * 3x matches a crisp 3x render; downscales average instead of aliasing.
 */
export function resize(image: Image, width: number, height: number): Image {
	if (image.width === width && image.height === height) return image;
	const columns = coverage(image.width, width);
	const rows = coverage(image.height, height);

	// Premultiply so transparent pixels don't bleed their color into neighbours.
	const source = new Float64Array(image.data.length);
	for (let i = 0; i < image.data.length; i += 4) {
		const alpha = (image.data[i + 3] as number) / 255;
		source[i] = (image.data[i] as number) * alpha;
		source[i + 1] = (image.data[i + 1] as number) * alpha;
		source[i + 2] = (image.data[i + 2] as number) * alpha;
		source[i + 3] = image.data[i + 3] as number;
	}

	const horizontal = new Float64Array(width * image.height * 4);
	for (let y = 0; y < image.height; y++) {
		const sourceRow = y * image.width;
		for (let x = 0; x < width; x++) {
			const { start, weights } = columns[x] as Span;
			const out = (y * width + x) * 4;
			for (let k = 0; k < weights.length; k++) {
				const weight = weights[k] as number;
				const src = (sourceRow + start + k) * 4;
				for (let c = 0; c < 4; c++) {
					horizontal[out + c] =
						(horizontal[out + c] as number) +
						(source[src + c] as number) * weight;
				}
			}
		}
	}

	const data = new Uint8Array(width * height * 4);
	const pixel = new Float64Array(4);
	for (let y = 0; y < height; y++) {
		const { start, weights } = rows[y] as Span;
		for (let x = 0; x < width; x++) {
			pixel.fill(0);
			for (let k = 0; k < weights.length; k++) {
				const weight = weights[k] as number;
				const src = ((start + k) * width + x) * 4;
				for (let c = 0; c < 4; c++) {
					pixel[c] =
						(pixel[c] as number) + (horizontal[src + c] as number) * weight;
				}
			}
			const alpha = pixel[3] as number;
			const unpremultiply = alpha > 0 ? 255 / alpha : 0;
			const out = (y * width + x) * 4;
			for (let c = 0; c < 3; c++) {
				data[out + c] = Math.round((pixel[c] as number) * unpremultiply);
			}
			data[out + 3] = Math.round(alpha);
		}
	}
	return { width, height, data };
}

type Span = { start: number; weights: number[] };

/** For each target index, the source indices it covers and their weights. */
function coverage(sourceSize: number, targetSize: number): Span[] {
	const step = sourceSize / targetSize;
	return Array.from({ length: targetSize }, (_, target) => {
		const from = target * step;
		const to = from + step;
		const start = Math.floor(from);
		const end = Math.min(Math.ceil(to), sourceSize);
		const weights: number[] = [];
		for (let s = start; s < end; s++) {
			weights.push((Math.min(to, s + 1) - Math.max(from, s)) / step);
		}
		return { start, weights };
	});
}
