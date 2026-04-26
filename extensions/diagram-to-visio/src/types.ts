/** Shape types supported by the diagram-to-visio converter. */
export type ShapeType =
	| "rectangle"
	| "rounded-rectangle"
	| "circle"
	| "ellipse"
	| "diamond"
	| "hexagon"
	| "cylinder"
	| "parallelogram"
	| "cloud"
	| "document"
	| "generic";

export type PortDirection = "top" | "bottom" | "left" | "right";

export interface ConnectionEndpoint {
	/** ID of the target shape. */
	shapeId: string;
	/** Optional port hint for where the connector attaches. */
	port?: PortDirection;
}

export interface DiagramConnection {
	id: string;
	from: ConnectionEndpoint;
	to: ConnectionEndpoint;
	label?: string;
	/** Arrow style: "single" (default, from→to), "double", "none". */
	arrowStyle?: "single" | "double" | "none";
	lineStyle?: "solid" | "dashed" | "dotted";
}

export interface DiagramShape {
	id: string;
	type: ShapeType;
	/** Primary text label inside the shape. */
	label: string;
	/** Secondary/subtitle text. */
	sublabel?: string;
	/** Logical grid row (0-based, top to bottom). */
	row: number;
	/** Logical grid column (0-based, left to right). */
	column: number;
	/** Width in grid units (default 1). */
	colSpan?: number;
	/** Height in grid units (default 1). */
	rowSpan?: number;
	/** Fill color hint from the original diagram (hex string). */
	fillColor?: string;
	/** Border/stroke color hint (hex string). */
	strokeColor?: string;
	/** Group ID if this shape belongs to a container/group. */
	groupId?: string;
}

export interface DiagramGroup {
	id: string;
	label: string;
	/** IDs of shapes in this group. */
	shapeIds: string[];
	fillColor?: string;
}

export type DiagramType = "flowchart" | "architecture" | "sequence" | "org-chart" | "generic";

export interface DiagramRepresentation {
	diagramType: DiagramType;
	title?: string;
	shapes: DiagramShape[];
	connections: DiagramConnection[];
	groups?: DiagramGroup[];
}
