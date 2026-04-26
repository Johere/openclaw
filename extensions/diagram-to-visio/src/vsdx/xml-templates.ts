import {
	NS_CONTENT_TYPES,
	NS_CORE_PROPS,
	NS_DC,
	NS_DCTERMS,
	NS_EXT_PROPS,
	NS_RELS,
	NS_VISIO,
	NS_XSI,
	REL_CORE_PROPS,
	REL_EXT_PROPS,
	REL_PAGE,
	REL_VISIO_DOCUMENT,
} from "./constants.js";

/** Escape special XML characters in text content. */
export function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Convert a hex color like "#4472C4" to Visio's format "#4472C4" (kept as-is, strip leading #). */
export function visioColor(hex: string): string {
	return hex.startsWith("#") ? hex : `#${hex}`;
}

export function contentTypesXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${NS_CONTENT_TYPES}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/>
  <Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>
  <Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

export function rootRelsXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_RELS}">
  <Relationship Id="rId1" Type="${REL_VISIO_DOCUMENT}" Target="visio/document.xml"/>
  <Relationship Id="rId2" Type="${REL_CORE_PROPS}" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="${REL_EXT_PROPS}" Target="docProps/app.xml"/>
</Relationships>`;
}

export function documentXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<VisioDocument xmlns="${NS_VISIO}" xml:space="preserve">
  <DocumentProperties>
    <Creator>OpenClaw diagram-to-visio</Creator>
  </DocumentProperties>
</VisioDocument>`;
}

export function documentRelsXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_RELS}">
  <Relationship Id="rId1" Type="${REL_PAGE}" Target="pages/pages.xml"/>
</Relationships>`;
}

export function pagesXml(pageWidth: number, pageHeight: number): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Pages xmlns="${NS_VISIO}" xml:space="preserve">
  <Page ID="0" Name="Page-1" NameU="Page-1">
    <PageSheet>
      <Cell N="PageWidth" V="${pageWidth}"/>
      <Cell N="PageHeight" V="${pageHeight}"/>
      <Cell N="DrawingScale" V="1"/>
      <Cell N="PageScale" V="1"/>
    </PageSheet>
    <Rel xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>
  </Page>
</Pages>`;
}

export function pagesRelsXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS_RELS}">
  <Relationship Id="rId1" Type="${REL_PAGE}" Target="page1.xml"/>
</Relationships>`;
}

export function corePropsXml(title?: string): string {
	const now = new Date().toISOString();
	const titleEl = title ? `<dc:title>${escapeXml(title)}</dc:title>` : "";
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="${NS_CORE_PROPS}" xmlns:dc="${NS_DC}" xmlns:dcterms="${NS_DCTERMS}" xmlns:xsi="${NS_XSI}">
  ${titleEl}
  <dc:creator>OpenClaw diagram-to-visio</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

export function appPropsXml(): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="${NS_EXT_PROPS}">
  <Application>OpenClaw</Application>
</Properties>`;
}

/** Build the page1.xml content from pre-built shape XML fragments. */
export function pageXml(pageWidth: number, pageHeight: number, shapesXml: string): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<PageContents xmlns="${NS_VISIO}" xml:space="preserve">
  <Shapes>
${shapesXml}
  </Shapes>
</PageContents>`;
}
