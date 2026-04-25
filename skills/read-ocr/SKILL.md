---
name: read-ocr
description: Use OCR to accurately extract text from images when vision description fails to capture text content
license: MIT
compatibility: opencode
---

## When to use me

Use `read-ocr` instead of `read-image` when:

- The image contains **text that was not accurately recognized** by the vision model
- The user **specifically asks for OCR** or text extraction
- You need **raw text output** rather than a visual description
- The image contains **tables, code, formulas, or structured data** that need precise transcription
- The image is a **screenshot, scan, or document photo** where text accuracy is critical

## How to use

Call the `read-ocr` tool:

```
read-ocr(path: "path/to/image.png")
read-ocr(path: "screenshot.jpg", language: "zh")
read-ocr(path: "document.pdf")
```

### Parameters

- `path` (required): Path to the image or PDF file
- `language` (optional): Language hint like `"zh"`, `"en"`, `"ja"` — defaults to config setting

### Difference from read-image

| Tool | Purpose | Output |
|------|---------|--------|
| `read-image` | Visual description | Describes what the image looks like, including colors, layout, scene |
| `read-ocr` | Text extraction | Returns only the raw text content, preserving structure and formatting |

### Examples

**Screenshot with error message:**
```
read-ocr(path: "error-screenshot.png")
→ Returns the exact error text, stack trace, etc.
```

**Table in an image:**
```
read-ocr(path: "table.png", language: "en")
→ Returns the table data in structured text format
```

**Scanned document:**
```
read-ocr(path: "scan.pdf")
→ Returns all text content from the PDF
```
