export class ToolCallRateLimiter {
  constructor({ limit = 30, windowMs = 60_000, maxBuckets = 10_000, countAll = false, now = () => Date.now() } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1
      || !Number.isSafeInteger(windowMs) || windowMs < 1
      || !Number.isSafeInteger(maxBuckets) || maxBuckets < 1
      || typeof now !== 'function') {
      throw new Error('Tool call rate limiter options are invalid.');
    }
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxBuckets = maxBuckets;
    this.now = now;
    this.countAll = countAll;
    this.buckets = new Map();
  }

  consume(body, clientKey = 'anonymous') {
    const messages = Array.isArray(body) ? body : [body];
    const callCount = this.countAll ? Math.max(1, messages.length)
      : messages.filter((message) => message?.method === 'tools/call').length;
    if (callCount === 0) return true;

    const now = this.now();
    const key = typeof clientKey === 'string' && clientKey ? clientKey : 'anonymous';
    let bucket = this.buckets.get(key);
    if (!bucket && this.buckets.size >= this.maxBuckets) {
      for (const [oldKey, oldBucket] of this.buckets) {
        if (now - oldBucket.windowStartedAt >= this.windowMs) this.buckets.delete(oldKey);
      }
      if (this.buckets.size >= this.maxBuckets) return false;
    }
    if (!bucket || now - bucket.windowStartedAt >= this.windowMs) {
      bucket = { windowStartedAt: now, count: 0 };
      this.buckets.set(key, bucket);
    }
    if (bucket.count + callCount > this.limit) return false;
    bucket.count += callCount;
    return true;
  }
}
