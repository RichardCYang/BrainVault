import { describe, expect, it } from "vitest";
import {
  accordionLimits,
  createDefaultAccordionData,
  getAccordionData,
  renderAccordionHtml,
  summarizeAccordionData
} from "../src/lib/accordion.js";
import { renderBlockHtml } from "../src/lib/markdown.js";
import {
  assertStructuredBlockMetadataIntegrity,
  StructuredMetadataIntegrityError
} from "../src/lib/structured-metadata-integrity.js";

describe("Accordion block data", () => {
  it("keeps item order, icons, open state, and numbering preference in metadata", () => {
    const metadata = {
      accordion: {
        title: "Release checklist",
        showOrder: true,
        items: [
          { id: "second", icon: "🚀", title: "Deploy", content: "Ship it", open: false },
          { id: "first", icon: "icon:star", title: "Verify", content: "Run regression tests", open: true }
        ]
      }
    };

    const data = getAccordionData(metadata);
    expect(data.title).toBe("Release checklist");
    expect(data.showOrder).toBe(true);
    expect(data.items.map((item) => item.id)).toEqual(["second", "first"]);
    expect(data.items.map((item) => item.icon)).toEqual(["🚀", "icon:star"]);
    expect(data.items.map((item) => item.open)).toEqual([false, true]);
  });

  it("creates a safe default accordion and bounds search-only markdown summaries", () => {
    const data = createDefaultAccordionData();
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({ icon: "📄", open: true });

    const huge = {
      title: "A".repeat(accordionLimits.titleLength),
      items: Array.from({ length: accordionLimits.items }, (_, index) => ({
        id: `item-${index}`,
        icon: "📄",
        title: "T".repeat(accordionLimits.itemTitleLength),
        content: "C".repeat(accordionLimits.itemContentLength),
        open: true
      }))
    };
    expect(summarizeAccordionData(huge)).toHaveLength(20_000);
    expect(huge.items[0].content).toHaveLength(accordionLimits.itemContentLength);
  });
});

describe("Accordion block rendering", () => {
  const metadata = {
    accordion: {
      title: "FAQ <script>alert(1)</script>",
      showOrder: true,
      items: [
        {
          id: "one",
          icon: "icon:star",
          title: "First <img src=x onerror=alert(1)>",
          content: "Line one\n<script>alert(2)</script>Line two",
          open: true
        },
        { id: "two", icon: "✅", title: "Second", content: "Done", open: false }
      ]
    }
  };

  it("renders native details/summary disclosures with clean order labels and icon hydration data", () => {
    const html = renderAccordionHtml(metadata);
    expect(html).toContain('class="rendered-accordion"');
    expect(html).toContain('<span class="rendered-accordion-order">1</span>');
    expect(html).toContain('data-icon-value="icon:star"');
    expect(html).toMatch(/<details class="rendered-accordion-item" open>/);
    expect(html).toMatch(/<details class="rendered-accordion-item">[\s\S]*Second/);
    expect(html).toContain("Line one<br>&lt;script&gt;alert(2)&lt;/script&gt;Line two");
  });

  it("is sanitized through the standard renderer without losing accordion attributes", () => {
    const html = renderBlockHtml("ACCORDION", "ignored derived markdown", false, metadata);
    expect(html).toContain('class="rendered-accordion-summary"');
    expect(html).toContain('data-icon-value="icon:star"');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });
});

describe("Accordion structured metadata integrity", () => {
  it("accepts lossless accordion metadata and rejects duplicate IDs or invalid icons", () => {
    const valid = {
      accordion: {
        title: "FAQ",
        showOrder: false,
        items: [
          { id: "a", icon: "💡", title: "Question", content: "Answer", open: true },
          { id: "b", icon: "icon:star", title: "Question 2", content: "Answer 2", open: false }
        ]
      }
    };
    expect(() => assertStructuredBlockMetadataIntegrity("ACCORDION", valid)).not.toThrow();

    expect(() => assertStructuredBlockMetadataIntegrity("ACCORDION", {
      accordion: { ...valid.accordion, items: valid.accordion.items.map((item) => ({ ...item, id: "same" })) }
    })).toThrow(StructuredMetadataIntegrityError);

    expect(() => assertStructuredBlockMetadataIntegrity("ACCORDION", {
      accordion: { ...valid.accordion, items: [{ ...valid.accordion.items[0], icon: "x".repeat(40) }] }
    })).toThrow(StructuredMetadataIntegrityError);
  });
});
