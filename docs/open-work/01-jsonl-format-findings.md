# JSONL Session-File Format Findings (Task 1 Spike)

Date: 2026-05-24  
Status: complete

---

## Files Inspected

| # | Project dir | Session file (truncated) | Size | Age |
|---|-------------|--------------------------|------|-----|
| 1 | `C--Glean` | `57c3184c-…1875.jsonl` | ~987 KB, 319 lines | ~8 h old |
| 2 | `C--career-ops` | `8735be52-…6819.jsonl` | ~3.3 MB, 356 lines | ~31 h old |
| 3 | `C--ClaudeCode-Work` | `a6cd814c-…53d0.jsonl` | ~52 KB, 30 lines | ~21 days old |
| 4 | `C--Users-user-OneDrive-Documents-Github-Jonny` | `576d09f1-…eeba0.jsonl` | ~565 lines | ~32 h old |

---

## Confirmed Field Names and JSON Paths

### Timestamp

- **Field name:** `timestamp`
- **Location:** top-level on `assistant`, `user`, `system`, `queue-operation`, and `attachment` records
- **Raw format in JSON:** ISO 8601 UTC string — `"2026-05-23T19:41:03.105Z"`
- **Note:** PowerShell's `ConvertFrom-Json` silently converts this to a local `DateTime` object. When reading the raw JSON string (e.g. via regex or `jq`/`JSON.parse` in Node), it is always ISO 8601.
- **Missing on:** `ai-title`, `last-prompt`, `permission-mode` records — these carry no timestamp.

### Working Directory

- **Field name:** `cwd`
- **Location:** top-level on `assistant`, `user`, `system`, `attachment` records
- **Value:** absolute OS path, e.g. `C:\Glean` or `C:\career_ops`
- **Missing on:** `ai-title`, `last-prompt`, `permission-mode`, `queue-operation` records
- **Key finding:** `cwd` is the reliable way to disambiguate dash-encoded path collisions in the project directory name. The dash-encoded folder name (e.g. `C--career-ops`) can be ambiguous; `cwd` on any `assistant` or `user` record gives the canonical path.

### aiTitle

- **Field name:** `aiTitle`
- **Location:** top-level on records of `type === "ai-title"` — a dedicated record type, not embedded in `assistant` or `user`
- **Record shape:** `{"type":"ai-title","aiTitle":"<human-readable title>","sessionId":"<uuid>"}`
- **No timestamp on ai-title records.** To find when a session's title was set, correlate `sessionId` with the surrounding `assistant`/`user` records.
- **Appears multiple times:** A session file accumulates one `ai-title` record per conversation leg (Claude Code appends a new one each time the title is regenerated). The **last** `ai-title` record in the file is the most current title.
- **May be absent:** File 4 (OneDrive/Github session, 565 lines) had **zero** `ai-title` records. Treat `aiTitle` as optional; fall back to `null` or derive from first user message.

### Session ID

- **Field name:** `sessionId`
- **Location:** top-level on every record type
- **Value:** UUID matching the JSONL filename (e.g. `57c3184c-13f0-4fe7-acca-17d6726d1875`)

### Record Type (`type`)

Observed values across all 4 files:

| type | Has `timestamp` | Has `cwd` | Notes |
|------|----------------|-----------|-------|
| `assistant` | yes | yes | Main response records; richest field set |
| `user` | yes | yes | User turn records |
| `system` | yes | yes | System prompt / context injection |
| `attachment` | yes | yes | File attachments |
| `ai-title` | **no** | **no** | Carries `aiTitle`; no temporal data |
| `last-prompt` | **no** | **no** | Leaf node marker |
| `permission-mode` | **no** | **no** | Permission state snapshot |
| `queue-operation` | yes | **no** | Seen in newer sessions only |
| `file-history-snapshot` | — | — | File state snapshots |

**No `summary` record type was found** in any of the 4 files (nor in any other file across all project directories). The plan's `findLastSummary` concept needs adjustment — see section below.

### Slug

- **Field name:** `slug`
- **Location:** top-level on `assistant`, `user`, `system`, `attachment` records
- **Value:** human-readable kebab-case string, e.g. `"snuggly-strolling-hummingbird"`
- **Availability:** present in some sessions (File 1/Glean), absent in others (career-ops). Not reliable as a display name. Use `aiTitle` instead.

### Other Notable Fields (on `assistant` records)

- `uuid` — record-level UUID
- `parentUuid` — threading pointer
- `gitBranch` — active git branch, e.g. `"HEAD"` or `"main"`
- `isSidechain` — boolean; `false` on main conversation records
- `userType` — `"external"` on all observed records
- `version` — Claude Code client version string, e.g. `"2.1.150"`
- `entrypoint` — observed but often empty

---

## How to Derive `idle_hours`

```
idle_hours = (now_utc - last_assistant_timestamp) / 3600
```

- Find the **last record** of type `assistant` (or `user`) in the file.
- Read its `timestamp` field (ISO 8601 UTC string).
- Subtract from `Date.now()` / `new Date()` in UTC.
- Do **not** use the literal last line of the file for this — the last line is frequently `permission-mode` or `last-prompt`, which carry no timestamp.

---

## Surprises

1. **No `summary` record type.** The plan referenced `findLastSummary` as if a `summary` record holds the `aiTitle`. It does not exist. `aiTitle` lives on a dedicated `"ai-title"` record type.

2. **`aiTitle` can appear many times.** A 319-line file had 16 `ai-title` records, all with the same value in this case. Use the **last** occurrence.

3. **`aiTitle` can be absent entirely.** File 4 (565 lines, active session) had no `ai-title` records. `discover-jsonl.ts` must handle missing title gracefully.

4. **Literal last line is rarely `assistant`.** Across all 4 files the last line was: `assistant` (File 1), `permission-mode` (Files 2 and 3), `last-prompt` (File 4). Never assume the last line carries the timestamp.

5. **`cwd` is empty on `permission-mode`, `last-prompt`, and `ai-title`.** Only `assistant`/`user`/`system` records have a populated `cwd`.

6. **Timestamp format is consistently ISO 8601 UTC** (`"2026-05-23T19:41:03.105Z"`) across all files and record types that carry a timestamp. No epoch integers observed.

7. **`queue-operation` is a newer record type** not present in older sessions (May 3 file). Its `timestamp` is populated but `cwd` is empty.

8. **Multi-line JSON: none observed.** Every line in every file is a single complete JSON object. No truncation or continuation lines found.

---

## Sanitized Example Records

### `ai-title` record
```json
{"type":"ai-title","aiTitle":"[REDACTED SESSION TITLE]","sessionId":"[UUID]"}
```

### `assistant` record (structure only, values redacted)
```json
{
  "type": "assistant",
  "uuid": "[UUID]",
  "sessionId": "[UUID]",
  "parentUuid": "[UUID]",
  "timestamp": "2026-05-23T19:41:03.105Z",
  "cwd": "C:\\[PROJECT-PATH]",
  "gitBranch": "HEAD",
  "isSidechain": false,
  "userType": "external",
  "version": "2.1.150",
  "requestId": "[ID]",
  "slug": "snuggly-strolling-hummingbird",
  "message": { "...": "..." },
  "entrypoint": "",
  "attributionSkill": "..."
}
```

---

## What This Means for `discover-jsonl.ts` (Plan Task 10)

### 1. Replace `findLastSummary` with `findLastAiTitle`

There is no `summary` record type. Rename the helper to `findLastAiTitle` and scan for records where `record.type === "ai-title"`, returning `record.aiTitle` from the **last** match. Return `null` if none found.

```typescript
function findLastAiTitle(records: SessionRecord[]): string | null {
  const aiTitleRecords = records.filter(r => r.type === 'ai-title');
  if (aiTitleRecords.length === 0) return null;
  return aiTitleRecords[aiTitleRecords.length - 1].aiTitle ?? null;
}
```

### 2. Last timestamp: scan backwards for assistant/user records

Do not use the last line's timestamp. Scan from the end of the records array for the first record with `type === 'assistant'` or `type === 'user'` and a non-empty `timestamp`.

```typescript
function findLastTimestamp(records: SessionRecord[]): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if ((r.type === 'assistant' || r.type === 'user') && r.timestamp) {
      return r.timestamp; // ISO 8601 UTC string
    }
  }
  return null;
}
```

### 3. `cwd` derivation: read from first assistant/user/system record

Read `cwd` from the first record of type `assistant`, `user`, or `system` that has a non-empty `cwd`. This is more reliable than decoding the dash-encoded directory name.

### 4. `aiTitle` is optional — always null-guard

Some sessions (new, or very brief) never generate an `ai-title` record. `discover-jsonl.ts` must handle this: fall back to the first user message excerpt or `null`.

### 5. `sessionId` from filename, not records

The `sessionId` field on every record matches the JSONL filename UUID. Reading `path.basename(file, '.jsonl')` is cheaper than parsing any record.

### 6. Timestamp is ISO 8601 — parse with `new Date()`

All timestamps observed are `"YYYY-MM-DDTHH:mm:ss.mmmZ"`. `new Date(timestamp)` is safe. No epoch integers to handle.

### 7. Record type safety

Parse defensively — `queue-operation` and other types may appear and expand over time. Use a discriminated union or a `type` guard; do not assume unknown types have `timestamp` or `cwd`.
