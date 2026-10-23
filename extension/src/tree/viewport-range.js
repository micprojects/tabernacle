// Refill towards the moving edge only after its inner buffer is consumed.
// The two buffers together retain the usual overscan budget on both sides.
export function bufferRange({ startIndex, endIndex, overscan, count }, previous) {
  const minimum = Math.floor(overscan / 2);
  const maximum = 2 * overscan - minimum;
  if (!previous || previous.end >= count)
    return {
      start: Math.max(0, startIndex - overscan),
      end: Math.min(count - 1, endIndex + overscan),
    };
  if (previous.start > 0 && startIndex - previous.start < minimum)
    return {
      start: Math.max(0, startIndex - maximum),
      end: Math.min(count - 1, endIndex + minimum),
    };
  if (previous.end < count - 1 && previous.end - endIndex < minimum)
    return {
      start: Math.max(0, startIndex - minimum),
      end: Math.min(count - 1, endIndex + maximum),
    };
  return previous;
}
