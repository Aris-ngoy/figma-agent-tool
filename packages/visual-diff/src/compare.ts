// The visual-diff entry point: align a design image to an actual (device)
// image, mask what shouldn't count, pixel-diff the rest and report where the
// two disagree. Pure: bytes in, report out, no Figma or device knowledge.
import pixelmatch from "pixelmatch";
import { AspectRatioMismatchError, ComparisonError } from "./errors";
import { decodePng, encodePng, type Image, resize } from "./image";
import { clusterRegions, type MismatchRegion } from "./regions";

export type Rect = { x: number; y: number; width: number; height: number };

export type Platform = "ios" | "android" | "none";

/**
 * Status bar / top inset and home indicator / bottom inset per platform, in
 * points. Generous enough to cover notches, the Dynamic Island, punch-hole
 * cameras and three-button navigation.
 */
export const PLATFORM_INSETS: Record<
	Platform,
	{ top: number; bottom: number }
> = {
	ios: { top: 59, bottom: 34 },
	android: { top: 48, bottom: 48 },
	none: { top: 0, bottom: 0 },
};

export type CompareOptions = {
	/**
	 * Device pixels per design pixel, or "auto" to derive it from the widths
	 * (a 393px design and a 1179px capture give 3).
	 */
	scale?: "auto" | number;
	/** Masks the platform's status bar and home indicator. */
	platform?: Platform;
	/** Extra rectangles to ignore, in design image coordinates. */
	ignoreRegions?: Rect[];
	/** Per-pixel color distance (0–1) below which pixels count as equal. */
	threshold?: number;
	/** Don't count pixels that look like anti-aliasing differences. */
	detectAntiAliasing?: boolean;
	/** The comparison passes when at most this percentage of pixels differs. */
	mismatchBudget?: number;
	/** How far (as a fraction) the aspect ratios may differ before failing fast. */
	aspectTolerance?: number;
};

export const DEFAULT_COMPARE_OPTIONS = {
	scale: "auto",
	platform: "none",
	ignoreRegions: [],
	threshold: 0.1,
	detectAntiAliasing: true,
	mismatchBudget: 0.5,
	aspectTolerance: 0.01,
} as const satisfies Required<CompareOptions>;

export type AppliedMask = Rect & {
	kind: "status-bar" | "home-indicator" | "ignore-region";
};

export type ComparisonReport = {
	pass: boolean;
	/** Mismatched pixels as a percentage of the unmasked pixels. */
	mismatchPercent: number;
	mismatchBudget: number;
	mismatchedPixels: number;
	/** Unmasked pixels, the denominator of `mismatchPercent`. */
	comparedPixels: number;
	/** The size both images were compared at: the actual image's size. */
	dimensions: { width: number; height: number };
	/** How the design was scaled to line up with the actual image. */
	scale: { x: number; y: number };
	/** Clustered mismatches, largest first, in aligned (actual) pixels. */
	regions: MismatchRegion[];
	/** Masks applied, in aligned (actual) pixels. */
	masks: AppliedMask[];
	/** Red: mismatch, yellow: anti-aliasing, blue: masked. */
	diffPng: Uint8Array;
};

const DIFF_COLOR: [number, number, number] = [255, 0, 0];
const MASK_TINT: [number, number, number] = [96, 165, 250];

export function compare(
	designPng: Uint8Array,
	actualPng: Uint8Array,
	options: CompareOptions = {},
): ComparisonReport {
	const settings = { ...DEFAULT_COMPARE_OPTIONS, ...options };
	const design = decodePng(designPng, "design");
	const actual = decodePng(actualPng, "actual");
	checkAlignment(design, actual, settings.scale, settings.aspectTolerance);

	const { width, height } = actual;
	const aligned = resize(design, width, height);
	const scale = { x: width / design.width, y: height / design.height };

	const masks = collectMasks(design, settings, scale);
	const ignoreMask = new Uint8Array(width * height);
	for (const mask of masks) {
		for (let y = mask.y; y < mask.y + mask.height; y++) {
			ignoreMask.fill(1, y * width + mask.x, y * width + mask.x + mask.width);
		}
	}
	const maskedPixels = ignoreMask.reduce((sum, value) => sum + value, 0);

	const diff = new Uint8Array(width * height * 4);
	const mismatchedPixels = pixelmatch(
		aligned.data,
		actual.data,
		diff,
		width,
		height,
		{
			threshold: settings.threshold,
			includeAA: !settings.detectAntiAliasing,
			diffColor: DIFF_COLOR,
			ignoreMask,
		},
	);

	// Mismatched pixels are the ones pixelmatch painted in DIFF_COLOR; its
	// grayscale backdrop and yellow anti-aliasing pixels never are.
	const mismatchMap = new Uint8Array(width * height);
	for (let i = 0; i < mismatchMap.length; i++) {
		const pos = i * 4;
		mismatchMap[i] = Number(
			diff[pos] === DIFF_COLOR[0] &&
				diff[pos + 1] === DIFF_COLOR[1] &&
				diff[pos + 2] === DIFF_COLOR[2],
		);
		if (ignoreMask[i]) {
			for (let c = 0; c < 3; c++) {
				diff[pos + c] = Math.round(
					((diff[pos + c] as number) + (MASK_TINT[c] as number)) / 2,
				);
			}
		}
	}

	const comparedPixels = width * height - maskedPixels;
	const ratio =
		comparedPixels === 0 ? 0 : (mismatchedPixels / comparedPixels) * 100;
	return {
		pass: ratio <= settings.mismatchBudget,
		mismatchPercent: Math.round(ratio * 1000) / 1000,
		mismatchBudget: settings.mismatchBudget,
		mismatchedPixels,
		comparedPixels,
		dimensions: { width, height },
		scale,
		regions: clusterRegions(mismatchMap, width, height),
		masks,
		diffPng: encodePng({ width, height, data: diff }),
	};
}

function checkAlignment(
	design: Image,
	actual: Image,
	scale: "auto" | number,
	tolerance: number,
) {
	const size = (image: Image) => `${image.width}×${image.height}`;
	const designAspect = design.width / design.height;
	const actualAspect = actual.width / actual.height;
	const aspectDelta = Math.abs(designAspect - actualAspect) / actualAspect;
	if (aspectDelta > tolerance) {
		throw new AspectRatioMismatchError(
			`The design (${size(design)}, aspect ${designAspect.toFixed(3)}) and the ` +
				`actual image (${size(actual)}, aspect ${actualAspect.toFixed(3)}) ` +
				`differ in aspect ratio by ${(aspectDelta * 100).toFixed(1)}%, beyond ` +
				`the ${tolerance * 100}% tolerance. Check that you compared the right ` +
				"frame against the right device screen.",
		);
	}
	if (scale === "auto") return;
	const expected = {
		width: design.width * scale,
		height: design.height * scale,
	};
	const off = (expectedSize: number, actualSize: number) =>
		Math.abs(expectedSize - actualSize) / actualSize > tolerance;
	if (
		off(expected.width, actual.width) ||
		off(expected.height, actual.height)
	) {
		throw new ComparisonError(
			`At scale ${scale}, the ${size(design)} design should line up with a ` +
				`${Math.round(expected.width)}×${Math.round(expected.height)} image, ` +
				`but the actual image is ${size(actual)}. Check the device pixel ` +
				'ratio, or use scale "auto".',
		);
	}
}

function collectMasks(
	design: Image,
	{
		platform,
		ignoreRegions,
	}: { platform: Platform; ignoreRegions: readonly Rect[] },
	scale: { x: number; y: number },
): AppliedMask[] {
	const { top, bottom } = PLATFORM_INSETS[platform];
	const inDesign: AppliedMask[] = [
		{ kind: "status-bar", x: 0, y: 0, width: design.width, height: top },
		{
			kind: "home-indicator",
			x: 0,
			y: design.height - bottom,
			width: design.width,
			height: bottom,
		},
		...ignoreRegions.map((region) => ({
			kind: "ignore-region" as const,
			...region,
		})),
	];
	const width = Math.round(design.width * scale.x);
	const height = Math.round(design.height * scale.y);
	return inDesign.flatMap(({ kind, ...rect }) => {
		// Scale outwards so a mask always covers every pixel it touches.
		const left = clamp(Math.floor(rect.x * scale.x), width);
		const topEdge = clamp(Math.floor(rect.y * scale.y), height);
		const right = clamp(Math.ceil((rect.x + rect.width) * scale.x), width);
		const bottomEdge = clamp(
			Math.ceil((rect.y + rect.height) * scale.y),
			height,
		);
		if (right <= left || bottomEdge <= topEdge) return [];
		return [
			{
				kind,
				x: left,
				y: topEdge,
				width: right - left,
				height: bottomEdge - topEdge,
			},
		];
	});
}

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
