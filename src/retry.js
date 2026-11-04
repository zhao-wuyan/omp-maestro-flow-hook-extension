// 初始化恢复按当前会话计数；只在交互入口检查，不创建定时器或唤醒模型。
export class InitializationRetry {
  constructor(now = Date.now) { this.now = now; this.reset(); }

  reset() { this.attempts = 0; this.tools = 0; this.failedAt = undefined; }

  failed() { this.tools = 0; this.failedAt = this.now(); }

  toolCompleted() { if (this.failedAt !== undefined) this.tools++; }

  takeDue() {
    if (this.failedAt === undefined || this.attempts >= 3) return false;
    const multiplier = 2 ** this.attempts;
    if (this.tools < 3 * multiplier && this.now() - this.failedAt < 180000 * multiplier) return false;
    this.attempts++;
    this.failedAt = undefined;
    return true;
  }

  status() {
    const remaining = Math.max(0, 3 - this.attempts);
    return {
      attempts: this.attempts, remaining,
      ...(this.failedAt !== undefined && remaining ? {
        toolsCompleted: this.tools, toolsRequired: 3 * 2 ** this.attempts,
        retryAt: this.failedAt + 180000 * 2 ** this.attempts,
      } : {}),
    };
  }
}
