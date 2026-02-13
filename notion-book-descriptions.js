#!/usr/bin/env node

const https = require('https');

// ============================================
// CONFIGURATION
// ============================================
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_ID = process.env.DATABASE_ID;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const HARDCOVER_TOKEN = process.env.HARDCOVER_TOKEN;
const MAX_BOOKS_PER_RUN = 50;
const MAX_DESCRIPTION_LENGTH = 2000; // Notion rich_text limit per block

// ============================================
// HELPER FUNCTIONS
// ============================================

function httpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (postData) {
      if (typeof postData === 'string') {
        req.write(postData);
      } else {
        req.write(JSON.stringify(postData));
      }
    }
    req.end();
  });
}

// ============================================
// NOTION FUNCTIONS
// ============================================

async function getNotionPages() {
  const options = {
    hostname: 'api.notion.com',
    path: '/v1/databases/' + DATABASE_ID + '/query',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    }
  };

  const filter = {
    and: [
      {
        property: 'Format',
        select: {
          equals: 'Book'
        }
      },
      {
        property: 'Book Description',
        rich_text: {
          is_empty: true
        }
      }
    ]
  };

  const body = {
    filter: filter,
    sorts: [
      {
        property: 'Name',
        direction: 'ascending'
      }
    ],
    page_size: MAX_BOOKS_PER_RUN
  };

  return await httpsRequest(options, body);
}

async function updateNotionDescription(pageId, description) {
  // Truncate if over Notion's limit, breaking at a sentence boundary
  let text = description;
  if (text.length > MAX_DESCRIPTION_LENGTH) {
    text = text.substring(0, MAX_DESCRIPTION_LENGTH);
    const lastPeriod = text.lastIndexOf('.');
    const lastExclamation = text.lastIndexOf('!');
    const lastQuestion = text.lastIndexOf('?');
    const lastSentenceEnd = Math.max(lastPeriod, lastExclamation, lastQuestion);

    if (lastSentenceEnd > MAX_DESCRIPTION_LENGTH * 0.7) {
      text = text.substring(0, lastSentenceEnd + 1);
    }
  }

  const options = {
    hostname: 'api.notion.com',
    path: `/v1/pages/${pageId}`,
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    }
  };

  const body = {
    properties: {
      'Book Description': {
        rich_text: [
          {
            type: 'text',
            text: {
              content: text
            }
          }
        ]
      }
    }
  };

  return await httpsRequest(options, body);
}

// ============================================
// BOOK DESCRIPTION SEARCH FUNCTIONS
// ============================================

async function searchGoogleBooksDescription(title, author) {
  const query = author ? `${title} ${author}` : title;
  const encodedQuery = encodeURIComponent(query);

  const options = {
    hostname: 'www.googleapis.com',
    path: `/books/v1/volumes?q=${encodedQuery}&maxResults=5`,
    method: 'GET'
  };

  try {
    const data = await httpsRequest(options);

    if (!data.items || data.items.length === 0) {
      return [];
    }

    return data.items
      .filter(item => item.volumeInfo?.description)
      .map(item => {
        const v = item.volumeInfo;
        return {
          title: v.title || 'Unknown',
          authors: v.authors || [],
          description: v.description,
          source: 'Google Books'
        };
      });
  } catch (error) {
    console.log('  X Google Books error:', error.message);
    return [];
  }
}

async function searchOpenLibraryDescription(title, author) {
  // Rate limit courtesy pause
  await new Promise(resolve => setTimeout(resolve, 1000));

  const query = author ? `${title} ${author}` : title;
  const encodedQuery = encodeURIComponent(query);

  const searchOptions = {
    hostname: 'openlibrary.org',
    path: `/search.json?q=${encodedQuery}&limit=3`,
    method: 'GET',
    headers: {
      'User-Agent': 'NotionBookDescriptionBot/1.0'
    }
  };

  try {
    const searchData = await httpsRequest(searchOptions);

    if (!searchData.docs || searchData.docs.length === 0) {
      return [];
    }

    const results = [];

    for (const doc of searchData.docs.slice(0, 3)) {
      if (!doc.key) continue;

      // Courtesy delay between Open Library requests
      await new Promise(resolve => setTimeout(resolve, 500));

      const workOptions = {
        hostname: 'openlibrary.org',
        path: `${doc.key}.json`,
        method: 'GET',
        headers: {
          'User-Agent': 'NotionBookDescriptionBot/1.0'
        }
      };

      try {
        const workData = await httpsRequest(workOptions);

        // Description can be a string or an object with { type, value }
        let description = null;
        if (typeof workData.description === 'string') {
          description = workData.description;
        } else if (workData.description?.value) {
          description = workData.description.value;
        }

        if (description) {
          results.push({
            title: doc.title || 'Unknown',
            authors: doc.author_name || [],
            description: description,
            source: 'Open Library'
          });
        }
      } catch (err) {
        console.log(`    Open Library work fetch failed: ${err.message}`);
      }
    }

    return results;
  } catch (error) {
    console.log('  X Open Library error:', error.message);
    return [];
  }
}

async function searchHardcoverDescription(title, author) {
  if (!HARDCOVER_TOKEN) {
    return [];
  }

  const query = author ? `${title} ${author}` : title;

  const graphqlQuery = {
    query: `{ search(query: "${query.replace(/"/g, '\\"')}", query_type: "books", per_page: 3) { results } }`
  };

  const postBody = JSON.stringify(graphqlQuery);

  const options = {
    hostname: 'api.hardcover.app',
    path: '/v1/graphql',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${HARDCOVER_TOKEN}`
    }
  };

  try {
    const data = await httpsRequest(options, postBody);

    if (!data?.data?.search?.results?.hits) {
      return [];
    }

    return data.data.search.results.hits
      .filter(hit => hit.document?.description)
      .map(hit => {
        const doc = hit.document;
        return {
          title: doc.title || 'Unknown',
          authors: doc.author_names || [],
          description: doc.description,
          source: 'Hardcover'
        };
      });
  } catch (error) {
    console.log('  X Hardcover error:', error.message);
    return [];
  }
}

async function searchGoodreadsDescription(title, author) {
  const query = author ? `${title} ${author}` : title;
  const encodedQuery = encodeURIComponent(query);

  // Step 1: Search Goodreads for the book page URL
  const searchOptions = {
    hostname: 'www.goodreads.com',
    path: `/search?q=${encodedQuery}`,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    }
  };

  try {
    const searchHtml = await httpsRequest(searchOptions);

    if (typeof searchHtml !== 'string') {
      return [];
    }

    // Extract the first book URL from search results
    const bookUrlMatch = searchHtml.match(/\/book\/show\/\d+[^"'\s]*/);
    if (!bookUrlMatch) {
      return [];
    }

    const bookPath = bookUrlMatch[0];

    // Courtesy delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 2: Fetch the book page
    const bookOptions = {
      hostname: 'www.goodreads.com',
      path: bookPath,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    };

    const bookHtml = await httpsRequest(bookOptions);

    if (typeof bookHtml !== 'string') {
      return [];
    }

    // Step 3: Extract description from data-testid="description" area
    // Find the description section and extract text from span.Formatted
    const descSectionMatch = bookHtml.match(/data-testid="description"[\s\S]*?<span class="Formatted">([\s\S]*?)<\/span>/);
    if (!descSectionMatch) {
      return [];
    }

    let description = descSectionMatch[1];

    // Convert <br> to newlines, strip remaining HTML tags
    description = description.replace(/<br\s*\/?>/g, '\n');
    description = description.replace(/<[^>]*>/g, '');
    description = description.replace(/\n{3,}/g, '\n\n').trim();

    // Decode HTML entities
    description = description
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, ' ');

    if (description.length < 20) {
      return [];
    }

    // Extract title from page for logging
    const pageTitleMatch = bookHtml.match(/<title>([^<]*)<\/title>/);
    const pageTitle = pageTitleMatch ? pageTitleMatch[1].replace(/ by .*/, '').trim() : 'Unknown';

    return [{
      title: pageTitle,
      authors: author ? [author] : [],
      description: description,
      source: 'Goodreads'
    }];
  } catch (error) {
    console.log('  X Goodreads error:', error.message);
    return [];
  }
}

// ============================================
// CLAUDE AI FUNCTIONS
// ============================================

async function askClaudeToPickBestDescription(title, author, descriptions) {
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  };

  const prompt = `I have multiple descriptions for the book "${title}" by ${author || 'Unknown'}. Pick the one that is the BEST and most complete actual book description/blurb.

Prefer descriptions that:
- Actually describe what the book is about (plot, themes, premise)
- Are substantive (not just one sentence)
- Read like a back-of-book blurb

Avoid descriptions that are mostly:
- Press quotes or review excerpts
- Lists of awards
- Author biographical information

${descriptions.map((d, i) => `--- Description ${i + 1} (${d.source}) ---\n${d.description}`).join('\n\n')}

Respond with ONLY the number (1, 2, 3, etc.) of the best description.`;

  const body = {
    model: 'claude-3-haiku-20240307',
    max_tokens: 50,
    messages: [{ role: 'user', content: prompt }]
  };

  try {
    const response = await httpsRequest(options, body);

    if (!response || !response.content || !Array.isArray(response.content) || response.content.length === 0) {
      return 0;
    }

    const answer = response.content[0].text.trim();
    const digitMatch = answer.match(/\b(\d+)\b/);

    if (digitMatch) {
      const number = parseInt(digitMatch[1]);
      if (number >= 1 && number <= descriptions.length) {
        return number - 1; // Convert to 0-indexed
      }
    }

    return 0; // Default to first description
  } catch (error) {
    console.log('  X Claude pick error:', error.message);
    return 0;
  }
}

async function askClaudeToCleanDescription(title, author, rawDescription) {
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  };

  const prompt = `Clean this book description for "${title}" by ${author || 'Unknown'}.

REMOVE all of the following:
- Press/review quotes (e.g., "'A masterpiece' - New York Times", "'Brilliant!' - Stephen King")
- Bestseller/award mentions (e.g., "A #1 New York Times Bestseller", "Winner of the Pulitzer Prize")
- Author endorsement quotes from other authors
- "Now a major motion picture" or similar promotional lines
- Phrases like "From the author of [other book]..." at the very start (but keep if it's mid-description context)
- Marketing superlatives not part of the actual blurb ("The must-read book of the year!")

KEEP:
- The actual book description/blurb text that describes what the book is about
- Plot summary, character introductions, thematic descriptions
- Any "about the book" content that tells the reader what to expect

RULES:
- Return ONLY the cleaned description text, nothing else
- Do NOT add any commentary, headers, or labels
- Do NOT start with phrases like "Here is..." or "The cleaned description..." -- begin DIRECTLY with the book description text
- Do NOT rewrite or paraphrase -- preserve the original wording of the kept parts
- If after removing everything there is very little left, return what you can -- even a single descriptive sentence is fine
- If the ENTIRE description is quotes/accolades with zero actual blurb, return the original text as-is (something is better than nothing)
- Strip any HTML tags if present

Raw description:
${rawDescription}`;

  const body = {
    model: 'claude-3-haiku-20240307',
    max_tokens: 2048,
    system: 'You are a text processing tool. Output ONLY the processed text. Never add introductions, labels, headers, or commentary. Begin your response directly with the book description text.',
    messages: [{ role: 'user', content: prompt }]
  };

  try {
    const response = await httpsRequest(options, body);

    if (!response?.content?.[0]?.text) {
      return rawDescription;
    }

    let cleaned = response.content[0].text.trim();

    // Strip any AI-generated intro lines like "Here is the cleaned description for..."
    cleaned = cleaned.replace(/^(?:Here(?:'s| is) the cleaned (?:book )?description.*?:\s*)/i, '');

    // Safety fallback: if Claude returned something very short but original was substantial
    if (cleaned.length < 20 && rawDescription.length > 200) {
      console.log('  ! Claude returned very short result, using original');
      return rawDescription;
    }

    // Strip any remaining HTML tags as safety net
    cleaned = cleaned.replace(/<[^>]*>/g, '');

    return cleaned;
  } catch (error) {
    console.log('  X Claude clean error:', error.message);
    return rawDescription;
  }
}

// ============================================
// SLACK NOTIFICATION
// ============================================

async function sendSlackNotification(successBooks, failedBooks, runTime) {
  if (!SLACK_WEBHOOK_URL) {
    console.log('\nNo Slack webhook configured, skipping notification');
    return;
  }

  const url = new URL(SLACK_WEBHOOK_URL);

  const pacificTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'full',
    timeStyle: 'short'
  }).format(runTime);

  let message = `*Book Description Automation Report*\n${pacificTime}\n\n`;

  if (successBooks.length > 0) {
    message += `*${successBooks.length} description${successBooks.length === 1 ? '' : 's'} added:*\n`;
    successBooks.forEach(book => {
      message += `- <${book.url}|${book.title}>${book.author ? ` by ${book.author}` : ''}\n`;
    });
    message += '\n';
  }

  if (failedBooks.length > 0) {
    message += `*${failedBooks.length} book${failedBooks.length === 1 ? '' : 's'} skipped:*\n`;
    failedBooks.forEach(book => {
      message += `- <${book.url}|${book.title}>${book.author ? ` by ${book.author}` : ''}\n  _Reason: ${book.reason}_\n`;
    });
    message += '\n';
  }

  if (successBooks.length === 0 && failedBooks.length === 0) {
    message += 'No books needed descriptions\n';
  }

  if (process.env.GITHUB_RUN_ID) {
    const repo = process.env.GITHUB_REPOSITORY;
    const runId = process.env.GITHUB_RUN_ID;
    message += `\n<https://github.com/${repo}/actions/runs/${runId}|View full logs on GitHub>`;
  }

  const payload = { text: message };

  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  try {
    await httpsRequest(options, payload);
    console.log('Slack notification sent');
  } catch (error) {
    console.log('Failed to send Slack notification:', error.message);
  }
}

// ============================================
// MAIN PROCESSING
// ============================================

(async () => {
  const startTime = new Date();
  console.log('=== Book Description Automation Started ===');
  console.log(startTime.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  console.log(`Max books per run: ${MAX_BOOKS_PER_RUN}\n`);

  const successBooks = [];
  const failedBooks = [];

  try {
    const response = await getNotionPages();
    const pages = response.results || [];

    console.log(`Found ${pages.length} book(s) needing descriptions\n`);

    for (const page of pages) {
      const properties = page.properties;
      const titleProp = properties['Media'] || properties['Title'] || properties['Name'];
      const sourceProp = properties['Source'];

      const title = titleProp?.title?.[0]?.plain_text || 'Unknown';
      const author = sourceProp?.rich_text?.[0]?.plain_text || '';
      const pageUrl = `https://notion.so/${page.id.replace(/-/g, '')}`;

      console.log(`\nProcessing: ${title}${author ? ` by ${author}` : ''}`);
      console.log('  Searching for descriptions...');

      const googleResults = await searchGoogleBooksDescription(title, author);
      const openLibResults = await searchOpenLibraryDescription(title, author);
      const hardcoverResults = await searchHardcoverDescription(title, author);

      let allResults = [...googleResults, ...openLibResults, ...hardcoverResults];

      // If no results from APIs, try scraping Goodreads as a last resort
      if (allResults.length === 0) {
        console.log('  No API results, trying Goodreads scraping...');
        const goodreadsResults = await searchGoodreadsDescription(title, author);
        allResults = goodreadsResults;
      }

      if (allResults.length === 0) {
        console.log('  X No descriptions found - skipping');
        failedBooks.push({ title, author, url: pageUrl, reason: 'No descriptions found' });
        continue;
      }

      console.log(`  Found ${allResults.length} description(s)`);

      // Pick the best description
      let selectedDescription;

      if (allResults.length === 1) {
        console.log('  Using the only description found');
        selectedDescription = allResults[0].description;
      } else {
        console.log('  Asking Claude to pick best description...');
        const selectedIndex = await askClaudeToPickBestDescription(title, author, allResults);
        selectedDescription = allResults[selectedIndex].description;
        console.log(`  Selected description #${selectedIndex + 1} from ${allResults[selectedIndex].source}`);
      }

      // Clean the description with Claude
      console.log('  Cleaning description with Claude...');
      const cleanedDescription = await askClaudeToCleanDescription(title, author, selectedDescription);

      if (cleanedDescription.length > MAX_DESCRIPTION_LENGTH) {
        console.log(`  ! Description is ${cleanedDescription.length} chars, will truncate to ${MAX_DESCRIPTION_LENGTH}`);
      }

      // Update Notion
      console.log('  Updating Notion...');
      try {
        await updateNotionDescription(page.id, cleanedDescription);
        console.log('  Done!');
        successBooks.push({ title, author, url: pageUrl });
      } catch (error) {
        console.log(`  X Notion update failed: ${error.message}`);
        failedBooks.push({ title, author, url: pageUrl, reason: `Update failed: ${error.message}` });
      }

      // Rate limiting pause between books
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log('\n=== Summary ===');
    console.log(`Processed: ${pages.length}`);
    console.log(`Done: ${successBooks.length}`);
    console.log(`Skipped: ${failedBooks.length}`);

    await sendSlackNotification(successBooks, failedBooks, startTime);

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
})();
