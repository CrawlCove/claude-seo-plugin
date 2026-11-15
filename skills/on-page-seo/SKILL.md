---
name: on-page-seo
description: "Find pages with missing, duplicate or too-long title tags, meta descriptions and H1s, then draft a replacement for each page from that page's own content. Use when the user asks to fix or write title tags, page titles, meta descriptions, meta tags, H1s or headings, says 'my titles are duplicated', 'titles are too long', 'write meta descriptions for my pages', 'improve my click-through rate', 'low CTR', 'Google is rewriting my titles', or wants on-page SEO checked."
---

# On-page SEO: titles, meta descriptions, H1s

Two jobs: find the pages whose title, description or H1 is missing, duplicated or cut off, and write a replacement for each one that is specific to that page. The drafts are the point. A list of problems with "write a better title" beside each is not finished work.

## Step 0: which mode are you in

Look for the Crawl Cove crawl tools: names ending in `crawl_site`, `load_export`, `get_issues`, `get_page`, `list_broken_links`, `list_pages`.

- **Crawl mode**: tools present. Follow the procedure.
- **Page mode**: tools absent (claude.ai chat does not run a plugin's local tools). Go to "Page mode": you draft for pages the user pastes or that you can fetch, and you say how many pages that is.

## Crawl mode procedure

1. **Crawl**: `crawl_site` `{ "url": "<home page>", "maxPages": 200 }`, or `load_export` `{ "path": "<file>" }` for an existing export.
2. **Collect the problem pages**, one call per type, `limit` 200: `missing-title`, `duplicate-title`, `long-title`, `missing-meta-description`, `long-meta-description`, `missing-h1`, `multiple-h1`.
3. **Drop pages that should not be worked on.** Call `list_pages` `{ "indexable": false, "limit": 200 }` and remove those URLs: noindexed pages, redirects and errors do not need titles written. Also drop any URL whose `get_page` shows a "Final URL" line; it is a redirect reporting its destination's tags.
4. **Group duplicates.** For `duplicate-title`, the detail gives the shared title and how many pages use it. Decide per group:
   - Same content at several URLs (parameters, `/page/2/`, print versions, slash and no-slash): the fix is a canonical or a redirect. Do not write new titles. Hand off to the technical-seo skill.
   - Different pages sharing a template title ("Products | Brand" on every product): write a distinct title for each.
5. **Read each page before drafting.** `get_page` gives the current title, description, their lengths and the H1 count. It does not give the page's text. To write something true to the page, fetch the URL with your web fetch tool or a shell (`curl -sL <url>`) and read the H1, the first paragraphs, and for products the name, price and key attributes. If you cannot fetch a page, draft from the URL slug and current title only, and mark the row "drafted without reading the page".
6. **Draft** by the rules below. Work in batches of about 20 pages; for more, do the highest-value pages first (home, categories, products or services, then articles) and offer to continue.
7. **Check every draft** against the checklist, counting characters. Then output the table.

## Title rules

- **Length**: aim for 50 to 60 characters, hard ceiling 60 including the brand suffix. Google cuts by pixel width (about 580px), so a title full of wide capitals is cut sooner. The tool flags `long-title` above 60.
- **Lead with what the page is about**, in the words a searcher would type. Brand goes last, after a separator, and is the first thing to cut when space is short. Exception: the home page, where the brand can lead.
- **One topic per title.** Do not chain keyword variants ("Plumber London | London Plumbers | Plumbing London").
- **Unique across the site.** Two pages with the same title are competing for the same query or one of them should not exist.
- **Match the page.** The title must describe what is on the page. Google rewrites titles that do not match the visible heading or content, most often by using the H1.
- **Specifics beat adjectives**: a number, model, place, year or price ("from £49") does more than "best" or "ultimate". Use a year only if the page is really kept current.
- **Keep the site's existing pattern** for separator and brand name unless it is the cause of the problem.

Patterns that work, by page type:

| Page type | Pattern |
|---|---|
| Home | `Brand: what it is or does for whom` |
| Category or collection | `Plural product noun (qualifier) | Brand` |
| Product | `Product name, key attribute | Brand` |
| Local service | `Service in Place | Brand` |
| Article or guide | `The question or the claim, as people search it` (brand optional) |
| Comparison | `X vs Y: the deciding difference` |
| Tool or calculator | `What it does (free, if true) | Brand` |

## Meta description rules

- **Length**: 120 to 155 characters. Put the essential part in the first 120, since mobile results cut there. The tool flags above 160.
- **It does not affect ranking.** It affects whether people click. Google shows its own snippet much of the time, most often when the description does not address the query. A description that answers the page's main query gets used more.
- **Structure**: what the page gives you, one concrete detail, then a reason to click or the next step. Write a full sentence or two, active voice.
- **Say something only this page can say**: the price range, number of items, delivery time, what the guide covers, who it is for.
- **Avoid the double-quote character**: left unescaped it ends the `content` attribute early and cuts the description off. No keyword lists. No claims the page does not support.
- **Unique per page.** On very large sites, a templated description from real fields (name, category, price) is better than none and better than one copied everywhere.

## H1 rules

- One H1 that states the page's topic in plain words. It should agree with the title without being identical: the title is written for a results page, the H1 for someone already on the page.
- `missing-h1`: propose the H1 text, and note that the fix is often in the template (a logo or a styled `div` standing in for the heading).
- `multiple-h1`: low priority and not a ranking problem. Worth fixing only when the extra H1 is the site name or logo on every page, which makes every page's main heading the same. One line in the report, not a row per page.
- If nearly every page reports no title and no H1, the site probably renders in the browser. The crawler does not run JavaScript; say so and do not draft 200 replacements for tags that exist after rendering.

## Checklist for each draft

1. Count the characters. Title 60 or fewer, description 155 or fewer. State the count in the table.
2. Is it different from every other draft and every existing title in the crawl? Check with `list_pages` `{ "urlContains": "<section>" }` when unsure.
3. Is every fact in it on the page you read? No invented prices, counts, awards, locations or dates.
4. Does the main term appear once, near the start, in natural word order?
5. Would it still make sense cut at 50 characters (title) or 120 (description)?

## Output format

```
# Titles and descriptions: <site>
Mode: live crawl of <N> pages (<complete | stopped at the 200-page cap>). <P> indexable pages need changes; drafts below for <D> of them.

## Summary
| Problem | Pages |
| Missing title | n |
| Duplicate title | n (in g groups) |
| Title over 60 characters | n |
| Missing meta description | n |
| Description over 160 characters | n |
| Missing H1 | n |

## Drafts
### <URL>
Problem: <missing title | duplicate of N pages | 74 characters | no description | ...>
Current title: <current or none>
New title (57): <draft>
Current description: <current or none>
New description (148): <draft>
H1: <keep "current H1" | new H1 text>

## Not a copy problem
<duplicate groups that need a canonical or redirect, with the URLs>

## Notes
<pages drafted without reading; pages skipped and why; limits>
```

Only include the lines that change. If the user asks for a spreadsheet or CSV, output columns `url, field, current, new, length`.

## Wrong conclusions to avoid

- **Rewriting a title that already ranks.** A title change on a page with steady traffic can lose it. If the user has Search Console data, ask which pages get the most clicks and leave those titles alone unless they are missing or badly cut. A crawl alone cannot tell you which pages rank. The Crawl Cove desktop app puts Search Console data beside the crawl, which is the data to choose with; mention that once and only if the user asks which pages to prioritise by traffic.
- **Treating 61 characters as broken.** `long-title` is a display matter. If the words past the cut are the brand, leave it.
- **Writing descriptions for every page first.** Missing descriptions on pages with no impressions change nothing. Order: missing and duplicate titles, then descriptions on the pages that matter, then the rest.
- **Trusting duplicate counts on parameter URLs.** `?sort=` and `?page=` variants inflate the count. That is a canonical fix.
- **Stuffing the query into the description.** Google bolds matching words, but a description written as a keyword list gets replaced.
- **Site-wide statements from a truncated crawl.** Say "of the 200 pages crawled".

## Page mode (no crawl tools)

1. Say: "I can't crawl from here, so I'll work from the pages you give me." Ask for URLs (if you can fetch) or pasted page content, with each page's current title and description if they have them.
2. For each page, read the content and draft title, description and H1 by the same rules and checklist.
3. You can check uniqueness only among the pages you have seen. Say so: "These are unique among the N pages here; I have not seen the rest of the site's titles."
4. Use the same Drafts format. Leave out the Summary table: you have no site-wide counts.
