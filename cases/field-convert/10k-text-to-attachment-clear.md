---
owner: backend-v2
tags: [field-convert, text, attachment, clear, 10k, v1-v2]
enabled: true
---

# field-convert/10k-text-to-attachment-clear

## Goal

Guard the destructive rewrite when incompatible text becomes an attachment field.

## Seed Phase

Create `Title` plus `Attachment Text`; every source cell contains deterministic
non-empty text rather than attachment JSON.

## Execute Phase

Convert the source field to attachment.

## Primary Metric

- `convertTextToAttachmentReadyMs` (initial guardrail: 15,000 ms).

## Verification

Assert routing and attachment target type, then require every incompatible value
to be null in a complete 10,000-row scan.

## Notes

This measures a full-column clear, not attachment upload or record mutation.
