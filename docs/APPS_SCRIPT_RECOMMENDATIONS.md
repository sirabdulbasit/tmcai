# Apps Script & Data Pipeline — Recommendations

**Date**: 2026-03-30

---

## Current Flow

```
Google Sheets (HR, Projects, Sales, etc.)
    ↓ Apps Script reads all sheets
TMC_Drive_Index.md (single file, 500K+ chars)
    ↓ Server fetches every 5 min
Parsed into 12 sections
    ↓ Sections truncated to fit context limits
AI sees partial data → may report wrong counts
```

## Problem: Data Accuracy

The AI currently truncates large sections (110K employee data → 20K context). Even with the Data Summary providing exact counts, when users ask "list all employees in delivery department", they only see a partial list.

---

## Recommendation 1: Add Summary Stats Per Sheet

**Already implemented in your updated Apps Script.** The `getRecordCounts()` and `getSingleSheetCount()` functions now generate exact counts at the source. The server reads these from the `## Data Summary` section.

**Status: DONE**

---

## Recommendation 2: Add Column Metadata to Help AI Understand Data

Currently the AI sees raw pipe-delimited data but doesn't know what each column means. Add a brief column description after each sheet header:

```javascript
// In contentToReadableText(), after writing headers:
function contentToReadableText(content) {
  if (Array.isArray(content)) {
    let text = "";
    content.forEach(sheet => {
      text += "Sheet: " + sheet.sheetName + "\n";
      if (sheet.rows && sheet.rows.length > 0) {
        // Add column descriptions for AI context
        text += "_Columns: " + sheet.headers.join(", ") + "_\n";
        text += sheet.headers.join(" | ") + "\n";
        text += sheet.headers.map(() => "---").join(" | ") + "\n";
        // ... rest of rows
```

**Impact**: AI better understands what each column means, reducing misinterpretation.

---

## Recommendation 3: Smart Row Ordering (Critical Rows First)

When the server truncates a section, it cuts from the bottom. If important data (critical risks, recent deals) is at the bottom, it gets cut.

**Fix in Apps Script**: Sort rows by importance before writing to markdown:

```javascript
// In contentToReadableText(), sort rows before writing:
if (nameLower.includes("project")) {
  // Sort by risk (critical first) then by progress (lowest first)
  sheet.rows.sort((a, b) => {
    const riskOrder = { "Critical": 0, "High": 1, "Medium": 2, "Low": 3, "None": 4 };
    const rA = riskOrder[a["Risk Level"]] ?? 5;
    const rB = riskOrder[b["Risk Level"]] ?? 5;
    if (rA !== rB) return rA - rB;
    return (a["Overall Progress %"] || 0) - (b["Overall Progress %"] || 0);
  });
} else if (nameLower.includes("deal")) {
  // Sort by date closed (most recent first)
  sheet.rows.sort((a, b) => {
    return new Date(b["Date Closed"] || 0) - new Date(a["Date Closed"] || 0);
  });
}
```

**Impact**: When truncation happens, the MOST important data is always included.

---

## Recommendation 4: Section Size Limits in Apps Script

Some sections are massive (Sales Deals = 217K chars, Employee Profile = 110K chars). The AI can only use ~20-35K of context per query. Instead of letting the server truncate blindly, the Apps Script should limit output intelligently:

```javascript
const SECTION_LIMITS = {
  "Project Status": { maxRows: 100, sortBy: "Overall Progress %", sortDir: "asc" },
  "HR — Employee Profile Sheet": { maxRows: 700, sortBy: null },
  "Sales Deals": { maxRows: 600, sortBy: "Date Closed", sortDir: "desc" },
  "Sales — Live Pipeline Snapshot": { maxRows: 50, sortBy: null },
};
```

**Impact**: Keeps the markdown file from growing unbounded as data grows.

---

## Recommendation 5: Incremental Updates (Performance)

Currently, every hour the Apps Script:
1. Reads ALL files from Drive folder
2. Rebuilds the ENTIRE markdown file
3. Deletes old file, creates new one

For large datasets, this takes time and is wasteful when only 1 file changed.

**Better approach**: Track file modification timestamps and only re-read changed files:

```javascript
function runFullPipeline() {
  const lastRunTime = PropertiesService.getScriptProperties().getProperty('LAST_RUN_TIME');
  const data = getAllFilesData(FOLDER_ID, lastRunTime ? new Date(lastRunTime) : null);

  if (data.changedFiles.length === 0) {
    Logger.log('No changes detected — skipping rebuild.');
    return;
  }

  // Merge changed data with cached data
  // ... rebuild only affected sections
}
```

**Impact**: Faster refresh cycles, less Drive API usage.

---

## Recommendation 6: Data Validation in Apps Script

Add validation before writing to markdown to catch data quality issues:

```javascript
function validateData(file) {
  const warnings = [];

  if (Array.isArray(file.content)) {
    file.content.forEach(sheet => {
      // Check for empty key columns
      const keyCol = inferKeyColumn(file.name, sheet.headers.map(h => h.toLowerCase()));
      if (keyCol) {
        const emptyKeys = sheet.rows.filter(r => !r[sheet.headers[keyCol]] || r[sheet.headers[keyCol]].toString().trim() === "-");
        if (emptyKeys.length > 0) {
          warnings.push(`${file.name}/${sheet.sheetName}: ${emptyKeys.length} rows have empty key column`);
        }
      }

      // Check for duplicate keys
      const keys = new Set();
      const dupes = [];
      sheet.rows.forEach(r => {
        const val = r[sheet.headers[keyCol]]?.toString().trim();
        if (val && keys.has(val)) dupes.push(val);
        keys.add(val);
      });
      if (dupes.length > 0) {
        warnings.push(`${file.name}/${sheet.sheetName}: ${dupes.length} duplicate keys found`);
      }
    });
  }

  return warnings;
}
```

**Impact**: Catches data issues at the source before they reach the AI.

---

## Recommendation 7: Notify Server After Refresh

Your Apps Script already calls `refreshDataAPICache()`. Update the server URL to trigger an immediate index refresh:

```javascript
function refreshDataAPICache() {
  const serverUrl = PropertiesService.getScriptProperties().getProperty('DATA_API_URL');
  if (!serverUrl) return;

  try {
    // Trigger server to re-fetch the updated Drive file
    UrlFetchApp.fetch(serverUrl + "/api/index/refresh", {
      method: "POST",
      muteHttpExceptions: true
    });
    Logger.log('Server index refresh triggered.');
  } catch(e) {
    Logger.log('Server refresh failed: ' + e.toString());
  }
}
```

The server endpoint already exists at `POST /api/index/refresh`. This ensures the server picks up new data immediately instead of waiting up to 5 minutes.

---

## Recommendation 8: Add Data Quality Score

Add a quality indicator per section so the AI knows when data might be incomplete:

```javascript
// In the Data Summary section:
md += "## Data Summary\n";
md += "_Data Quality: All sheets refreshed successfully_\n\n";

data.forEach(file => {
  const counts = getRecordCounts(file);
  const quality = validateData(file);
  const status = quality.length === 0 ? "✓" : "⚠ " + quality.length + " issues";
  if (counts) md += "- **" + file.name + "**: " + counts + " (" + status + ")\n";
});
```

**Impact**: AI can mention "Note: employee data has 3 quality warnings" when relevant.

---

## Server-Side Changes Needed

### 1. Read Routing Manifest (NEW)

The Apps Script now generates a Routing Manifest. The server should use it to find the right section faster:

```typescript
// In indexCacheService.ts — parse routing manifest
export function getRoutingManifest(): Map<string, { fileName: string; sheet: string; keyColumn: string; records: string }> {
  const manifest = new Map();
  const section = cachedSections.find(s => s.headerLower.includes('routing manifest'));
  if (!section) return manifest;

  // Parse the markdown table
  const lines = section.body.split('\n').filter(l => l.startsWith('|') && !l.includes('---'));
  // Skip header row
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length >= 5) {
      const keywords = cols[0].split(',').map(k => k.trim().toLowerCase());
      keywords.forEach(kw => {
        manifest.set(kw, {
          fileName: cols[1],
          sheet: cols[3],
          keyColumn: cols[4],
          records: cols[5] || '',
        });
      });
    }
  }
  return manifest;
}
```

### 2. Use Manifest in Section Retrieval

Before embedding-based section matching, check the manifest for a direct match:

```typescript
// In chatController.ts, before retrieveFullSections():
const manifest = getRoutingManifest();
const matchedRoute = [...manifest.entries()].find(([kw]) =>
  scope.toLowerCase().includes(kw)
);
if (matchedRoute) {
  // Direct section retrieval by file name — no embedding needed
  const section = sections.find(s => s.headerLower.includes(matchedRoute[1].fileName.toLowerCase()));
  if (section) {
    context = section.body.slice(0, maxChars);
    // Skip embedding call — save 1-2s
  }
}
```

### 3. Data Summary Already Reads from File

The `getDataSummary()` function already checks for "Data Summary" section first (Layer 1). No changes needed — it will automatically use the Apps Script-generated counts once the Drive file is refreshed.

---

## Priority Order

| # | Change | Where | Impact | Effort |
|---|--------|-------|--------|--------|
| 1 | Record counts in Data Summary | Apps Script (DONE) | Data accuracy | Done |
| 2 | Routing Manifest | Apps Script (DONE) | Faster retrieval | Done |
| 3 | Server reads Data Summary | Server (DONE) | Exact counts | Done |
| 4 | Sort rows by importance | Apps Script | Better truncation | Medium |
| 5 | Notify server after refresh | Apps Script | Instant data update | Low |
| 6 | Data validation | Apps Script | Catch errors early | Medium |
| 7 | Server reads Routing Manifest | Server | Skip embedding, 1-2s faster | Medium |
| 8 | Incremental updates | Apps Script | Faster refresh cycle | High |
