import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/'

interface GeminiPart {
  text?: string
}
interface GeminiContent {
  role?: 'user' | 'model'
  parts?: GeminiPart[]
}
interface GeminiResponse {
  candidates?: { content?: GeminiContent }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

/**
 * Map our provider-neutral `user`/`assistant` roles onto Gemini's
 * `user`/`model` roles. Consecutive same-role turns are merged, and any
 * leading `model` (assistant) turn is dropped so the transcript starts
 * on the user — Gemini's generateContent is lenient, but a leading
 * model turn carries no prior user context and can confuse the model.
 */
function normalizeForGemini(messages: ChatMessage[]): GeminiContent[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', parts: [{ text: '(The customer has not sent a message yet.)' }] }]
  }
  return merged.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
}

/**
 * Call Google's Gemini generateContent endpoint with the caller's own
 * Google AI Studio (Developer) API key. The key is sent as the
 * `x-goog-api-key` header rather than a URL query param so it never
 * leaks into server logs / link metadata. Returns the raw assistant
 * text + token usage (handoff parsing happens in `generateReply`).
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(`${GEMINI_URL}${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: normalizeForGemini(messages),
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res)
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null
  const text = data?.candidates?.[0]?.content?.parts
    ?.filter((p) => typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('')
    .trim()
  if (!text || !text.trim()) {
    throw new AiError('Gemini returned an empty response.', {
      code: 'empty_response',
    })
  }

  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  })
  return { text, usage }
}
