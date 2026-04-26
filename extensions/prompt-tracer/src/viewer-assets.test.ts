import { describe, expect, it } from "vitest";
import { buildViewerHtml } from "./viewer-assets.js";

describe("buildViewerHtml", () => {
  it("returns valid HTML with doctype", () => {
    const html = buildViewerHtml({
      xml: "<trace/>",
      theme: "dark",
      traceId: "20260425-abc123",
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  it("includes the trace id in the title", () => {
    const html = buildViewerHtml({
      xml: "<trace/>",
      theme: "dark",
      traceId: "20260425-abc123",
    });
    expect(html).toContain("20260425-abc123");
  });

  it("contains no CDN or external resource links", () => {
    const html = buildViewerHtml({
      xml: "<trace/>",
      theme: "dark",
      traceId: "test-id",
    });
    // Allow standard XML/W3C namespace URIs; reject external CDN domains
    const externalLinks = html.match(/https?:\/\/(?!www\.w3\.org)[a-zA-Z]/g);
    expect(externalLinks).toBeNull();
  });

  it("embeds XML in script tag when inlineXml=true", () => {
    const xml = "<trace><turns></turns></trace>";
    const html = buildViewerHtml({
      xml,
      theme: "dark",
      traceId: "test-id",
    });
    expect(html).toContain('id="pt-xml-data"');
    expect(html).toContain("<trace>");
  });

  it("escapes </script> inside embedded content", () => {
    const xml = '<trace id="</script>bad"/>';
    const html = buildViewerHtml({
      xml,
      theme: "dark",
      traceId: "test-id",
    });
    // Should not have a raw closing script tag that could break parsing
    expect(html).not.toContain("</script>bad");
  });

  it("uses light theme colors when theme=light", () => {
    const darkHtml = buildViewerHtml({ xml: "<t/>", theme: "dark", traceId: "x" });
    const lightHtml = buildViewerHtml({ xml: "<t/>", theme: "light", traceId: "x" });
    // Dark should have dark background
    expect(darkHtml).toContain("#0d1117");
    // Light should have white background
    expect(lightHtml).toContain("#ffffff");
  });
});
