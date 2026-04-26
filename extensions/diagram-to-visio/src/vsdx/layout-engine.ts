import type {
	DiagramConnection,
	DiagramGroup,
	DiagramRepresentation,
	DiagramShape,
	PortDirection,
} from "../types.js";
import {
	CELL_HEIGHT,
	CELL_SPACING_H,
	CELL_SPACING_V,
	CELL_WIDTH,
	DEFAULT_PAGE_HEIGHT,
	DEFAULT_PAGE_WIDTH,
	PAGE_MARGIN,
} from "./constants.js";

export interface ShapeLayout {
	shape: DiagramShape;
	/** Center X in page coordinates (inches). */
	pinX: number;
	/** Center Y in page coordinates (inches, origin bottom-left). */
	pinY: number;
	width: number;
	height: number;
}

export interface ConnectorLayout {
	conn: DiagramConnection;
	fromX: number;
	fromY: number;
	toX: number;
	toY: number;
}

export interface GroupLayout {
	group: DiagramGroup;
	label: string;
	pinX: number;
	pinY: number;
	width: number;
	height: number;
	fillColor: string | undefined;
}

export interface PageLayout {
	pageWidth: number;
	pageHeight: number;
	shapes: ShapeLayout[];
	connectors: ConnectorLayout[];
	groups: GroupLayout[];
}

/** Compute grid dimensions from the diagram shapes. */
function computeGridSize(shapes: DiagramShape[]): { rows: number; cols: number } {
	let maxRow = 0;
	let maxCol = 0;
	for (const s of shapes) {
		const endRow = s.row + (s.rowSpan ?? 1) - 1;
		const endCol = s.column + (s.colSpan ?? 1) - 1;
		if (endRow > maxRow) {
			maxRow = endRow;
		}
		if (endCol > maxCol) {
			maxCol = endCol;
		}
	}
	return { rows: maxRow + 1, cols: maxCol + 1 };
}

/** Convert a grid (row, column) to page coordinates. Visio origin is bottom-left. */
function gridToPage(
	row: number,
	col: number,
	colSpan: number,
	rowSpan: number,
	gridRows: number,
	pageHeight: number,
): { pinX: number; pinY: number; width: number; height: number } {
	const width = colSpan * CELL_WIDTH + (colSpan - 1) * CELL_SPACING_H;
	const height = rowSpan * CELL_HEIGHT + (rowSpan - 1) * CELL_SPACING_V;

	// X: left margin + column offset + half width
	const pinX = PAGE_MARGIN + col * (CELL_WIDTH + CELL_SPACING_H) + width / 2;

	// Y: Visio origin is bottom-left, row 0 is at the top
	const topY = PAGE_MARGIN + row * (CELL_HEIGHT + CELL_SPACING_V);
	const pinY = pageHeight - topY - height / 2;

	return { pinX, pinY, width, height };
}

/** Get the connector attachment point for a shape at the given port. */
function connectorPoint(
	layout: ShapeLayout,
	port: PortDirection | undefined,
): { x: number; y: number } {
	const { pinX, pinY, width, height } = layout;
	switch (port) {
		case "top":
			return { x: pinX, y: pinY + height / 2 };
		case "bottom":
			return { x: pinX, y: pinY - height / 2 };
		case "left":
			return { x: pinX - width / 2, y: pinY };
		case "right":
			return { x: pinX + width / 2, y: pinY };
		default:
			// Default: center (Visio will auto-route)
			return { x: pinX, y: pinY };
	}
}

/** Automatically determine the best port for a connection between two shapes. */
function autoPort(from: ShapeLayout, to: ShapeLayout): { fromPort: PortDirection; toPort: PortDirection } {
	const dx = to.pinX - from.pinX;
	const dy = to.pinY - from.pinY;

	if (Math.abs(dx) > Math.abs(dy)) {
		// Primarily horizontal
		return dx > 0
			? { fromPort: "right", toPort: "left" }
			: { fromPort: "left", toPort: "right" };
	}
	// Primarily vertical (remember: Visio Y increases upward)
	return dy > 0
		? { fromPort: "top", toPort: "bottom" }
		: { fromPort: "bottom", toPort: "top" };
}

/** Compute the full page layout from a DiagramRepresentation. */
export function computeLayout(diagram: DiagramRepresentation): PageLayout {
	const { rows, cols } = computeGridSize(diagram.shapes);

	// Compute page dimensions to fit all shapes
	const contentWidth = cols * CELL_WIDTH + (cols - 1) * CELL_SPACING_H;
	const contentHeight = rows * CELL_HEIGHT + (rows - 1) * CELL_SPACING_V;
	const pageWidth = Math.max(DEFAULT_PAGE_WIDTH, contentWidth + PAGE_MARGIN * 2);
	const pageHeight = Math.max(DEFAULT_PAGE_HEIGHT, contentHeight + PAGE_MARGIN * 2);

	// Lay out shapes
	const shapeLayouts: ShapeLayout[] = diagram.shapes.map((shape) => {
		const colSpan = shape.colSpan ?? 1;
		const rowSpan = shape.rowSpan ?? 1;
		const { pinX, pinY, width, height } = gridToPage(
			shape.row,
			shape.column,
			colSpan,
			rowSpan,
			rows,
			pageHeight,
		);
		return { shape, pinX, pinY, width, height };
	});

	// Index shapes by ID for connector lookup
	const shapeById = new Map<string, ShapeLayout>();
	for (const sl of shapeLayouts) {
		shapeById.set(sl.shape.id, sl);
	}

	// Lay out connectors
	const connectors: ConnectorLayout[] = [];
	for (const conn of diagram.connections) {
		const fromLayout = shapeById.get(conn.from.shapeId);
		const toLayout = shapeById.get(conn.to.shapeId);
		if (!fromLayout || !toLayout) {
			continue;
		}

		// Determine ports
		let fromPort = conn.from.port;
		let toPort = conn.to.port;
		if (!fromPort || !toPort) {
			const auto = autoPort(fromLayout, toLayout);
			fromPort = fromPort ?? auto.fromPort;
			toPort = toPort ?? auto.toPort;
		}

		const fromPt = connectorPoint(fromLayout, fromPort);
		const toPt = connectorPoint(toLayout, toPort);
		connectors.push({
			conn,
			fromX: fromPt.x,
			fromY: fromPt.y,
			toX: toPt.x,
			toY: toPt.y,
		});
	}

	// Lay out groups as background rectangles
	const groups: GroupLayout[] = [];
	if (diagram.groups) {
		for (const group of diagram.groups) {
			const memberLayouts = group.shapeIds
				.map((id) => shapeById.get(id))
				.filter((l): l is ShapeLayout => l != null);

			if (memberLayouts.length === 0) {
				continue;
			}

			// Compute bounding box with padding
			const padding = 0.3;
			let minX = Infinity;
			let maxX = -Infinity;
			let minY = Infinity;
			let maxY = -Infinity;
			for (const ml of memberLayouts) {
				minX = Math.min(minX, ml.pinX - ml.width / 2);
				maxX = Math.max(maxX, ml.pinX + ml.width / 2);
				minY = Math.min(minY, ml.pinY - ml.height / 2);
				maxY = Math.max(maxY, ml.pinY + ml.height / 2);
			}

			const width = maxX - minX + padding * 2;
			const height = maxY - minY + padding * 2;
			const pinX = minX - padding + width / 2;
			const pinY = minY - padding + height / 2;

			groups.push({
				group,
				label: group.label,
				pinX,
				pinY,
				width,
				height,
				fillColor: group.fillColor,
			});
		}
	}

	return { pageWidth, pageHeight, shapes: shapeLayouts, connectors, groups };
}
