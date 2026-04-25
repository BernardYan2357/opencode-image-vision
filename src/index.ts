/**
 * opencode-image-vision
 * 
 * 为不支持图片/PDF 输入的 AI 模型提供视觉能力和 OCR 文字识别。
 * 支持剪贴板图片自动保存。
 * 
 * 必须通过 npm 包方式配置插件选项：
 * {
 *   "plugin": [
 *     ["opencode-image-vision", {
 *       "vision": { "provider": "custom", "model": "...", "apiKey": "sk-xxx", "baseUrl": "..." },
 *       "ocr": { "provider": "custom", "model": "...", "apiKey": "sk-xxx", "baseUrl": "..." },
 *       "clipboard": { "enabled": true }
 *     }]
 *   ]
 * }
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import OpenAI from "openai"
import path from "path"
import fs from "fs"
import os from "os"
import pdfParse from "pdf-parse"

// ============================================================================
// Type Definitions
// ============================================================================

/** Vision 模型 Provider 类型 */
type VisionProvider = "openai" | "anthropic" | "custom"

/** OCR Provider 类型（只支持 custom，即 OpenAI 兼容 API） */
type OcrProvider = "custom"

/** Vision 配置 */
interface VisionConfig {
  provider: VisionProvider
  model: string
  /** 直接写入的 API Key（优先级最高） */
  apiKey?: string
  /** API Key 所在的环境变量名（优先级次之） */
  apiKeyEnv?: string
  /** API 基础 URL */
  baseUrl?: string
  /** 描述语言，默认 "zh" */
  language?: string
  /** 描述最大 token 数，默认 1024 */
  maxTokens?: number
  /** 强制所有模型走视觉描述，默认 false */
  forceDescription?: boolean
  /** 补充标记为支持图片的模型 ID 列表 */
  skipModels?: string[]
  /** 是否拦截 PDF，默认 true */
  enabledForPdf?: boolean
}

/** OCR 配置 */
interface OcrConfig {
  provider: OcrProvider
  model: string
  apiKey?: string
  apiKeyEnv?: string
  baseUrl: string  // custom 必须提供
  language?: string
  maxTokens?: number
}

/** 剪贴板配置 */
interface ClipboardConfig {
  enabled?: boolean
  saveDir?: string
}

/** 插件选项（从 npm 包配置传入） */
interface PluginOptions {
  vision?: VisionConfig
  ocr?: OcrConfig
  clipboard?: ClipboardConfig
}

/** 缓存条目 */
interface CacheEntry {
  description: string
  mtime: number
}

// ============================================================================
// Constants - 支持的文件类型
// ============================================================================

/** 支持的图片扩展名 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"])

/** 支持的 PDF 扩展名 */
const PDF_EXTENSIONS = new Set([".pdf"])

/** 所有支持的视觉文件扩展名 */
const VISION_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...PDF_EXTENSIONS])

/** 扩展名到 MIME 类型的映射 */
const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
}

// ============================================================================
// Constants - Provider 默认值
// ============================================================================

/** 各 Provider 的默认 API Key 环境变量名 */
const PROVIDER_DEFAULT_API_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  custom: "",  // custom 无默认，需要用户配置
}

/** 各 Provider 的默认 Base URL */
const PROVIDER_DEFAULT_BASE_URL: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  custom: "",  // custom 无默认，必须用户配置
}

/** 视觉模型支持图片的模型 ID 正则匹配模式 */
const VISION_MODEL_PATTERNS: RegExp[] = [
  /\bgpt[\-_]?4o\b/i,
  /\bgpt[\-_]?4[\-_]?turbo\b/i,
  /\bgpt[\-_]?4[\-_]?vision\b/i,
  /\bgpt[\-_]?5/i,
  /\bo[1-4]\b/i,
  /\bclaude[\-_]?3[\-_]?5[\-_]?sonnet\b/i,
  /\bclaude[\-_]?3[\-_]?opus\b/i,
  /\bclaude[\-_]?(4|opus[\-_]?4|sonnet[\-_]?4)/i,
  /\bclaude[\-_]?sonnet[\-_]?4/i,
  /\bclaude[\-_]?opus[\-_]?4/i,
  /\bclaude[\-_]?4[\-_]?5/i,
  /\bgemini[\-_]?2/i,
  /\bgemini[\-_]?3/i,
  /\bqwen[\-_]?vl\b/i,
  /\bllava\b/i,
  /\bgemma[\-_]?3/i,
  /\binternvl\b/i,
  /\bcogvlm\b/i,
  /\bmini[\-_]?cpm[\-_]?v\b/i,
  /\bphi[\-_]?3[\-_]?vision\b/i,
]

// ============================================================================
// Constants - 运行参数
// ============================================================================

/** 视觉描述临时文件目录 */
const TMP_DIR = path.join(os.tmpdir(), "opencode-image-vision")

/** 剪贴板图片保存目录 */
const DEFAULT_SAVE_DIR = path.join(os.tmpdir(), "opencode-images")

/** 默认参数 */
const DEFAULT_MAX_TOKENS = 1024
const DEFAULT_OCR_MAX_TOKENS = 4096
const DEFAULT_LANGUAGE = "zh"
const MAX_IMAGE_SIZE = 20 * 1024 * 1024   // 20MB
const MAX_PDF_SIZE = 50 * 1024 * 1024   // 50MB
const VISION_API_TIMEOUT = 60_000       // 60 秒
const OCR_API_TIMEOUT = 120_000         // 120 秒

// ============================================================================
// Utility Functions - 文件类型检测
// ============================================================================

/** 检查是否为图片文件 */
function isImagePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

/** 检查是否为 PDF 文件 */
function isPdfPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return PDF_EXTENSIONS.has(ext)
}

/** 从文件扩展名获取 MIME 类型 */
function mimeTypeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return EXT_TO_MIME[ext] ?? "image/png"
}

// ============================================================================
// Utility Functions - API Key 获取
// ============================================================================

/**
 * 获取 API Key
 * 优先级：apiKey 字段 > apiKeyEnv 环境变量 > provider 默认环境变量
 */
function getApiKey(config: { apiKey?: string; apiKeyEnv?: string; provider: string }): string {
  // 1. 直接配置的 apiKey
  if (config.apiKey) return config.apiKey
  
  // 2. 通过 apiKeyEnv 环境变量名读取
  if (config.apiKeyEnv) {
    return process.env[config.apiKeyEnv] || ""
  }
  
  // 3. 通过 provider 默认环境变量名读取
  const defaultEnvVar = PROVIDER_DEFAULT_API_KEY_ENV[config.provider]
  if (defaultEnvVar) {
    return process.env[defaultEnvVar] || ""
  }
  
  return ""
}

/** 获取 Base URL */
function getBaseUrl(config: { baseUrl?: string; provider: string }): string {
  if (config.baseUrl) return config.baseUrl
  return PROVIDER_DEFAULT_BASE_URL[config.provider] || ""
}

// ============================================================================
// Utility Functions - 构建提示词
// ============================================================================

/** 构建视觉描述提示词 */
function buildVisionPrompt(config: { language?: string }, userPrompt?: string, isPdf?: boolean): string {
  const lang = config.language || DEFAULT_LANGUAGE
  
  if (userPrompt) return userPrompt
  
  if (isPdf) {
    return (
      `Please analyze this PDF document in detail in ${lang === "zh" ? "Chinese" : "English"}. ` +
      `Include: document structure, key content, text transcription, tables (if any), charts/diagrams descriptions, and summary of main points. ` +
      `If the PDF contains code or formulas, transcribe them accurately.`
    )
  }
  
  return (
    `Please describe this image in detail in ${lang === "zh" ? "Chinese" : "English"}. ` +
    `Include: visual content, layout, text content (if any), colors, and any notable details. ` +
    `If the image contains code or error messages, transcribe them accurately.`
  )
}

/** 构建 OCR 提示词 */
function buildOcrPrompt(config: { language?: string }): string {
  const lang = config.language || DEFAULT_LANGUAGE
  return (
    `Perform OCR on this image. Extract ALL text content accurately in ${lang === "zh" ? "Chinese" : "English"}. ` +
    `Preserve the original structure, layout, and formatting. ` +
    `If there are tables, transcribe them. If there is code, transcribe it exactly. ` +
    `Output only the extracted text, no additional commentary.`
  )
}

// ============================================================================
// Utility Functions - 文件目录
// ============================================================================

/** 确保目录存在 */
async function ensureDir(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true })
  }
}

// ============================================================================
// Cache - 会话级内存缓存
// ============================================================================

const cache = new Map<string, CacheEntry>()

function getCached(absPath: string, mtime: number): string | null {
  const entry = cache.get(absPath)
  if (entry && entry.mtime === mtime) {
    return entry.description
  }
  return null
}

function setCache(absPath: string, mtime: number, description: string): void {
  cache.set(absPath, { description, mtime })
}

// ============================================================================
// Shared Client - OpenAI 客户端单例（视觉描述）
// ============================================================================

let sharedOpenAIClient: OpenAI | null = null

function getOpenAIClient(config: { apiKey?: string; baseUrl?: string; provider: string }): OpenAI {
  if (sharedOpenAIClient) return sharedOpenAIClient

  const apiKey = getApiKey(config)
  const baseUrl = getBaseUrl(config)

  sharedOpenAIClient = new OpenAI({
    apiKey: apiKey || "unused",
    baseURL: baseUrl || undefined,
    timeout: VISION_API_TIMEOUT,
  })

  return sharedOpenAIClient
}

// ============================================================================
// Vision - OpenAI 兼容 API 调用
// ============================================================================

/**
 * 使用 OpenAI 兼容 API 进行视觉描述
 * 支持: OpenAI, 硅基流动, DeepInfra, 智谱, 自建 vLLM 等所有 OpenAI 兼容端点
 */
async function openaiVisionDescribe(
  config: VisionConfig,
  base64: string,
  mime: string,
  prompt: string
): Promise<string> {
  const oai = getOpenAIClient(config)
  
  const response = await oai.chat.completions.create({
    model: config.model,
    max_tokens: config.maxTokens || DEFAULT_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
          { type: "text", text: prompt },
        ],
      },
    ],
  })
  
  return response.choices?.[0]?.message?.content?.trim() || "[No description returned]"
}

// ============================================================================
// Vision - Anthropic API 调用
// ============================================================================

/**
 * 使用 Anthropic Claude 进行视觉描述
 * Anthropic 原生支持 PDF document 类型
 */
async function anthropicVisionDescribe(
  config: VisionConfig,
  base64: string,
  mime: string,
  prompt: string
): Promise<string> {
  const apiKey = getApiKey(config)
  const baseUrl = getBaseUrl(config) || "https://api.anthropic.com"
  const url = `${baseUrl}/messages`

  // PDF 使用 document 类型，图片使用 image 类型
  const contentBlock: any =
    mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: mime, data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mime, data: base64 } }

  const body = {
    model: config.model,
    max_tokens: config.maxTokens || DEFAULT_MAX_TOKENS,
    messages: [{ role: "user", content: [contentBlock, { type: "text", text: prompt }] }],
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VISION_API_TIMEOUT)

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Anthropic API error: ${response.status} ${text}`)
    }

    const data = (await response.json()) as { content: Array<{ type: string; text?: string }> }
    const textBlock = data.content?.find((b) => b.type === "text")
    return textBlock?.text?.trim() || "[No description returned]"
  } finally {
    clearTimeout(timeout)
  }
}

// ============================================================================
// Vision - 主描述函数
// ============================================================================

/**
 * 视觉描述主函数
 * 根据 provider 分发到不同的 API 调用
 */
async function describeImage(
  config: VisionConfig,
  base64: string,
  mime: string,
  userPrompt?: string
): Promise<string> {
  const isPdf = mime === "application/pdf"
  const prompt = buildVisionPrompt(config, userPrompt, isPdf)
  
  switch (config.provider) {
    case "anthropic":
      return anthropicVisionDescribe(config, base64, mime, prompt)
    case "openai":
    case "custom":
      return openaiVisionDescribe(config, base64, mime, prompt)
    default:
      throw new Error(`Unknown vision provider: ${config.provider}`)
  }
}

// ============================================================================
// Vision - 模型能力检测
// ============================================================================

/** 检查模型 ID 是否为已知的视觉模型 */
function modelSupportsVision(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return VISION_MODEL_PATTERNS.some((p) => p.test(id))
}

/** 检测当前使用的模型是否支持视觉 */
async function currentModelSupportsVision(
  client: PluginInput["client"],
  config: VisionConfig
): Promise<boolean> {
  try {
    const res = await client.config.get()
    const data = res.data as any
    const modelStr = data?.model || ""

    // 检查 skipModels 列表
    if (config.skipModels?.length) {
      const skipLower = config.skipModels.map((m) => m.toLowerCase())
      if (skipLower.some((m) => modelStr.toLowerCase().includes(m))) {
        return true
      }
    }

    return modelSupportsVision(modelStr)
  } catch {
    return false
  }
}

// ============================================================================
// Vision - 模型预热
// ============================================================================

/**
 * 预热视觉模型，消除冷启动延迟
 */
async function warmUpVisionModel(config: VisionConfig): Promise<void> {
  try {
    switch (config.provider) {
      case "openai":
      case "custom": {
        const oai = getOpenAIClient(config)
        await oai.chat.completions.create({
          model: config.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        })
        break
      }
      case "anthropic": {
        const apiKey = getApiKey(config)
        const baseUrl = getBaseUrl(config) || "https://api.anthropic.com"
        await fetch(`${baseUrl}/messages`, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
        })
        break
      }
    }
  } catch {
    // 预热失败静默忽略
  }
}

// ============================================================================
// Vision - PDF 文本提取
// ============================================================================

/**
 * 使用 pdf-parse 提取 PDF 文本
 */
async function extractPdfText(absPath: string): Promise<string> {
  const dataBuffer = await fs.promises.readFile(absPath)
  const data = await pdfParse(dataBuffer)
  const pages = data.numpages
  const text = data.text.trim()
  const info = data.info as Record<string, string> | undefined
  
  const meta: string[] = []
  if (info?.Title) meta.push(`Title: ${info.Title}`)
  if (info?.Author) meta.push(`Author: ${info.Author}`)
  if (info?.CreationDate) meta.push(`Created: ${info.CreationDate}`)

  const parts: string[] = []
  if (meta.length) parts.push(meta.join("\n"))
  parts.push(`Pages: ${pages}`)
  
  if (text) {
    parts.push("", text)
  } else {
    parts.push("", "[This PDF contains no extractable text. It may be a scanned document or image-based PDF.]")
  }
  
  return parts.join("\n")
}

// ============================================================================
// Vision - 处理图片/PDF 主函数
// ============================================================================

/**
 * 处理图片或 PDF 文件，返回视觉描述
 */
async function processImage(
  filePath: string,
  config: VisionConfig,
  userPrompt?: string
): Promise<{ description: string; cacheHit: boolean }> {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath)

  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`)
  }

  const stat = await fs.promises.stat(absPath)
  const isPdf = isPdfPath(absPath)
  const maxSize = isPdf ? MAX_PDF_SIZE : MAX_IMAGE_SIZE

  if (stat.size > maxSize) {
    throw new Error(
      `File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max ${maxSize / 1024 / 1024}MB)`
    )
  }

  // 检查缓存
  const cached = getCached(absPath, stat.mtimeMs)
  if (cached) return { description: cached, cacheHit: true }

  let description: string

  // PDF 处理：Anthropic 原生支持，其他 provider 先尝试文本提取
  if (isPdf && config.provider !== "anthropic") {
    const extractedText = await extractPdfText(absPath)
    const hasText = extractedText.length > 100 && !extractedText.includes("[This PDF contains no extractable text")
    
    if (hasText) {
      // 有可提取文本，直接返回（更省 token）
      description = extractedText
    } else {
      // 扫描件，走视觉 API
      const bytes = await fs.promises.readFile(absPath)
      const base64 = Buffer.from(bytes).toString("base64")
      description = await describeImage(config, base64, "application/pdf", userPrompt)
    }
  } else {
    // 图片处理
    const bytes = await fs.promises.readFile(absPath)
    const base64 = Buffer.from(bytes).toString("base64")
    const mime = mimeTypeFromExt(absPath)
    description = await describeImage(config, base64, mime, userPrompt)
  }

  setCache(absPath, stat.mtimeMs, description)
  return { description, cacheHit: false }
}

// ============================================================================
// Vision - 临时描述文件写入
// ============================================================================

/**
 * 将视觉描述写入临时文件，供 read 工具读取
 */
async function writeTempDescription(
  originalPath: string,
  description: string,
  config: VisionConfig
): Promise<string> {
  await ensureDir(TMP_DIR)
  const basename = path.basename(originalPath, path.extname(originalPath))
  const tmpPath = path.join(TMP_DIR, `${basename}.vision.txt`)
  
  const content = [
    "[Image Vision Plugin]",
    `Source: ${originalPath}`,
    `Vision Model: ${config.provider}/${config.model}`,
    "",
    description,
  ].join("\n")
  
  // 添加 UTF-8 BOM 解决 Windows 中文乱码
  await fs.promises.writeFile(tmpPath, "\ufeff" + content, "utf-8")
  return tmpPath
}

// ============================================================================
// OCR - 主函数
// ============================================================================

/**
 * OCR 文字识别主函数
 * 只使用 OpenAI 兼容 API（custom provider）
 */
async function performOcr(
  filePath: string,
  config: OcrConfig,
  language?: string
): Promise<string> {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath)

  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`)
  }

  const stat = await fs.promises.stat(absPath)
  
  if (stat.size > MAX_PDF_SIZE) {
    throw new Error(
      `File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max ${MAX_PDF_SIZE / 1024 / 1024}MB)`
    )
  }

  const bytes = await fs.promises.readFile(absPath)
  const base64 = Buffer.from(bytes).toString("base64")
  const mime = mimeTypeFromExt(absPath)

  const apiKey = getApiKey(config)
  const baseUrl = getBaseUrl(config)

  const oai = new OpenAI({
    apiKey: apiKey || "unused",
    baseURL: baseUrl || undefined,
    timeout: OCR_API_TIMEOUT,
  })

  const prompt = buildOcrPrompt({ language: language || config.language })

  const response = await oai.chat.completions.create({
    model: config.model,
    max_tokens: config.maxTokens || DEFAULT_OCR_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
          { type: "text", text: prompt },
        ],
      },
    ],
  })

  return response.choices?.[0]?.message?.content?.trim() || "[No text extracted]"
}

// ============================================================================
// Clipboard - 剪贴板图片处理
// ============================================================================

/** 检查字符串是否为 base64 data URL */
function isBase64DataUrl(text: string): boolean {
  return /^data:image\/[a-z]+;base64,/.test(text)
}

/** 从 data URL 提取 MIME 类型 */
function getDataUrlMime(dataUrl: string): string {
  const match = dataUrl.match(/^data:(image\/[a-z+.-]+);/)
  return match?.[1] || "image/png"
}

/** 从 data URL 提取 MIME 类型和数据 */
function extractBase64FromDataUrl(dataUrl: string): { mime: string; data: string } {
  const mime = getDataUrlMime(dataUrl)
  const commaIdx = dataUrl.indexOf(",")
  const data = commaIdx === -1 ? dataUrl : dataUrl.slice(commaIdx + 1)
  return { mime, data }
}

/**
 * 保存剪贴板图片到临时目录
 */
async function saveClipboardImage(dataUrl: string, saveDir: string): Promise<string> {
  await ensureDir(saveDir)
  const { mime, data } = extractBase64FromDataUrl(dataUrl)
  
  const extMap: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/webp": ".webp",
  }
  
  const ext = extMap[mime] || ".png"
  const filename = `clipboard-${Date.now()}${ext}`
  const filePath = path.join(saveDir, filename)
  const buffer = Buffer.from(data, "base64")
  
  await fs.promises.writeFile(filePath, buffer)
  return filePath
}

// ============================================================================
// Plugin - 主入口
// ============================================================================

/**
 * opencode-image-vision 插件主函数
 * 
 * @param ctx - OpenCode 插件上下文
 * @param options - 可选的插件配置（从 npm 包 config 传入）
 */
export const ImageVisionPlugin: Plugin = async (ctx, options?: PluginOptions) => {
  const { client, directory, worktree } = ctx

  // 从 PluginOptions 读取配置（npm 包方式唯一入口）
  const visionConfig = options?.vision || null
  const ocrConfig = options?.ocr || null
  const clipboardConfig = options?.clipboard || { enabled: true }

  // 验证必需的配置
  if (!visionConfig?.provider || !visionConfig?.model) {
    await client.app.log({
      body: {
        service: "opencode-image-vision",
        level: "warn",
        message: "Vision config missing. Add vision config in plugin options.",
      },
    })
  }

  // 验证 vision API Key
  if (visionConfig) {
    const apiKey = getApiKey(visionConfig)
    if (!apiKey) {
      await client.app.log({
        body: {
          service: "opencode-image-vision",
          level: "warn",
          message: `Vision API key not set. Set apiKey or apiKeyEnv in config.`,
        },
      })
    } else {
      // 预热模型
      warmUpVisionModel(visionConfig).catch(() => {})
    }

    await client.app.log({
      body: {
        service: "opencode-image-vision",
        level: "info",
        message: `Vision initialized: provider=${visionConfig.provider}, model=${visionConfig.model}`,
      },
    })
  }

  // 验证 OCR 配置
  if (ocrConfig) {
    const ocrApiKey = getApiKey(ocrConfig)
    if (!ocrApiKey) {
      await client.app.log({
        body: {
          service: "opencode-image-vision",
          level: "warn",
          message: "OCR API key not set in config.",
        },
      })
    }

    await client.app.log({
      body: {
        service: "opencode-image-vision",
        level: "info",
        message: `OCR initialized: provider=${ocrConfig.provider}, model=${ocrConfig.model}`,
      },
    })
  }

  // 记录剪贴板状态
  if (clipboardConfig?.enabled !== false) {
    await client.app.log({
      body: {
        service: "opencode-image-vision",
        level: "info",
        message: `Clipboard support enabled, saveDir=${clipboardConfig.saveDir || DEFAULT_SAVE_DIR}`,
      },
    })
  }

  // 构建 hooks
  const hooks: any = {}

  // ====== Tool Hook: read 拦截 ======
  if (visionConfig) {
    hooks["tool.execute.before"] = async (input: any, output: any) => {
      try {
        // 只拦截 read 工具
        if (input.tool !== "read") return

        const filePath: string = output.args?.filePath || ""
        if (!filePath) return

        const isImg = isImagePath(filePath)
        const isPdf = isPdfPath(filePath)
        if (!isImg && !isPdf) return

        // PDF 启用检查
        if (isPdf && !visionConfig.enabledForPdf) return

        // 自动跳过支持视觉的模型
        if (!visionConfig.forceDescription) {
          const supportsVision = await currentModelSupportsVision(client, visionConfig)
          if (supportsVision) return
        }

        const absPath = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(worktree || directory, filePath)

        // 文件存在检查
        if (!fs.existsSync(absPath)) return

        // 处理图片/PDF
        const { description } = await processImage(absPath, visionConfig)
        const tmpPath = await writeTempDescription(absPath, description, visionConfig)
        output.args.filePath = tmpPath
      } catch (err: any) {
        await client.app.log({
          body: {
            service: "opencode-image-vision",
            level: "error",
            message: `tool.execute.before error: ${err?.message || err}`,
          },
        })
      }
    }
  }

  // ====== Tool Definitions ======
  const toolDefs: any = {}

  // read-image 工具：视觉描述
  if (visionConfig) {
    toolDefs["read-image"] = tool({
      description:
        "读取图片或 PDF 文件并返回文字描述。当 read 无法展示图片/PDF 内容时使用此工具。支持 png/jpg/gif/bmp/webp 图片和 PDF 文档。",
      args: {
        path: tool.schema.string().describe("图片或 PDF 文件的相对或绝对路径"),
        prompt: tool.schema.string().optional().describe("可选提示词，引导视觉模型关注特定方面"),
      },
      async execute(args: any, context: any) {
        const absPath = path.isAbsolute(args.path)
          ? args.path
          : path.resolve(context.worktree || context.directory, args.path)
        const { description } = await processImage(absPath, visionConfig, args.prompt)
        return description
      },
    })
  }

  // read-ocr 工具：OCR 文字识别
  if (ocrConfig) {
    toolDefs["read-ocr"] = tool({
      description:
        "对图片或 PDF 执行 OCR 文字识别，返回提取的纯文本。当视觉描述对文字识别效果不好时使用此工具。支持 png/jpg/gif/bmp/webp/tiff 图片和 PDF 文档。",
      args: {
        path: tool.schema.string().describe("图片或 PDF 文件的相对或绝对路径"),
        language: tool.schema.string().optional().describe("识别语言提示，如 zh/en，默认从配置读取"),
      },
      async execute(args: any, context: any) {
        const absPath = path.isAbsolute(args.path)
          ? args.path
          : path.resolve(context.worktree || context.directory, args.path)
        return performOcr(absPath, ocrConfig, args.language)
      },
    })
  }

  if (Object.keys(toolDefs).length > 0) {
    hooks.tool = toolDefs
  }

  // ====== Clipboard Hook: messages.transform ======
  if (clipboardConfig?.enabled !== false) {
    const clipSaveDir = clipboardConfig.saveDir || DEFAULT_SAVE_DIR

    hooks["experimental.chat.messages.transform"] = async (_input: any, output: any) => {
      try {
        if (!output?.messages) return

        for (const msg of output.messages) {
          if (!msg?.parts) continue

          for (let i = 0; i < msg.parts.length; i++) {
            const part = msg.parts[i]

            // 处理 file 类型的 base64 data URL
            if (part?.type === "file" && part?.url && isBase64DataUrl(part.url)) {
              const savedPath = await saveClipboardImage(part.url, clipSaveDir)
              msg.parts[i] = {
                type: "text",
                text: `[Image saved to: ${savedPath}]`,
              }
              await client.app.log({
                body: {
                  service: "opencode-image-vision",
                  level: "info",
                  message: `Clipboard image saved: ${savedPath}`,
                },
              })
            }

            // 处理 text 中嵌入的 base64 data URL
            if (part?.type === "text" && typeof part.text === "string") {
              const dataUrlMatch = part.text.match(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g)
              if (dataUrlMatch) {
                let newText = part.text
                for (const dataUrl of dataUrlMatch) {
                  const savedPath = await saveClipboardImage(dataUrl, clipSaveDir)
                  newText = newText.replace(dataUrl, savedPath)
                }
                msg.parts[i] = { type: "text", text: newText }
              }
            }
          }
        }
      } catch (err: any) {
        await client.app.log({
          body: {
            service: "opencode-image-vision",
            level: "error",
            message: `messages.transform error: ${err?.message || err}`,
          },
        })
      }
    }
  }

  return hooks
}