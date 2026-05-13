export class NomaSystemError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "NomaSystemError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class NomaSpawnError extends NomaSystemError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "NomaSpawnError";
  }
}

export class NomaTransportError extends NomaSystemError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "NomaTransportError";
  }
}

export class NomaCapabilityError extends NomaSystemError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "NomaCapabilityError";
  }
}

export class NomaTimeoutError extends NomaSystemError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "NomaTimeoutError";
  }
}
