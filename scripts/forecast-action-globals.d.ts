type D1Database = object;
type RateLimit = object;

declare class HTMLRewriter {
  on(
    selector: string,
    handlers: {
      element?(element: { remove(): void }): void;
      text?(chunk: { text: string }): void;
    },
  ): this;
  transform(response: Response): Response;
}
