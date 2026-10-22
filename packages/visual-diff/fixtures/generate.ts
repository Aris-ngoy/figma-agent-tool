// Regenerates the stored PNG fixtures: `bun fixtures/generate.ts`.
// A 393×852pt phone screen as the 1x design, and 3x "device captures" of it
// with one kind of difference each.
import { join } from "node:path";
import { PNG } from "pngjs";

type Rect = { x: number; y: number; width: number; height: number };
type Shape = Rect & { color: string };

const screen = { width: 393, height: 852 };

const clock: Shape = { x: 24, y: 18, width: 54, height: 16, color: "#000000" };
const battery: Shape = {
	x: 340,
	y: 20,
	width: 28,
	height: 12,
	color: "#000000",
};
const header: Shape = { x: 0, y: 59, width: 393, height: 56, color: "#1e3a8a" };
const card: Shape = {
	x: 24,
	y: 140,
	width: 345,
	height: 200,
	color: "#6b7280",
};
const button: Shape = {
	x: 24,
	y: 700,
	width: 345,
	height: 52,
	color: "#2563eb",
};
const homeIndicator: Shape = {
	x: 130,
	y: 838,
	width: 134,
	height: 5,
	color: "#000000",
};

const scene = [clock, battery, header, card, button, homeIndicator];

function render(
	shapes: Shape[],
	scale: number,
	size: { width: number; height: number } = screen,
): Buffer {
	const png = new PNG({
		width: size.width * scale,
		height: size.height * scale,
	});
	png.data.fill(255);
	for (const shape of shapes) {
		const [r, g, b] = [1, 3, 5].map((i) =>
			Number.parseInt(shape.color.slice(i, i + 2), 16),
		) as [number, number, number];
		const right = Math.min((shape.x + shape.width) * scale, png.width);
		const bottom = Math.min((shape.y + shape.height) * scale, png.height);
		for (let y = shape.y * scale; y < bottom; y++) {
			for (let x = shape.x * scale; x < right; x++) {
				const i = (y * png.width + x) * 4;
				png.data[i] = r;
				png.data[i + 1] = g;
				png.data[i + 2] = b;
			}
		}
	}
	return PNG.sync.write(png);
}

const replace = (from: Shape, to: Partial<Shape>) =>
	scene.map((shape) => (shape === from ? { ...shape, ...to } : shape));

const fixtures: Record<string, Buffer> = {
	"design.png": render(scene, 1),
	"actual-identical.png": render(scene, 3),
	"actual-shifted.png": render(replace(card, { y: card.y + 16 }), 3),
	"actual-recolored.png": render(replace(button, { color: "#dc2626" }), 3),
	"actual-status-bar.png": render(
		replace(clock, { width: 40 }).map((shape) =>
			shape === battery ? { ...shape, width: 18 } : shape,
		),
		3,
	),
	"actual-wrong-aspect.png": render(scene, 3, { width: 393, height: 393 }),
};

for (const [name, bytes] of Object.entries(fixtures)) {
	await Bun.write(join(import.meta.dir, name), bytes);
}
