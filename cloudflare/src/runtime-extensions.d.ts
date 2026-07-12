export {};

declare global {
  interface SubtleCrypto {
    timingSafeEqual(
      left: ArrayBuffer | ArrayBufferView,
      right: ArrayBuffer | ArrayBufferView,
    ): boolean;
  }
}
