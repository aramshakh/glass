# Emotion JSON Migration

This update adds support for storing detected emotions alongside meeting summaries.

## Database Changes

The `summaries` table gains a new `emotion_json` column:

```sql
ALTER TABLE summaries ADD COLUMN emotion_json TEXT;
```

The application automatically performs this change on startup through the schema
synchronisation logic. Existing deployments should run the statement above if the
column is missing.

## Purpose

`emotion_json` stores an array of textual emotions inferred from the
conversation, allowing the renderer to display emotional context within the
summary view.

