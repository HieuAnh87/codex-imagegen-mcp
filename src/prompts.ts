// Turns tool arguments into one prompt per image. Kept pure so it can be tested
// without Codex.

export interface GenerateSpec {
  prompt: string;
  variations?: string[];
  count?: number;
  aspectRatio?: string;
  transparentBackground?: boolean;
}

export interface PlannedImage {
  index: number;
  variation: string | null;
  prompt: string;
}

function constraints(spec: { aspectRatio?: string; transparentBackground?: boolean }): string[] {
  const lines: string[] = [];
  if (spec.aspectRatio) lines.push(`Canvas aspect ratio: ${spec.aspectRatio}`);
  if (spec.transparentBackground) lines.push("Background: fully transparent (real alpha channel), no ground shadow");
  return lines;
}

export function planGenerate(spec: GenerateSpec): PlannedImage[] {
  const base = [spec.prompt.trim(), ...constraints(spec)].join("\n");
  if (spec.variations && spec.variations.length > 0) {
    return spec.variations.map((variation, index) => ({
      index,
      variation,
      prompt: `${base}\n\nVariation direction (this image only): ${variation.trim()}`,
    }));
  }
  const count = spec.count ?? 1;
  return Array.from({ length: count }, (_, index) => ({
    index,
    variation: null,
    prompt: count > 1 ? `${base}\n\nThis is variant ${index + 1} of ${count}; make it a distinct take on the brief.` : base,
  }));
}

export function planEdit(spec: { instructions: string; count?: number; transparentBackground?: boolean }): PlannedImage[] {
  const prompt = [
    "Edit the attached image.",
    "Apply only these changes and keep everything else (layout, text, colors, proportions) identical:",
    spec.instructions.trim(),
    ...constraints(spec),
  ].join("\n");
  return Array.from({ length: spec.count ?? 1 }, (_, index) => ({ index, variation: null, prompt }));
}

/** Runs tasks with at most `limit` in flight, preserving result order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}
