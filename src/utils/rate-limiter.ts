import { config } from "../config.js";

interface RateRecord {
  timestamps: number[];
}

export class RateLimiter {
  private userLimits = new Map<string, RateRecord>();
  private readonly windowMs = 60 * 1000;
  private readonly maxRequests: number;

  constructor(maxRequests: number = config.rateLimitPerUserPerMin) {
    this.maxRequests = maxRequests;
  }

  public checkAndIncrement(userId: string): { allowed: boolean; remaining: number } {
    const now = Date.now();
    let record = this.userLimits.get(userId);

    if (!record) {
      record = { timestamps: [] };
      this.userLimits.set(userId, record);
    }

    // Filter out timestamps outside the sliding window
    record.timestamps = record.timestamps.filter((ts) => now - ts < this.windowMs);

    if (record.timestamps.length >= this.maxRequests) {
      return { allowed: false, remaining: 0 };
    }

    record.timestamps.push(now);
    return {
      allowed: true,
      remaining: this.maxRequests - record.timestamps.length,
    };
  }

  public clear(): void {
    this.userLimits.clear();
  }
}

export const defaultRateLimiter = new RateLimiter();
