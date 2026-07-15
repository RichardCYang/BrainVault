import { describe, expect, it } from "vitest";
import {
  createFallbackBookmarkPreview,
  createPinnedLookup,
  getBookmarkData,
  isPrivateAddress,
  parseBookmarkPreview,
  prioritizeResolvedAddresses,
  renderBookmarkHtml,
  summarizeBookmarkData
} from "../src/lib/bookmark.js";
import { renderBlockHtml } from "../src/lib/markdown.js";

describe("bookmark OpenGraph parsing", () => {
  it("extracts OpenGraph data, resolves relative assets, and decodes entities", () => {
    const preview = parseBookmarkPreview(
      `<!doctype html><html><head>
        <meta content="A &amp; B" property="og:title">
        <meta name="description" content="Fallback description">
        <meta property="og:description" content="OpenGraph &quot;description&quot;">
        <meta property="og:image" content="/media/cover.jpg">
        <meta property="og:site_name" content="Example News">
        <link href="/articles/story" rel="canonical">
        <link rel="icon" href="/icons/favicon.png">
      </head></html>`,
      "https://example.com/source"
    );

    expect(preview).toEqual({
      url: "https://example.com/articles/story",
      title: "A & B",
      description: 'OpenGraph "description"',
      imageUrl: "https://example.com/media/cover.jpg",
      faviconUrl: "https://example.com/icons/favicon.png",
      siteName: "Example News"
    });
  });

  it("falls back to the document title, hostname, and favicon path", () => {
    const preview = parseBookmarkPreview(
      "<html><head><title>  Plain page  </title></head></html>",
      "https://docs.example.org/guide"
    );

    expect(preview.title).toBe("Plain page");
    expect(preview.siteName).toBe("docs.example.org");
    expect(preview.faviconUrl).toBe("https://docs.example.org/favicon.ico");
    expect(preview.imageUrl).toBe("");
  });
});

describe("bookmark data normalization and rendering", () => {
  const metadata = {
    bookmark: {
      view: "gallery",
      items: [
        {
          id: "one",
          url: "https://example.com/post",
          title: "Unsafe <script>alert(1)</script>",
          description: "Description <img src=x onerror=alert(1)>",
          imageUrl: "/cover.jpg",
          faviconUrl: "/favicon.png",
          siteName: "Example"
        },
        {
          id: "duplicate",
          url: "https://example.com/post",
          title: "Duplicate"
        },
        {
          id: "invalid",
          url: "javascript:alert(1)",
          title: "Invalid"
        }
      ]
    }
  };

  it("deduplicates URLs and rejects non-HTTP links", () => {
    const data = getBookmarkData(metadata);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].imageUrl).toBe("https://example.com/cover.jpg");
    expect(data.items[0].faviconUrl).toBe("https://example.com/favicon.png");
    expect(summarizeBookmarkData(data)).toContain("https://example.com/post");
  });

  it("renders a sanitized OpenGraph gallery", () => {
    const html = renderBookmarkHtml(metadata);
    expect(html).toContain('class="rendered-bookmarks rendered-bookmarks--gallery"');
    expect(html).toContain('class="rendered-bookmark-image"');
    expect(html).toContain("Unsafe &lt;script&gt;");
    expect(html).not.toContain("<script>");

    const sanitized = renderBlockHtml("BOOKMARK", "", false, metadata);
    expect(sanitized).toContain('referrerpolicy="no-referrer"');
    expect(sanitized).toContain('target="_blank"');
    expect(sanitized).not.toContain("javascript:");
  });

  it("renders list view with favicon and title but without descriptions", () => {
    const html = renderBookmarkHtml({
      bookmark: {
        ...metadata.bookmark,
        view: "list"
      }
    });
    expect(html).toContain("rendered-bookmarks--list");
    expect(html).toContain("rendered-bookmark-favicon");
    expect(html).toContain("Unsafe &lt;script&gt;");
    expect(html).not.toContain("rendered-bookmark-description");
    expect(html).not.toContain("Description &lt;img");
  });
});

describe("bookmark SSRF address filtering", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.8",
    "172.16.10.4",
    "192.168.1.10",
    "169.254.169.254",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1"
  ])("blocks private address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows public address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});


describe("bookmark network address selection", () => {
  it("prioritizes IPv4, keeps IPv6 fallback addresses, and removes duplicates", () => {
    expect(prioritizeResolvedAddresses([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
      { address: "1.1.1.1", family: 4 }
    ])).toEqual([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 }
    ]);
  });

  it("returns all pinned public addresses when Node requests family autoselection", async () => {
    const lookup = createPinnedLookup([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 }
    ]);

    const result = await new Promise<unknown>((resolve, reject) => {
      lookup("example.com", { all: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    });

    expect(result).toEqual([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 }
    ]);
  });

  it("creates a usable basic bookmark when OpenGraph retrieval is unavailable", () => {
    expect(createFallbackBookmarkPreview("https://example.com/articles/1#section")).toEqual({
      url: "https://example.com/articles/1",
      title: "example.com",
      description: "",
      imageUrl: "",
      faviconUrl: "https://example.com/favicon.ico",
      siteName: "example.com"
    });
  });
});
