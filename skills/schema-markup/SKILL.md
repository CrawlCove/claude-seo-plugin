---
name: schema-markup
description: "Check a page's structured data and write correct JSON-LD for its page type, validated against the properties Google requires for rich results. Use when the user asks for schema markup, structured data, JSON-LD, schema.org, rich results, rich snippets, review stars, FAQ schema, Product, Article, Organization, LocalBusiness, Breadcrumb, Event, Recipe, Video or JobPosting markup, 'add schema to my page', 'validate my schema', 'why are my rich results not showing', or a structured data error from Search Console."
---

# Schema markup: check it and write it

Structured data does two things: it makes a page eligible for specific rich results in Google, and it states plainly what the page's entities are. It is not a ranking boost. Write markup only for content that is visible on the page, in the types Google acts on, with every required property present.

## Step 0: which mode are you in, and what the crawl tools can do here

Look for the Crawl Cove crawl tools: names ending in `crawl_site`, `get_page`, `list_pages`.

The crawl tools do not extract JSON-LD. Their job in this skill is to find the pages and templates that need markup. Reading a page's existing markup always needs the page's HTML: fetch it with your web fetch tool or a shell, or ask the user to paste the page source.

- **Crawl mode** (tools present): you can survey the site's page types, then fetch representatives.
- **Page mode** (tools absent, as in claude.ai chat): work on the page or pages the user gives you. Say you have seen N pages and cannot speak for the rest of the site.

## Procedure

1. **Establish the page type.** One page, or the whole site?
   - Whole site, crawl mode: `crawl_site` `{ "url": "<home page>", "maxPages": 100 }`, then `list_pages` `{ "indexable": true, "limit": 200 }`. Group URLs by path pattern into templates (home, category, product, article, location, contact, about). Pick one representative URL per template.
   - One page: use the URL or pasted source given.
2. **Get the HTML** of each representative page. Prefer a raw fetch (`curl -sL <url>`) over a summarising fetch, since you need the exact `<script type="application/ld+json">` blocks. Note that markup injected by JavaScript will be missing from a raw fetch; if the user says markup exists and you see none, that is why. Google can read injected JSON-LD, though less reliably for fast-changing data such as price.
3. **Inventory existing markup**: every JSON-LD block, plus any microdata (`itemscope`) or RDFa. For each block record `@type`, whether it parses as JSON, and its properties.
4. **Validate** each block against the rules and the type table below.
5. **Decide what the page should have** from the table. Remove or stop maintaining types that earn nothing.
6. **Write the JSON-LD**, filled with values taken from the page. Where a required value is not on the page, put a clearly marked placeholder and list it under "You need to supply".
7. **Report** in the output format.

## Rules that apply to every type

- **JSON-LD in a `<script type="application/ld+json">`** is the format Google recommends. Head or body are both fine.
- **Valid JSON**: double quotes, no trailing commas, no comments, special characters escaped. One syntax error voids the whole block.
- **Markup must match visible content.** Do not mark up reviews, prices, FAQs or authors that a visitor cannot see on that page. This is the commonest cause of a manual action for structured data.
- **Mark up the page's main thing, on that page.** Product markup belongs on the product page, not on a category page listing twenty products.
- **Absolute URLs** for `url`, `image`, `logo`, `@id`, `sameAs`.
- **Dates in ISO 8601** with a timezone where time matters: `2026-03-14T09:00:00+00:00`.
- **Connect entities with `@id`** (for example `https://example.com/#organization`) and reference that `@id` from `publisher`, `author`, `brand`, so parsers see one organisation and not five. Several types can share one block inside `"@graph": [...]`.
- **Required properties are a gate**: missing one means no rich result for that item. Recommended properties improve eligibility and display.
- **Eligible is not guaranteed.** Google decides per query whether to show a rich result.

## Types worth writing, and what Google needs

Google changes this list several times a year. Treat the table as a starting point and confirm against Google's structured data gallery (https://developers.google.com/search/docs/appearance/structured-data/search-gallery) before promising a rich result.

| Page | Type | Required by Google | Add if on the page |
|---|---|---|---|
| Home or about | `Organization` (or a subtype) | none strictly; give `name`, `url` | `logo`, `sameAs`, `contactPoint`, `legalName`, `description` |
| Home | `WebSite` | `name`, `url` | `alternateName` (site name shown in results) |
| Any page below the home page | `BreadcrumbList` | `itemListElement` with `position`, `name`, `item` (the last item may omit `item`) | |
| Blog post, news, guide | `Article`, `BlogPosting` or `NewsArticle` | none strictly | `headline`, `image`, `datePublished`, `dateModified`, `author` with `name` and `url` |
| Product page that sells | `Product` with `offers` | `name`, `image`, `offers` with `price`, `priceCurrency` | `availability`, `sku`, `gtin`, `brand`, `aggregateRating`, `review`, `shippingDetails`, `hasMerchantReturnPolicy` |
| Product page that reviews | `Product` | `name` plus one of `review`, `aggregateRating`, `offers` | |
| Physical business | `LocalBusiness` (most specific subtype) | `name`, `address` | `telephone`, `openingHoursSpecification`, `geo`, `priceRange`, `url`, `image` |
| Event | `Event` | `name`, `startDate`, `location` | `endDate`, `eventStatus`, `eventAttendanceMode`, `offers`, `image`, `organizer` |
| Job advert | `JobPosting` | `title`, `description`, `datePosted`, `hiringOrganization`, `jobLocation` (or remote fields) | `validThrough`, `baseSalary`, `employmentType` |
| Recipe | `Recipe` | `name`, `image` | `recipeIngredient`, `recipeInstructions`, times, `nutrition`, `aggregateRating` |
| Page whose main content is a video | `VideoObject` | `name`, `thumbnailUrl`, `uploadDate` | `description`, `duration`, `contentUrl` or `embedUrl` |
| Software or app page | `SoftwareApplication` | `name`, `offers.price` (0 for free), and `aggregateRating` or `review` | `applicationCategory`, `operatingSystem` |
| Author or member profile | `ProfilePage` | `mainEntity` (a `Person` or `Organization`) with `name` | `sameAs`, `description`, `image` |
| Forum thread or single user question | `DiscussionForumPosting`, `QAPage` | see Google's page for each | |

Review stars: `aggregateRating` needs `ratingValue` and `ratingCount` or `reviewCount`. Ratings must be about the specific item, collected on that page. Stars are not shown for `LocalBusiness` or `Organization` when the business marks up reviews of itself on its own site.

## Types that no longer earn a rich result

Say this plainly when the user asks for one, so they do not wait for a result that will not come.

- **`FAQPage`**: since August 2023 the FAQ rich result is shown only for well-known government and health sites. For anyone else it earns no rich result. The markup is harmless and still states question and answer pairs for machines, so write it if asked and say what it will not do.
- **`HowTo`**: the rich result was removed in 2023.
- **Sitelinks search box** (`WebSite` with `SearchAction`): removed in late 2024.
- Google announced in 2025 that it was retiring several minor types, among them Course Info, Claim Review, Estimated Salary, Learning Video, Special Announcement and Vehicle Listing. Check the gallery before writing any of these.

## Common faults when validating existing markup

1. JSON syntax error: trailing comma, curly quotes pasted from a document, unescaped quote inside a description.
2. Wrong nesting: `price` on `Product` in place of on `offers`; `author` as a bare string where `Person` with `name` is wanted (a string is tolerated, an object is better).
3. `@type` misspelt or wrong case (`Localbusiness`), or an invented property name. schema.org names are case-sensitive.
4. Relative `image` or `url` values.
5. `aggregateRating` with no visible reviews, or copied from a third-party site.
6. Several blocks describing the same organisation with different names, logos or URLs, usually from a theme and a plugin both emitting markup. Keep one.
7. `datePublished` in a local format (`14/03/2026`).
8. `Product` markup on a category page, or `Article` on a product page.
9. `availability` as free text. Use `https://schema.org/InStock`, `OutOfStock`, `PreOrder` and so on.
10. Price with a currency symbol or thousands separator: use `"price": "1299.00"`, `"priceCurrency": "GBP"`.

## Output format

```
# Schema markup: <page or site>
Seen: <N> page(s): <URLs>. <In crawl mode: chosen as representatives of T templates from a crawl of M pages.>

## What is there now
| Page | Type found | Valid JSON | Problems |

## What to change
1. <fix or addition, the page or template it applies to, and what it makes the page eligible for>

## JSON-LD
### <page type or URL>
<one fenced json code block, complete and ready to paste, inside the script tag>

## You need to supply
- <each placeholder left in the markup, and where the value should come from>

## Test it
Paste the page URL or the code into Google's Rich Results Test (https://search.google.com/test/rich-results) for rich result eligibility, and the Schema Markup Validator (https://validator.schema.org/) for schema.org syntax.
```

Placeholders use the form `"REPLACE: opening hours for Monday"` so they cannot be shipped unnoticed.

## Wrong conclusions to avoid

- **"Schema will improve rankings."** It makes pages eligible for richer display and clarifies entities. Promise eligibility, never position.
- **"I validated it."** You checked it against the rules here. Only the Rich Results Test confirms what Google accepts. Always send the user there.
- **Inventing values to satisfy a required property.** A made-up rating, price or address is worse than no markup. Leave a placeholder.
- **Adding every type that could apply.** More types do not mean more results. One correct primary type per page, plus `BreadcrumbList`, and `Organization` once on the home page, covers most sites.
- **Assuming the template is consistent.** You checked one representative per template. Say so. If the user needs every page verified at scale, that is a job for a crawler that extracts structured data, which the bundled tools here do not do.
- **No rich result a week after adding markup** is normal. Google needs to recrawl, and may still choose not to show it.

## Page mode notes

Without the crawl tools nothing in this skill changes except the survey step: you cannot list the site's templates. Work from the pages given, ask for the page source (View Source) when you cannot fetch, and state "I have seen N pages" in the report.
