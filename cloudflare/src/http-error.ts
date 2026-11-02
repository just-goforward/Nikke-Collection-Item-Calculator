import type { AppErrorCode } from "../../shared/errorCodes";

/** The message is the public response code and the log code: a registered code only. */
export class HttpError extends Error {
  status: number;
  retryable?: boolean;

  constructor(status: number, message: AppErrorCode, retryable?: boolean) {
    super(message);
    this.status = status;
    if (retryable !== undefined) this.retryable = retryable;
  }
}
