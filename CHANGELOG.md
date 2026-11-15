# Changelog

## 1.0.0 (2026-11-15)

First release.

- Seven skills: `seo-audit`, `technical-seo`, `broken-links`, `on-page-seo`, `schema-markup`, `ai-search-visibility`, `site-migration-check`. Each works with the crawl tools and, where those are not available, from pages you paste or Claude fetches.
- A bundled local MCP server with six read-only tools: `crawl_site`, `load_export`, `get_issues`, `get_page`, `list_broken_links`, `list_pages`. Same tools and behaviour as [seo-mcp-server](https://github.com/CrawlCove/seo-mcp-server).
- The server is plain JavaScript with no dependencies: the crawler is a port of [crawlcove-cli](https://github.com/CrawlCove/seo-crawler-cli) 1.1.4 with a hand-written HTML scanner and robots.txt parser, and the MCP stdio protocol is hand-written.
- Tool answers are capped at about 25,000 characters and say how to narrow a list that was cut.
