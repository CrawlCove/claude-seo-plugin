---
name: ai-search-visibility
description: "Check how well a website can be read, quoted and cited by AI search and assistants (ChatGPT, Claude, Perplexity, Google AI Overviews, Copilot): AI crawler access in robots.txt, whether content is in the server HTML, answer-first passages, entity clarity, and llms.txt. Use when the user asks about AI search, AI visibility, AEO, GEO, LLM SEO, 'how do I show up in ChatGPT', 'get cited by AI', 'is my site blocking GPTBot or ClaudeBot', AI Overviews, 'should I add llms.txt', or whether AI crawlers can read their site."
---

# AI search visibility

AI answers come from two places: what a model learned in training, and pages a search system retrieves at the moment of the question. A site owner can influence the second directly and the first slowly. This skill checks the parts that are checkable: can the AI crawlers fetch the pages, is the content in the HTML they receive, and are the pages written so that a passage can be lifted and attributed.

Be straightforward about evidence. Access and rendering are facts you can test. Passage structure and entity clarity are well-supported practice. Anything about how a given assistant ranks sources is not published; do not present guesses as mechanics.

## Step 0: which mode are you in

Look for the Crawl Cove crawl tools: names ending in `crawl_site`, `get_issues`, `get_page`, `list_pages`.

- **Crawl mode**: tools present. You get a site-wide view of what a non-rendering crawler receives.
- **Page mode**: tools absent (claude.ai chat does not run a plugin's local tools). You check robots.txt and the specific pages you can fetch or the user pastes. Say you have seen N pages, not the site.

In both modes you need `robots.txt` and the HTML of a few key pages. Fetch them with your web fetch tool or a shell (`curl -sL`), or ask the user to paste them.

## Procedure

1. **Fetch `<origin>/robots.txt`** and evaluate each AI user agent using the table and rules in the next section.
2. **Crawl** (crawl mode): `crawl_site` `{ "url": "<home page>", "maxPages": 100 }`. This crawler reads server HTML without running JavaScript, which is also how most AI crawlers read a page, so its results stand in for theirs:
   - `get_issues` `{ "type": "missing-title" }` and `{ "type": "missing-h1" }`: if most pages lack both, content is probably rendered in the browser and largely invisible to AI crawlers.
   - `get_issues` `{ "type": "noindex" }` and `{ "type": "broken-page" }`: pages that search indexes, which AI answers draw on, will not hold.
   - Note the "Skipped per robots.txt" list.
3. **Pick 3 to 5 pages that should be cited**: the pages that answer the questions customers ask (product or service explanation, pricing, comparison, a how-to, the about page). Ask the user or choose from `list_pages`.
4. **Fetch each page's raw HTML** and check: is the main text present in the HTML (search for a sentence you expect), or is the body an empty app shell? Then assess the passage and entity checklists below.
5. **Check for `/llms.txt`** (one fetch). Report whether it exists. See the llms.txt section for what to say.
6. **Report** in the output format.

## AI crawlers and robots.txt

| User agent | Operator | What it is for | Blocking it means |
|---|---|---|---|
| `GPTBot` | OpenAI | Collects training data | Content is not used to train future models |
| `OAI-SearchBot` | OpenAI | Builds the index behind ChatGPT search | Pages are not surfaced or cited in ChatGPT search |
| `ChatGPT-User` | OpenAI | Fetches a page when a user's request needs it | ChatGPT cannot open the page during a conversation |
| `ClaudeBot` | Anthropic | Collects training data | Content is not used to train future models |
| `Claude-SearchBot` | Anthropic | Builds search results for Claude | Pages are less likely to appear in Claude's search answers |
| `Claude-User` | Anthropic | Fetches a page when a user's request needs it | Claude cannot open the page during a conversation |
| `PerplexityBot` | Perplexity | Builds Perplexity's index | Pages are not cited in Perplexity answers |
| `Perplexity-User` | Perplexity | Fetches a page for a user's request | Perplexity states this agent generally does not follow robots.txt, as the fetch is user-initiated |
| `Google-Extended` | Google | A robots.txt token, not a separate crawler: controls use of content for Gemini models | Does not affect Google Search or AI Overviews |

The three user-triggered agents (`ChatGPT-User`, `Claude-User`, `Perplexity-User`) act for a person who asked for a page, and operators do not all bind them to robots.txt in the same way. Operators also rename and add agents. Check each operator's current crawler documentation before giving a definitive answer about one of them.

How to read the file:

- A crawler obeys the group that names it; only if none does, the `*` group. So `User-agent: *` / `Disallow: /private/` plus `User-agent: GPTBot` / `Disallow: /` blocks GPTBot from everything.
- If no group names an AI agent, it follows `*`. A site with a permissive `*` group allows all of them. State that as "allowed by default".
- Report each of the nine agents as **allowed**, **blocked** or **partly blocked** (with the paths), and quote the deciding line.
- **Google AI Overviews and AI Mode use the normal Google Search index**, crawled by `Googlebot`. Blocking `Google-Extended` does not remove a site from them, and there is no robots.txt token that does. The controls are the snippet ones: `nosnippet`, `max-snippet` and `data-nosnippet`, which also limit ordinary snippets.
- **Microsoft Copilot draws on the Bing index** (`bingbot`). A site that is not indexed in Bing is unlikely to appear there.
- Training and search are separate decisions. A common, coherent policy is: block the training agents (`GPTBot`, `ClaudeBot`, `Google-Extended`) and allow the search and user agents. Blocking everything "AI" also removes the site from AI search citations. Lay out the trade and let the owner choose; do not push either way.
- Other agents the user may ask about: `CCBot` (Common Crawl, widely used as training data), `Bytespider`, `Amazonbot`, `Applebot-Extended` (a token controlling Apple's AI training use), `meta-externalagent`.

**robots.txt is not the only gate.** Firewalls and CDN bot settings can refuse AI crawlers with a 403 even when robots.txt allows them, and some CDN plans now block AI bots by default. You cannot see this from a crawl. Tell the user to check their CDN or firewall bot settings and their server logs for these user agents. Do not claim a bot "can access" the site; say "robots.txt allows it".

## Is the content in the HTML

Most AI crawlers fetch the HTML and do not run JavaScript. Google's crawler does render, later and at a cost.

- Signals of a problem: the crawl reports missing titles and H1s on most pages; the raw HTML body is a single empty root element plus scripts; the text you can see in a browser is absent from the fetched source.
- The fix is server-side rendering, static generation or prerendering for the pages that matter. It is not a tag.
- Content behind tabs, accordions or "read more" is fine if it is in the HTML. Content loaded on click or on scroll is not there for a crawler.
- Text inside images, PDFs without a text layer, and video without a transcript cannot be quoted.

## Passage checklist (per page)

Retrieval systems pull passages, not pages. A passage gets used when it answers the question by itself.

1. **Answer first.** Under each heading, the first one or two sentences state the answer; detail follows. Check the page's main question: can you copy 40 to 60 words that answer it completely?
2. **Headings as the questions people ask**, or plain statements of the topic. "How long does delivery take?" beats "Logistics".
3. **Self-contained sentences.** A lifted sentence should name its subject: "Acme's Pro plan costs £29 a month", not "It costs £29".
4. **Specifics**: numbers, dates, prices, measurements, named sources. Vague claims do not get quoted.
5. **Definitions and comparisons in a form that survives extraction**: a one-sentence definition; a table for anything compared across attributes; a numbered list for steps.
6. **Dated and attributed.** A visible published or updated date and a named author or organisation. Stale or anonymous pages lose to dated, attributed ones.
7. **One topic per page**, covered fully, in place of many thin pages that each answer a fragment.
8. **Original material**: first-hand data, test results, examples. A page that restates what ten others say has no reason to be the one cited.

## Entity checklist (site level)

An assistant can only recommend a business it can identify.

1. The home page says in plain text, in the first screen of HTML, what the organisation is, what it offers and for whom. Not only a slogan.
2. The same name, spelt the same way, in the title, the H1 or logo alt text, the footer and the about page.
3. An about page with real facts: who runs it, where, since when, contact details.
4. `Organization` JSON-LD on the home page with `name`, `url`, `logo` and `sameAs` links to the profiles that are really theirs (use the schema-markup skill to write it).
5. Pricing, plans and product names as text on a page, not only inside an image or a script widget.
6. The brand described consistently on third-party sites: directories, review sites, profiles. Assistants lean on what others say about a brand. You can only check this for pages you are given or can fetch.

## llms.txt

`/llms.txt` is a proposed convention: a Markdown file listing a site's key pages for language models. State its standing accurately:

- It is optional and unproven. No major AI provider has confirmed that it affects what gets retrieved or cited, and Google has said it does not use it.
- It does no harm, takes minutes to write, and some developer tools and agents do read it when pointed at a site, so it has most value for documentation sites.
- It is not an access control. robots.txt remains the place to allow or block crawlers.

If the user wants one, write it: an H1 with the site name, a one-paragraph summary in a blockquote, then H2 sections of links with a short description each, limited to the pages that best explain the product. Recommend it as a low-cost extra, never as a fix for visibility.

## Output format

```
# AI search visibility: <site>
Seen: robots.txt, <a crawl of N pages | no crawl>, and <K> pages read in full: <URLs>.

## Crawler access (robots.txt)
| Agent | Status | Deciding rule |
(nine rows)
Not checked: firewall or CDN blocking. <one line on how to check>

## Can crawlers read the content
<server-rendered | rendered in the browser | mixed>, with the evidence.

## Page review
### <URL>
Works: <what is quotable now>
Change: <specific edits: the heading to rename, the answer sentence to add, the table to build>

## Entity clarity
<findings against the six points>

## llms.txt
<present | absent>. <one or two sentences, no overselling>

## Do next
1. <highest value change>
...
```

Where you suggest an answer-first rewrite, write the rewritten passage out.

## Wrong conclusions to avoid

- **"Your site is visible in ChatGPT."** You checked access and readability. Whether an assistant cites the site for a given question can only be seen by asking it, and answers vary by run and by user. Never report a visibility score or share of answers from this skill.
- **"Blocking Google-Extended removes you from AI Overviews."** It does not.
- **"Allow GPTBot to appear in ChatGPT search."** Search citation depends on `OAI-SearchBot`. `GPTBot` is training.
- **"Add llms.txt to get cited."** Unproven. See above.
- **Treating FAQ schema as an AI lever.** Clear question-and-answer text in the HTML is what helps. Markup is optional.
- **Assuming the `*` rule covers a named bot.** A group naming the bot replaces `*` for that bot.
- **Reading a truncated or small crawl as the whole site.** Say how many pages you saw.
- **Rewriting everything as FAQs.** Answer-first structure applies inside normal pages. Pages padded with invented questions read badly to people and gain nothing.
