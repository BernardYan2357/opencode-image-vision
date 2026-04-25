# opencode-image-vision

Image vision, OCR, and clipboard support for OpenCode — enables vision models for models that don't support image input.

## Installation

```bash
npm install opencode-image-vision
```

Configure in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    ["opencode-image-vision", {
      "vision": {
        "provider": "custom",
        "model": "Qwen/Qwen3-VL-8B-Instruct",
        "apiKey": "your-key",
        "baseUrl": "https://your-api.com/v1",
        "language": "zh"
      },
      "ocr": {
        "provider": "custom",
        "model": "deepseek-ai/DeepSeek-OCR",
        "apiKey": "your-key",
        "baseUrl": "https://your-api.com/v1"
      },
      "clipboard": {
        "enabled": true
      }
    }]
  ]
}
```

Copy SKILL.md to opencode skills directory:

```bash
mkdir -p ~/.config/opencode/skills/read-ocr
cp path/to/opencode-image-vision/skills/read-ocr/SKILL.md ~/.config/opencode/skills/read-ocr/
```

## Features

| Feature | Tool | Description |
| --- | --- | --- |
| **Vision** | `read-image` | Image/PDF → text description (scene, layout, colors) |
| **OCR** | `read-ocr` | Image/PDF → plain text (accurate extraction) |
| **Clipboard** | automatic | Pasting images auto-saves to local files |

## Configuration

### apiKey Priority

1. `apiKey` field (inline value)
2. `apiKeyEnv` environment variable name
3. Provider default env var: `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`

### Vision Providers

#### Custom (OpenAI-compatible API)

```json
{
  "vision": {
    "provider": "custom",
    "model": "Qwen/Qwen3-VL-8B-Instruct",
    "apiKey": "sk-xxx",
    "baseUrl": "https://api.siliconflow.cn/v1",
    "language": "zh"
  }
}
```

#### OpenAI

```json
{
  "vision": {
    "provider": "openai",
    "model": "gpt-4o",
    "apiKey": "sk-proj-xxx",
    "language": "zh"
  }
}
```

#### Anthropic

```json
{
  "vision": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "apiKey": "sk-ant-xxx",
    "language": "zh"
  }
}
```

### OCR Provider

OCR only supports `custom` (OpenAI-compatible API):

```json
{
  "ocr": {
    "provider": "custom",
    "model": "deepseek-ai/DeepSeek-OCR",
    "apiKey": "sk-xxx",
    "baseUrl": "https://api.siliconflow.cn/v1"
  }
}
```

## Tools

### read-image

Returns a detailed text description of an image or PDF.

```
read-image(path: "screenshot.png", prompt?: "focus on UI elements")
```

### read-ocr

Returns raw text extracted from an image or PDF.

```
read-ocr(path: "document.pdf", language: "zh")
```

## How It Works

### Vision

```
agent calls read(image.png)
  → tool.execute.before intercepts
  → model supports vision? → yes → skip
                            → no ↓
  → check cache → hit → return
                → miss → vision API → write temp file → redirect path
```

### OCR

```
agent calls read-ocr(image.png)
  → call OCR API (OpenAI-compatible)
  → returns extracted text
```

### Clipboard

```
user pastes image (Ctrl+V)
  → experimental.chat.messages.transform intercepts
  → saves to temp file
  → replaces with file path
  → subsequent read triggers vision description
```

## FAQ

### 401 / Connection error

Check that `apiKey` is correctly configured.

### First read is slow

Model cold start 10-30s. Plugin warms up the model during initialization.

### Chinese text garbled

Temp files include UTF-8 BOM.

## License

MIT
