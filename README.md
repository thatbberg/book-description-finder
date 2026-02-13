# Notion Book Descriptions Automation

Automatically finds and adds book descriptions to your Notion database using GitHub Actions.

## What It Does

1. Queries your Notion database for books where **Format = "Book"** and **Book Description is empty**
2. Searches Google Books and Open Library for the book's description/blurb
3. Uses Claude AI to pick the best description (when multiple are found)
4. Uses Claude AI to clean the description — removes press quotes, bestseller mentions, author endorsements, and other promotional text
5. Updates the Notion page's "Book Description" property with the cleaned text
6. Sends a Slack notification with results

## Setup Instructions

### 1. Create a new GitHub repository

1. Go to https://github.com/new
2. Name it something like `notion-book-descriptions`
3. You can make it private (still free for Actions)

### 2. Add your secrets to GitHub

1. Go to your repo → Settings → Secrets and variables → Actions
2. Click "New repository secret" and add these four secrets:

   - **NOTION_TOKEN** — Your Notion integration token
   - **ANTHROPIC_API_KEY** — Your Claude API key
   - **DATABASE_ID** — Your Notion database ID
   - **SLACK_WEBHOOK_URL** — Your Slack webhook URL (optional)

These are the same secrets used by the book cover automation.

### 3. Push your code to GitHub

```bash
cd ~/Documents
mkdir notion-book-descriptions
cd notion-book-descriptions

# Copy notion-book-descriptions.js into this folder

git init
mkdir -p .github/workflows

# Copy book-descriptions-workflow.yml to .github/workflows/book-descriptions.yml

git add .
git commit -m "Initial commit: Book description automation"

# Replace YOUR-USERNAME with your GitHub username
git remote add origin https://github.com/YOUR-USERNAME/notion-book-descriptions.git
git branch -M main
git push -u origin main
```

### 4. Done!

The workflow will now run:
- **Automatically** every 6 hours
- **Manually** whenever you go to Actions → Update Book Descriptions → Run workflow

## Slack Notifications

After each run, you'll get a Slack notification with:
- List of books that got descriptions (with clickable Notion links)
- List of books that were skipped (with reasons and clickable links)
- Link to the full GitHub Actions logs

## How It Works

- GitHub Actions provides a free Ubuntu machine
- Installs Node.js
- Runs your script with the secrets you provided
- For each book missing a description:
  - Searches Google Books API and Open Library API
  - If multiple descriptions found, Claude picks the best one
  - Claude cleans the description (removes quotes, accolades, promotional text)
  - Updates the Notion page
- Sends a Slack notification with results
- Processes up to 50 books per run, alphabetically

## Cost

**FREE** (or nearly free)

- GitHub Actions: free for public repos, 2,000 minutes/month for private repos
- Google Books API: free (no API key required)
- Open Library API: free
- Claude API (Haiku): fractions of a cent per book — well under $0.10 per 50-book run
