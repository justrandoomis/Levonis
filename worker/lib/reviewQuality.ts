/**
 * Deterministic, auditable review-quality scoring.
 *
 * This module never reads sentiment: a useful one-star review can earn the
 * same tier as a useful five-star review. It also never grants anything. It
 * only reports evidence for the existing five gift levels; the review route
 * remains authoritative for queueing and the admin remains authoritative for
 * the final tier.
 */

export interface ReviewQualityMedia {
  key: string;
  kind: 'image' | 'video';
  /** SHA-256 recorded by the trusted upload route. */
  sha256?: string;
  bytes?: number;
  mime?: string;
}

export interface ReviewQualityInput {
  stars: number;
  body: string;
  media: ReviewQualityMedia[];
  hasEvidence: boolean;
  isPrinter: boolean;
  /** Normalized bodies from this customer's other reviews. */
  previousBodies?: string[];
  /** Trusted media digests from this customer's other reviews. */
  previousMediaHashes?: string[];
}

export interface ReviewQualityResult {
  score: number;
  tier: 1 | 2 | 3 | 4 | 5 | null;
  reasons: string[];
  textQuality: number;
  imageCount: number;
  imageQuality: number;
  videoPresent: boolean;
  videoQuality: number;
  suspiciousSignals: string[];
  rewardEligible: boolean;
}

/** Used by tests and duplicate detection so both paths normalize identically. */
export function normalizeReviewText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * Maps evidence to the five EXISTING levels. The gates deliberately grow in
 * substance, not file count alone: level 3 needs three distinct useful
 * images, level 4 adds useful video, and level 5 also needs durable evidence.
 */
function tierFor(
  score: number,
  textChars: number,
  uniqueImages: ReviewQualityMedia[],
  imageQuality: number,
  videoPresent: boolean,
  videoQuality: number,
  hasEvidence: boolean
): 1 | 2 | 3 | 4 | 5 | null {
  if (textChars < 100 || uniqueImages.length < 1) return null;
  if (
    score >= 94 &&
    uniqueImages.length >= 3 &&
    imageQuality >= 27 &&
    videoPresent &&
    videoQuality >= 18 &&
    hasEvidence
  ) return 5;
  if (score >= 84 && uniqueImages.length >= 3 && videoPresent && videoQuality >= 8) return 4;
  if (score >= 70 && uniqueImages.length >= 3 && imageQuality >= 18) return 3;
  if (score >= 58 && uniqueImages.length >= 2 && imageQuality >= 12) return 2;
  if (score >= 45) return 1;
  return null;
}

export function evaluateReviewQuality(input: ReviewQualityInput): ReviewQualityResult {
  const body = normalizeReviewText(input.body);
  const textChars = [...body.replace(/\s/g, '')].length;
  const words = body ? body.split(' ').filter(Boolean) : [];
  const uniqueWords = new Set(words);
  const diversity = words.length ? uniqueWords.size / words.length : 0;
  const reasons: string[] = [];
  const suspiciousSignals: string[] = [];

  let textQuality = 0;
  if (textChars >= 40) { textQuality += 8; reasons.push('text_40_chars'); }
  if (textChars >= 100) { textQuality += 10; reasons.push('meaningful_text'); }
  if (textChars >= 220) { textQuality += 7; reasons.push('detailed_text'); }
  if (words.length >= 12) textQuality += 5;
  if (words.length >= 30) textQuality += 4;
  if (words.length >= 8 && diversity >= 0.5) { textQuality += 5; reasons.push('varied_language'); }
  if (/\d|[.!?؟،,:؛]/u.test(input.body)) textQuality += 3;
  textQuality = clamp(textQuality, 0, 42);

  if (words.length >= 15 && diversity < 0.25) suspiciousSignals.push('repetitive_text');
  if (/(.{2,12})\1{4,}/u.test(body.replace(/\s/g, ''))) suspiciousSignals.push('padded_text');
  const previous = new Set((input.previousBodies ?? []).map(normalizeReviewText).filter(Boolean));
  if (body.length >= 20 && previous.has(body)) suspiciousSignals.push('duplicate_text');

  const images = input.media.filter((m) => m.kind === 'image');
  const videos = input.media.filter((m) => m.kind === 'video');
  const seenImage = new Set<string>();
  const uniqueImages: ReviewQualityMedia[] = [];
  for (const image of images) {
    const identity = image.sha256 || `key:${image.key}`;
    if (seenImage.has(identity)) {
      suspiciousSignals.push('duplicate_media');
      continue;
    }
    seenImage.add(identity);
    uniqueImages.push(image);
  }

  const oldHashes = new Set((input.previousMediaHashes ?? []).filter(Boolean));
  if (uniqueImages.some((m) => m.sha256 && oldHashes.has(m.sha256))) suspiciousSignals.push('reused_media');

  const goodImages = uniqueImages.filter((m) => Number(m.bytes ?? 0) >= 80 * 1024);
  const tinyImages = uniqueImages.filter((m) => Number(m.bytes ?? 0) > 0 && Number(m.bytes) < 8 * 1024);
  if (tinyImages.length) suspiciousSignals.push('low_quality_image');
  const imageQuality = clamp(uniqueImages.length * 6 + goodImages.length * 3, 0, 27);
  if (uniqueImages.length) reasons.push('unique_images');
  if (uniqueImages.length >= 3) reasons.push('three_or_more_images');
  if (goodImages.length >= 3) reasons.push('high_quality_images');

  const videoPresent = videos.length > 0;
  const usefulVideo = videos.some((m) => Number(m.bytes ?? 0) >= 500 * 1024);
  const videoQuality = videoPresent ? 8 + (usefulVideo ? 10 : 0) : 0;
  if (videoPresent) reasons.push('video_present');
  if (usefulVideo) reasons.push('useful_video');
  if (videoPresent && videos.every((m) => Number(m.bytes ?? 0) > 0 && Number(m.bytes) < 16 * 1024)) {
    suspiciousSignals.push('low_quality_video');
  }
  if (input.hasEvidence) reasons.push('supporting_evidence');

  const severe = suspiciousSignals.some((s) =>
    ['duplicate_text', 'reused_media', 'repetitive_text', 'padded_text'].includes(s)
  );
  const rawScore =
    (input.stars >= 1 && input.stars <= 5 ? 5 : 0) +
    textQuality +
    imageQuality +
    videoQuality +
    (input.hasEvidence ? 8 : 0) -
    (severe ? 30 : 0) -
    (suspiciousSignals.includes('low_quality_image') ? 5 : 0) -
    (suspiciousSignals.includes('low_quality_video') ? 5 : 0);
  const score = clamp(Math.round(rawScore), 0, 100);
  const tier = severe
    ? null
    : tierFor(score, textChars, uniqueImages, imageQuality, videoPresent, videoQuality, input.hasEvidence);

  return {
    score,
    tier,
    reasons: [...new Set(reasons)],
    textQuality,
    imageCount: uniqueImages.length,
    imageQuality,
    videoPresent,
    videoQuality,
    suspiciousSignals: [...new Set(suspiciousSignals)],
    rewardEligible: input.isPrinter && tier !== null,
  };
}

