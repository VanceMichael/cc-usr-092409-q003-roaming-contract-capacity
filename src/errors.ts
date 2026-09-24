export class ServiceError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** 准入拒绝：错误抛出前调用方已将拒绝写入 admission_events，可凭 sessionId 追溯。 */
export class AdmissionRejected extends ServiceError {}

export function reject(code: string, message: string, details?: Record<string, unknown>): never {
  throw new AdmissionRejected(code, 422, message, details);
}
