/** The images can't be compared as given; the message says why and what to do. */
export class ComparisonError extends Error {
	override name = "ComparisonError";
}

/** The design and actual images are different shapes, so a score would be meaningless. */
export class AspectRatioMismatchError extends ComparisonError {
	override name = "AspectRatioMismatchError";
}
