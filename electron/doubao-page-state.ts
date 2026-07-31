export function normalizeComparableText(value: string) {
  return value.replace(/[^\p{L}\p{N}]+/gu, "").trim();
}

export function promptSignature(prompt: string) {
  const normalized = normalizeComparableText(prompt);
  return normalized.slice(0, Math.min(42, Math.max(12, normalized.length)));
}

export function containsPromptSignature(value: string, prompt: string) {
  const signature = promptSignature(prompt);
  return signature.length > 0 && normalizeComparableText(value).includes(signature);
}

export function extractDoubaoFailureMessage(pageText: string) {
  const text = pageText.replace(/\s+/g, " ").trim();
  if (!text) return null;

  const failurePatterns = [
    /生成内容中疑似包含[^。！？]*?(?:侵权|违规)[^。！？]*?(?:无法返回|不能返回|换个主题|额度未扣除)[^。！？]*(?:[。！？]|$)/,
    /疑似包含[^。！？]*?(?:侵权|违规)[^。！？]*?(?:无法返回|不能返回|换个主题|额度未扣除)[^。！？]*(?:[。！？]|$)/,
    /(?:侵权|违规)内容[^。！？]*?(?:无法返回|不能返回|换个主题|额度未扣除)[^。！？]*(?:[。！？]|$)/,
    /无法返回该内容[^。！？]*(?:[。！？]|$)/,
    /换个主题再试试[^。！？]*(?:[。！？]|$)/,
    /生成额度未扣除[^。！？]*(?:[。！？]|$)/,
    /额度未扣除[^。！？]*(?:[。！？]|$)/,
    /视频生成失败[^。！？]*(?:[。！？]|$)/,
    /生成视频失败[^。！？]*(?:[。！？]|$)/,
    /未能生成视频[^。！？]*(?:[。！？]|$)/
  ];

  for (const pattern of failurePatterns) {
    const matched = text.match(pattern)?.[0]?.trim();
    if (matched) return matched;
  }

  return null;
}

export function countTextOccurrences(text: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

export function hasNewTextOccurrence(currentText: string, baselineText: string, needle: string) {
  const count = (text: string) => {
    if (!needle) return 0;
    let occurrences = 0;
    let index = 0;
    while (true) {
      index = text.indexOf(needle, index);
      if (index === -1) return occurrences;
      occurrences += 1;
      index += needle.length;
    }
  };
  return count(currentText) > count(baselineText);
}

export function isQuotaNotChargedFailure(message: string) {
  return /额度未扣除|生成额度未扣除|未消耗|未扣费|不会扣除/.test(message);
}
