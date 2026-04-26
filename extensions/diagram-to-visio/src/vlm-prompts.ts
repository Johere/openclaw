import type { DiagramType } from "./types.js";

/** Build the system prompt that instructs the VLM to extract diagram structure. */
export function buildExtractionPrompt(diagramTypeHint?: DiagramType | "auto"): string {
	const typeConstraint =
		diagramTypeHint && diagramTypeHint !== "auto" && diagramTypeHint !== "generic"
			? `The diagram is a ${diagramTypeHint}. `
			: "";

	return `You are a diagram structure extractor. Given an image of a diagram, output a JSON object describing every visible shape, connection, and label.

${typeConstraint}Rules:
1. Assign each shape a unique ID: "s1", "s2", "s3", etc.
2. Identify shape types from this list: rectangle, rounded-rectangle, circle, ellipse, diamond, hexagon, cylinder, parallelogram, cloud, document, generic. Use "generic" only when no other type fits.
3. Extract ALL text labels exactly as written in the diagram.
4. Determine relative positions using a grid system:
   - row 0 is the topmost row of shapes, row 1 is the next row down, etc.
   - column 0 is the leftmost column, column 1 is the next column right, etc.
   - If a shape spans multiple grid cells, use colSpan/rowSpan.
5. For every arrow or line connecting shapes, record:
   - "from" and "to" with the source/target shape IDs
   - port hint: "top", "bottom", "left", or "right" indicating where the connector attaches
   - arrowStyle: "single" (one-directional, default), "double" (bidirectional), or "none" (plain line)
   - lineStyle: "solid" (default), "dashed", or "dotted"
6. If shapes are grouped inside a container, boundary box, or labeled region, record a group with the container label and member shape IDs.
7. Detect the overall diagram type: "flowchart", "architecture", "sequence", "org-chart", or "generic".
8. If the diagram has a title, include it.
9. Note fill colors as hex values (e.g. "#4472C4") when they are clearly distinguishable.

Output ONLY valid JSON (no markdown fences, no extra text) matching this exact schema:

{
  "diagramType": "flowchart" | "architecture" | "sequence" | "org-chart" | "generic",
  "title": "optional title string",
  "shapes": [
    {
      "id": "s1",
      "type": "rectangle",
      "label": "Shape Label",
      "sublabel": "optional subtitle",
      "row": 0,
      "column": 0,
      "colSpan": 1,
      "rowSpan": 1,
      "fillColor": "#4472C4",
      "strokeColor": "#2F528F",
      "groupId": "optional group ID"
    }
  ],
  "connections": [
    {
      "id": "c1",
      "from": { "shapeId": "s1", "port": "bottom" },
      "to": { "shapeId": "s2", "port": "top" },
      "label": "optional label",
      "arrowStyle": "single",
      "lineStyle": "solid"
    }
  ],
  "groups": [
    {
      "id": "g1",
      "label": "Group Label",
      "shapeIds": ["s1", "s2"],
      "fillColor": "#D9E2F3"
    }
  ]
}`;
}

/** Build a retry prompt when the first extraction produced invalid JSON. */
export function buildRetryPrompt(error: string): string {
	return `Your previous response was not valid JSON. Error: ${error}

Please output ONLY the corrected JSON object, with no markdown fences or surrounding text. Follow the exact schema from the previous instructions.`;
}
