import type { PageContext } from '../threads/page';

/** Requests the side panel sends to the content script of a tab: type -> request and reply data. */
export interface TabRequests {
  'page:get': { req: void; res: PageContext };
  ping: { req: void; res: { version: string } };
}

/** Messages the content script announces to the side panel: type -> data. */
export interface Broadcasts {
  'page:changed': PageContext;
}

export type MessagingErrorCode = 'no_content_script' | 'unknown';

export class MessagingError extends Error {
  readonly code: MessagingErrorCode;

  constructor(code: MessagingErrorCode, message: string) {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
  }
}
