export class HttpError extends Error {
  status: number;
  retryable?: boolean;

  constructor(status: number, message: string, retryable?: boolean) {
    super(message);
    this.status = status;
    if (retryable !== undefined) this.retryable = retryable;
  }
}
