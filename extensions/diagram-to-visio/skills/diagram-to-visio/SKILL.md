---
name: diagram-to-visio
description: Use the diagram_to_visio tool to convert diagram images (architecture diagrams, flowcharts, org charts, sequence diagrams) into editable Visio (.vsdx) files.
---

When a user provides an image of a diagram and wants it converted to an editable format, use the `diagram_to_visio` tool.

The tool accepts:
- `image_path` (required): Local file path to the diagram image (PNG/JPG/WebP).
- `diagram_type` (optional): Hint for the diagram type — "flowchart", "architecture", "sequence", "org-chart", or "auto" (default).
- `output_path` (optional): Where to save the .vsdx file. Defaults to a temp directory.

The tool uses a vision model to analyze the diagram image and extract:
- Shape types (rectangles, circles, diamonds, hexagons, cylinders, etc.)
- Text labels inside shapes
- Connections and arrows between shapes
- Grouping and container regions
- Approximate layout

The output is a .vsdx file that Microsoft Visio and LibreOffice Draw can open and edit. Shapes are fully editable, not embedded images.

Supported diagram types:
- Architecture diagrams (cloud infra, system design)
- Flowcharts (process flows, decision trees)
- Org charts (organizational hierarchies)
- Sequence diagrams (basic message flows)
- Generic diagrams

Tips:
- Provide a `diagram_type` hint when you know the type for better extraction accuracy.
- The tool works best with clear, well-labeled diagrams with distinct shapes and readable text.
- After conversion, let the user know they can rearrange shapes in Visio since the auto-layout is approximate.
